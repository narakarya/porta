import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { checkForUpdate } from "../../lib/updater";

export default function AboutSection() {
  const [version, setVersion] = useState<string>("");
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    getVersion().then(setVersion).catch(() => {});
  }, []);

  async function handleCheck() {
    if (checking) return;
    setChecking(true);
    try {
      // silent: false → shows a dialog whether or not an update is available
      await checkForUpdate({ silent: false });
    } finally {
      setChecking(false);
    }
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
            <p className="text-[13px] font-medium text-zinc-200">Porta</p>
            <p className="text-[11px] text-zinc-500 mt-0.5">
              Version <span className="font-mono text-zinc-400">{version || "…"}</span>
            </p>
          </div>
          <button
            onClick={handleCheck}
            disabled={checking}
            className="px-3 py-1.5 text-[12px] font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-60 text-white rounded-lg transition-colors shrink-0"
          >
            {checking ? "Checking…" : "Check for updates"}
          </button>
        </div>

        <div className="h-px bg-white/[0.05]" />

        <p className="text-[11px] text-zinc-500 leading-relaxed">
          Porta checks for updates automatically on launch. When a new version is
          published, it'll prompt you to download and restart.
        </p>
      </div>
    </div>
  );
}
