import type { StateCreator } from "zustand";
import type { SetupStatus } from "../../types";
import type { AllSlices } from "../index";
import type { ExtensionInfo } from "../../types/extension";
import * as cmd from "../../lib/commands";

export type ExtensionSidebarState = {
  appId: string;
  extensions: ExtensionInfo[];
};

export interface UiSlice {
  setupStatus: SetupStatus | null;
  loading: boolean;
  error: string | null;
  openToasts: string[];
  notificationsEnabled: boolean;
  imageUpdateNotifyEnabled: boolean;
  extensionSidebar: ExtensionSidebarState | null;

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
