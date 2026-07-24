import { useEffect, useRef, useState } from "react";
import { isTauri, openExternalUrl, brewAvailable, runProvisionStep, cancelProvisionStep, type ProvisionStep } from "../../lib/commands";

interface Props {
  step: number;
  title: string;
  body: string;
  cmd: string;
  copied: string | null;
  onCopy: (cmd: string) => void;
  onRecheck: () => void;
  recheckLabel: string;
  /** When true, the recheck button shows a spinner and is disabled. Surfaces
   *  feedback during async rechecks that otherwise look like a no-op. */
  loading?: boolean;
  /** Rendered below the button when set — typically a "still not ready"
   *  message after a recheck that didn't change state. */
  hint?: string | null;
  /** Run this step inside Porta instead of making the user open a terminal.
   *  Omit for steps Porta can't drive (anything needing sudo). */
  runStep?: ProvisionStep;
  /** Label for the run button — say what it does ("Install with Homebrew"). */
  runLabel?: string;
  /** Set to explain why the run button is unavailable (e.g. no Homebrew). The
   *  button stays visible but disabled, so the reason is discoverable. */
  runBlockedReason?: string | null;
}

/** First https URL in a line — `tailscale up` and `cloudflared tunnel login`
 *  both print one and then block until it's visited. */
const URL_RE = /https:\/\/[^\s"'<>]+/;

/**
 * Small numbered card used by the Named-tunnel / Tailscale setup flows. Shows
 * one CLI command with Copy + a "I've done it" recheck button — and, when the
 * step is one Porta can run itself, a button that runs it here and streams the
 * output, so the whole flow never leaves the app.
 */
export default function SetupCard({
  step, title, body, cmd, copied, onCopy, onRecheck, recheckLabel,
  loading = false, hint = null, runStep, runLabel = "Run this for me", runBlockedReason = null,
}: Props) {
  const isCopied = copied === cmd;
  const [status, setStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  // The auth URL a blocked step is waiting on. Keeping it as its own control
  // beats asking the user to find it in the transcript and select the text.
  const authUrl = lines.reduce<string | null>((found, l) => l.match(URL_RE)?.[0] ?? found, null);

  // Stream this step's output while it runs.
  useEffect(() => {
    if (!runStep || status !== "running" || !isTauri) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    import("@tauri-apps/api/event").then(({ listen }) =>
      listen<{ step: string; line: string }>("provision:log", (e) => {
        if (e.payload.step !== runStep) return;
        // Cap the buffer: brew's transcript can run to hundreds of lines and
        // this pane is a progress indicator, not a log viewer.
        setLines((prev) => [...prev, e.payload.line].slice(-200));
      }).then((fn) => (cancelled ? fn() : (unlisten = fn))),
    );
    return () => { cancelled = true; unlisten?.(); };
  }, [runStep, status]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [lines]);

  // Install steps go through Homebrew. Everything else (a curl|sh bootstrap, a
  // .pkg) wants an interactive sudo prompt Porta has no honest way to host, so
  // a machine without brew gets told where to get it instead of a button that
  // fails halfway through.
  const needsBrew = runStep === "install-cloudflared" || runStep === "install-tailscale";
  const [brewOk, setBrewOk] = useState<boolean | null>(null);
  useEffect(() => {
    if (!needsBrew) return;
    brewAvailable().then(setBrewOk).catch(() => setBrewOk(false));
  }, [needsBrew]);
  const blocked = runBlockedReason
    ?? (needsBrew && brewOk === false
      ? "Homebrew isn't installed, so Porta can't run this for you. Get it from brew.sh, then this button works."
      : null);

  async function run() {
    if (!runStep) return;
    setStatus("running");
    setLines([]);
    setError(null);
    try {
      await runProvisionStep(runStep);
      setStatus("done");
      // The card's own state is now stale — whatever check gates it (is the CLI
      // there? are we logged in?) has to re-run before the flow can advance.
      onRecheck();
    } catch (e) {
      setStatus("error");
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const running = status === "running";

  return (
    <div className="p-3 rounded-lg bg-accent-bg border border-[rgba(96,165,250,0.30)] flex flex-col gap-2">
      <div className="flex items-start gap-2.5">
        <span className="shrink-0 w-5 h-5 rounded-full bg-[rgba(96,165,250,0.22)] text-accent-ink text-[11px] font-semibold flex items-center justify-center">
          {step}
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-[12px] font-medium text-ink">{title}</p>
          <p className="text-[11px] text-ink-3 mt-0.5">{body}</p>
        </div>
      </div>
      <div className="relative">
        <code className="block px-2.5 py-2 pr-14 rounded-md bg-surface-code border border-subtle text-[11px] text-ink font-mono whitespace-pre-wrap break-all">
          {cmd}
        </code>
        <button
          type="button"
          onClick={() => onCopy(cmd)}
          className="absolute top-1.5 right-1.5 px-2 py-0.5 text-[10px] font-medium rounded bg-surface-2 hover:bg-white/[0.10] text-ink-2 transition-colors"
          style={{ color: isCopied ? "#a3e635" : undefined }}
        >
          {isCopied ? "Copied!" : "Copy"}
        </button>
      </div>

      {/* Live output — only while there's something to show. */}
      {runStep && lines.length > 0 && (
        <div
          ref={logRef}
          className="max-h-28 overflow-y-auto rounded-md bg-surface-code border border-subtle px-2.5 py-1.5 text-[10px] leading-relaxed text-ink-2 font-mono whitespace-pre-wrap break-all"
        >
          {lines.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      )}

      {/* The step is blocked on a browser flow — hand over the link. */}
      {running && authUrl && (
        <button
          type="button"
          onClick={() => { void openExternalUrl(authUrl); }}
          className="self-start px-3 py-1 text-[11px] font-medium rounded-md bg-accent text-white hover:brightness-110 transition"
        >
          Open sign-in page ↗
        </button>
      )}

      <div className="flex items-center gap-1.5 flex-wrap">
        {runStep && (
          <button
            type="button"
            onClick={running ? () => { void cancelProvisionStep(runStep); } : () => { void run(); }}
            disabled={!!blocked && !running}
            title={blocked ?? undefined}
            className={`flex items-center gap-1.5 px-3 py-1 text-[11px] font-medium rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
              running
                ? "bg-surface-2 text-ink-2 hover:bg-white/[0.10]"
                : "bg-accent text-white hover:brightness-110"
            }`}
          >
            {running && (
              <svg className="animate-spin" width="10" height="10" viewBox="0 0 12 12" fill="none">
                <path d="M6 1.5A4.5 4.5 0 1 1 1.5 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            )}
            {running ? "Cancel" : runLabel}
          </button>
        )}
        <button
          type="button"
          onClick={onRecheck}
          disabled={loading || running}
          className="flex items-center gap-1.5 px-3 py-1 text-[11px] font-medium rounded-md bg-[rgba(96,165,250,0.12)] hover:bg-[rgba(96,165,250,0.22)] text-accent-ink transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {loading ? (
            <svg className="animate-spin" width="10" height="10" viewBox="0 0 12 12" fill="none">
              <path d="M6 1.5A4.5 4.5 0 1 1 1.5 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          ) : (
            "↻"
          )}
          {loading ? "Checking…" : recheckLabel}
        </button>
      </div>

      {blocked && status === "idle" && (
        <p className="text-[10px] text-warn leading-snug">{blocked}</p>
      )}
      {error && <p className="text-[10px] text-bad leading-snug break-all">{error}</p>}
      {status === "done" && !error && (
        <p className="text-[10px] text-ok leading-snug">Done — rechecking…</p>
      )}
      {hint && <p className="text-[10px] text-warn leading-snug">{hint}</p>}
    </div>
  );
}
