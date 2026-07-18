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
  /** Resource monitoring drawer. Docker stats polling is gated on this. */
  resourceDrawerOpen: boolean;
  /** Which top-level surface the main content area renders. */
  mainView: "workspace" | "hosts";
  /**
   * Sidebar section collapse prefs — persisted to localStorage so they survive
   * reload. Previously component-local useState that reset on every launch.
   */
  sidebarWsExpanded: boolean;
  sidebarOtherExpanded: boolean;
  sidebarServicesCollapsed: boolean;
  /** Per-app "Instances" region expansion, keyed by app id (persisted). */
  appInstancesExpanded: Record<string, boolean>;

  checkSetup: () => Promise<void>;
  loadSettings: () => Promise<void>;
  registerToast: (id: string) => void;
  unregisterToast: (id: string) => void;
  getToastIndex: (id: string) => number;
  setNotificationsEnabled: (enabled: boolean) => Promise<void>;
  setImageUpdateNotifyEnabled: (enabled: boolean) => Promise<void>;
  openExtensionSidebar: (appId: string, extensions: ExtensionInfo[], focusExtensionId?: string) => void;
  closeExtensionSidebar: () => void;
  cacheAppExtensions: (appId: string, extensions: ExtensionInfo[]) => void;
  openSettingsSection: (section: SettingsSection) => void;
  clearSettingsSection: () => void;
  toggleResourceDrawer: () => void;
  setTerminalPlacement: (p: TerminalPlacement) => void;
  setTerminalPanelHeight: (frac: number) => void;
  /** Bump `extensionListVersion` to trigger re-fetches in subscribed views. */
  bumpExtensionList: () => void;
  setMainView: (v: "workspace" | "hosts") => void;
  setSidebarWsExpanded: (v: boolean) => void;
  setSidebarOtherExpanded: (v: boolean) => void;
  setSidebarServicesCollapsed: (v: boolean) => void;
  setAppInstancesExpanded: (appId: string, v: boolean) => void;
}

// Monotonic counter feeding ExtensionSidebarState.focusNonce (see its docs).
let extensionFocusNonce = 0;

const LS_PLACEMENT = "porta.terminal.placement";
const LS_PANEL_HEIGHT = "porta.terminal.panelHeight";
const LS_WS_EXPANDED = "porta.sidebar.wsExpanded";
const LS_OTHER_EXPANDED = "porta.sidebar.otherExpanded";
const LS_SERVICES_COLLAPSED = "porta.sidebar.servicesCollapsed";
const LS_INSTANCES_EXPANDED = "porta.app.instancesExpanded";

function loadPlacement(): TerminalPlacement {
  if (typeof localStorage === "undefined") return "modal";
  const v = localStorage.getItem(LS_PLACEMENT);
  return v === "panel" ? "panel" : "modal";
}

function loadPanelHeight(): number {
  if (typeof localStorage === "undefined") return 0.4;
  const n = parseFloat(localStorage.getItem(LS_PANEL_HEIGHT) || "");
  return Number.isFinite(n) && n >= 0.15 && n <= 0.92 ? n : 0.4;
}

function loadBool(key: string, fallback: boolean): boolean {
  if (typeof localStorage === "undefined") return fallback;
  const v = localStorage.getItem(key);
  return v === null ? fallback : v === "true";
}

function loadInstancesExpanded(): Record<string, boolean> {
  if (typeof localStorage === "undefined") return {};
  try {
    const parsed = JSON.parse(localStorage.getItem(LS_INSTANCES_EXPANDED) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export const createUiSlice: StateCreator<AllSlices, [], [], UiSlice> = (set, get) => ({
  setupStatus: null,
  loading: false,
  error: null,
  openToasts: [],
  notificationsEnabled: true,
  imageUpdateNotifyEnabled: true,
  extensionSidebar: null,
  appExtensions: {},
  settingsSection: null,
  updaterPhase: "idle",
  updaterInfo: null,
  updaterError: null,
  updaterCheckSource: "background",
  terminalPlacement: loadPlacement(),
  terminalPanelHeight: loadPanelHeight(),
  extensionListVersion: 0,
  resourceDrawerOpen: false,
  mainView: "workspace",
  sidebarWsExpanded: loadBool(LS_WS_EXPANDED, true),
  sidebarOtherExpanded: loadBool(LS_OTHER_EXPANDED, true),
  sidebarServicesCollapsed: loadBool(LS_SERVICES_COLLAPSED, false),
  appInstancesExpanded: loadInstancesExpanded(),

  checkSetup: async () => {
    const setupStatus = await cmd.checkSetup();
    set({ setupStatus });
  },

  loadSettings: async () => {
    try {
      const [enabled, imageUpdateEnabled] = await Promise.all([
        cmd.getNotificationsEnabled(),
        cmd.getImageUpdateNotifyEnabled(),
      ]);
      set({ notificationsEnabled: enabled, imageUpdateNotifyEnabled: imageUpdateEnabled });
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

  openExtensionSidebar: (appId, extensions, focusExtensionId) =>
    set({ extensionSidebar: { appId, extensions, focusExtensionId, focusNonce: ++extensionFocusNonce } }),

  closeExtensionSidebar: () => set({ extensionSidebar: null }),

  cacheAppExtensions: (appId, extensions) =>
    set((s) => ({ appExtensions: { ...s.appExtensions, [appId]: extensions } })),

  openSettingsSection: (section) => set({ settingsSection: section }),
  clearSettingsSection: () => set({ settingsSection: null }),
  toggleResourceDrawer: () => set((s) => ({ resourceDrawerOpen: !s.resourceDrawerOpen })),

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

  setMainView: (v) => set({ mainView: v }),

  setSidebarWsExpanded: (v) => {
    if (typeof localStorage !== "undefined") localStorage.setItem(LS_WS_EXPANDED, String(v));
    set({ sidebarWsExpanded: v });
  },
  setSidebarOtherExpanded: (v) => {
    if (typeof localStorage !== "undefined") localStorage.setItem(LS_OTHER_EXPANDED, String(v));
    set({ sidebarOtherExpanded: v });
  },
  setSidebarServicesCollapsed: (v) => {
    if (typeof localStorage !== "undefined") localStorage.setItem(LS_SERVICES_COLLAPSED, String(v));
    set({ sidebarServicesCollapsed: v });
  },
  setAppInstancesExpanded: (appId, v) =>
    set((s) => {
      const next = { ...s.appInstancesExpanded, [appId]: v };
      if (typeof localStorage !== "undefined") localStorage.setItem(LS_INSTANCES_EXPANDED, JSON.stringify(next));
      return { appInstancesExpanded: next };
    }),
});
