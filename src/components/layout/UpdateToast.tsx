import { useShallow } from "zustand/react/shallow";
import { usePortaStore } from "../../store";
import { dismissUpdater, restartForUpdate, startUpdateDownload, checkForUpdate } from "../../lib/updater";

// No dedicated release-URL helper exists yet, so we link straight to the
// tagged GitHub release (release tags follow the `v{version}` convention).
const RELEASES_BASE = "https://github.com/narakarya/porta/releases";

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

  // ─── Leading glyphs ────────────────────────────────────────────────────
  const dotColor =
    phase === "ready"        ? "bg-accent" :
    phase === "uptodate"     ? "bg-ok" :
    phase === "error"        ? "bg-bad" :
    phase === "checking"     ? "bg-accent pulse-dot" :
    phase === "downloading"  ? "bg-accent pulse-dot" :
    phase === "installing"   ? "bg-warn pulse-dot" :
    phase === "restarting"   ? "bg-accent pulse-dot" :
                               "bg-accent";
  const dot = <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotColor}`} />;

  // Celebratory sparkle for the downloaded-and-ready state.
  const sparkle = (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-accent">
      <path d="M12 3l1.8 4.7L18.5 9.5 13.8 11.3 12 16l-1.8-4.7L5.5 9.5l4.7-1.8z" />
    </svg>
  );

  // Up-arrow-in-circle marks an available (announced, not-yet-downloaded) update.
  // Accent-toned to match the neutral self-update popover in the mockups — the
  // warning tint belonged to the (separate) Docker image-update card.
  const upArrow = (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-accent">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 15.5v-7m0 0l-3 3m3-3l3 3" />
    </svg>
  );

  const leadIcon =
    phase === "available" ? upArrow :
    phase === "ready"     ? sparkle :
                            dot;

  // Shared button styles keyed off the design tokens.
  const primaryBtn =
    "inline-flex items-center gap-[5px] px-[13px] py-[5px] text-[12px] font-normal text-white bg-accent " +
    "rounded-control hover:opacity-90 transition-opacity";
  const secondaryBtn =
    "px-3 py-[5px] text-[12px] font-normal text-ink-2 border border-subtle rounded-control " +
    "hover:border-strong hover:text-ink transition-colors";

  // Release notes: `updaterInfo.body` is a newline-separated changelog. Render
  // each non-empty line as a green "+" bullet, then a link to the full notes.
  // Shared by the `available` and `ready` states.
  const releaseNotes = (version: string, bodyText: string | null) => {
    const lines = (bodyText ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l) => (l.startsWith("- ") ? l.slice(2) : l));
    return (
      <div className="text-[12px] text-ink-2 leading-[1.65]">
        {lines.length > 0 && (
          <div className="max-h-28 overflow-y-auto pr-1">
            {lines.map((line, i) => (
              <div key={i} className="flex gap-[7px]">
                <span className="text-[#4ade80] shrink-0">+</span>
                <span>{line}</span>
              </div>
            ))}
          </div>
        )}
        <a
          href={`${RELEASES_BASE}/tag/v${version}`}
          target="_blank"
          rel="noreferrer"
          className="inline-block mt-1 text-[11px] text-accent hover:underline"
        >
          Full release notes
        </a>
      </div>
    );
  };

  // Simple title + optional subtitle used by the transient work states.
  // The leading glyph sits inline with the title only; the subline drops to
  // the card's left padding (mockup 15) rather than indenting under the icon.
  const titleBlock = (t: string, s?: React.ReactNode) => (
    <>
      <div className="flex items-center gap-2">
        <span className="flex items-center">{leadIcon}</span>
        <p className="text-[13px] font-medium text-ink">{t}</p>
      </div>
      {s && <p className="text-[11px] text-ink-3 mt-0.5">{s}</p>}
    </>
  );

  // ─── Header + body + actions per phase ─────────────────────────────────
  let headerNode: React.ReactNode = null;
  let body: React.ReactNode = null;
  let actions: React.ReactNode = null;

  if (phase === "checking") {
    headerNode = titleBlock("Checking for updates", "Contacting the release server.");
    actions = (
      <button onClick={dismissUpdater} className={secondaryBtn}>
        Cancel
      </button>
    );
  } else if (phase === "uptodate") {
    headerNode = titleBlock("You're on the latest version", "Porta is up to date.");
  } else if (phase === "available" && info) {
    // Neutral popover header (matches the ready state) — "Porta X available"
    // + current-version subline. No warning tint.
    headerNode = (
      <>
        <div className="flex items-center gap-2">
          <span className="flex items-center">{leadIcon}</span>
          <p className="text-[13px] font-medium text-ink">Porta {info.version} available</p>
        </div>
        <p className="text-[11px] text-ink-3 mt-0.5">You're on {info.currentVersion}</p>
      </>
    );
    body = releaseNotes(info.version, info.body);
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
    headerNode = titleBlock(`Downloading ${info.version}`);
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
    headerNode = titleBlock("Installing…", "Replacing the app bundle. Don't close Porta.");
  } else if (phase === "ready" && info) {
    headerNode = titleBlock(
      `Porta ${info.version} is ready`,
      `You're on ${info.currentVersion} · downloaded & verified`,
    );
    body = releaseNotes(info.version, info.body);
    actions = (
      <>
        <button onClick={() => void restartForUpdate()} className={primaryBtn}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12a9 9 0 1 1-2.64-6.36M21 4v4h-4" />
          </svg>
          Restart to update
        </button>
        <button onClick={dismissUpdater} className={secondaryBtn}>
          Later
        </button>
      </>
    );
  } else if (phase === "restarting") {
    headerNode = titleBlock("Restarting…", "Hang tight.");
  } else if (phase === "error") {
    headerNode = titleBlock("Update failed");
    body = (
      <p className="text-[12px] text-[rgba(248,113,113,0.9)] break-all leading-relaxed">
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

  // No header X — dismissal always lives in the footer (Cancel / Later /
  // Dismiss), matching the clean self-update popover (mockup 15). Transient
  // states without a footer (uptodate) self-dismiss.
  // One neutral popover skin for every phase — surface-popover (#202024),
  // hairline strong border, 12px radius, deep drop shadow. Matches the
  // self-update popover in the mockups; state is conveyed by the leading glyph
  // and copy, not by tinting the whole card.
  const skin =
    "bg-[#202024] border border-strong rounded-[12px] shadow-[0_12px_40px_rgba(0,0,0,0.55)]";

  // Anchored to the rail's account avatar (bottom-left), reading as a popover
  // emanating from the rail rather than a detached bottom-right toast (mockup
  // 15). The rail is 54px wide, so we sit just past it and let a small caret
  // point back toward the avatar.
  return (
    <div
      className="fixed left-[60px] bottom-[14px] z-[60]"
      role="status"
      aria-live="polite"
    >
      {/* Connecting caret — a rotated square whose left/bottom edges face the
          rail, so the card reads as anchored to the account button. */}
      <span
        aria-hidden="true"
        className="absolute left-[-5px] bottom-[16px] w-[10px] h-[10px] rotate-45 bg-[#202024] border-l border-b border-strong"
      />

      <div className={`relative w-[280px] overflow-hidden ${skin}`}>
        {/* Header: leading glyph inline with title, subline at the card's left
            edge (px 14, pt 12, pb 10 per mockup 15) */}
        <div className="px-3.5 pt-3 pb-2.5">{headerNode}</div>

        {/* Body: release notes / progress / detail */}
        {body && <div className="px-3.5 pb-2.5 pt-0">{body}</div>}

        {/* Footer: actions on a raised bar (surface-1), matching the popover mockup */}
        {actions && (
          <div className="flex items-center gap-2 px-3.5 py-2.5 border-t border-subtle bg-surface-1">
            {actions}
          </div>
        )}
      </div>
    </div>
  );
}
