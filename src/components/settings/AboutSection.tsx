import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { getVersion } from "@tauri-apps/api/app";
import { usePortaStore } from "../../store";
import { checkForUpdate, dismissUpdater, restartForUpdate, startUpdateDownload } from "../../lib/updater";

export default function AboutSection() {
  const [version, setVersion] = useState<string>("");
  const { phase, info, betaUpdates, setBetaUpdates } = usePortaStore(
    useShallow((s) => ({
      phase: s.updaterPhase,
      info: s.updaterInfo,
      betaUpdates: s.betaUpdates,
      setBetaUpdates: s.setBetaUpdates,
    })),
  );

  useEffect(() => {
    getVersion().then(setVersion).catch(() => {});
  }, []);

  // Button behaviour is phase-driven so it stays in sync with the global
  // toast and with any auto-check still in flight. Without this, clicking
  // the button mid-download spawned a second `check()` and the user got
  // either a duplicate prompt or a re-download from zero.
  const isWorking =
    phase === "downloading" ||
    phase === "installing" ||
    phase === "restarting";

  const label = (() => {
    switch (phase) {
      case "checking":    return "Cancel check";
      case "available":   return "Download update";
      case "downloading": return "Downloading…";
      case "installing":  return "Installing…";
      case "ready":       return "Restart to apply";
      case "restarting":  return "Restarting…";
      default:            return "Check for updates";
    }
  })();

  async function handleClick() {
    if (phase === "checking")  return void dismissUpdater();
    if (phase === "available") return void startUpdateDownload();
    if (phase === "ready")     return void restartForUpdate();
    if (isWorking)             return; // already in flight, the toast covers UI
    await checkForUpdate({ silent: false });
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-[16px] font-semibold text-ink">About</h1>
        <p className="text-[12px] text-ink-3 mt-1 leading-relaxed">
          Version and updates.
        </p>
      </div>

      <div className="flex flex-col gap-4 p-5 rounded-card bg-surface-1 border border-subtle">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[13px] font-medium text-ink">Porta</p>
            <p className="text-[11px] text-ink-3 mt-0.5">
              Version <span className="font-mono text-ink-2">{version || "…"}</span>
              {phase === "ready" && info && (
                <span className="ml-2 text-ok">→ {info.version} pending restart</span>
              )}
            </p>
          </div>
          <button
            onClick={handleClick}
            disabled={isWorking}
            className="px-3 py-1.5 text-[12px] font-medium bg-accent hover:opacity-90 disabled:opacity-60 text-white rounded-control transition-colors shrink-0"
          >
            {label}
          </button>
        </div>

        <div className="h-px bg-white/[0.05]" />

        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[13px] font-medium text-ink">Beta updates</p>
            <p className="text-[12px] text-ink-3 mt-0.5 leading-relaxed">
              Receive pre-release (beta) builds. Betas may be unstable.
            </p>
          </div>
          <button
            onClick={() => setBetaUpdates(!betaUpdates)}
            className={`relative w-9 h-5 rounded-full transition-colors shrink-0 mt-0.5 ${
              betaUpdates ? "bg-accent" : "bg-white/[0.14]"
            }`}
            role="switch"
            aria-checked={betaUpdates}
            aria-label="Toggle beta updates"
          >
            <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all ${
              betaUpdates ? "left-[18px]" : "left-0.5"
            }`} />
          </button>
        </div>

        <div className="h-px bg-white/[0.05]" />

        <p className="text-[11px] text-ink-3 leading-relaxed">
          Porta checks for updates automatically on launch. New versions are
          announced inline with download and restart controls.
        </p>
      </div>
    </div>
  );
}
