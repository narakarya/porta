import { useCallback, useEffect, useRef, useState } from "react";
import type { App } from "../../types";
import TerminalTab from "./TerminalTab";

interface PaneSession {
  id: string;
  rootDir: string;
  startupCommand: string | null;
  hasUnseenOutput: boolean;
}

interface TabSession {
  id: string;
  appId: string;
  appName: string;
  rootDir: string;
  label: string;
  panes: PaneSession[];
}

export interface SessionRequest {
  id: string;
  startupCommand?: string | null;
}

interface Props {
  initialApp: App;
  isOpen: boolean;
  onClose: () => void;
  pendingSession: SessionRequest | null;
}

let _idCounter = 0;
function newId(prefix: string) {
  return `${prefix}-${Date.now()}-${++_idCounter}`;
}

export default function TerminalModal({ initialApp, isOpen, onClose, pendingSession }: Props) {
  const [tabs, setTabs] = useState<TabSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState<string>("");
  const handledRequestIds = useRef<Set<string>>(new Set());

  const activeTab = tabs.find((t) => t.id === activeId) ?? null;

  // When a tab becomes active, clear unseen-output flags on all its panes.
  useEffect(() => {
    if (!activeId) return;
    setTabs((prev) => {
      const tab = prev.find((t) => t.id === activeId);
      if (!tab || !tab.panes.some((p) => p.hasUnseenOutput)) return prev;
      return prev.map((t) =>
        t.id !== activeId ? t : { ...t, panes: t.panes.map((p) => (p.hasUnseenOutput ? { ...p, hasUnseenOutput: false } : p)) }
      );
    });
  }, [activeId]);

  // Consume pendingSession: reuse active tab when no startup command; else add a new tab.
  useEffect(() => {
    if (!pendingSession) return;
    if (handledRequestIds.current.has(pendingSession.id)) return;
    handledRequestIds.current.add(pendingSession.id);
    const startup = pendingSession.startupCommand?.trim() || null;
    setTabs((prev) => {
      if (!startup && prev.length > 0) {
        const keep = prev.find((t) => t.id === activeId) ?? prev[0];
        setActiveId(keep.id);
        return prev;
      }
      const tabId = newId("tab");
      const tab: TabSession = {
        id: tabId,
        appId: initialApp.id,
        appName: initialApp.name,
        rootDir: initialApp.root_dir,
        label: startup ? `${initialApp.name} · ${startup.split(/\s+/)[0]}` : initialApp.name,
        panes: [{ id: newId("pane"), rootDir: initialApp.root_dir, startupCommand: startup, hasUnseenOutput: false }],
      };
      setActiveId(tabId);
      return [...prev, tab];
    });
  }, [pendingSession, initialApp, activeId]);

  const addNewTab = useCallback(() => {
    const src = tabs.find((t) => t.id === activeId) ?? tabs[0];
    if (!src) return;
    const tabId = newId("tab");
    const tab: TabSession = {
      id: tabId,
      appId: src.appId,
      appName: src.appName,
      rootDir: src.rootDir,
      label: src.appName,
      panes: [{ id: newId("pane"), rootDir: src.rootDir, startupCommand: null, hasUnseenOutput: false }],
    };
    setTabs((prev) => [...prev, tab]);
    setActiveId(tabId);
  }, [tabs, activeId]);

  const closeTab = useCallback(
    (tabId: string) => {
      setTabs((prev) => {
        const idx = prev.findIndex((t) => t.id === tabId);
        if (idx < 0) return prev;
        const next = prev.filter((t) => t.id !== tabId);
        if (next.length === 0) {
          onClose();
          return prev;
        }
        if (activeId === tabId) setActiveId(next[Math.max(0, idx - 1)].id);
        return next;
      });
    },
    [activeId, onClose]
  );

  const splitActiveTab = useCallback(() => {
    if (!activeTab || activeTab.panes.length >= 2) return;
    setTabs((prev) =>
      prev.map((t) =>
        t.id !== activeTab.id
          ? t
          : {
              ...t,
              panes: [
                ...t.panes,
                { id: newId("pane"), rootDir: t.rootDir, startupCommand: null, hasUnseenOutput: false },
              ],
            }
      )
    );
  }, [activeTab]);

  const closePane = useCallback(
    (tabId: string, paneId: string) => {
      setTabs((prev) => {
        const tab = prev.find((t) => t.id === tabId);
        if (!tab) return prev;
        if (tab.panes.length <= 1) {
          const idx = prev.findIndex((t) => t.id === tabId);
          const next = prev.filter((t) => t.id !== tabId);
          if (next.length === 0) {
            onClose();
            return prev;
          }
          if (activeId === tabId) setActiveId(next[Math.max(0, idx - 1)].id);
          return next;
        }
        return prev.map((t) => (t.id !== tabId ? t : { ...t, panes: t.panes.filter((p) => p.id !== paneId) }));
      });
    },
    [activeId, onClose]
  );

  const markPaneBusy = useCallback(
    (tabId: string, paneId: string) => {
      if (tabId === activeId) return;
      setTabs((prev) => {
        const tab = prev.find((t) => t.id === tabId);
        if (!tab) return prev;
        const pane = tab.panes.find((p) => p.id === paneId);
        if (!pane || pane.hasUnseenOutput) return prev;
        return prev.map((t) =>
          t.id !== tabId ? t : { ...t, panes: t.panes.map((p) => (p.id !== paneId ? p : { ...p, hasUnseenOutput: true })) }
        );
      });
    },
    [activeId]
  );

  const startRename = useCallback((tab: TabSession) => {
    setEditingTabId(tab.id);
    setEditingLabel(tab.label);
  }, []);
  const commitRename = useCallback(() => {
    if (!editingTabId) return;
    const label = editingLabel.trim();
    setTabs((prev) => prev.map((t) => (t.id !== editingTabId ? t : { ...t, label: label || t.appName })));
    setEditingTabId(null);
    setEditingLabel("");
  }, [editingTabId, editingLabel]);
  const cancelRename = useCallback(() => {
    setEditingTabId(null);
    setEditingLabel("");
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !(e.target instanceof HTMLCanvasElement)) {
        onClose();
        return;
      }
      if (!e.metaKey) return;
      if (e.key === "t") {
        e.preventDefault();
        addNewTab();
        return;
      }
      if (e.key === "w") {
        e.preventDefault();
        if (activeId) closeTab(activeId);
        return;
      }
      if (e.key === "d") {
        e.preventDefault();
        splitActiveTab();
        return;
      }
      if (/^[1-9]$/.test(e.key)) {
        const idx = parseInt(e.key, 10) - 1;
        if (tabs[idx]) {
          e.preventDefault();
          setActiveId(tabs[idx].id);
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose, addNewTab, closeTab, splitActiveTab, activeId, tabs]);

  const canSplit = !!activeTab && activeTab.panes.length < 2;

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
            <path d="M2 2l9 9M11 2L2 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {/* ── Body: tab sidebar + terminal area ───────────────────────────────── */}
      <div className="flex flex-1 min-h-0">
        {/* Tab sidebar */}
        <div className="w-[180px] shrink-0 border-r border-white/[0.06] flex flex-col">
          <div className="flex-1 overflow-y-auto px-2 py-2 flex flex-col gap-0.5">
            {tabs.map((tab) => {
              const isActive = activeId === tab.id;
              const isEditing = editingTabId === tab.id;
              const busy = !isActive && tab.panes.some((p) => p.hasUnseenOutput);
              return (
                <div
                  key={tab.id}
                  onClick={() => !isEditing && setActiveId(tab.id)}
                  onDoubleClick={() => startRename(tab)}
                  className={`group flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[12px] font-medium cursor-pointer transition-colors ${
                    isActive
                      ? "bg-white/[0.09] text-zinc-100"
                      : "text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.05]"
                  }`}
                >
                  {busy && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" title="Activity" />}
                  {isEditing ? (
                    <input
                      autoFocus
                      value={editingLabel}
                      onChange={(e) => setEditingLabel(e.target.value)}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") {
                          e.preventDefault();
                          commitRename();
                        }
                        if (e.key === "Escape") {
                          e.preventDefault();
                          cancelRename();
                        }
                      }}
                      onClick={(e) => e.stopPropagation()}
                      className="font-mono flex-1 bg-transparent outline-none border border-white/[0.2] rounded px-1 -mx-1 -my-px text-zinc-100 min-w-0"
                    />
                  ) : (
                    <span className="font-mono truncate flex-1">{tab.label}</span>
                  )}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(tab.id);
                    }}
                    className="shrink-0 text-zinc-600 hover:text-zinc-300 opacity-0 group-hover:opacity-100 transition-opacity"
                    title="Close tab (⌘W)"
                  >
                    <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
                      <path d="M1 1l7 7M8 1L1 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                    </svg>
                  </button>
                </div>
              );
            })}
          </div>

          <div className="shrink-0 mx-2 mb-2 flex gap-1">
            <button
              onClick={addNewTab}
              className="flex-1 flex items-center justify-center gap-1.5 h-7 rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.06] transition-colors text-[12px] font-medium border border-white/[0.06] hover:border-white/[0.12]"
              title="New tab (⌘T)"
            >
              <span className="text-[14px] leading-none">+</span>
              <span>New</span>
            </button>
            <button
              onClick={splitActiveTab}
              disabled={!canSplit}
              className="flex-1 flex items-center justify-center gap-1.5 h-7 rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.06] transition-colors text-[12px] font-medium border border-white/[0.06] hover:border-white/[0.12] disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-zinc-500 disabled:hover:bg-transparent disabled:hover:border-white/[0.06]"
              title="Split pane (⌘D)"
            >
              <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                <rect x="0.5" y="0.5" width="10" height="10" rx="1" stroke="currentColor" />
                <line x1="5.5" y1="0.5" x2="5.5" y2="10.5" stroke="currentColor" />
              </svg>
              <span>Split</span>
            </button>
          </div>
        </div>

        {/* Main terminal area — all tabs stay mounted; each tab renders 1 or 2 panes side-by-side */}
        <div className="flex-1 overflow-hidden relative min-w-0">
          {tabs.map((tab) => {
            const isTabActive = tab.id === activeId && isOpen;
            return (
              <div
                key={tab.id}
                className="absolute inset-0 flex"
                style={{ display: tab.id === activeId ? "flex" : "none" }}
              >
                {tab.panes.map((pane, idx) => (
                  <div
                    key={pane.id}
                    className={`group/pane relative flex-1 min-w-0 ${idx > 0 ? "border-l border-white/[0.06]" : ""}`}
                  >
                    {tab.panes.length > 1 && (
                      <button
                        onClick={() => closePane(tab.id, pane.id)}
                        className="absolute top-1.5 right-1.5 z-10 p-1 rounded text-zinc-600 bg-[#0d0d0f]/80 hover:text-zinc-200 hover:bg-white/[0.1] opacity-0 group-hover/pane:opacity-100 transition-opacity"
                        title="Close pane"
                      >
                        <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
                          <path d="M1 1l7 7M8 1L1 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                        </svg>
                      </button>
                    )}
                    <TerminalTab
                      appId={pane.id}
                      rootDir={pane.rootDir}
                      visible={isTabActive}
                      startupCommand={pane.startupCommand}
                      onOutput={() => markPaneBusy(tab.id, pane.id)}
                    />
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
