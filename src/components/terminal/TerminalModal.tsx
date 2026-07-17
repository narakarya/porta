import { useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { usePortaStore } from "../../store";
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
  // Placement is persisted in UI slice (localStorage-backed) so the user
  // doesn't have to re-dock the terminal every session.
  const { placement, panelHeight, setPlacement, setPanelHeight } = usePortaStore(
    useShallow((s) => ({
      placement: s.terminalPlacement,
      panelHeight: s.terminalPanelHeight,
      setPlacement: s.setTerminalPlacement,
      setPanelHeight: s.setTerminalPanelHeight,
    })),
  );

  const [tabs, setTabs] = useState<TabSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState<string>("");
  const [terminalQuery, setTerminalQuery] = useState("");
  const [filterOutput, setFilterOutput] = useState(false);
  // Orientation of a split tab: "cols" = side-by-side (border-l between panes),
  // "rows" = stacked vertically (border-t between panes).
  const [splitOrientation, setSplitOrientation] = useState<"cols" | "rows">("cols");
  const [transcriptStats, setTranscriptStats] = useState<Record<string, { lineCount: number; matchCount: number | null }>>({});
  const handledRequestIds = useRef<Set<string>>(new Set());

  const activeTab = tabs.find((t) => t.id === activeId) ?? null;
  const activeStats = activeTab
    ? activeTab.panes.reduce(
        (acc, pane) => {
          const stats = transcriptStats[pane.id];
          if (!stats) return acc;
          return {
            lineCount: acc.lineCount + stats.lineCount,
            matchCount: acc.matchCount === null || stats.matchCount === null ? null : acc.matchCount + stats.matchCount,
          };
        },
        { lineCount: 0, matchCount: terminalQuery.trim() ? 0 : null as number | null }
      )
    : { lineCount: 0, matchCount: null };

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

  // Split (reuses the existing split wiring) and set the pane orientation. When
  // the tab is already split, splitActiveTab is a no-op so this just flips the
  // orientation of the two existing panes.
  const splitInto = useCallback(
    (orientation: "cols" | "rows") => {
      setSplitOrientation(orientation);
      splitActiveTab();
    },
    [splitActiveTab],
  );

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
      const target = e.target;
      const isTextInput =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable);

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        const input = document.getElementById("terminal-search-input") as HTMLInputElement | null;
        input?.focus();
        input?.select();
        return;
      }

      if (isTextInput) {
        if (e.key === "Escape" && target instanceof HTMLInputElement && target.id === "terminal-search-input") {
          e.preventDefault();
          if (terminalQuery) setTerminalQuery("");
          else target.blur();
        }
        return;
      }

      if (e.key === "Escape" && !(target instanceof HTMLCanvasElement)) {
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
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [isOpen, onClose, addNewTab, closeTab, splitActiveTab, activeId, tabs, terminalQuery]);

  const isSplit = !!activeTab && activeTab.panes.length >= 2;

  // Drag-to-resize for panel mode. Records the last height seen during
  // the drag so it can be committed on mouseup (closure over React state
  // would capture the start value, not the running one).
  function beginResize(e: React.MouseEvent) {
    if (placement !== "panel") return;
    e.preventDefault();
    const startY = e.clientY;
    const startH = panelHeight;
    let lastH = startH;
    const onMove = (ev: MouseEvent) => {
      const delta = (startY - ev.clientY) / window.innerHeight;
      lastH = Math.max(0.15, Math.min(0.92, startH + delta));
      setPanelHeight(lastH);
    };
    const onUp = () => {
      setPanelHeight(lastH); // commit final value to localStorage
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  const containerClass = placement === "panel"
    ? "fixed left-0 right-0 bottom-0 z-50 bg-[#111113] flex flex-col border-t-2 border-white/[0.12] shadow-[0_-12px_28px_rgba(0,0,0,0.45)]"
    : "fixed inset-0 z-50 bg-[#111113] flex flex-col";

  const containerStyle: React.CSSProperties = {
    display: isOpen ? undefined : "none",
    ...(placement === "panel" ? { height: `${panelHeight * 100}vh` } : {}),
  };

  return (
    <div className={containerClass} style={containerStyle}>
      {/* Resize handle — only rendered in panel mode. The 8px target gives
          a comfortable grab area; the visible 2px line at the top edge of
          the panel matches the border. */}
      {placement === "panel" && (
        <div
          onMouseDown={beginResize}
          className="absolute -top-1 left-0 right-0 h-2 cursor-ns-resize"
          title="Drag to resize"
        />
      )}
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 px-5 py-3 border-b border-white/[0.08] shrink-0">
        <span className="text-[14px] font-semibold text-zinc-100 font-mono">Terminal</span>
        <span className="text-[11px] text-zinc-700">·</span>
        <span className="text-[11px] text-zinc-600">
          {activeStats.lineCount.toLocaleString()} lines
          {activeStats.matchCount !== null ? ` · ${activeStats.matchCount.toLocaleString()} matches` : ""}
        </span>
        <div className="flex-1" />
        <div className="relative w-[320px] max-w-[36vw]">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-600 pointer-events-none">
            <circle cx="5" cy="5" r="3.5" stroke="currentColor" strokeWidth="1.3" />
            <path d="M8 8l2 2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
          <input
            id="terminal-search-input"
            spellCheck={false}
            value={terminalQuery}
            onChange={(e) => setTerminalQuery(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            placeholder="Search terminal output…"
            className="w-full bg-white/[0.05] border border-white/[0.08] rounded-lg pl-7 pr-7 py-1.5 text-[12px] text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-blue-500/50 focus:bg-white/[0.07] transition-all"
          />
          {terminalQuery && (
            <button
              onClick={() => setTerminalQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-600 hover:text-zinc-300"
              title="Clear search"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              </svg>
            </button>
          )}
        </div>
        <button
          onClick={() => setFilterOutput((v) => !v)}
          className={`h-7 px-2.5 rounded-md text-[12px] font-medium border transition-colors ${
            filterOutput
              ? "bg-blue-500/15 text-blue-300 border-blue-500/25"
              : "text-zinc-500 border-white/[0.08] hover:text-zinc-200 hover:bg-white/[0.06]"
          }`}
          title="Show searchable text transcript"
        >
          Filter
        </button>
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

      {/* ── Body: horizontal tab strip + terminal area ──────────────────────── */}
      <div className="flex flex-col flex-1 min-h-0">
        {/* Tab strip */}
        <div className="flex items-center gap-1 px-2.5 py-[7px] border-b border-subtle shrink-0">
          {tabs.map((tab) => {
            const isActive = activeId === tab.id;
            const isEditing = editingTabId === tab.id;
            const busy = !isActive && tab.panes.some((p) => p.hasUnseenOutput);
            return (
              <div
                key={tab.id}
                onClick={() => !isEditing && setActiveId(tab.id)}
                onDoubleClick={() => startRename(tab)}
                className={`group flex items-center gap-1.5 rounded-[5px] px-2 py-[3px] text-[11px] cursor-pointer transition-colors ${
                  isActive
                    ? "bg-white/[0.08] text-ink"
                    : "text-ink-2 hover:text-ink hover:bg-white/[0.05]"
                }`}
              >
                <svg width="12" height="12" viewBox="0 0 15 15" fill="none" className="shrink-0 text-ink-3" aria-hidden="true">
                  <rect x="1.5" y="2.5" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.1" />
                  <path d="M4 6l2 1.5L4 9" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M7.5 9.5h3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
                </svg>
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
                    className="font-mono bg-transparent outline-none border border-strong rounded px-1 -my-px text-ink min-w-0 w-[120px]"
                  />
                ) : (
                  <span className="font-mono truncate max-w-[160px]">{tab.label}</span>
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tab.id);
                  }}
                  className="shrink-0 text-ink-3 hover:text-ink opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Close tab (⌘W)"
                >
                  <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
                    <path d="M1 1l7 7M8 1L1 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
            );
          })}

          {/* New tab (⌘T) */}
          <button
            onClick={addNewTab}
            className="shrink-0 flex items-center justify-center w-6 h-6 rounded-[5px] text-ink-3 hover:text-ink hover:bg-white/[0.05] transition-colors"
            title="New tab (⌘T)"
          >
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
              <path d="M6.5 2v9M2 6.5h9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
          </button>

          {/* Split + fullscreen controls */}
          <div className="ml-auto flex items-center gap-3 text-ink-2">
            <button
              onClick={() => splitInto("cols")}
              className={`transition-colors hover:text-ink ${isSplit && splitOrientation === "cols" ? "text-ink" : ""}`}
              title="Split vertically (⌘D)"
            >
              <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
                <rect x="1.5" y="2.5" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
                <line x1="7.5" y1="2.5" x2="7.5" y2="12.5" stroke="currentColor" strokeWidth="1.2" />
              </svg>
            </button>
            <button
              onClick={() => splitInto("rows")}
              className={`transition-colors hover:text-ink ${isSplit && splitOrientation === "rows" ? "text-ink" : ""}`}
              title="Split horizontally"
            >
              <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
                <rect x="1.5" y="2.5" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
                <line x1="1.5" y1="7.5" x2="13.5" y2="7.5" stroke="currentColor" strokeWidth="1.2" />
              </svg>
            </button>
            <button
              onClick={() => setPlacement(placement === "modal" ? "panel" : "modal")}
              className="transition-colors hover:text-ink"
              title={placement === "modal" ? "Dock to bottom" : "Expand to full screen"}
            >
              {placement === "modal" ? (
                // Icon: bottom panel — outline rectangle with bottom band
                <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
                  <rect x="1.5" y="2.5" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
                  <path d="M1.5 9.5h12" stroke="currentColor" strokeWidth="1.2" />
                </svg>
              ) : (
                // Icon: fullscreen — four corner arrows
                <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
                  <path d="M2 5.5V2.5h3M13 5.5V2.5h-3M2 9.5v3h3M13 9.5v3h-3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>
          </div>
        </div>

        {/* Terminal area — all tabs stay mounted; each tab renders 1 or 2 panes */}
        <div className="flex-1 overflow-hidden relative min-w-0">
          {tabs.map((tab) => {
            const isTabActive = tab.id === activeId && isOpen;
            const isRows = splitOrientation === "rows";
            return (
              <div
                key={tab.id}
                className={`absolute inset-0 flex ${isRows ? "flex-col" : "flex-row"}`}
                style={{ display: tab.id === activeId ? "flex" : "none" }}
              >
                {tab.panes.map((pane, idx) => {
                  // Prefer the pane's shell/session label (derived from its
                  // startup command); fall back to the tab's app name.
                  const paneShell = pane.startupCommand?.trim().split(/\s+/)[0] || "zsh";
                  const paneLabel = `${tab.appName} · ${paneShell}`;
                  const sep = idx > 0 ? (isRows ? "border-t border-[rgba(255,255,255,0.12)]" : "border-l border-[rgba(255,255,255,0.12)]") : "";
                  return (
                    <div
                      key={pane.id}
                      className={`group/pane relative flex flex-col flex-1 min-w-0 min-h-0 ${sep}`}
                    >
                      {/* Per-pane header: activity dot + shell/session label */}
                      <div className="flex items-center gap-1.5 px-3 pt-2 mb-[5px] text-[10px] text-zinc-500 shrink-0">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
                        <span className="truncate">{paneLabel}</span>
                      </div>
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
                      <div className="relative flex-1 min-h-0">
                        <TerminalTab
                          appId={pane.id}
                          rootDir={pane.rootDir}
                          visible={isTabActive}
                          startupCommand={pane.startupCommand}
                          searchQuery={terminalQuery}
                          filterOutput={filterOutput}
                          onOutput={() => markPaneBusy(tab.id, pane.id)}
                          onTranscriptStats={(lineCount, matchCount) =>
                            setTranscriptStats((prev) => {
                              const current = prev[pane.id];
                              if (current?.lineCount === lineCount && current?.matchCount === matchCount) return prev;
                              return { ...prev, [pane.id]: { lineCount, matchCount } };
                            })
                          }
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
