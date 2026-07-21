import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
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
  /** Source app the tabs/panes spawn their PTYs from. */
  appId: string;
  appName: string;
  rootDir: string;
  /** Whether this surface is on screen — gates xterm repaint + shortcuts. */
  active: boolean;
  /** Externally requested session (grid "Run in terminal"). Modal-only. */
  pendingSession?: SessionRequest | null;
  /** Seed a first tab on mount instead of waiting for a pendingSession. */
  autoSeed?: boolean;
  /** Called when the last tab closes. Without it, a fresh tab is seeded so an
   *  always-present surface (the workbench tab) never ends up empty. */
  onEmpty?: () => void;
  /** Escape while focus is outside a text input. Modal uses it to close. */
  onEscape?: () => void;
  /** Header row start slot (the modal's "Terminal" title). */
  title?: ReactNode;
  /** Header row end slot (the modal's close button). */
  headerTrail?: ReactNode;
  /** Tab strip end slot, after the split controls (placement toggle). */
  tabStripTrail?: ReactNode;
}

let _idCounter = 0;
function newId(prefix: string) {
  return `${prefix}-${Date.now()}-${++_idCounter}`;
}

/**
 * The multi-tab + split terminal surface: tab strip, 1–2 panes per tab, shared
 * search/filter over the panes' transcripts, and the ⌘T/⌘W/⌘D/⌘1-9 shortcuts.
 *
 * Owns no chrome of its own so both hosts can wrap it — the full-screen /
 * docked modal opened from the app grid, and the workbench's Terminal tab.
 * Each pane's `pane.id` IS its PTY id, so panes are independent shells.
 */
export default function TerminalWorkspace({
  appId,
  appName,
  rootDir,
  active,
  pendingSession = null,
  autoSeed = false,
  onEmpty,
  onEscape,
  title,
  headerTrail,
  tabStripTrail,
}: Props) {
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

  // Build a tab for the source app. Kept as a factory so seeding, ⌘T and
  // pendingSession all produce identically-shaped tabs.
  const makeTab = useCallback(
    (startup: string | null): TabSession => {
      const tabId = newId("tab");
      return {
        id: tabId,
        appId,
        appName,
        rootDir,
        label: startup ? `${appName} · ${startup.split(/\s+/)[0]}` : appName,
        panes: [{ id: newId("pane"), rootDir, startupCommand: startup, hasUnseenOutput: false }],
      };
    },
    [appId, appName, rootDir]
  );

  // Seed the first tab for hosts that are always present (the workbench tab) —
  // the modal instead waits for the pendingSession that opened it.
  useEffect(() => {
    if (!autoSeed) return;
    setTabs((prev) => {
      if (prev.length > 0) return prev;
      const tab = makeTab(null);
      setActiveId(tab.id);
      return [tab];
    });
  }, [autoSeed, makeTab]);

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
      const tab = makeTab(startup);
      setActiveId(tab.id);
      return [...prev, tab];
    });
  }, [pendingSession, makeTab, activeId]);

  const addNewTab = useCallback(() => {
    const tab = makeTab(null);
    setTabs((prev) => [...prev, tab]);
    setActiveId(tab.id);
  }, [makeTab]);

  // Drop `tabId`; when it was the last one, hand off to `onEmpty` or reseed so
  // an embedded surface never renders a blank pane area.
  const dropTab = useCallback(
    (prev: TabSession[], tabId: string): TabSession[] => {
      const idx = prev.findIndex((t) => t.id === tabId);
      if (idx < 0) return prev;
      const next = prev.filter((t) => t.id !== tabId);
      if (next.length === 0) {
        if (onEmpty) {
          onEmpty();
          return prev;
        }
        const seeded = makeTab(null);
        setActiveId(seeded.id);
        return [seeded];
      }
      if (activeId === tabId) setActiveId(next[Math.max(0, idx - 1)].id);
      return next;
    },
    [activeId, onEmpty, makeTab]
  );

  const closeTab = useCallback(
    (tabId: string) => setTabs((prev) => dropTab(prev, tabId)),
    [dropTab]
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
        if (tab.panes.length <= 1) return dropTab(prev, tabId);
        return prev.map((t) => (t.id !== tabId ? t : { ...t, panes: t.panes.filter((p) => p.id !== paneId) }));
      });
    },
    [dropTab]
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

  // Search input id must be unique per surface — the modal and the workbench
  // tab can both be mounted, and ⌘F focuses by id.
  const searchInputId = `terminal-search-input-${appId}`;

  useEffect(() => {
    if (!active) return;
    function onKey(e: KeyboardEvent) {
      const target = e.target;
      const isTextInput =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable);

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        const input = document.getElementById(searchInputId) as HTMLInputElement | null;
        input?.focus();
        input?.select();
        return;
      }

      if (isTextInput) {
        if (e.key === "Escape" && target instanceof HTMLInputElement && target.id === searchInputId) {
          e.preventDefault();
          if (terminalQuery) setTerminalQuery("");
          else target.blur();
        }
        return;
      }

      if (e.key === "Escape" && !(target instanceof HTMLCanvasElement)) {
        onEscape?.();
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
  }, [active, onEscape, addNewTab, closeTab, splitActiveTab, activeId, tabs, terminalQuery, searchInputId]);

  const isSplit = !!activeTab && activeTab.panes.length >= 2;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* ── Header: title slot + transcript stats + search/filter ─────────── */}
      <div className="flex items-center gap-3 px-5 py-3 border-b border-white/[0.08] shrink-0">
        {title}
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
            id={searchInputId}
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
        {headerTrail}
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

          {/* Split controls (+ host-provided extras) */}
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
            {tabStripTrail}
          </div>
        </div>

        {/* Terminal area — all tabs stay mounted; each tab renders 1 or 2 panes */}
        <div className="flex-1 overflow-hidden relative min-w-0">
          {tabs.map((tab) => {
            const isTabActive = tab.id === activeId && active;
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
