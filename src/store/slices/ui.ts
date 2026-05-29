import type { StateCreator } from "zustand";
import type { SetupStatus } from "../../types";
import type { AllSlices } from "../index";
import type { ExtensionInfo } from "../../types/extension";
import * as cmd from "../../lib/commands";

export type ExtensionSidebarState = {
  appId: string;
  extensions: ExtensionInfo[];
};

/**
 * App-updater state machine. Lives in the store so any component (the
 * Settings → About button, the global toast, future menubar UI…) sees the
 * same phase and can't kick off a second download while one is in flight.
 *
 * Transitions:
 *   idle → checking → idle             (no update found)
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

export interface UiSlice {
  setupStatus: SetupStatus | null;
  loading: boolean;
  error: string | null;
  openToasts: string[];
  notificationsEnabled: boolean;
  imageUpdateNotifyEnabled: boolean;
  extensionSidebar: ExtensionSidebarState | null;
  updaterPhase: UpdaterPhase;
  updaterInfo: UpdaterInfo | null;
  updaterError: string | null;

  checkSetup: () => Promise<void>;
  loadSettings: () => Promise<void>;
  registerToast: (id: string) => void;
  unregisterToast: (id: string) => void;
  getToastIndex: (id: string) => number;
  setNotificationsEnabled: (enabled: boolean) => Promise<void>;
  setImageUpdateNotifyEnabled: (enabled: boolean) => Promise<void>;
  openExtensionSidebar: (appId: string, extensions: ExtensionInfo[]) => void;
  closeExtensionSidebar: () => void;
}

export const createUiSlice: StateCreator<AllSlices, [], [], UiSlice> = (set, get) => ({
  setupStatus: null,
  loading: false,
  error: null,
  openToasts: [],
  notificationsEnabled: true,
  imageUpdateNotifyEnabled: true,
  extensionSidebar: null,
  updaterPhase: "idle",
  updaterInfo: null,
  updaterError: null,

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

  openExtensionSidebar: (appId, extensions) =>
    set({ extensionSidebar: { appId, extensions } }),

  closeExtensionSidebar: () => set({ extensionSidebar: null }),
});
