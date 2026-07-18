import type { StateCreator } from "zustand";
import type { SetupStatus } from "../../types";
import type { AllSlices } from "../index";
import type { ExtensionInfo } from "../../types/extension";
import * as cmd from "../../lib/commands";

export type ExtensionSidebarState = {
  appId: string;
  extensions: ExtensionInfo[];
  /** When set, the sidebar opens straight into this extension's full panel. */
  focusExtensionId?: string;
  /**
   * Bumped on every `openExtensionSidebar` call. Lets the sidebar's focus
   * effect re-fire even when the same app+extension is requested again (e.g.
   * close the extension modal, then click the same card action a second time) —
   * `appId`/`focusExtensionId` alone are unchanged, so the effect wouldn't
   * otherwise re-run.
   */
  focusNonce: number;
};

export type SettingsSection =
  | "setup"
  | "cloudflare"
  | "tailscale"
  | "remote"
  | "notifications"
  | "git"
  | "backup"
  | "disk"
  | "extensions"
  | "about";

/**
 * App-updater state machine. Lives in the store so any component (the
 * Settings → About button, the global toast, future menubar UI…) sees the
 * same phase and can't kick off a second download while one is in flight.
 *
 * Transitions:
 *   idle → checking → uptodate → idle  (no update found; manual check only)
 *   idle → checking → available        (update found, awaiting user confirm)
 *   available → downloading → installing → ready
 *   ready → restarting                  (user clicks Restart)
 *   any → error                          (with `updaterError` set; user can retry)
 *
 * Once we hit `ready`, the binary has been swapped on disk — re-checking
 * would just return the same update and re-download for nothing, so callers
 * should short-circuit and offer Restart instead.
 */
export type UpdaterPhase =
  | "idle"
  | "checking"
  | "uptodate"
  | "available"
  | "downloading"
  | "installing"
  | "ready"
  | "restarting"
  | "error";

export interface UpdaterInfo {
  version: string;
  currentVersion: string;
  body: string | null;
  /** Total bytes from the `Started` event; 0 until that fires. */
  total: number;
  /** Cumulative bytes received from `Progress` events. */
  downloaded: number;
}

export type TerminalPlacement = "modal" | "panel";

export interface UiSlice {
  setupStatus: SetupStatus | null;
  loading: boolean;
  error: string | null;
  openToasts: string[];
  notificationsEnabled: boolean;
  imageUpdateNotifyEnabled: boolean;
  /** Advanced Git tools (stage/unstage/commit/branch ops) toggle; persisted in Rust config. */
  gitAdvancedEnabled: boolean;
  extensionSidebar: ExtensionSidebarState | null;
  /**
   * Per-app cache of extensions matching each app's kind+tags, keyed by app id.
   * Populated by app cards as they mount. Lets the command palette offer each
   * app's appActions without recomputing the (async) tag detection + filter.
   */
  appExtensions: Record<string, ExtensionInfo[]>;
  /** One-shot request to open Settings on a specific section; consumed by SettingsPage. */
  settingsSection: SettingsSection | null;
  updaterPhase: UpdaterPhase;
  updaterInfo: UpdaterInfo | null;
  updaterError: string | null;
  /**
   * Opt-in to the pre-release (beta) update channel. Persisted to
   * localStorage so it survives restarts. When true, the updater checks the
   * beta endpoint (a fixed `beta`-tagged latest.json) instead of stable.
   */
  betaUpdates: boolean;
  /** Who initiated the current check — lets the toast stay quiet for checks
   *  started from the sidebar popover (the popover shows progress itself). */
  updaterCheckSource: "popover" | "menu" | "background";
  /** Where the terminal renders: full-screen modal vs. bottom-docked panel. */
  terminalPlacement: TerminalPlacement;
  /** Panel-mode height as a fraction of the viewport (0.15 – 0.92). */
  terminalPanelHeight: number;
  /**
   * Monotonic counter bumped whenever an extension's on-disk state may
   * have changed (install / update / uninstall / toggle from anywhere).
   * Consumers — like Settings → Extensions — use this as a useEffect
   * dependency to re-fetch their list. Without it, a Settings panel
   * left open while the user updates an extension from the in-app
   * sidebar showed stale version numbers until reload.
   */
  extensionListVersion: number;
  /** Which top-level surface the main content area renders. */
  activeDomain: "workspaces" | "hosts" | "services" | "activity" | "extensions";
  /** App opened in the Workspaces workbench (null = app list). */
  selectedAppId: string | null;
  selectApp: (id: string | null) => void;
  /** App whose settings modal is open (null = closed). */
  settingsAppId: string | null;
  openAppSettings: (id: string | null) => void;

  checkSetup: () => Promise<void>;
  loadSettings: () => Promise<void>;
  registerToast: (id: string) => void;
  unregisterToast: (id: string) => void;
  getToastIndex: (id: string) => number;
  setNotificationsEnabled: (enabled: boolean) => Promise<void>;
  setImageUpdateNotifyEnabled: (enabled: boolean) => Promise<void>;
  setGitAdvancedEnabled: (enabled: boolean) => void;
  setBetaUpdates: (enabled: boolean) => void;
  openExtensionSidebar: (appId: string, extensions: ExtensionInfo[], focusExtensionId?: string) => void;
  closeExtensionSidebar: () => void;
  cacheAppExtensions: (appId: string, extensions: ExtensionInfo[]) => void;
  openSettingsSection: (section: SettingsSection) => void;
  clearSettingsSection: () => void;
  setTerminalPlacement: (p: TerminalPlacement) => void;
  setTerminalPanelHeight: (frac: number) => void;
  /** Bump `extensionListVersion` to trigger re-fetches in subscribed views. */
  bumpExtensionList: () => void;
  setActiveDomain: (v: "workspaces" | "hosts" | "services" | "activity" | "extensions") => void;
}

// Monotonic counter feeding ExtensionSidebarState.focusNonce (see its docs).
let extensionFocusNonce = 0;

const LS_PLACEMENT = "porta.terminal.placement";
const LS_PANEL_HEIGHT = "porta.terminal.panelHeight";
const LS_BETA_UPDATES = "porta.updater.betaUpdates";

function loadPlacement(): TerminalPlacement {
  if (typeof localStorage === "undefined") return "modal";
  const v = localStorage.getItem(LS_PLACEMENT);
  return v === "panel" ? "panel" : "modal";
}

function loadBetaUpdates(): boolean {
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem(LS_BETA_UPDATES) === "true";
}

function loadPanelHeight(): number {
  if (typeof localStorage === "undefined") return 0.4;
  const n = parseFloat(localStorage.getItem(LS_PANEL_HEIGHT) || "");
  return Number.isFinite(n) && n >= 0.15 && n <= 0.92 ? n : 0.4;
}

export const createUiSlice: StateCreator<AllSlices, [], [], UiSlice> = (set, get) => ({
  setupStatus: null,
  loading: false,
  error: null,
  openToasts: [],
  notificationsEnabled: true,
  imageUpdateNotifyEnabled: true,
  gitAdvancedEnabled: true,
  extensionSidebar: null,
  appExtensions: {},
  settingsSection: null,
  updaterPhase: "idle",
  updaterInfo: null,
  updaterError: null,
  betaUpdates: loadBetaUpdates(),
  updaterCheckSource: "background",
  terminalPlacement: loadPlacement(),
  terminalPanelHeight: loadPanelHeight(),
  extensionListVersion: 0,
  activeDomain: "workspaces",
  selectedAppId: null,
  settingsAppId: null,

  checkSetup: async () => {
    const setupStatus = await cmd.checkSetup();
    set({ setupStatus });
  },

  loadSettings: async () => {
    try {
      const [enabled, imageUpdateEnabled, gitAdvancedEnabled] = await Promise.all([
        cmd.getNotificationsEnabled(),
        cmd.getImageUpdateNotifyEnabled(),
        cmd.getGitAdvancedEnabled(),
      ]);
      set({ notificationsEnabled: enabled, imageUpdateNotifyEnabled: imageUpdateEnabled, gitAdvancedEnabled });
    } catch {}
  },

  registerToast: (id) =>
    set((s) => ({
      openToasts: s.openToasts.includes(id) ? s.openToasts : [...s.openToasts, id],
    })),

  unregisterToast: (id) =>
    set((s) => ({ openToasts: s.openToasts.filter((t) => t !== id) })),

  getToastIndex: (id) => get().openToasts.indexOf(id),

  setNotificationsEnabled: async (enabled) => {
    await cmd.setNotificationsEnabled(enabled);
    set({ notificationsEnabled: enabled });
  },

  setImageUpdateNotifyEnabled: async (enabled) => {
    await cmd.setImageUpdateNotifyEnabled(enabled);
    set({ imageUpdateNotifyEnabled: enabled });
  },

  setGitAdvancedEnabled: (enabled) => set({ gitAdvancedEnabled: enabled }),

  setBetaUpdates: (enabled) => {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(LS_BETA_UPDATES, String(enabled));
    }
    set({ betaUpdates: enabled });
  },

  openExtensionSidebar: (appId, extensions, focusExtensionId) =>
    set({ extensionSidebar: { appId, extensions, focusExtensionId, focusNonce: ++extensionFocusNonce } }),

  closeExtensionSidebar: () => set({ extensionSidebar: null }),

  cacheAppExtensions: (appId, extensions) =>
    set((s) => ({ appExtensions: { ...s.appExtensions, [appId]: extensions } })),

  openSettingsSection: (section) => set({ settingsSection: section }),
  clearSettingsSection: () => set({ settingsSection: null }),

  setTerminalPlacement: (p) => {
    if (typeof localStorage !== "undefined") localStorage.setItem(LS_PLACEMENT, p);
    set({ terminalPlacement: p });
  },
  setTerminalPanelHeight: (frac) => {
    const clamped = Math.max(0.15, Math.min(0.92, frac));
    if (typeof localStorage !== "undefined") localStorage.setItem(LS_PANEL_HEIGHT, String(clamped));
    set({ terminalPanelHeight: clamped });
  },

  bumpExtensionList: () => set((s) => ({ extensionListVersion: s.extensionListVersion + 1 })),

  setActiveDomain: (v) => set({ activeDomain: v }),
  selectApp: (id) => set({ selectedAppId: id }),
  openAppSettings: (id) => set({ settingsAppId: id }),
});
