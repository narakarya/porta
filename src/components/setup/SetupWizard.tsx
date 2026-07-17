import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { runSetup } from "../../lib/commands";
import { usePortaStore } from "../../store";
import { detectLevel, LEVEL_CLS, stripAnsi } from "../../lib/log-utils";

type StepState = "idle" | "loading" | "done" | "error";

// Presentation state for a consolidated group row.
type RowDisplay = "done" | "loading" | "error" | "attention" | "pending";

// Underlying setup steps, in the order the backend runs them. This ordering
// still drives which single row spins during a run (see stepState).
const STEP_ORDER = [
  "caddy_installed",
  "dnsmasq_installed",
  "test_resolver_exists",
  "mkcert_installed",
  "certs_generated",
  "caddy_running",
];

// Human labels for the *active* step, surfaced above the live log.
const STEP_LABELS: Record<string, string> = {
  caddy_installed:      "Installing Caddy",
  dnsmasq_installed:    "Installing dnsmasq",
  test_resolver_exists: "Configuring .test resolver",
  mkcert_installed:     "Installing mkcert",
  certs_generated:      "Generating SSL certificates",
  caddy_running:        "Starting Caddy",
};

interface Concern {
  key: string;    // underlying setup step key
  active: string; // subtitle while this concern is running (accent)
  unmet: string;  // subtitle when this is the first unsatisfied concern (amber)
  action: string; // inline fix-button label
}

interface Group {
  key: string;
  label: string;
  readyText: string;    // subtitle when every concern is satisfied
  concerns: Concern[];  // ordered sub-concerns
}

// Three grouped rows. Each consolidates the granular steps that share a
// user-facing concern. Order of `concerns` = the order we surface unmet status.
const GROUPS: Group[] = [
  {
    key: "caddy",
    label: "Caddy proxy",
    readyText: "installed · running",
    concerns: [
      { key: "caddy_installed", active: "Installing Caddy…", unmet: "not installed yet",       action: "Install" },
      { key: "caddy_running",   active: "Starting Caddy…",   unmet: "installed · not running", action: "Start" },
    ],
  },
  {
    key: "dnsmasq",
    label: "dnsmasq (*.test)",
    readyText: "resolving to 127.0.0.1",
    concerns: [
      { key: "dnsmasq_installed",    active: "Installing dnsmasq…",         unmet: "not installed yet",       action: "Install" },
      { key: "test_resolver_exists", active: "Configuring .test resolver…", unmet: "resolver not configured", action: "Configure" },
    ],
  },
  {
    key: "cert",
    label: "Certificate trust",
    readyText: "root cert trusted",
    concerns: [
      { key: "mkcert_installed", active: "Installing mkcert…",       unmet: "root cert not trusted yet",  action: "Trust cert" },
      { key: "certs_generated",  active: "Generating certificates…", unmet: "certificates not generated", action: "Generate" },
    ],
  },
];

function RowIcon({ display }: { display: RowDisplay }) {
  if (display === "loading") return <span className="spinner text-accent shrink-0" />;
  if (display === "done") {
    return (
      <svg width="18" height="18" viewBox="0 0 16 16" fill="none" className="text-ok shrink-0">
        <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.3" opacity="0.4" />
        <path d="M5 8l2 2 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (display === "error") {
    return (
      <svg width="18" height="18" viewBox="0 0 16 16" fill="none" className="text-bad shrink-0">
        <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.3" opacity="0.4" />
        <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }
  if (display === "attention") {
    return (
      <svg width="18" height="18" viewBox="0 0 16 16" fill="none" className="text-warn shrink-0">
        <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.3" opacity="0.5" />
        <path d="M8 4.75v3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <circle cx="8" cy="11" r="0.85" fill="currentColor" />
      </svg>
    );
  }
  // pending — waiting its turn during a run
  return <span className="w-[18px] h-[18px] rounded-full border border-strong shrink-0" />;
}

function CopyButton({ text, className = "" }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <button
      onClick={copy}
      className={`text-[10px] px-1.5 py-0.5 rounded flex items-center gap-1 transition-colors ${className}`}
      title="Copy to clipboard"
    >
      {copied ? (
        <>
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
            <path d="M2.5 6.5l2.5 2.5L9.5 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Copied
        </>
      ) : (
        <>
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
            <rect x="3.5" y="3.5" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.1" />
            <path d="M2 8V2.5Q2 2 2.5 2H8" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Copy
        </>
      )}
    </button>
  );
}

interface Props {
  forceShow?: boolean;
  onClose?: () => void;
}

export default function SetupWizard({ forceShow, onClose }: Props = {}) {
  const { setupStatus, checkSetup } = usePortaStore();
  const [running, setRunning] = useState(false);
  const [activeStep, setActiveStep] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [setupStarted, setSetupStarted] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const unlisteners: Array<() => void> = [];

    listen<string>("setup:step", (e) => {
      setActiveStep(e.payload);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisteners.push(fn);
    });

    listen<string>("setup:log", (e) => {
      setLogs((prev) => [...prev, e.payload]);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisteners.push(fn);
    });

    return () => {
      cancelled = true;
      unlisteners.forEach((fn) => fn());
    };
  }, []);

  // Auto-scroll log to bottom
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  if (!setupStatus) return null;

  // caddy_running is intentionally excluded — it's runtime state, not setup state.
  // Porta handles a stopped Caddy separately (auto-start banner) so the wizard
  // doesn't pop up on every launch after a reboot.
  const allGood =
    setupStatus.caddy_installed &&
    setupStatus.dnsmasq_installed &&
    setupStatus.test_resolver_exists &&
    setupStatus.mkcert_installed &&
    setupStatus.certs_generated;

  if ((dismissed || (allGood && !setupStarted)) && !forceShow) return null;

  const okByKey: Record<string, boolean> = {
    caddy_installed:      setupStatus.caddy_installed,
    dnsmasq_installed:    setupStatus.dnsmasq_installed,
    test_resolver_exists: setupStatus.test_resolver_exists,
    mkcert_installed:     setupStatus.mkcert_installed,
    certs_generated:      setupStatus.certs_generated,
    caddy_running:        setupStatus.caddy_running,
  };
  // First step still pending — used to show *one* spinner in the brief window
  // before the backend emits its first `setup:step` event.
  const firstPendingIdx = STEP_ORDER.findIndex((k) => !okByKey[k]);

  function stepState(ok: boolean, key: string): StepState {
    if (ok) return "done";
    const activeIdx = STEP_ORDER.indexOf(activeStep ?? "");
    const keyIdx = STEP_ORDER.indexOf(key);
    // A run failed: mark only the step that was running when it broke; every
    // step that never got reached stays idle (not a misleading red X).
    if (error) return keyIdx === activeIdx ? "error" : "idle";
    if (!running) return "idle";
    // No step event yet — warm up the first pending row only.
    if (activeIdx < 0) return keyIdx === firstPendingIdx ? "loading" : "idle";
    // Exactly the active step spins; everything else waits.
    return keyIdx === activeIdx ? "loading" : "idle";
  }

  // Consolidate the granular steps into the three grouped rows. Each row's
  // display is derived purely from its underlying step states — the run
  // handlers and per-step logic below are untouched.
  const rows = GROUPS.map((group) => {
    const subs = group.concerns.map((c) => ({
      ...c,
      ok: okByKey[c.key],
      state: stepState(okByKey[c.key], c.key),
    }));
    const allOk = subs.every((s) => s.ok);
    const anyError = subs.some((s) => s.state === "error");
    const anyLoading = subs.some((s) => s.state === "loading");
    // Ready only when every sub-concern is satisfied; otherwise surface the
    // first unmet one.
    const display: RowDisplay =
      allOk      ? "done" :
      anyError   ? "error" :
      anyLoading ? "loading" :
      running    ? "pending" :
      "attention";
    const firstUnmet = subs.find((s) => !s.ok);
    const activeConcern = subs.find((s) => s.state === "loading");
    const subtitle =
      display === "done"    ? group.readyText :
      display === "loading" ? (activeConcern?.active ?? "working…") :
      (firstUnmet?.unmet ?? "");
    const subtitleCls =
      display === "done"      ? "text-ink-3" :
      display === "loading"   ? "text-accent" :
      display === "error"     ? "text-bad" :
      display === "attention" ? "text-warn" :
      "text-ink-3"; // pending
    return { group, display, subtitle, subtitleCls, allOk, firstUnmet };
  });

  async function handleRunSetup() {
    setSetupStarted(true);
    setRunning(true);
    setActiveStep(null);
    setLogs([]);
    setError(null);

    const poll = setInterval(async () => {
      try { await checkSetup(); } catch {}
    }, 1200);

    try {
      await runSetup();
      await checkSetup();
      if (forceShow && onClose) setTimeout(onClose, 1000);
    } catch (e) {
      setError(String(e));
      // Keep activeStep so stepState() can flag the row that actually failed.
    } finally {
      clearInterval(poll);
      setRunning(false);
    }
  }

  const activeStepLabel = activeStep ? STEP_LABELS[activeStep] : undefined;
  const readyRowCount = rows.filter((r) => r.allOk).length;

  return (
    <div className="fixed inset-0 bg-[rgba(13,13,15,0.95)] backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-surface-2 border border-subtle rounded-card w-[380px] shadow-2xl relative flex flex-col overflow-hidden">

        {/* Header — text only, no icon */}
        <div className="flex items-start justify-between gap-3 px-[18px] pt-5 pb-3">
          <div className="flex-1 min-w-0">
            <h1 className="text-[16px] font-medium text-ink">
              {forceShow ? "Setup & Certificates" : "Welcome to Porta"}
            </h1>
            <p className="text-[12px] text-ink-2 mt-0.5 leading-relaxed">
              {forceShow
                ? "Re-run setup to regenerate SSL certs or fix broken services."
                : "Let's get your local environment ready."
              }
            </p>
          </div>
          {forceShow && onClose && !running && (
            <button onClick={onClose} className="text-ink-3 hover:text-ink transition-colors mt-0.5 shrink-0">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </button>
          )}
        </div>

        {/* Consolidated status rows */}
        <ul className="flex flex-col px-[18px] pb-1">
          {rows.map((row, i) => {
            const isLast = i === rows.length - 1;
            return (
              <li
                key={row.group.key}
                className={`flex items-center gap-2.5 py-2.5 transition-colors ${isLast ? "" : "border-b border-subtle"}`}
              >
                <RowIcon display={row.display} />
                <div className="flex-1 min-w-0">
                  <div className={`text-[13px] ${row.display === "error" ? "text-bad" : "text-ink"}`}>
                    {row.group.label}
                  </div>
                  <div className={`text-[11px] mt-0.5 ${row.subtitleCls}`}>
                    {row.subtitle}
                  </div>
                </div>
                {row.display === "attention" && (
                  <button
                    onClick={handleRunSetup}
                    className="text-[11px] font-medium text-white bg-warn hover:brightness-110 transition-all rounded-control px-3 py-1 shrink-0"
                  >
                    {row.firstUnmet?.action ?? "Fix"}
                  </button>
                )}
                {row.display === "loading" && <span className="spinner text-accent shrink-0" />}
              </li>
            );
          })}
        </ul>

        {/* Live log */}
        {(running || logs.length > 0) && (
          <div className="flex flex-col gap-1.5 px-5 pb-3 pt-1">
            {activeStepLabel && running && (
              <p className="text-[11px] text-accent font-medium">{activeStepLabel}…</p>
            )}
            <div className="relative bg-surface-code rounded-control border border-subtle h-[120px] overflow-auto px-3 py-2 terminal-log-font select-text">
              {logs.length > 0 && (
                <CopyButton
                  text={logs.map(stripAnsi).join("\n")}
                  className="sticky top-0 float-right z-10 bg-white/[0.04] text-ink-2 hover:text-ink hover:bg-white/[0.08]"
                />
              )}
              {logs.map((line, i) => {
                const clean = stripAnsi(line);
                const level = detectLevel(clean);
                const cls = level ? LEVEL_CLS[level] : "text-ink-2";
                return (
                  <p key={i} className={`terminal-log-line text-[11px] ${cls}`}>{clean}</p>
                );
              })}
              {running && logs.length === 0 && (
                <p className="text-[11px] text-ink-3">Starting…</p>
              )}
              <div ref={logEndRef} />
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="mx-5 mb-3 px-3 py-2.5 bg-bad-bg border border-[rgba(248,113,113,0.20)] rounded-control">
            <div className="flex items-start justify-between gap-2">
              <p className="text-[12px] text-bad leading-relaxed font-mono select-text whitespace-pre-wrap break-words">{error}</p>
              <CopyButton
                text={error}
                className="shrink-0 text-[rgba(248,113,113,0.80)] hover:text-bad hover:bg-bad-bg"
              />
            </div>
          </div>
        )}

        {/* Footer bar */}
        <div className="flex items-center justify-between gap-3 px-5 py-3 border-t border-subtle bg-surface-1">
          <span className="text-[11px] text-ink-3">
            {readyRowCount} of {GROUPS.length} ready
          </span>
          {allGood && !running && !error && setupStarted ? (
            <button
              onClick={() => forceShow ? onClose?.() : setDismissed(true)}
              className="inline-flex items-center justify-center gap-2 rounded-control px-4 py-1.5 text-[12px] font-medium text-white bg-ok hover:brightness-110 transition-all"
            >
              Done
            </button>
          ) : (
            <button
              onClick={handleRunSetup}
              disabled={running}
              className="inline-flex items-center justify-center gap-2 rounded-control px-4 py-1.5 text-[12px] font-medium text-white bg-accent hover:brightness-110 transition-all disabled:opacity-60"
            >
              {running && <span className="spinner text-white/70" />}
              {running ? "Running…" : error ? "Retry" : forceShow ? "Re-run Setup" : "Run Setup"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
