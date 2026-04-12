import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import type { App, SetupStatus, Workspace } from "../types";
import * as cmd from "../lib/commands";

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

  // ── Async status ─────────────────────────────────────────────────────────
  loading: boolean;
  error: string | null;

  // ── Actions ──────────────────────────────────────────────────────────────
  load: () => Promise<void>;
  checkSetup: () => Promise<void>;
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
  loading: false,
  error: null,

  checkSetup: async () => {
    const setupStatus = await cmd.checkSetup();
    set({ setupStatus });
  },

  load: async () => {
    set({ loading: true, error: null });
    try {
      const [workspaces, apps] = await Promise.all([
        cmd.listWorkspaces(),
        cmd.listApps(),
      ]);
      set({ workspaces, apps, loading: false });
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
    }));
  },

  startApp: async (id) => {
    set((s) => ({
      appLogs: { ...s.appLogs, [id]: [] },
      appExitCode: { ...s.appExitCode, [id]: null },
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
    }));
  },

  killApp: async (id) => {
    await cmd.killApp(id);
    set((s) => ({
      apps: s.apps.map((a) =>
        a.id === id ? { ...a, status: "stopped" as const, pid: null } : a
      ),
    }));
  },

  clearAppLogs: (id) =>
    set((s) => ({ appLogs: { ...s.appLogs, [id]: [] } })),

  visibleApps: () => {
    const { apps, selectedWorkspaceId } = get();
    if (selectedWorkspaceId === null) return apps;
    return apps.filter((a) => a.workspace_id === selectedWorkspaceId);
  },

  _subscribeToAppEvents: () => {
    const unlisteners: Array<() => void> = [];

    const subscribeForApps = (apps: App[]) => {
      unlisteners.forEach((fn) => fn());
      unlisteners.length = 0;

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
        }).then((fn) => unlisteners.push(fn));

        listen<number>(`app:exit:${app.id}`, (e) => {
          set((s) => ({
            apps: s.apps.map((a) =>
              a.id === app.id ? { ...a, status: "stopped" as const, pid: null } : a
            ),
            appExitCode: { ...s.appExitCode, [app.id]: e.payload },
          }));
          cmd.markAppStopped(app.id).catch(() => {});
        }).then((fn) => unlisteners.push(fn));

        listen(`app:ready:${app.id}`, () => {
          set((s) => ({
            apps: s.apps.map((a) =>
              a.id === app.id ? { ...a, status: "running" as const } : a
            ),
          }));
          cmd.markAppReady(app.id).catch(() => {});
        }).then((fn) => unlisteners.push(fn));
      });
    };

    subscribeForApps(get().apps);

    const unsub = usePortaStore.subscribe((state, prev) => {
      if (state.apps !== prev.apps) {
        subscribeForApps(state.apps);
      }
    });

    return () => {
      unlisteners.forEach((fn) => fn());
      unsub();
    };
  },
}));
