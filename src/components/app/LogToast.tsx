import { useState } from "react";
import { killPid } from "../../lib/commands";
import { stripAnsi, filterNoise as filterLog } from "../../lib/log-utils";

// Detect "held by process XXXX" pattern in log lines (Mix lock, npm lock, etc.)
const LOCK_RE = /held by process (\d+)/i;

export interface LogToastProps {
  appName: string;
  logs: string[];
  isRunning?: boolean;
  isStarting?: boolean;
  crashed?: boolean;
  stackIndex?: number;
  onExpand: () => void;
  onClose: () => void;
}

export default function LogToast({ appName, logs, isRunning, isStarting, crashed, stackIndex = 0, onExpand, onClose }: LogToastProps) {
  const [killedPid, setKilledPid] = useState<number | null>(null);
  const preview = filterLog(logs).slice(-4).map(stripAnsi);

  // Scan recent logs for a lock-holder PID
  const lockPid = (() => {
    for (let i = logs.length - 1; i >= Math.max(0, logs.length - 20); i--) {
      const m = stripAnsi(logs[i]).match(LOCK_RE);
      if (m) return parseInt(m[1], 10);
    }
    return null;
  })();

  const dotColor = crashed
    ? "bg-red-400"
    : isStarting
    ? "bg-amber-400 pulse-dot"
    : isRunning
    ? "bg-emerald-400 pulse-dot"
    : "bg-zinc-600";

  async function handleKillLock() {
    if (!lockPid) return;
    try {
      await killPid(lockPid);
      setKilledPid(lockPid);
    } catch {}
  }

  const bottomOffset = 16 + stackIndex * 152; // 152px = max toast height + 8px gap

  return (
    <div
      className={`fixed right-4 z-50 w-[320px] bg-[#1c1c1e] border rounded-xl shadow-2xl overflow-hidden transition-all ${
        crashed ? "border-red-500/20" : "border-white/[0.10]"
      }`}
      style={{ bottom: bottomOffset }}
    >
      {/* Header */}
      <div className={`flex items-center gap-2 px-3 py-2 border-b ${crashed ? "border-red-500/10" : "border-white/[0.06]"}`}>
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotColor}`} />
        <span className="text-[12px] font-medium text-zinc-200 flex-1 truncate">{appName}</span>
        <button onClick={onExpand} className="text-[11px] text-blue-400 hover:text-blue-300 transition-colors shrink-0">
          View full logs
        </button>
        <button onClick={onClose} className="ml-1 text-zinc-600 hover:text-zinc-300 transition-colors shrink-0">
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
            <path d="M1.5 1.5l8 8M9.5 1.5l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
          </svg>
        </button>
      </div>

      {/* Log preview — selectable */}
      <div className="px-3 py-2 font-mono min-h-[48px] select-text">
        {preview.length === 0 ? (
          <p className="text-[11px] text-zinc-600 select-none">Starting…</p>
        ) : (
          preview.map((line, i) => (
            <p key={i} className={`text-[11px] leading-[21px] truncate ${crashed ? "text-red-300/70" : "text-zinc-400"}`}>
              {line || "\u00A0"}
            </p>
          ))
        )}
      </div>

      {/* Lock-holder action */}
      {lockPid && (
        <div className="px-3 py-2 border-t border-white/[0.05] flex items-center gap-2">
          {killedPid === lockPid ? (
            <p className="text-[11px] text-emerald-400">Killed process {lockPid}</p>
          ) : (
            <>
              <p className="text-[11px] text-zinc-500 flex-1">Lock held by pid {lockPid}</p>
              <button
                onClick={handleKillLock}
                className="text-[11px] font-medium text-orange-400 hover:text-orange-200 bg-orange-500/10 hover:bg-orange-500/20 px-2 py-0.5 rounded transition-colors"
              >
                Kill {lockPid}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
