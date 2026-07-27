import { useState } from "react";
import { killPid, killPortHolder } from "../../lib/commands";
import { stripAnsi, filterNoise as filterLog } from "../../lib/log-utils";
import { detectBlocker } from "../../lib/log-blockers";
import { Spinner } from "../ui";

/** Porta stamps un-stamped output with `HH:MM:SS.mmm ` — the full viewer gives
 *  that its own column, but in a 320px toast it would eat half the width. */
const LEAD_TS_RE = /^\d{1,2}:\d{2}:\d{2}(?:\.\d{1,6})?\s+/;

export interface LogToastProps {
  appName: string;
  logs: string[];
  /** The port this app is configured on — the fallback target when the log says
   *  "address already in use" without naming which address. */
  appPort?: number;
  isRunning?: boolean;
  isStarting?: boolean;
  crashed?: boolean;
  stackIndex?: number;
  onExpand: () => void;
  onClose: () => void;
}

export default function LogToast({ appName, logs, appPort, isRunning, isStarting, crashed, stackIndex = 0, onExpand, onClose }: LogToastProps) {
  const [killed, setKilled] = useState<string | null>(null);
  const [killing, setKilling] = useState(false);
  const [killError, setKillError] = useState<string | null>(null);
  const preview = filterLog(logs).slice(-4).map((l) => stripAnsi(l).replace(LEAD_TS_RE, ""));

  // What's in the way, if anything: a PID sitting on a lock, or a port that's
  // already bound. Both are one click from fixed, which is the entire point of
  // showing it here instead of making the user open the log and read.
  const blocker = detectBlocker(logs);
  const targetPort = blocker?.kind === "port" ? (blocker.port ?? appPort ?? null) : null;
  const canKill = blocker?.kind === "pid" || targetPort !== null;

  const dotColor = crashed
    ? "bg-red-400"
    : isStarting
    ? "bg-amber-400 pulse-dot"
    : isRunning
    ? "bg-emerald-400 pulse-dot"
    : "bg-zinc-600";

  async function handleKill() {
    if (!blocker || killing) return;
    setKilling(true);
    setKillError(null);
    try {
      if (blocker.kind === "pid") {
        await killPid(blocker.pid);
        setKilled(`Killed process ${blocker.pid}`);
      } else if (targetPort !== null) {
        const pid = await killPortHolder(targetPort);
        setKilled(`Freed :${targetPort} (killed pid ${pid})`);
      }
    } catch (e) {
      setKillError(e instanceof Error ? e.message : String(e));
    } finally {
      setKilling(false);
    }
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

      {/* Blocker action — a PID on a lock, or a bound port. */}
      {blocker && canKill && (
        <div className="px-3 py-2 border-t border-white/[0.05] flex items-center gap-2">
          {killed ? (
            <p className="text-[11px] text-emerald-400">{killed} — start it again</p>
          ) : (
            <>
              <p className="text-[11px] text-zinc-500 flex-1 truncate" title={killError ?? blocker.label}>
                {killError ?? (blocker.kind === "port" && blocker.port === null && targetPort !== null
                  ? `Port :${targetPort} is already in use`
                  : blocker.label)}
              </p>
              <button
                onClick={handleKill}
                disabled={killing}
                className="shrink-0 inline-flex items-center gap-1 text-[11px] font-medium text-orange-400 hover:text-orange-200 bg-orange-500/10 hover:bg-orange-500/20 disabled:opacity-50 px-2 py-0.5 rounded transition-colors"
              >
                {killing && <Spinner size={10} />}
                {blocker.kind === "pid" ? `Kill ${blocker.pid}` : `Free :${targetPort}`}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
