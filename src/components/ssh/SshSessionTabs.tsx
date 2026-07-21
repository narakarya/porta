import { usePortaStore } from "../../store";
import type { SshSession } from "../../store/slices/ssh";
import SshTerminal from "./SshTerminal";

const STATUS_DOT: Record<SshSession["status"], string> = {
  connected: "bg-emerald-400",
  error: "bg-red-400",
  connecting: "bg-amber-400",
  disconnected: "bg-zinc-600",
};

export default function SshSessionTabs() {
  const sessions = usePortaStore((s) => s.sshSessions);
  const active = usePortaStore((s) => s.activeSessionId);
  const setActive = usePortaStore((s) => s.setActiveSession);
  const disconnect = usePortaStore((s) => s.disconnectSsh);
  const connectSsh = usePortaStore((s) => s.connectSsh);

  const activeHostId = sessions.find((s) => s.id === active)?.hostId;

  if (sessions.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-[13px] text-zinc-600">
        Pick a host to open a session
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-1 px-2 h-9 border-b border-subtle overflow-x-auto shrink-0">
        {sessions.map((s) => (
          <div
            key={s.id}
            className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] cursor-pointer ${
              active === s.id ? "bg-white/[0.08] text-zinc-100" : "text-zinc-400 hover:bg-white/[0.04]"
            }`}
            onClick={() => setActive(s.id)}
          >
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT[s.status]}`} />
            <span className="truncate max-w-[120px]">{s.label}</span>
            <button
              className="text-zinc-600 hover:text-red-400"
              onClick={(e) => {
                e.stopPropagation();
                disconnect(s.id);
              }}
            >
              ✕
            </button>
          </div>
        ))}
        {activeHostId && (
          <button
            className="shrink-0 flex items-center justify-center w-6 h-6 rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.04] text-[14px] leading-none transition-colors"
            onClick={() => connectSsh(activeHostId)}
            title="New session"
          >
            ＋
          </button>
        )}
      </div>
      <div className="flex-1 min-h-0 p-1">
        {sessions.map((s) =>
          // A failed connect never writes a byte to the PTY, so rendering the
          // terminal for it showed a blank black pane next to a red dot and no
          // way to learn why. Show the backend's reason + a retry instead.
          s.status === "error" ? (
            <div key={s.id} className="h-full flex items-center justify-center p-6" style={{ display: active === s.id ? "flex" : "none" }}>
              <div className="max-w-md w-full rounded-lg border border-red-500/20 bg-red-500/[0.06] px-4 py-3.5">
                <div className="flex items-center gap-2 mb-1.5">
                  <svg width="12" height="12" viewBox="0 0 11 11" fill="none" className="text-red-400 shrink-0">
                    <path d="M5.5 1.5l4 7H1.5l4-7z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
                    <path d="M5.5 5v1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                    <circle cx="5.5" cy="8" r="0.5" fill="currentColor" />
                  </svg>
                  <span className="text-[12px] font-medium text-red-300">Couldn't connect to {s.label}</span>
                </div>
                <p className="text-[11px] text-red-400/80 font-mono break-words select-text">
                  {s.error ?? "Connection failed"}
                </p>
                <div className="flex gap-2 mt-3">
                  <button
                    onClick={() => connectSsh(s.hostId)}
                    className="px-2.5 py-1 text-[11px] font-medium text-zinc-200 bg-white/[0.07] hover:bg-white/[0.12] rounded-md transition-colors"
                  >
                    Retry
                  </button>
                  <button
                    onClick={() => disconnect(s.id)}
                    className="px-2.5 py-1 text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors"
                  >
                    Close
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <SshTerminal key={s.id} sessionId={s.id} visible={active === s.id} />
          )
        )}
      </div>
    </div>
  );
}
