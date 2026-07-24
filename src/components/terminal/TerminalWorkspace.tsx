import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { usePortaStore } from "../../store";
import type { TabSession } from "../../store/slices/terminal";
import TerminalTab, { type PaneSearchApi } from "./TerminalTab";
import TerminalStatusBar from "./TerminalStatusBar";
import { terminalState, terminalClose, terminalSignal } from "../../lib/commands";

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
  /** Externally requested session — the grid's "Run in terminal", or the
   *  workbench's one-click fix for a boot failure ("Run mix deps.get"). */
  pendingSession?: SessionRequest | null;
  /** Seed a first tab on mount instead of waiting for a pendingSession. */
  autoSeed?: boolean;
  /** Called when the last tab closes. Without it, a fresh tab is seeded so an
   *  always-present surface (the workbench tab) never ends up empty. */
  onEmpty?: () => void;
  /** Escape while focus is outside a text input. Modal uses it to close. */
  onEscape?: () => void;
  /** Tab strip start slot, before the tabs (the modal's "Terminal" title). */
  title?: ReactNode;
  /** Tab strip far-end slot, after everything else (the modal's close button). */
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
 * The multi-tab + split terminal surface: tab strip, 1–2 panes per tab, a find
 * widget over the focused pane's buffer, and the ⌘T/⌘W/⌘D/⌘1-9 shortcuts.
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
  // The find widget is an overlay, not chrome: it only exists while the user is
  // searching, so the tab strip is the single row at the top of the surface.
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  // Which pane last took keyboard focus — drives the split-view focus edge.
  // View state, not session state: it doesn't need to survive a reload.
  const [focusedPaneId, setFocusedPaneId] = useState<string | null>(null);
  const [lineCounts, setLineCounts] = useState<Record<string, number>>({});
  // Search runs inside one pane's xterm buffer (the focused one), so results
  // are a single pair rather than a per-pane record — `-1` index means the
  // addon gave up counting past its highlight limit.
  const [searchResults, setSearchResults] = useState<{ index: number; count: number }>({ index: -1, count: 0 });
  const paneSearchRef = useRef<Map<string, PaneSearchApi>>(new Map());
  const handledRequestIds = useRef<Set<string>>(new Set());

  const activeTab = tabs.find((t) => t.id === activeId) ?? null;
  // A stable scalar the poll effect below depends on so it notices a pane
  // being added (a new tab, or an existing one split) or removed, without
  // depending on `tabs` itself — see that effect's comment for why the array
  // reference is unsafe to depend on.
  const paneCount = tabs.reduce((n, t) => n + t.panes.length, 0);
  const activeLineCount = activeTab
    ? activeTab.panes.reduce((total, pane) => total + (lineCounts[pane.id] ?? 0), 0)
    : 0;

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
  // `restartFocusedPane` mutates this ref directly the instant it bumps the
  // nonce, rather than relying solely on this render-body sync line — a
  // response can land in the gap before React gets around to re-rendering
  // (or, as importantly, before `setRestartNonce`'s updater function itself
  // actually runs, which React does not guarantee happens synchronously).
  // This line stays as the steady-state sync path for every other render.
  const [restartNonce, setRestartNonce] = useState<Record<string, number>>({});
  const restartNonceRef = useRef(restartNonce);
  restartNonceRef.current = restartNonce;

  // Poll every pane of every tab for this app, not just the one the user is
  // looking at — a confirm-before-close that only knows the focused pane's
  // state (Finding 4) leaves every background tab reading `idle` forever,
  // no matter what's actually running in it. One `tcgetpgrp` per pane per 2s
  // is cheap.
  //
  // The interval itself is deliberately stable across restarts and focus
  // changes — deps are `active`/`appId`/`paneCount`/the store setter, none of
  // which change on a poll write. This is what avoids the render-loop hazard
  // a pane-object (or even a pane-*list*) dependency would reintroduce:
  // either of those is a fresh reference on every single successful poll
  // (each tick's `setTerminalPaneState` produces a new pane/tab array, with
  // no value diff before the spread), so depending on one would restart the
  // interval — and re-fire its immediate tick() — on every write, turning a
  // 2s poll into an IPC-paced storm.
  //
  // `paneCount` (a stable scalar sum, not the array itself — see where it's
  // computed above) is the one exception: without *something* to notice a
  // pane appearing, a freshly split pane, or the workbench tab's very first
  // pane (autoSeed's own effect creates it *after* this one — effects run in
  // declaration order — so this effect's first run would otherwise poll an
  // empty list and do nothing) wouldn't get its first poll until the
  // interval's next natural 2s firing. Depending on `paneCount` means the
  // effect re-runs — with its own fresh immediate tick — the moment a pane is
  // actually added or removed, without re-running for the vastly more common
  // case of a poll simply writing a new state onto an existing one.
  //
  // Each pane's restart generation is captured fresh at the moment *that
  // pane's* request goes out (not once at effect setup, since one shared
  // effect instance now issues requests for many panes over its lifetime) —
  // see the staleness guard inside `tick` for why that still closes the same
  // gap the single-pane version's effect-scoped generation used to.
  //
  // Guards against flapping with TerminalTab's onExit (which sets `exited`
  // independently, off this same poll cadence): each pane's tick reads the
  // store's current state for it right before *and* right after its IPC
  // round trip, so neither a tick already in flight when that pane's shell
  // exits nor a stale tick queued after can resurrect an `exited` pane back
  // to `idle`.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;

    const paneIds = () =>
      (usePortaStore.getState().terminalTabs[appId] ?? []).flatMap((t) => t.panes.map((p) => p.id));

    const paneState = (paneId: string) =>
      usePortaStore
        .getState()
        .terminalTabs[appId]?.flatMap((t) => t.panes)
        .find((p) => p.id === paneId)?.state;

    const pollOne = (paneId: string) => {
      // This request's restart generation, captured at the moment it's
      // issued — see the comment above the effect for why per-request (not
      // per-effect-setup) is what a shared, long-lived interval needs.
      const requestGeneration = restartNonceRef.current[paneId] ?? 0;
      const isStaleRestart = () => (restartNonceRef.current[paneId] ?? 0) !== requestGeneration;

      terminalState(paneId)
        .then((s) => {
          if (cancelled || isStaleRestart()) return;
          if (s === null) {
            // No record of this session yet — Rust hasn't seen terminal_open
            // land. This is the ordinary open() race (TerminalTab defers it
            // into a requestAnimationFrame, which can itself be delayed —
            // e.g. an occluded/minimized window suspends rAF entirely while
            // this interval keeps firing) and self-heals whenever the open
            // reaches Rust, however many ticks that takes. There's no bound
            // past which absence means the open failed: a real spawn failure
            // is already surfaced by `terminal_open` itself rejecting, which
            // the pane renders inline — this poll doesn't need to invent a
            // terminal state to represent it. Never synthesize a state from
            // an absent session; just leave the pane as is and keep polling.
            return;
          }
          if (paneState(paneId) === "exited") return;
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

    const tick = () => {
      for (const paneId of paneIds()) {
        // Don't poll a pane already known to have exited.
        if (paneState(paneId) === "exited") continue;
        pollOne(paneId);
      }
    };

    tick();
    const intervalId = window.setInterval(tick, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [active, appId, paneCount, setTerminalPaneState]);

  // Guards restartFocusedPane against a second click landing while the first
  // restart's terminalClose → store-reset → remount round trip is still in
  // flight — without it, two fast clicks dispatch two terminalClose calls
  // and two nonce bumps for the same pane, and if the second close resolves
  // after the first restart's remount it closes the fresh PTY instead of the
  // dead one it was meant for. Released once that remount has actually
  // committed (see the `restartNonce` effect below), not the moment the
  // store writes land — a click landing in that microtask gap could still
  // issue a `terminalClose` that outlives the remount's `terminalOpen`.
  const pendingRestarts = useRef<Set<string>>(new Set());
  // paneIds whose nonce bump landed this render, waiting for the remount it
  // triggers to commit before their `pendingRestarts` entry is released.
  const pendingReleaseRef = useRef<Set<string>>(new Set());

  // Restart drops the dead session so the pane starts clean rather than
  // stacking a second shell's output under the first one's. Bumping the
  // nonce remounts the pane's xterm, which is what reopens the PTY. Also
  // drops this pane's cached line count — otherwise the status bar would keep
  // showing the previous (dead) shell's count until the fresh TerminalTab
  // mounts and reports its own.
  const restartFocusedPane = useCallback(() => {
    const paneId = focusedPaneKey;
    if (!paneId) return;
    if (pendingRestarts.current.has(paneId)) return;
    pendingRestarts.current.add(paneId);
    void terminalClose(paneId)
      .catch(() => {})
      .then(() => {
        setTerminalPaneState(appId, paneId, { state: "idle", exitCode: null, pid: null });
        setLineCounts((prev) => {
          if (!(paneId in prev)) return prev;
          const next = { ...prev };
          delete next[paneId];
          return next;
        });
        // Mutate the ref as a plain, unconditional statement right here —
        // NOT from inside the `setRestartNonce` updater function passed
        // below. A `useState` updater is only guaranteed to run eagerly
        // (synchronously, at call time) when it's the first update queued
        // for an otherwise-idle fiber; the two `setState` calls just above
        // already mark this component as having pending work, so by the
        // time `setRestartNonce` runs its updater is deferred to the actual
        // render pass instead — which happens asynchronously, leaving the
        // exact gap this fix exists to close (confirmed empirically: with
        // the mutation inside the updater, a poll response landing right
        // here still read the stale generation because the updater hadn't
        // run yet). Computing off the ref (not the possibly-stale
        // `restartNonce` state closure) and writing it back immediately
        // makes the ref genuinely live the instant this handler runs — the poll
        // effect's staleness check reads this same ref from inside a
        // response handler that can run in the gap between this synchronous
        // write and React's next flush.
        const nextNonce = {
          ...restartNonceRef.current,
          [paneId]: (restartNonceRef.current[paneId] ?? 0) + 1,
        };
        restartNonceRef.current = nextNonce;
        setRestartNonce(nextNonce);
        pendingReleaseRef.current.add(paneId);
      });
  }, [focusedPaneKey, appId, setTerminalPaneState]);

  // Releases `pendingRestarts` entries once the remount their nonce bump
  // triggered has committed. This effect's own commit happens after the
  // just-remounted pane's mount effects have run (child effects fire before
  // the parent's in the same commit), which is the earliest point a second
  // Restart click can safely be allowed to close the fresh PTY.
  useEffect(() => {
    if (pendingReleaseRef.current.size === 0) return;
    for (const id of pendingReleaseRef.current) pendingRestarts.current.delete(id);
    pendingReleaseRef.current.clear();
  }, [restartNonce]);

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
    if (!active || !onEmpty || autoSeed) return;
    if (tabs.length === 0 && hadTabs.current) onEmpty();
  }, [active, tabs.length, onEmpty, autoSeed]);

  const addNewTab = useCallback(
    () => { addTerminalTab(appId, appName, rootDir, null); },
    [addTerminalTab, appId, appName, rootDir],
  );

  // A tab with a foreground process is the case that used to lose work
  // silently. Ask; an idle prompt closes without ceremony.
  const closeTab = useCallback(
    (tabId: string) => {
      const tab = tabs.find((t) => t.id === tabId);
      if (!tab) return;
      if (tabState(tab) !== "running") {
        void closeTerminalTab(appId, tabId);
        return;
      }
      void (async () => {
        const { confirm } = await import("@tauri-apps/plugin-dialog");
        const ok = await confirm(`"${tab.label}" is still running. Close it anyway?`, {
          title: "Close terminal tab",
          kind: "warning",
        });
        if (ok) await closeTerminalTab(appId, tabId);
      })();
    },
    [tabs, closeTerminalTab, appId],
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

  // Same confirmation `closeTab` gives a running tab — this button used to
  // skip it entirely, closing a pane the poll above already knows is running
  // with no prompt at all.
  const closePane = useCallback(
    (tabId: string, paneId: string) => {
      const pane = tabs.find((t) => t.id === tabId)?.panes.find((p) => p.id === paneId);
      if (pane?.state !== "running") {
        void closeTerminalPane(appId, tabId, paneId);
        return;
      }
      void (async () => {
        const { confirm } = await import("@tauri-apps/plugin-dialog");
        const ok = await confirm("This pane is still running. Close it anyway?", {
          title: "Close terminal pane",
          kind: "warning",
        });
        if (ok) await closeTerminalPane(appId, tabId, paneId);
      })();
    },
    [tabs, closeTerminalPane, appId],
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
  // tab can both be mounted, and Escape routing keys off it.
  const searchInputId = `terminal-search-input-${appId}`;

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    // Focus after the widget has actually mounted; on the first ⌘F the input
    // doesn't exist yet when this runs.
    requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
  }, []);

  /** Search targets whichever pane has focus, so ⌘F in a split searches the
   *  half you were looking at rather than both at once. */
  const searchPaneId = focusedPane?.id ?? null;

  // The results callback fires from inside xterm, outside React's render, so
  // it reads the target pane off a ref rather than a captured render value.
  const searchPaneIdRef = useRef<string | null>(searchPaneId);
  searchPaneIdRef.current = searchPaneId;

  const runSearch = useCallback(
    (direction: "next" | "prev", incremental = false) => {
      if (!searchPaneId) return;
      paneSearchRef.current.get(searchPaneId)?.find(terminalQuery, direction, incremental);
    },
    [searchPaneId, terminalQuery],
  );

  // Typing re-runs the search from the current selection (`incremental`, so a
  // growing query keeps extending the same match instead of jumping away).
  useEffect(() => {
    if (!searchOpen) return;
    runSearch("next", true);
  }, [searchOpen, runSearch]);

  /** Closing drops the query and every pane's highlight with it — decorations
   *  are xterm-side state and would otherwise outlive the widget. */
  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setTerminalQuery("");
    setSearchResults({ index: -1, count: 0 });
    for (const api of paneSearchRef.current.values()) api.clear();
  }, []);

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
        openSearch();
        return;
      }

      if (isTextInput) {
        if (e.key === "Escape" && target instanceof HTMLInputElement && target.id === searchInputId) {
          e.preventDefault();
          // First Escape clears a typed query, the second dismisses the widget.
          if (terminalQuery) setTerminalQuery("");
          else closeSearch();
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
  }, [active, onEscape, addNewTab, closeTab, splitActiveTab, activeId, tabs, terminalQuery, searchInputId, appId, setActiveTerminalTab, openSearch, closeSearch]);

  const isSplit = !!activeTab && activeTab.panes.length >= 2;

  // The pane whose job has already been sent SIGINT and kept running, so the
  // next press escalates. Cleared below the moment that pane stops running, so
  // an unrelated later job never starts out armed for SIGKILL.
  const [interruptedPaneId, setInterruptedPaneId] = useState<string | null>(null);
  useEffect(() => {
    if (!interruptedPaneId) return;
    const pane = tabs.flatMap((t) => t.panes).find((p) => p.id === interruptedPaneId);
    if (!pane || pane.state !== "running") setInterruptedPaneId(null);
  }, [interruptedPaneId, tabs]);

  const killFocusedPane = useCallback(() => {
    const paneId = focusedPaneKey;
    if (!paneId) return;
    const escalate = interruptedPaneId === paneId;
    void terminalSignal(paneId, escalate ? "kill" : "int").catch(() => {});
    // Arm the escalation on the first press; the poll clears it once the job
    // is actually gone (see the effect above).
    setInterruptedPaneId(escalate ? null : paneId);
  }, [focusedPaneKey, interruptedPaneId]);

  const hasMatches = searchResults.count > 0;
  // `index` is -1 once the addon stops tracking position past its highlight
  // limit — show the total alone rather than a bogus "0 of 4000".
  const matchLabel = !terminalQuery.trim()
    ? ""
    : searchResults.count === 0
      ? "no results"
      : searchResults.index < 0
        ? `${searchResults.count}+`
        : `${searchResults.index + 1}/${searchResults.count}`;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* ── Body: single top row (title + tabs + controls) + terminal area ─── */}
      <div className="flex flex-col flex-1 min-h-0">
        {/* Tab strip — the only chrome above the terminal. Search lives in a
            find widget overlaid on the panes instead of a second row, so the
            sessions sit at the very top of the surface. */}
        <div className="flex items-center gap-1 px-2.5 py-[7px] border-b border-subtle shrink-0">
          {title && (
            <div className="flex items-center gap-2 shrink-0 pl-1 pr-2">
              {title}
              <span className="w-px h-3.5 bg-white/[0.1]" />
            </div>
          )}
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

          {/* Search + split controls (+ host-provided extras) */}
          <div className="ml-auto flex items-center gap-3 text-ink-2">
            <button
              onClick={() => (searchOpen ? closeSearch() : openSearch())}
              className={`transition-colors hover:text-ink ${searchOpen ? "text-ink" : ""}`}
              title="Find in terminal output (⌘F)"
            >
              <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
                <circle cx="6.5" cy="6.5" r="4" stroke="currentColor" strokeWidth="1.2" />
                <path d="M9.5 9.5l3 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
            </button>
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
            {headerTrail}
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
                          onOutput={() => markTerminalPaneOutput(appId, tab.id, pane.id)}
                          onFocus={() => setFocusedPaneId(pane.id)}
                          onExit={(code) =>
                            setTerminalPaneState(appId, pane.id, { state: "exited", exitCode: code })
                          }
                          onLineCount={(lineCount) =>
                            setLineCounts((prev) =>
                              prev[pane.id] === lineCount ? prev : { ...prev, [pane.id]: lineCount },
                            )
                          }
                          registerSearch={(api) => {
                            if (api) paneSearchRef.current.set(pane.id, api);
                            else paneSearchRef.current.delete(pane.id);
                          }}
                          onSearchResults={(index, count) => {
                            // Only the pane being searched may drive the label;
                            // a background pane clearing its own decorations
                            // would otherwise zero the count under the widget.
                            if (pane.id !== searchPaneIdRef.current) return;
                            setSearchResults((prev) =>
                              prev.index === index && prev.count === count ? prev : { index, count },
                            );
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}

          {/* Find widget — floats over the panes like VS Code's, so it costs no
              vertical space when nobody is searching. */}
          {searchOpen && (
            <div className="absolute top-2 right-3 z-20 flex items-center gap-1.5 rounded-lg border border-white/[0.1] bg-[#1a1a1d] pl-2 pr-1.5 py-1 shadow-[0_10px_28px_rgba(0,0,0,0.55)]">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="shrink-0 text-zinc-600">
                <circle cx="5" cy="5" r="3.5" stroke="currentColor" strokeWidth="1.3" />
                <path d="M8 8l2 2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              </svg>
              <input
                id={searchInputId}
                ref={searchInputRef}
                spellCheck={false}
                value={terminalQuery}
                onChange={(e) => setTerminalQuery(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  runSearch(e.shiftKey ? "prev" : "next");
                }}
                placeholder="Find in output…"
                className="w-[190px] bg-transparent py-0.5 text-[12px] text-zinc-200 placeholder:text-zinc-600 outline-none"
              />
              <span className="shrink-0 text-[11px] tabular-nums text-zinc-600 select-none">{matchLabel}</span>
              <span className="w-px h-4 bg-white/[0.1] shrink-0" />
              <button
                onClick={() => runSearch("prev")}
                disabled={!hasMatches}
                className="shrink-0 p-1 rounded text-zinc-600 enabled:hover:text-zinc-200 enabled:hover:bg-white/[0.08] disabled:opacity-40 transition-colors"
                title="Previous match (⇧⏎)"
              >
                <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                  <path d="M2.5 6.75L5.5 3.75l3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <button
                onClick={() => runSearch("next")}
                disabled={!hasMatches}
                className="shrink-0 p-1 rounded text-zinc-600 enabled:hover:text-zinc-200 enabled:hover:bg-white/[0.08] disabled:opacity-40 transition-colors"
                title="Next match (⏎)"
              >
                <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                  <path d="M2.5 4.25l3 3 3-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <button
                onClick={closeSearch}
                className="shrink-0 p-1 rounded text-zinc-600 hover:text-zinc-200 hover:bg-white/[0.08] transition-colors"
                title="Close (Esc)"
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          )}
        </div>

        <TerminalStatusBar
          pane={focusedPane}
          lineCount={activeLineCount}
          matchCount={searchOpen && terminalQuery.trim() ? searchResults.count : null}
          onRestart={restartFocusedPane}
          onKill={killFocusedPane}
          killEscalated={interruptedPaneId === focusedPaneKey}
        />
      </div>
    </div>
  );
}
