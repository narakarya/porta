import { useEffect, useState } from "react";
import {
  getGitAutofetchEnabled,
  getGitAutofetchIntervalSecs,
  setGitAutofetchEnabled,
  setGitAutofetchIntervalSecs,
} from "../../lib/commands";

// Rust clamps this to 60..=600 on both read and write
// (src-tauri/src/commands/settings.rs) and never reports back what it
// clamped to. Any choice added here must stay inside that range, or the
// UI will highlight a value that silently disagrees with what's on disk.
const INTERVALS = [
  { secs: 60, label: "1 minute" },
  { secs: 180, label: "3 minutes" },
  { secs: 300, label: "5 minutes" },
  { secs: 600, label: "10 minutes" },
];

export default function GitSection() {
  const [enabled, setEnabled] = useState(true);
  const [intervalSecs, setIntervalSecs] = useState(180);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    getGitAutofetchEnabled()
      .then(setEnabled)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    getGitAutofetchIntervalSecs()
      .then(setIntervalSecs)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  async function toggle() {
    const prev = enabled;
    const next = !enabled;
    setEnabled(next);
    setError("");
    try {
      await setGitAutofetchEnabled(next);
    } catch (e) {
      setEnabled(prev);
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function pick(secs: number) {
    const prev = intervalSecs;
    setIntervalSecs(secs);
    setError("");
    try {
      await setGitAutofetchIntervalSecs(secs);
    } catch (e) {
      setIntervalSecs(prev);
      setError(e instanceof Error ? e.message : String(e));
    }
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

      <div className={enabled ? "" : "opacity-40"}>
        <p className="text-[12px] text-zinc-200 mb-1.5">Check every</p>
        <div className="flex gap-1.5">
          {INTERVALS.map((i) => (
            <button
              key={i.secs}
              onClick={() => pick(i.secs)}
              disabled={!enabled}
              className={`px-2.5 py-1 rounded text-[11px] transition-colors disabled:cursor-not-allowed ${
                intervalSecs === i.secs
                  ? "bg-blue-500/15 border border-blue-500/30 text-blue-300"
                  : "bg-white/[0.04] border border-white/[0.06] text-zinc-400 hover:bg-white/[0.07]"
              }`}
            >
              {i.label}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="text-[12px] text-red-400">{error}</p>}
    </div>
  );
}
