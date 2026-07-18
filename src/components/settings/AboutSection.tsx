import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { getVersion } from "@tauri-apps/api/app";
import { usePortaStore } from "../../store";
import { checkForUpdate, dismissUpdater, restartForUpdate, startUpdateDownload } from "../../lib/updater";

export default function AboutSection() {
  const [version, setVersion] = useState<string>("");
  const { phase, info } = usePortaStore(
    useShallow((s) => ({ phase: s.updaterPhase, info: s.updaterInfo })),
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
        <h1 className="text-[16px] font-semibold text-zinc-100">About</h1>
        <p className="text-[12px] text-zinc-500 mt-1 leading-relaxed">
          Version and updates.
        </p>
      </div>

      <div className="flex flex-col gap-4 p-5 rounded-xl bg-white/[0.03] border border-white/[0.07]">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[13px] text-zinc-300">
              Version <span className="font-mono text-zinc-100">{version || "…"}</span>
              {phase === "ready" && info && (
                <span className="ml-2 text-emerald-400">→ {info.version} pending restart</span>
              )}
            </p>
          </div>
          <button
            onClick={handleClick}
            disabled={isWorking}
            className="px-3 py-1.5 text-[12px] font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-60 text-white rounded-lg transition-colors shrink-0"
          >
            {label}
          </button>
        </div>

        <div className="h-px bg-white/[0.05]" />

        <p className="text-[11px] text-zinc-500 leading-relaxed">
          Porta checks for updates automatically on launch. New versions are
          announced inline with download and restart controls.
        </p>
      </div>
    </div>
  );
}
