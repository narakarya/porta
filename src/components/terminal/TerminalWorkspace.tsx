import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { usePortaStore } from "../../store";
import type { TabSession } from "../../store/slices/terminal";
import TerminalTab from "./TerminalTab";
import TerminalStatusBar from "./TerminalStatusBar";
import { terminalState, terminalClose } from "../../lib/commands";

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

// Stable empty ref so the selector never returns a new array.
const EMPTY_TABS: TabSession[] = [];

/** One dot, one meaning: a tab is running if anything in it is, exited only
 *  once nothing is left alive. Unseen output is carried by label brightness
 *  instead, so the two signals never fight over the same pixel. */
export function tabState(tab: TabSession): "idle" | "running" | "exited" {
  if (tab.panes.some((p) => p.state === "running")) return "running";
  if (tab.panes.length > 0 && tab.panes.every((p) => p.state === "exited")) return "exited";
  return "idle";
}

const STATE_DOT: Record<"idle" | "running" | "exited", string> = {
  idle: "bg-zinc-600",
  running: "bg-emerald-400",
  exited: "bg-amber-400",
};

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
  const tabs = usePortaStore(useShallow((s) => s.terminalTabs[appId] ?? EMPTY_TABS));
  const activeId = usePortaStore((s) => s.terminalActiveTab[appId] ?? null);
  const {
    ensureTerminalTab,
    addTerminalTab,
    closeTerminalTab,
    closeTerminalPane,
    splitTerminalTab,
    setActiveTerminalTab,
    renameTerminalTab,
    markTerminalPaneOutput,
    setTerminalPaneState,
  } = usePortaStore(
    useShallow((s) => ({
      ensureTerminalTab: s.ensureTerminalTab,
      addTerminalTab: s.addTerminalTab,
      closeTerminalTab: s.closeTerminalTab,
      closeTerminalPane: s.closeTerminalPane,
      splitTerminalTab: s.splitTerminalTab,
      setActiveTerminalTab: s.setActiveTerminalTab,
      renameTerminalTab: s.renameTerminalTab,
      markTerminalPaneOutput: s.markTerminalPaneOutput,
      setTerminalPaneState: s.setTerminalPaneState,
    })),
  );

  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState<string>("");
  const [terminalQuery, setTerminalQuery] = useState("");
  const [filterOutput, setFilterOutput] = useState(false);
  // Which pane last took keyboard focus — drives the split-view focus edge.
  // View state, not session state: it doesn't need to survive a reload.
  const [focusedPaneId, setFocusedPaneId] = useState<string | null>(null);
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

  const focusedPane =
    activeTab?.panes.find((p) => p.id === focusedPaneId) ?? activeTab?.panes[0] ?? null;
  // A stable primitive, not the pane object: the object is a fresh reference
  // every time this same poll writes to the store (each tick's
  // setTerminalPaneState produces a new pane), so depending on it below would
  // restart the interval — and re-fire its immediate tick() — on every write,
  // turning a 2s poll into a tight loop.
  const focusedPaneKey = focusedPane?.id ?? null;

  // Bumped by Restart (below). Included in the poll effect's deps so a
  // restart tears down and re-establishes the poll for its pane. `Ref`
  // mirrors the same record so the poll's response handlers — which close
  // over the generation captured when *their* request was issued — can
  // compare against the *live* generation when the response actually lands.
  // `cancelled` alone isn't enough for that (see the poll effect below).
  const [restartNonce, setRestartNonce] = useState<Record<string, number>>({});
  const restartNonceRef = useRef(restartNonce);
  restartNonceRef.current = restartNonce;

  // Named so the poll effect's dep array holds a value, not a computed
  // expression — statically checkable even without a lint script to catch a
  // future mistake here.
  const focusedPaneRestartNonce = restartNonce[focusedPaneKey ?? ""] ?? 0;

  // Poll only the pane the user is looking at. Guards against flapping with
  // TerminalTab's onExit (which sets `exited` independently, off this same
  // poll cadence): a tick reads the store's current state for this pane right
  // before *and* right after its IPC round trip, so neither a tick already in
  // flight when the shell exits nor a stale tick queued after can resurrect
  // an `exited` pane back to `idle`.
  useEffect(() => {
    if (!active || !focusedPaneKey) return;
    const paneId = focusedPaneKey;
    // This effect instance's restart generation, captured once at setup.
    // `restartFocusedPane`'s store writes (idle reset) land, then only later
    // does React actually run this effect's cleanup (which flips
    // `cancelled`) — child-before-parent effect ordering plus the async
    // `terminalClose` round trip mean a response already in flight when
    // Restart is clicked can resolve *inside* that window, while `cancelled`
    // is still false. Comparing the live nonce (via the ref, since a plain
    // closure over `restartNonce` would also be stale) against the
    // generation this request was issued under discards that response
    // instead of writing the dead session's state over the freshly reset
    // pane.
    const requestGeneration = focusedPaneRestartNonce;
    let cancelled = false;
    let intervalId: number | undefined;
    // Consecutive "Rust has no record of this session" responses in a row.
    // One or two of these are the ordinary terminal_open race (a pane that
    // hasn't attached in Rust yet) and self-heal within a tick or two. A
    // session that never shows up after several ticks means terminalOpen
    // itself failed — polling forever with nothing to show would strand the
    // pane at its initial state with no way back, so past this bound treat
    // it as a failed open and surface Restart instead.
    let consecutiveAbsent = 0;
    const MAX_CONSECUTIVE_ABSENT = 5; // ~8s of ticks: far past the single-
    // frame open() race, short enough not to leave the user staring at a
    // silently stuck pane.

    const currentState = () =>
      usePortaStore
        .getState()
        .terminalTabs[appId]?.flatMap((t) => t.panes)
        .find((p) => p.id === paneId)?.state;

    const isStaleRestart = () => (restartNonceRef.current[paneId] ?? 0) !== requestGeneration;

    const tick = () => {
      if (currentState() === "exited") {
        if (intervalId !== undefined) window.clearInterval(intervalId);
        return;
      }
      terminalState(paneId)
        .then((s) => {
          if (cancelled || isStaleRestart()) return;
          if (s === null) {
            // No record of this session yet — Rust hasn't seen terminal_open
            // land, or (past the bound) it never will. Never synthesize a
            // state from an absent session; just leave the pane as is and
            // keep polling until it either shows up or we give up.
            consecutiveAbsent += 1;
            if (consecutiveAbsent >= MAX_CONSECUTIVE_ABSENT) {
              setTerminalPaneState(appId, paneId, { state: "exited", exitCode: null, pid: null });
            }
            return;
          }
          consecutiveAbsent = 0;
          if (currentState() === "exited") return;
          setTerminalPaneState(appId, paneId, {
            state: !s.alive ? "exited" : s.running ? "running" : "idle",
            exitCode: s.exitCode,
            pid: s.pid,
          });
        })
        .catch((err) => {
          console.error(`[terminal] state poll failed for pane ${paneId}:`, err);
        });
    };
    // Skip installing anything for a pane that's already exited when this
    // effect sets up — otherwise the interval still gets created (only to
    // fire once at 2s and immediately clear itself), which doesn't match
    // what the guard above reads as preventing.
    if (currentState() !== "exited") {
      tick();
      intervalId = window.setInterval(tick, 2000);
    }
    return () => {
      cancelled = true;
      if (intervalId !== undefined) window.clearInterval(intervalId);
    };
  }, [active, appId, focusedPaneKey, focusedPaneRestartNonce, setTerminalPaneState]);

  // Guards restartFocusedPane against a second click landing while the first
  // restart's terminalClose → store-reset round trip is still in flight —
  // without it, two fast clicks dispatch two terminalClose calls and two
  // nonce bumps for the same pane, and if the second close resolves after
  // the first restart's remount it closes the fresh PTY instead of the dead
  // one it was meant for.
  const pendingRestarts = useRef<Set<string>>(new Set());

  // Restart drops the dead session so the pane starts clean rather than
  // stacking a second shell's output under the first one's. Bumping the
  // nonce remounts the pane's xterm, which is what reopens the PTY. Also
  // drops this pane's cached transcript stats — otherwise the status bar
  // would keep showing the previous (dead) shell's line count until the
  // fresh TerminalTab mounts and reports its own (0-line) stats, which only
  // happens once it's visible.
  const restartFocusedPane = useCallback(() => {
    const paneId = focusedPaneKey;
    if (!paneId) return;
    if (pendingRestarts.current.has(paneId)) return;
    pendingRestarts.current.add(paneId);
    void terminalClose(paneId)
      .catch(() => {})
      .then(() => {
        setTerminalPaneState(appId, paneId, { state: "idle", exitCode: null, pid: null });
        setTranscriptStats((prev) => {
          if (!(paneId in prev)) return prev;
          const next = { ...prev };
          delete next[paneId];
          return next;
        });
        setRestartNonce((n) => ({ ...n, [paneId]: (n[paneId] ?? 0) + 1 }));
      })
      .finally(() => {
        pendingRestarts.current.delete(paneId);
      });
  }, [focusedPaneKey, appId, setTerminalPaneState]);

  // Seed for hosts that are always present (the workbench tab) — the modal
  // instead waits for the pendingSession that opened it. This also re-seeds
  // after the last tab closes, which is why it keys on tabs.length.
  useEffect(() => {
    if (!autoSeed) return;
    ensureTerminalTab(appId, appName, rootDir);
  }, [autoSeed, appId, appName, rootDir, tabs.length, ensureTerminalTab]);

  // Consume pendingSession: reuse the active tab when no startup command;
  // else add a new one.
  useEffect(() => {
    if (!pendingSession) return;
    if (handledRequestIds.current.has(pendingSession.id)) return;
    handledRequestIds.current.add(pendingSession.id);
    const startup = pendingSession.startupCommand?.trim() || null;
    if (!startup && tabs.length > 0) {
      setActiveTerminalTab(appId, activeId ?? tabs[0].id);
      return;
    }
    addTerminalTab(appId, appName, rootDir, startup);
  }, [pendingSession, appId, appName, rootDir, tabs, activeId, addTerminalTab, setActiveTerminalTab]);

  // An empty surface has no way back, so a host that can close (the modal)
  // gets told. The `hadTabs` guard matters: the modal mounts empty and waits
  // for its pendingSession, and firing onEmpty then would close it on sight.
  const hadTabs = useRef(false);
  if (tabs.length > 0) hadTabs.current = true;
  useEffect(() => {
    if (!onEmpty || autoSeed) return;
    if (tabs.length === 0 && hadTabs.current) onEmpty();
  }, [tabs.length, onEmpty, autoSeed]);

  const addNewTab = useCallback(
    () => { addTerminalTab(appId, appName, rootDir, null); },
    [addTerminalTab, appId, appName, rootDir],
  );

  const closeTab = useCallback(
    (tabId: string) => { void closeTerminalTab(appId, tabId); },
    [closeTerminalTab, appId],
  );

  const splitInto = useCallback(
    (orientation: "cols" | "rows") => {
      if (!activeId) return;
      splitTerminalTab(appId, activeId, orientation);
    },
    [splitTerminalTab, appId, activeId],
  );

  const splitActiveTab = useCallback(
    () => splitInto(activeTab?.splitOrientation ?? "cols"),
    [splitInto, activeTab],
  );

  const closePane = useCallback(
    (tabId: string, paneId: string) => { void closeTerminalPane(appId, tabId, paneId); },
    [closeTerminalPane, appId],
  );

  const startRename = useCallback((tab: TabSession) => {
    setEditingTabId(tab.id);
    setEditingLabel(tab.label);
  }, []);
  const commitRename = useCallback(() => {
    if (!editingTabId) return;
    renameTerminalTab(appId, editingTabId, editingLabel);
    setEditingTabId(null);
    setEditingLabel("");
  }, [editingTabId, editingLabel, renameTerminalTab, appId]);
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
          setActiveTerminalTab(appId, tabs[idx].id);
        }
      }
    }
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [active, onEscape, addNewTab, closeTab, splitActiveTab, activeId, tabs, terminalQuery, searchInputId, appId, setActiveTerminalTab]);

  const isSplit = !!activeTab && activeTab.panes.length >= 2;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* ── Header: title slot + transcript stats + search/filter ─────────── */}
      <div className="flex items-center gap-3 px-5 py-3 border-b border-white/[0.08] shrink-0">
        {title}
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
            const state = tabState(tab);
            const unseen = !isActive && tab.panes.some((p) => p.hasUnseenOutput);
            return (
              <div
                key={tab.id}
                onClick={() => !isEditing && setActiveTerminalTab(appId, tab.id)}
                onDoubleClick={() => startRename(tab)}
                className={`group flex items-center gap-1.5 rounded-[5px] px-2 py-[3px] text-[11px] cursor-pointer transition-colors ${
                  isActive
                    ? "bg-white/[0.08] text-ink"
                    : unseen
                      ? "text-ink hover:bg-white/[0.05]"
                      : "text-ink-2 hover:text-ink hover:bg-white/[0.05]"
                }`}
              >
                <span
                  data-testid="tab-state-dot"
                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATE_DOT[state]}`}
                  title={state === "exited" ? "Shell exited" : state === "running" ? "Running" : "Idle"}
                />
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
              className={`transition-colors hover:text-ink ${isSplit && activeTab?.splitOrientation === "cols" ? "text-ink" : ""}`}
              title="Split vertically (⌘D)"
            >
              <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
                <rect x="1.5" y="2.5" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
                <line x1="7.5" y1="2.5" x2="7.5" y2="12.5" stroke="currentColor" strokeWidth="1.2" />
              </svg>
            </button>
            <button
              onClick={() => splitInto("rows")}
              className={`transition-colors hover:text-ink ${isSplit && activeTab?.splitOrientation === "rows" ? "text-ink" : ""}`}
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
            // "cols" = panes side by side; "rows" = panes stacked.
            const isRows = tab.splitOrientation === "rows";
            return (
              <div
                key={tab.id}
                className={`absolute inset-0 flex ${isRows ? "flex-col" : "flex-row"}`}
                style={{ display: tab.id === activeId ? "flex" : "none" }}
              >
                {tab.panes.map((pane, idx) => {
                  const sep = idx > 0 ? (isRows ? "border-t border-[rgba(255,255,255,0.12)]" : "border-l border-[rgba(255,255,255,0.12)]") : "";
                  const isFocused = focusedPaneId === pane.id;
                  const split = tab.panes.length > 1;
                  // Inset box-shadow, not a border: a border toggled on/off adds
                  // to the box size and would nudge xterm's fit() by a pixel.
                  const focusEdge = split && isFocused
                    ? (isRows
                        ? "shadow-[inset_0_2px_0_0_rgba(59,130,246,0.6)]"
                        : "shadow-[inset_2px_0_0_0_rgba(59,130,246,0.6)]")
                    : "";
                  return (
                    <div
                      key={pane.id}
                      className={`group/pane relative flex flex-col flex-1 min-w-0 min-h-0 ${sep} ${focusEdge}`}
                    >
                      {split && (
                        <span
                          data-testid="pane-ordinal"
                          className="absolute top-1.5 right-2 z-10 text-[9px] text-zinc-600 select-none pointer-events-none"
                        >
                          {idx + 1}
                        </span>
                      )}
                      {split && (
                        <button
                          onClick={() => closePane(tab.id, pane.id)}
                          className="absolute top-1.5 right-6 z-10 p-1 rounded text-zinc-600 bg-[#0d0d0f]/80 hover:text-zinc-200 hover:bg-white/[0.1] opacity-0 group-hover/pane:opacity-100 transition-opacity"
                          title="Close pane"
                        >
                          <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
                            <path d="M1 1l7 7M8 1L1 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                          </svg>
                        </button>
                      )}
                      <div className="relative flex-1 min-h-0">
                        <TerminalTab
                          key={`${pane.id}-${restartNonce[pane.id] ?? 0}`}
                          appId={pane.id}
                          rootDir={pane.rootDir}
                          visible={isTabActive}
                          startupCommand={pane.startupCommand}
                          searchQuery={terminalQuery}
                          filterOutput={filterOutput}
                          onOutput={() => markTerminalPaneOutput(appId, tab.id, pane.id)}
                          onFocus={() => setFocusedPaneId(pane.id)}
                          onExit={(code) =>
                            setTerminalPaneState(appId, pane.id, { state: "exited", exitCode: code })
                          }
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

        <TerminalStatusBar
          pane={focusedPane}
          lineCount={activeStats.lineCount}
          matchCount={activeStats.matchCount}
          onRestart={restartFocusedPane}
        />
      </div>
    </div>
  );
}
