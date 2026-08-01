import { useState } from "react";
import { usePortaStore } from "../../store";
import type { SshSession } from "../../store/slices/ssh";
import SshTerminal from "./SshTerminal";
import SshConnectingOverlay from "./SshConnectingOverlay";
import SnippetBar from "./SnippetBar";
import SftpBrowser from "./SftpBrowser";

const STATUS_DOT: Record<SshSession["status"], string> = {
  connected: "bg-ok",
  error: "bg-bad",
  connecting: "bg-warn",
  disconnected: "bg-ink-3",
};

export default function SshSessionTabs() {
  const sessions = usePortaStore((s) => s.sshSessions);
  const active = usePortaStore((s) => s.activeSessionId);
  const setActive = usePortaStore((s) => s.setActiveSession);
  const disconnect = usePortaStore((s) => s.disconnectSsh);
  const connectSsh = usePortaStore((s) => s.connectSsh);
  const retrySsh = usePortaStore((s) => s.retrySsh);

  const activeSession = sessions.find((s) => s.id === active);
  const activeHostId = activeSession?.hostId;
  const [view, setView] = useState<"terminal" | "files">("terminal");

  if (sessions.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-[13px] text-ink-3">
        Pick a host to open a session
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center h-9 border-b border-subtle shrink-0">
        <div className="flex-1 min-w-0 h-full flex items-center gap-1 px-2 overflow-x-auto">
        {sessions.map((s) => (
          <div
            key={s.id}
            className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] cursor-pointer ${
              active === s.id ? "bg-white/[0.08] text-ink" : "text-ink-2 hover:bg-white/[0.04]"
            }`}
            onClick={() => setActive(s.id)}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT[s.status]} ${
                s.status === "connecting" ? "animate-pulse" : ""
              }`}
            />
            <span className="truncate max-w-[120px]">{s.label}</span>
            <button
              className="text-ink-3 hover:text-bad"
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
            className="shrink-0 flex items-center justify-center w-6 h-6 rounded-md text-ink-3 hover:text-ink hover:bg-white/[0.04] text-[14px] leading-none transition-colors"
            onClick={() => connectSsh(activeHostId)}
            title="New session"
          >
            ＋
          </button>
        )}
        </div>
        {/* Outside the scrolling strip on purpose: `overflow-x-auto` clips an
            absolutely-positioned popover, so the picker rendered off-screen
            when it lived among the tabs. */}
        {activeHostId && (
          <div className="shrink-0 flex items-center gap-px p-0.5 rounded-md bg-white/[0.04]">
            {(["terminal", "files"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`px-2 py-0.5 text-[11px] rounded transition-colors ${
                  view === v ? "bg-white/[0.10] text-ink" : "text-ink-3 hover:text-ink-2"
                }`}
              >
                {v === "terminal" ? "Terminal" : "Files"}
              </button>
            ))}
          </div>
        )}
        <div className="shrink-0 px-2">
          <SnippetBar
            hostId={activeHostId ?? null}
            sessionReady={activeSession?.status === "connected"}
          />
        </div>
      </div>
      <div className="flex-1 min-h-0 p-1">
        {sessions.map((s) =>
          // A failed connect never writes a byte to the PTY, so rendering the
          // terminal for it showed a blank black pane next to a red dot and no
          // way to learn why. Show the backend's reason + a retry instead.
          s.status === "error" ? (
            <div key={s.id} className="h-full flex items-center justify-center p-6" style={{ display: active === s.id ? "flex" : "none" }}>
              <div className="max-w-md w-full rounded-lg border border-[var(--danger-border)] bg-red-500/[0.06] px-4 py-3.5">
                <div className="flex items-center gap-2 mb-1.5">
                  <svg width="12" height="12" viewBox="0 0 11 11" fill="none" className="text-bad shrink-0">
                    <path d="M5.5 1.5l4 7H1.5l4-7z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
                    <path d="M5.5 5v1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                    <circle cx="5.5" cy="8" r="0.5" fill="currentColor" />
                  </svg>
                  <span className="text-[12px] font-medium text-bad">Couldn't connect to {s.label}</span>
                </div>
                <p className="text-[11px] text-red-400/80 font-mono break-words select-text">
                  {s.error ?? "Connection failed"}
                </p>
                <div className="flex gap-2 mt-3">
                  <button
                    onClick={() => retrySsh(s.id)}
                    className="px-2.5 py-1 text-[11px] font-medium text-ink bg-white/[0.07] hover:bg-white/[0.12] rounded-md transition-colors"
                  >
                    Retry
                  </button>
                  <button
                    onClick={() => disconnect(s.id)}
                    className="px-2.5 py-1 text-[11px] text-ink-3 hover:text-ink-2 transition-colors"
                  >
                    Close
                  </button>
                </div>
              </div>
            </div>
          ) : (
            // The terminal stays mounted through the handshake so its data
            // listener is registered before the shell's first byte arrives —
            // the connect UI is layered over it, not swapped in for it.
            <div
              key={s.id}
              className="relative h-full w-full"
              style={{ display: active === s.id ? "block" : "none" }}
            >
              <div
                className="h-full w-full"
                style={{ display: view === "terminal" ? "block" : "none" }}
              >
                <SshTerminal sessionId={s.id} visible={active === s.id && view === "terminal"} />
              </div>
              {/* Sibling, not a replacement: unmounting the terminal would drop
                  the data listener registered on its mount, and the session's
                  output would vanish while the user was in Files. */}
              {view === "files" && s.status === "connected" && (
                <div className="absolute inset-0 bg-surface-0">
                  <SftpBrowser sessionId={s.id} active={active === s.id} />
                </div>
              )}
              {s.status === "connecting" && (
                <div className="absolute inset-0 z-10">
                  <SshConnectingOverlay session={s} />
                </div>
              )}
            </div>
          )
        )}
      </div>
    </div>
  );
}
