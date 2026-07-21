import type { StateCreator } from "zustand";
import type { AllSlices } from "../index";
import * as cmd from "../../lib/commands";

/** One shell. `id` IS the PTY id Rust keys its session map by, so panes are
 *  independent sessions and closing one never touches another. */
export interface PaneSession {
  id: string;
  rootDir: string;
  startupCommand: string | null;
  hasUnseenOutput: boolean;
  /** Mirrors Rust's `terminal_state`; polled for the focused pane. */
  state: "idle" | "running" | "exited";
  exitCode: number | null;
  pid: number | null;
}

export interface TabSession {
  id: string;
  appId: string;
  appName: string;
  rootDir: string;
  label: string;
  panes: PaneSession[];
  /** Per-tab, not per-surface: tabs outlive navigation now, so a split
   *  orientation that lived on the component would leak across them. */
  splitOrientation: "cols" | "rows";
}

export interface TerminalSlice {
  /** appId → its tabs. Keyed per app so switching apps swaps the set instead
   *  of stranding the previous app's tabs on screen. */
  terminalTabs: Record<string, TabSession[]>;
  terminalActiveTab: Record<string, string | null>;

  ensureTerminalTab: (appId: string, appName: string, rootDir: string) => void;
  addTerminalTab: (appId: string, appName: string, rootDir: string, startup: string | null) => string;
  closeTerminalTab: (appId: string, tabId: string) => Promise<void>;
  closeTerminalPane: (appId: string, tabId: string, paneId: string) => Promise<void>;
  splitTerminalTab: (appId: string, tabId: string, orientation: "cols" | "rows") => void;
  setActiveTerminalTab: (appId: string, tabId: string) => void;
  renameTerminalTab: (appId: string, tabId: string, label: string) => void;
  markTerminalPaneOutput: (appId: string, tabId: string, paneId: string) => void;
  setTerminalPaneState: (
    appId: string,
    paneId: string,
    patch: Partial<Pick<PaneSession, "state" | "exitCode" | "pid">>,
  ) => void;
  /** Tear down every session an app owns — app deletion only. */
  closeAppTerminals: (appId: string) => Promise<void>;
}

let _idCounter = 0;
function newId(prefix: string) {
  return `${prefix}-${Date.now()}-${++_idCounter}`;
}

function makePane(rootDir: string, startup: string | null): PaneSession {
  return {
    id: newId("pane"),
    rootDir,
    startupCommand: startup,
    hasUnseenOutput: false,
    state: "idle",
    exitCode: null,
    pid: null,
  };
}

/** A tab is named for what runs in it. The app name is already the workbench
 *  title directly above the strip, so repeating it here reads as noise. */
function makeTab(appId: string, appName: string, rootDir: string, startup: string | null): TabSession {
  return {
    id: newId("tab"),
    appId,
    appName,
    rootDir,
    label: startup?.trim() || "zsh",
    panes: [makePane(rootDir, startup)],
    splitOrientation: "cols",
  };
}

export const createTerminalSlice: StateCreator<AllSlices, [], [], TerminalSlice> = (set, get) => ({
  terminalTabs: {},
  terminalActiveTab: {},

  ensureTerminalTab: (appId, appName, rootDir) => {
    if ((get().terminalTabs[appId] ?? []).length > 0) return;
    get().addTerminalTab(appId, appName, rootDir, null);
  },

  addTerminalTab: (appId, appName, rootDir, startup) => {
    const tab = makeTab(appId, appName, rootDir, startup);
    set((s) => ({
      terminalTabs: { ...s.terminalTabs, [appId]: [...(s.terminalTabs[appId] ?? []), tab] },
      terminalActiveTab: { ...s.terminalActiveTab, [appId]: tab.id },
    }));
    return tab.id;
  },

  closeTerminalTab: async (appId, tabId) => {
    const tabs = get().terminalTabs[appId] ?? [];
    const idx = tabs.findIndex((t) => t.id === tabId);
    if (idx < 0) return;

    await Promise.all(tabs[idx].panes.map((p) => cmd.terminalClose(p.id).catch(() => {})));

    // Emptying is all the slice does. Whether that means "seed a fresh shell"
    // (the workbench tab) or "close the surface" (the modal) is the host's
    // call — see TerminalWorkspace's empty-surface effect.
    const rest = tabs.filter((t) => t.id !== tabId);
    set((s) => ({
      terminalTabs: { ...s.terminalTabs, [appId]: rest },
      terminalActiveTab:
        s.terminalActiveTab[appId] === tabId
          ? {
              ...s.terminalActiveTab,
              [appId]: rest.length ? rest[Math.max(0, idx - 1)].id : null,
            }
          : s.terminalActiveTab,
    }));
  },

  closeTerminalPane: async (appId, tabId, paneId) => {
    const tab = (get().terminalTabs[appId] ?? []).find((t) => t.id === tabId);
    if (!tab) return;
    if (tab.panes.length <= 1) {
      await get().closeTerminalTab(appId, tabId);
      return;
    }
    await cmd.terminalClose(paneId).catch(() => {});
    set((s) => ({
      terminalTabs: {
        ...s.terminalTabs,
        [appId]: (s.terminalTabs[appId] ?? []).map((t) =>
          t.id !== tabId ? t : { ...t, panes: t.panes.filter((p) => p.id !== paneId) },
        ),
      },
    }));
  },

  splitTerminalTab: (appId, tabId, orientation) =>
    set((s) => ({
      terminalTabs: {
        ...s.terminalTabs,
        [appId]: (s.terminalTabs[appId] ?? []).map((t) => {
          if (t.id !== tabId) return t;
          // Already split → this is just an orientation flip.
          if (t.panes.length >= 2) return { ...t, splitOrientation: orientation };
          return {
            ...t,
            splitOrientation: orientation,
            panes: [...t.panes, makePane(t.rootDir, null)],
          };
        }),
      },
    })),

  setActiveTerminalTab: (appId, tabId) =>
    set((s) => ({
      terminalActiveTab: { ...s.terminalActiveTab, [appId]: tabId },
      terminalTabs: {
        ...s.terminalTabs,
        [appId]: (s.terminalTabs[appId] ?? []).map((t) =>
          t.id !== tabId ? t : { ...t, panes: t.panes.map((p) => ({ ...p, hasUnseenOutput: false })) },
        ),
      },
    })),

  renameTerminalTab: (appId, tabId, label) =>
    set((s) => ({
      terminalTabs: {
        ...s.terminalTabs,
        [appId]: (s.terminalTabs[appId] ?? []).map((t) =>
          t.id !== tabId ? t : { ...t, label: label.trim() || t.label },
        ),
      },
    })),

  markTerminalPaneOutput: (appId, tabId, paneId) => {
    if (get().terminalActiveTab[appId] === tabId) return;
    set((s) => ({
      terminalTabs: {
        ...s.terminalTabs,
        [appId]: (s.terminalTabs[appId] ?? []).map((t) =>
          t.id !== tabId
            ? t
            : { ...t, panes: t.panes.map((p) => (p.id !== paneId ? p : { ...p, hasUnseenOutput: true })) },
        ),
      },
    }));
  },

  setTerminalPaneState: (appId, paneId, patch) =>
    set((s) => ({
      terminalTabs: {
        ...s.terminalTabs,
        [appId]: (s.terminalTabs[appId] ?? []).map((t) => ({
          ...t,
          panes: t.panes.map((p) => (p.id !== paneId ? p : { ...p, ...patch })),
        })),
      },
    })),

  closeAppTerminals: async (appId) => {
    const tabs = get().terminalTabs[appId] ?? [];
    await Promise.all(
      tabs.flatMap((t) => t.panes.map((p) => cmd.terminalClose(p.id).catch(() => {}))),
    );
    set((s) => {
      const tabsNext = { ...s.terminalTabs };
      const activeNext = { ...s.terminalActiveTab };
      delete tabsNext[appId];
      delete activeNext[appId];
      return { terminalTabs: tabsNext, terminalActiveTab: activeNext };
    });
  },
});
