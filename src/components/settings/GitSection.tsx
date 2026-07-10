import { useEffect, useState } from "react";
import {
  getGitAutofetchEnabled,
  getGitAutofetchIntervalSecs,
  setGitAutofetchEnabled,
  setGitAutofetchIntervalSecs,
} from "../../lib/commands";

const INTERVALS = [
  { secs: 60, label: "1 minute" },
  { secs: 180, label: "3 minutes" },
  { secs: 300, label: "5 minutes" },
  { secs: 600, label: "10 minutes" },
];

export default function GitSection() {
  const [enabled, setEnabled] = useState(true);
  const [interval, setInterval] = useState(180);

  useEffect(() => {
    getGitAutofetchEnabled().then(setEnabled).catch(() => {});
    getGitAutofetchIntervalSecs().then(setInterval).catch(() => {});
  }, []);

  async function toggle() {
    const next = !enabled;
    setEnabled(next);
    await setGitAutofetchEnabled(next);
  }

  async function pick(secs: number) {
    setInterval(secs);
    await setGitAutofetchIntervalSecs(secs);
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-[13px] font-semibold text-zinc-100">Git</h2>
        <p className="text-[11px] text-zinc-600 mt-0.5">
          App cards show the current branch and how many commits are waiting to
          be pushed or pulled.
        </p>
      </div>

      <label className="flex items-start gap-2.5 cursor-pointer">
        <input
          type="checkbox"
          checked={enabled}
          onChange={toggle}
          className="mt-0.5 accent-blue-500"
        />
        <span>
          <span className="text-[12px] text-zinc-200">Fetch from remotes in the background</span>
          <span className="block text-[11px] text-zinc-600 mt-0.5">
            Git can only tell you how far behind you are by asking the remote.
            Without this, the ↓ count stays at zero until you fetch yourself.
            Porta never touches your working tree — it only runs{" "}
            <span className="font-mono">git fetch</span>.
          </span>
        </span>
      </label>

      <div className={enabled ? "" : "opacity-40 pointer-events-none"}>
        <p className="text-[12px] text-zinc-200 mb-1.5">Check every</p>
        <div className="flex gap-1.5">
          {INTERVALS.map((i) => (
            <button
              key={i.secs}
              onClick={() => pick(i.secs)}
              className={`px-2.5 py-1 rounded text-[11px] transition-colors ${
                interval === i.secs
                  ? "bg-blue-500/15 border border-blue-500/30 text-blue-300"
                  : "bg-white/[0.04] border border-white/[0.06] text-zinc-400 hover:bg-white/[0.07]"
              }`}
            >
              {i.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
