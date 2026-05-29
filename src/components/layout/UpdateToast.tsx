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
  const { phase, info, error } = usePortaStore(
    useShallow((s) => ({
      phase: s.updaterPhase,
      info: s.updaterInfo,
      error: s.updaterError,
    })),
  );

  if (phase === "idle") return null;
  if (phase === "checking") return null; // brief, no need to flash a toast

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
    phase === "ready"        ? "border-emerald-500/30" :
    phase === "error"        ? "border-red-500/30" :
    phase === "restarting"   ? "border-blue-500/30" :
                               "border-white/[0.10]";

  const dotColor =
    phase === "ready"        ? "bg-emerald-400" :
    phase === "error"        ? "bg-red-400" :
    phase === "downloading"  ? "bg-blue-400 pulse-dot" :
    phase === "installing"   ? "bg-amber-400 pulse-dot" :
    phase === "restarting"   ? "bg-blue-400 pulse-dot" :
                               "bg-blue-400";

  // ─── Title + actions per phase ─────────────────────────────────────────
  let title = "";
  let detail: React.ReactNode = null;
  let actions: React.ReactNode = null;

  if (phase === "available" && info) {
    title = `Porta ${info.version} available`;
    detail = (
      <p className="text-[11px] text-zinc-500 mt-1">
        You're on {info.currentVersion}. {info.body ? info.body.split("\n")[0].slice(0, 90) : ""}
      </p>
    );
    actions = (
      <>
        <button
          onClick={() => void startUpdateDownload()}
          className="px-2.5 py-1 text-[11px] font-medium text-blue-400 bg-blue-500/10 hover:bg-blue-500/20 rounded-md transition-colors"
        >
          Download
        </button>
        <button
          onClick={dismissUpdater}
          className="px-2.5 py-1 text-[11px] font-medium text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.06] rounded-md transition-colors"
        >
          Later
        </button>
      </>
    );
  } else if (phase === "downloading" && info) {
    title = `Downloading ${info.version}`;
    detail = (
      <>
        <div className="mt-1.5 h-1 bg-white/[0.05] rounded-full overflow-hidden">
          <div
            className="h-full bg-blue-400 transition-[width] duration-150"
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="text-[10px] text-zinc-500 mt-1 font-mono">
          {info.total > 0
            ? `${formatBytes(info.downloaded)} / ${formatBytes(info.total)} · ${pct}%`
            : `${formatBytes(info.downloaded)}…`}
        </p>
      </>
    );
  } else if (phase === "installing") {
    title = "Installing…";
    detail = (
      <p className="text-[11px] text-zinc-500 mt-1">
        Replacing the app bundle. Don't close Porta.
      </p>
    );
  } else if (phase === "ready" && info) {
    title = `Porta ${info.version} is ready`;
    detail = (
      <p className="text-[11px] text-zinc-500 mt-1">
        Restart to apply the update. You can keep working — it'll launch fresh.
      </p>
    );
    actions = (
      <button
        onClick={() => void restartForUpdate()}
        className="px-2.5 py-1 text-[11px] font-medium text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20 rounded-md transition-colors"
      >
        Restart now
      </button>
    );
  } else if (phase === "restarting") {
    title = "Restarting…";
    detail = (
      <p className="text-[11px] text-zinc-500 mt-1">Hang tight.</p>
    );
  } else if (phase === "error") {
    title = "Update failed";
    detail = (
      <p className="text-[11px] text-red-300/80 mt-1 break-all">
        {error || "Unknown error"}
      </p>
    );
    actions = (
      <>
        <button
          onClick={() => void checkForUpdate({ silent: false })}
          className="px-2.5 py-1 text-[11px] font-medium text-blue-400 bg-blue-500/10 hover:bg-blue-500/20 rounded-md transition-colors"
        >
          Retry
        </button>
        <button
          onClick={dismissUpdater}
          className="px-2.5 py-1 text-[11px] font-medium text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.06] rounded-md transition-colors"
        >
          Dismiss
        </button>
      </>
    );
  }

  // For `ready` we deliberately omit a close button — the entire affordance
  // to consume the update is that "Restart now" button. Letting users dismiss
  // would strand them on a downloaded-but-not-launched build.
  const showClose = phase === "available" || phase === "error";

  return (
    <div
      className={`fixed right-4 bottom-4 z-[60] w-[320px] bg-[#1c1c1e] border rounded-xl shadow-2xl overflow-hidden ${accent}`}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b border-white/[0.05]">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotColor}`} />
        <span className="text-[12px] font-medium text-zinc-200 flex-1 truncate">{title}</span>
        {showClose && (
          <button
            onClick={dismissUpdater}
            className="text-zinc-600 hover:text-zinc-300 transition-colors shrink-0"
            title="Dismiss"
          >
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
              <path d="M1.5 1.5l8 8M9.5 1.5l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
            </svg>
          </button>
        )}
      </div>

      <div className="px-3 py-2">
        {detail}
        {actions && <div className="flex items-center gap-2 mt-2">{actions}</div>}
      </div>
    </div>
  );
}
