import { useAppConfig } from "../AppConfigContext";

/** A failed Connect, shown *instead of* the status strip (mockup 32) — there is
 *  nothing running to report, and stacking the failure under a "not published"
 *  strip would just be two boxes saying the same thing.
 *
 *  Settings unfolds itself when this appears (see AppConfigContext): the fix is
 *  nearly always a field in there. */
export default function TunnelErrorBox() {
  const c = useAppConfig();
  if (!c.tunnelError) return null;

  return (
    <div className="flex flex-col gap-2">
      <div className="relative px-3 py-2 pr-14 rounded-lg bg-bad-bg border border-[var(--danger-border)] text-[11px] text-bad font-mono whitespace-pre-wrap break-words">
        {c.tunnelError}
        <button
          type="button"
          onClick={() => {
            navigator.clipboard.writeText(c.tunnelError!).then(() => {
              c.setTunnelErrorCopied(true);
              setTimeout(() => c.setTunnelErrorCopied(false), 1500);
            });
          }}
          className={`absolute top-1.5 right-1.5 px-2 py-0.5 text-[10px] font-sans font-medium rounded transition-colors ${
            c.tunnelErrorCopied
              ? "bg-ok-bg text-ok"
              : "bg-[var(--danger-border)] hover:bg-[rgba(248,113,113,0.32)] text-bad"
          }`}
        >
          {c.tunnelErrorCopied ? "Copied!" : "Copy"}
        </button>
      </div>
      <p className="text-[11px] text-ink-3">
        Nothing is published right now — {" "}
        <span className="font-mono text-ink-2">localhost:{c.app.port}</span> stays local.
      </p>
    </div>
  );
}
