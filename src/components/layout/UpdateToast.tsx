import { useShallow } from "zustand/react/shallow";
import { usePortaStore } from "../../store";
import { dismissUpdater, restartForUpdate, startUpdateDownload, checkForUpdate } from "../../lib/updater";

/**
 * Persistent bottom-right toast that reflects the global updater phase.
 * Hidden in `idle`; visible while an update is being announced, downloaded,
 * installed, or waiting to restart. Lives in App.tsx so it's reachable
 * regardless of which page (main, settings) is foregrounded.
 */
export default function UpdateToast() {
  const { phase, info, error, source } = usePortaStore(
    useShallow((s) => ({
      phase: s.updaterPhase,
      info: s.updaterInfo,
      error: s.updaterError,
      source: s.updaterCheckSource,
    })),
  );

  if (phase === "idle") return null;
  // The transient checking / up-to-date states only belong in the toast for a
  // menu-bar check (the popover shows them when the check came from there, and
  // background checks stay silent until they actually find an update).
  if ((phase === "checking" || phase === "uptodate") && source !== "menu") return null;

  const formatBytes = (n: number) => {
    if (!n) return "0 B";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  };

  const pct = info && info.total > 0
    ? Math.min(100, Math.floor((info.downloaded / info.total) * 100))
    : 0;

  // ─── Style by phase ────────────────────────────────────────────────────
  const accent =
    phase === "ready"        ? "border-accent/30" :
    phase === "uptodate"     ? "border-ok/30" :
    phase === "error"        ? "border-bad/30" :
    phase === "restarting"   ? "border-accent/30" :
                               "border-strong";

  const dotColor =
    phase === "ready"        ? "bg-accent" :
    phase === "uptodate"     ? "bg-ok" :
    phase === "error"        ? "bg-bad" :
    phase === "checking"     ? "bg-accent pulse-dot" :
    phase === "downloading"  ? "bg-accent pulse-dot" :
    phase === "installing"   ? "bg-warn pulse-dot" :
    phase === "restarting"   ? "bg-accent pulse-dot" :
                               "bg-accent";

  // Leading glyph. A sparkle for the celebratory announce/ready states, a
  // status dot for the transient work states.
  const sparkle = (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-accent">
      <path d="M12 3l1.8 4.7L18.5 9.5 13.8 11.3 12 16l-1.8-4.7L5.5 9.5l4.7-1.8z" />
    </svg>
  );
  const dot = <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotColor}`} />;
  const leadIcon = phase === "available" || phase === "ready" ? sparkle : dot;

  // Shared button styles keyed off the design tokens.
  const primaryBtn =
    "inline-flex items-center gap-1.5 px-3 py-[5px] text-[12px] font-medium text-white bg-accent " +
    "rounded-control hover:opacity-90 transition-opacity";
  const secondaryBtn =
    "px-3 py-[5px] text-[12px] font-medium text-ink-2 border border-subtle rounded-control " +
    "hover:border-strong hover:text-ink transition-colors";

  // ─── Title + subtitle + body + actions per phase ───────────────────────
  let title = "";
  let subtitle: React.ReactNode = null;
  let body: React.ReactNode = null;
  let actions: React.ReactNode = null;

  if (phase === "checking") {
    title = "Checking for updates";
    subtitle = "Contacting the release server.";
    actions = (
      <button onClick={dismissUpdater} className={secondaryBtn}>
        Cancel
      </button>
    );
  } else if (phase === "uptodate") {
    title = "You're on the latest version";
    subtitle = "Porta is up to date.";
  } else if (phase === "available" && info) {
    title = `Porta ${info.version} available`;
    subtitle = `You're on ${info.currentVersion}.`;
    // Body may be a bullet list of commit subjects. Render the first
    // ~5 lines so the toast stays compact; the GitHub release page
    // carries the full log.
    const bullets = (info.body ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .slice(0, 5);
    if (bullets.length > 0) {
      body = (
        <div className="space-y-1 max-h-28 overflow-y-auto pr-1 text-[12px] text-ink-2 leading-relaxed">
          {bullets.map((line, i) => (
            <div key={i} className="flex gap-2">
              <span className="text-ok shrink-0">+</span>
              <span>{line.startsWith("- ") ? line.slice(2) : line}</span>
            </div>
          ))}
        </div>
      );
    }
    actions = (
      <>
        <button onClick={() => void startUpdateDownload()} className={primaryBtn}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 4v11m0 0l-4-4m4 4l4-4M5 19h14" />
          </svg>
          Download
        </button>
        <button onClick={dismissUpdater} className={secondaryBtn}>
          Later
        </button>
      </>
    );
  } else if (phase === "downloading" && info) {
    title = `Downloading ${info.version}`;
    body = (
      <>
        <div className="h-1 bg-white/[0.06] rounded-full overflow-hidden">
          <div
            className="h-full bg-accent transition-[width] duration-150"
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="text-[10px] text-ink-3 mt-1.5 font-mono">
          {info.total > 0
            ? `${formatBytes(info.downloaded)} / ${formatBytes(info.total)} · ${pct}%`
            : `${formatBytes(info.downloaded)}…`}
        </p>
      </>
    );
  } else if (phase === "installing") {
    title = "Installing…";
    subtitle = "Replacing the app bundle. Don't close Porta.";
  } else if (phase === "ready" && info) {
    title = `Porta ${info.version} is ready`;
    subtitle = `You're on ${info.currentVersion} · downloaded & verified`;
    body = (
      <p className="text-[12px] text-ink-2 leading-relaxed">
        Restart to apply the update. You can keep working — it'll launch fresh.
      </p>
    );
    actions = (
      <button onClick={() => void restartForUpdate()} className={primaryBtn}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12a9 9 0 1 1-2.64-6.36M21 4v4h-4" />
        </svg>
        Restart to update
      </button>
    );
  } else if (phase === "restarting") {
    title = "Restarting…";
    subtitle = "Hang tight.";
  } else if (phase === "error") {
    title = "Update failed";
    body = (
      <p className="text-[12px] text-bad/90 break-all leading-relaxed">
        {error || "Unknown error"}
      </p>
    );
    actions = (
      <>
        <button onClick={() => void checkForUpdate({ silent: false })} className={primaryBtn}>
          Retry
        </button>
        <button onClick={dismissUpdater} className={secondaryBtn}>
          Dismiss
        </button>
      </>
    );
  }

  // For `ready` we deliberately omit a close button — the entire affordance
  // to consume the update is that "Restart now" button. Letting users dismiss
  // would strand them on a downloaded-but-not-launched build.
  const showClose = phase === "checking" || phase === "uptodate" || phase === "available" || phase === "error";

  return (
    <div
      className={`fixed right-4 bottom-4 z-[60] w-[300px] bg-surface-2 border rounded-card shadow-2xl overflow-hidden ${accent}`}
      role="status"
      aria-live="polite"
    >
      {/* Header: leading glyph + title + close */}
      <div className="flex items-start gap-2 px-3.5 pt-3 pb-1">
        <span className="mt-px flex items-center">{leadIcon}</span>
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-medium text-ink truncate">{title}</p>
          {subtitle && <p className="text-[11px] text-ink-3 mt-0.5">{subtitle}</p>}
        </div>
        {showClose && (
          <button
            onClick={dismissUpdater}
            className="text-ink-3 hover:text-ink-2 transition-colors shrink-0 mt-0.5"
            title="Dismiss"
          >
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
              <path d="M1.5 1.5l8 8M9.5 1.5l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </div>

      {/* Body: release notes / progress / detail */}
      {body && <div className="px-3.5 pb-3 pt-1.5">{body}</div>}

      {/* Footer: actions on a raised bar, matching the popover mockup */}
      {actions && (
        <div className="flex items-center gap-2 px-3.5 py-2.5 border-t border-subtle bg-surface-1">
          {actions}
        </div>
      )}
    </div>
  );
}
