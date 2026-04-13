import { useState } from "react";
import type { App } from "../../types";
import TerminalTab from "./TerminalTab";

interface TabSession {
  id: string;
  appId: string;
  appName: string;
  rootDir: string;
}

interface Props {
  initialApp: App;
  isOpen: boolean;
  onClose: () => void;
}

let _sessionCounter = 0;
function newSessionId() {
  return `terminal-session-${Date.now()}-${++_sessionCounter}`;
}

export default function TerminalModal({ initialApp, isOpen, onClose }: Props) {
  const [sessions, setSessions] = useState<TabSession[]>([
    {
      id: newSessionId(),
      appId: initialApp.id,
      appName: initialApp.name,
      rootDir: initialApp.root_dir,
    },
  ]);
  const [activeId, setActiveId] = useState<string>(sessions[0].id);

  function addNewTab() {
    // Open another shell for the same app as the currently active tab
    const current = sessions.find((s) => s.id === activeId) ?? sessions[0];
    const session: TabSession = {
      id: newSessionId(),
      appId: current.appId,
      appName: current.appName,
      rootDir: current.rootDir,
    };
    setSessions((prev) => [...prev, session]);
    setActiveId(session.id);
  }

  function closeTab(sessionId: string, e: React.MouseEvent) {
    e.stopPropagation();
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== sessionId);
      if (next.length === 0) {
        // Close the modal when last tab is closed
        onClose();
        return prev;
      }
      // If the closed tab was active, switch to the previous (or first) tab
      if (activeId === sessionId) {
        const idx = prev.findIndex((s) => s.id === sessionId);
        const nextActive = next[Math.max(0, idx - 1)];
        setActiveId(nextActive.id);
      }
      return next;
    });
  }

  return (
    <div className="fixed inset-0 z-50 bg-[#111113] flex flex-col" style={{ display: isOpen ? undefined : "none" }}>

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 px-5 py-3 border-b border-white/[0.08] shrink-0">
        <span className="text-[14px] font-semibold text-zinc-100 font-mono">Terminal</span>
        <div className="flex-1" />
        <button
          onClick={onClose}
          className="p-1.5 rounded-lg text-zinc-600 hover:text-zinc-200 hover:bg-white/[0.07] transition-colors"
          title="Close"
        >
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
            <path d="M2 2l9 9M11 2L2 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </button>
      </div>

      {/* ── Tab bar ────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-1 px-5 py-1.5 border-b border-white/[0.06] shrink-0 overflow-x-auto">
        {sessions.map((session) => (
          <div
            key={session.id}
            onClick={() => setActiveId(session.id)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-medium cursor-pointer transition-colors shrink-0 ${
              activeId === session.id
                ? "bg-white/[0.09] text-zinc-100"
                : "text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.05]"
            }`}
          >
            <span className="font-mono">{session.appName}</span>
            <button
              onClick={(e) => closeTab(session.id, e)}
              className="ml-0.5 text-zinc-600 hover:text-zinc-300 transition-colors"
              title="Close tab"
            >
              <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
                <path d="M1 1l7 7M8 1L1 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
              </svg>
            </button>
          </div>
        ))}

        {/* New tab button — sits right after the last tab */}
        <button
          onClick={addNewTab}
          className="shrink-0 flex items-center justify-center w-7 h-7 rounded-md text-zinc-600 hover:text-zinc-300 hover:bg-white/[0.06] transition-colors text-[16px] leading-none"
          title="New terminal"
        >
          +
        </button>
      </div>

      {/* ── Main terminal area ──────────────────────────────────────────────── */}
      {/* All sessions stay mounted so PTY sessions and scroll history survive tab switching */}
      <div className="flex-1 overflow-hidden relative">
        {sessions.map((session) => {
          const isVisible = session.id === activeId && isOpen;
          return (
            <div
              key={session.id}
              className="absolute inset-0"
              style={{ display: session.id === activeId ? "block" : "none" }}
            >
              <TerminalTab
                appId={session.id}
                rootDir={session.rootDir}
                visible={isVisible}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
