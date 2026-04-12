import { create } from "zustand";
import type { App, SetupStatus, Workspace } from "../types";
import * as cmd from "../lib/commands";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const MAX_LOG_LINES = 200;

interface PortaState {
  // ── Data ─────────────────────────────────────────────────────────────────
  workspaces: Workspace[];
  apps: App[];
  selectedWorkspaceId: string | null;
  setupStatus: SetupStatus | null;

  // ── Per-app logs & exit info ──────────────────────────────────────────────
  appLogs: Record<string, string[]>;
  appExitCode: Record<string, number | null>; // null = running / clean stop
  appRetryCount: Record<string, number>; // auto-restart attempt count
  portConflicts: Record<string, boolean>; // app IDs with active port conflicts

  // ── Global settings ───────────────────────────────────────────────────────
  notificationsEnabled: boolean;

  // ── Async status ─────────────────────────────────────────────────────────
  loading: boolean;
  error: string | null;

  // ── Actions ──────────────────────────────────────────────────────────────
  load: () => Promise<void>;
  checkSetup: () => Promise<void>;
  loadSettings: () => Promise<void>;
  selectWorkspace: (id: string | null) => void;

  addWorkspace: (name: string, domain: string) => Promise<void>;
  updateWorkspace: (id: string, name: string, domain: string) => Promise<void>;
  deleteWorkspace: (id: string) => Promise<void>;

  addApp: (params: Parameters<typeof cmd.addApp>[0]) => Promise<void>;
  updateApp: (params: Parameters<typeof cmd.updateApp>[0]) => Promise<void>;
  deleteApp: (id: string) => Promise<void>;
  startApp: (id: string) => Promise<void>;
  stopApp: (id: string) => Promise<void>;
  killApp: (id: string) => Promise<void>;
  clearAppLogs: (id: string) => void;
  dismissPortConflict: (id: string) => void;
  setNotificationsEnabled: (enabled: boolean) => Promise<void>;

  // ── Derived helpers ───────────────────────────────────────────────────────
  visibleApps: () => App[];

  // ── Internal ─────────────────────────────────────────────────────────────
  _subscribeToAppEvents: () => () => void;
}

export const usePortaStore = create<PortaState>((set, get) => ({
  workspaces: [],
  apps: [],
  selectedWorkspaceId: null,
  setupStatus: null,
  appLogs: {},
  appExitCode: {},
  appRetryCount: {},
  portConflicts: {},
  notificationsEnabled: true,
  loading: false,
  error: null,

  checkSetup: async () => {
    const setupStatus = await cmd.checkSetup();
    set({ setupStatus });
  },

  loadSettings: async () => {
    try {
      const enabled = await cmd.getNotificationsEnabled();
      set({ notificationsEnabled: enabled });
    } catch {}
  },

  load: async () => {
    set({ loading: true, error: null });
    try {
      const [workspaces, apps] = await Promise.all([
        cmd.listWorkspaces(),
        cmd.listApps(),
      ]);
      // Auto-select first workspace if nothing is selected yet
      const currentId = get().selectedWorkspaceId;
      const selectedWorkspaceId =
        currentId !== null
          ? currentId
          : workspaces.length > 0
          ? workspaces[0].id
          : null;
      set({ workspaces, apps, selectedWorkspaceId, loading: false });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  selectWorkspace: (id) => set({ selectedWorkspaceId: id }),

  addWorkspace: async (name, domain) => {
    const workspace = await cmd.addWorkspace(name, domain);
    set((s) => ({ workspaces: [...s.workspaces, workspace] }));
  },

  updateWorkspace: async (id, name, domain) => {
    const updated = await cmd.updateWorkspace(id, name, domain);
    set((s) => ({
      workspaces: s.workspaces.map((w) => (w.id === id ? updated : w)),
    }));
  },

  deleteWorkspace: async (id) => {
    await cmd.deleteWorkspace(id);
    set((s) => ({
      workspaces: s.workspaces.filter((w) => w.id !== id),
      apps: s.apps.filter((a) => a.workspace_id !== id),
      selectedWorkspaceId: s.selectedWorkspaceId === id ? null : s.selectedWorkspaceId,
    }));
  },

  addApp: async (params) => {
    const app = await cmd.addApp(params);
    set((s) => ({ apps: [...s.apps, app] }));
  },

  updateApp: async (params) => {
    const updated = await cmd.updateApp(params);
    set((s) => ({
      apps: s.apps.map((a) => (a.id === params.id ? updated : a)),
    }));
  },

  deleteApp: async (id) => {
    await cmd.deleteApp(id);
    set((s) => ({
      apps: s.apps.filter((a) => a.id !== id),
      appLogs: Object.fromEntries(Object.entries(s.appLogs).filter(([k]) => k !== id)),
      appExitCode: Object.fromEntries(Object.entries(s.appExitCode).filter(([k]) => k !== id)),
      appRetryCount: Object.fromEntries(Object.entries(s.appRetryCount).filter(([k]) => k !== id)),
      portConflicts: Object.fromEntries(Object.entries(s.portConflicts).filter(([k]) => k !== id)),
    }));
  },

  startApp: async (id) => {
    set((s) => ({
      appLogs: { ...s.appLogs, [id]: [] },
      appExitCode: { ...s.appExitCode, [id]: null },
      appRetryCount: { ...s.appRetryCount, [id]: 0 },
      portConflicts: { ...s.portConflicts, [id]: false },
    }));
    await cmd.startApp(id);
    set((s) => ({
      apps: s.apps.map((a) =>
        a.id === id ? { ...a, status: "starting" as const } : a
      ),
    }));
  },

  stopApp: async (id) => {
    await cmd.stopApp(id);
    set((s) => ({
      apps: s.apps.map((a) =>
        a.id === id ? { ...a, status: "stopped" as const, pid: null } : a
      ),
      appRetryCount: { ...s.appRetryCount, [id]: 0 },
    }));
  },

  killApp: async (id) => {
    await cmd.killApp(id);
    set((s) => ({
      apps: s.apps.map((a) =>
        a.id === id ? { ...a, status: "stopped" as const, pid: null } : a
      ),
      appRetryCount: { ...s.appRetryCount, [id]: 0 },
    }));
  },

  clearAppLogs: (id) =>
    set((s) => ({ appLogs: { ...s.appLogs, [id]: [] } })),

  dismissPortConflict: (id) =>
    set((s) => ({ portConflicts: { ...s.portConflicts, [id]: false } })),

  setNotificationsEnabled: async (enabled) => {
    await cmd.setNotificationsEnabled(enabled);
    set({ notificationsEnabled: enabled });
  },

  visibleApps: () => {
    const { apps, selectedWorkspaceId } = get();
    if (selectedWorkspaceId === null) return apps;
    return apps.filter((a) => a.workspace_id === selectedWorkspaceId);
  },

  _subscribeToAppEvents: () => {
    // In browser-only mode, Tauri events are unavailable — skip entirely.
    if (!isTauri) return () => {};

    const unlisteners: Array<() => void> = [];
    // Cancels any still-pending listen() promises from the previous subscribeForApps call
    let cancelPending = () => {};

    const subscribeForApps = async (apps: App[]) => {
      const { listen } = await import("@tauri-apps/api/event");
      // Cancel any promises that haven't resolved yet from the last call
      cancelPending();
      // Remove already-resolved listeners
      unlisteners.forEach((fn) => fn());
      unlisteners.length = 0;

      let cancelled = false;
      cancelPending = () => { cancelled = true; };

      apps.forEach((app) => {
        listen<string>(`app:log:${app.id}`, (e) => {
          set((s) => {
            const prev = s.appLogs[app.id] ?? [];
            const next = [...prev, e.payload];
            return {
              appLogs: {
                ...s.appLogs,
                [app.id]: next.length > MAX_LOG_LINES ? next.slice(-MAX_LOG_LINES) : next,
              },
            };
          });
        }).then((fn) => cancelled ? fn() : unlisteners.push(fn));

        listen<number>(`app:exit:${app.id}`, (e) => {
          set((s) => ({
            apps: s.apps.map((a) =>
              a.id === app.id ? { ...a, status: "stopped" as const, pid: null } : a
            ),
            appExitCode: { ...s.appExitCode, [app.id]: e.payload },
          }));
          cmd.markAppStopped(app.id).catch(() => {});
        }).then((fn) => cancelled ? fn() : unlisteners.push(fn));

        listen(`app:ready:${app.id}`, () => {
          set((s) => ({
            apps: s.apps.map((a) =>
              a.id === app.id ? { ...a, status: "running" as const } : a
            ),
          }));
          cmd.markAppReady(app.id).catch(() => {});
        }).then((fn) => cancelled ? fn() : unlisteners.push(fn));

        // Auto-restart: crashed and retrying
        listen<{ exit_code: number; attempt: number; max: number }>(`app:crashed:${app.id}`, (e) => {
          set((s) => ({
            appRetryCount: { ...s.appRetryCount, [app.id]: e.payload.attempt },
            apps: s.apps.map((a) =>
              a.id === app.id ? { ...a, status: "starting" as const } : a
            ),
          }));
        }).then((fn) => cancelled ? fn() : unlisteners.push(fn));

        // Auto-restart: gave up after max retries
        listen(`app:max-retries:${app.id}`, () => {
          set((s) => ({
            appRetryCount: { ...s.appRetryCount, [app.id]: 0 },
          }));
        }).then((fn) => cancelled ? fn() : unlisteners.push(fn));

        // Port conflict detected before start
        listen<number>(`app:port-conflict:${app.id}`, () => {
          set((s) => ({
            portConflicts: { ...s.portConflicts, [app.id]: true },
          }));
        }).then((fn) => cancelled ? fn() : unlisteners.push(fn));
      });
    };

    subscribeForApps(get().apps);

    // Only re-subscribe when the apps list itself changes (added/removed),
    // not on every status update — avoids thrashing listeners on start/stop.
    const subscribedIds = () => get().apps.map((a) => a.id).join(",");
    let lastIds = subscribedIds();

    const unsub = usePortaStore.subscribe((state) => {
      const ids = state.apps.map((a) => a.id).join(",");
      if (ids !== lastIds) {
        lastIds = ids;
        subscribeForApps(state.apps);
      }
    });

    return () => {
      cancelPending();
      unlisteners.forEach((fn) => fn());
      unsub();
    };
  },
}));
