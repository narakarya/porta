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

  if (sessions.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-[13px] text-zinc-600">
        Pick a host to open a session
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-1 px-2 h-9 border-b border-white/[0.06] overflow-x-auto shrink-0">
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
      </div>
      <div className="flex-1 min-h-0 p-1">
        {sessions.map((s) => (
          <SshTerminal key={s.id} sessionId={s.id} visible={active === s.id} />
        ))}
      </div>
    </div>
  );
}
