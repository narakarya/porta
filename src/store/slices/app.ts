import type { StateCreator } from "zustand";
import type { App, HealthStatus } from "../../types";
import type { AllSlices } from "../index";
import * as cmd from "../../lib/commands";
import { startMockProcess, stopMockProcess, killMockProcess } from "../../lib/mock-data";

export const MAX_LOG_LINES = 2000;

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface AppSlice {
  apps: App[];
  appLogs: Record<string, string[]>;
  appExitCode: Record<string, number | null>;
  appRetryCount: Record<string, number>;
  portConflicts: Record<string, boolean>;
  appRestarting: Record<string, boolean>;
  appTunnelErrors: Record<string, string | null>;
  appMetrics: Record<string, { cpu: number; mem_mb: number }>;
  appStartedAt: Record<string, number>;
  healthStatuses: Record<string, HealthStatus>;

  refreshHealth: () => Promise<void>;
  startAllInWorkspace: (workspaceId: string) => Promise<void>;
  stopAllInWorkspace: (workspaceId: string) => Promise<void>;
  addApp: (params: Parameters<typeof cmd.addApp>[0]) => Promise<void>;
  updateApp: (params: Parameters<typeof cmd.updateApp>[0]) => Promise<void>;
  cloneApp: (id: string) => Promise<void>;
  deleteApp: (id: string) => Promise<void>;
  startApp: (id: string) => Promise<void>;
  stopApp: (id: string) => Promise<void>;
  restartApp: (id: string) => Promise<void>;
  killApp: (id: string) => Promise<void>;
  clearAppLogs: (id: string) => void;
  dismissPortConflict: (id: string) => void;
  startTunnel: (id: string) => void;
  stopTunnel: (id: string) => void;
  visibleApps: () => App[];
}

export const createAppSlice: StateCreator<AllSlices, [], [], AppSlice> = (set, get) => ({
  apps: [],
  appLogs: {},
  appExitCode: {},
  appRetryCount: {},
  portConflicts: {},
  appRestarting: {},
  appTunnelErrors: {},
  appMetrics: {},
  appStartedAt: {},
  healthStatuses: {},

  refreshHealth: async () => {
    try {
      const statuses = await cmd.checkAllHealth();
      set({ healthStatuses: statuses });
    } catch {}
  },

  startAllInWorkspace: async (workspaceId) => {
    const { apps } = get();
    const wsAppIds = apps
      .filter((a) => a.workspace_id === workspaceId && a.status === "stopped" && a.start_command)
      .map((a) => a.id);

    if (wsAppIds.length === 0) return;

    set((s) => ({
      apps: s.apps.map((a) =>
        wsAppIds.includes(a.id) ? { ...a, status: "starting" as const } : a
      ),
      appLogs: wsAppIds.reduce((acc, id) => ({ ...acc, [id]: [] }), s.appLogs),
      appExitCode: wsAppIds.reduce((acc, id) => ({ ...acc, [id]: null }), s.appExitCode),
      appRetryCount: wsAppIds.reduce((acc, id) => ({ ...acc, [id]: 0 }), s.appRetryCount),
      portConflicts: wsAppIds.reduce((acc, id) => ({ ...acc, [id]: false }), s.portConflicts),
    }));

    if (isTauri) {
      await cmd.startWorkspaceApps(workspaceId);
    } else {
      wsAppIds.forEach((id) => startMockProcess(id));
    }
  },

  stopAllInWorkspace: async (workspaceId) => {
    const { apps } = get();
    const wsAppIds = apps
      .filter((a) => a.workspace_id === workspaceId && (a.status === "running" || a.status === "starting"))
      .map((a) => a.id);

    if (wsAppIds.length === 0) return;

    if (isTauri) {
      await cmd.stopWorkspaceApps(workspaceId);
    } else {
      wsAppIds.forEach((id) => stopMockProcess(id));
    }

    set((s) => {
      const restStartedAt = { ...s.appStartedAt };
      wsAppIds.forEach((id) => { delete restStartedAt[id]; });
      return {
        apps: s.apps.map((a) =>
          wsAppIds.includes(a.id) ? { ...a, status: "stopped" as const, pid: null } : a
        ),
        appRetryCount: wsAppIds.reduce((acc, id) => ({ ...acc, [id]: 0 }), s.appRetryCount),
        appRestarting: wsAppIds.reduce((acc, id) => ({ ...acc, [id]: false }), s.appRestarting),
        appStartedAt: restStartedAt,
      };
    });
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

  cloneApp: async (id) => {
    const cloned = await cmd.cloneApp(id);
    set((s) => ({ apps: [...s.apps, cloned] }));
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
    if (isTauri) {
      await cmd.startApp(id);
      // Load early log lines that were written before the event listener was ready
      setTimeout(() => {
        cmd.getAppLogs(id).then((logs) => {
          if (logs.length === 0) return;
          set((s) => {
            const current = s.appLogs[id] ?? [];
            // Merge: use file logs if they have more content than streamed logs
            if (logs.length > current.length) {
              return { appLogs: { ...s.appLogs, [id]: logs.slice(-MAX_LOG_LINES) } };
            }
            return {};
          });
        }).catch(() => {});
      }, 800);
    } else {
      startMockProcess(id);
    }
    set((s) => ({
      apps: s.apps.map((a) =>
        a.id === id ? { ...a, status: "starting" as const } : a
      ),
    }));
  },

  stopApp: async (id) => {
    if (isTauri) {
      await cmd.stopApp(id);
    } else {
      stopMockProcess(id);
    }
    set((s) => {
      const { [id]: _, ...restStartedAt } = s.appStartedAt;
      return {
        apps: s.apps.map((a) =>
          a.id === id ? { ...a, status: "stopped" as const, pid: null } : a
        ),
        appRetryCount: { ...s.appRetryCount, [id]: 0 },
        appRestarting: { ...s.appRestarting, [id]: false },
        appStartedAt: restStartedAt,
      };
    });
  },

  restartApp: async (id) => {
    set((s) => ({
      appRestarting: { ...s.appRestarting, [id]: true },
      apps: s.apps.map((a) => a.id === id ? { ...a, status: "starting" as const } : a),
      appLogs: { ...s.appLogs, [id]: [] },
      appExitCode: { ...s.appExitCode, [id]: null },
      appRetryCount: { ...s.appRetryCount, [id]: 0 },
      portConflicts: { ...s.portConflicts, [id]: false },
    }));
    if (isTauri) {
      await cmd.restartApp(id);
      // Load early log lines that were written before the event listener was ready
      setTimeout(() => {
        cmd.getAppLogs(id).then((logs) => {
          if (logs.length === 0) return;
          set((s) => {
            const current = s.appLogs[id] ?? [];
            if (logs.length > current.length) {
              return { appLogs: { ...s.appLogs, [id]: logs.slice(-MAX_LOG_LINES) } };
            }
            return {};
          });
        }).catch(() => {});
      }, 800);
    } else {
      stopMockProcess(id);
      startMockProcess(id);
      set((s) => ({
        apps: s.apps.map((a) => a.id === id ? { ...a, status: "starting" as const } : a),
      }));
    }
  },

  killApp: async (id) => {
    if (isTauri) {
      await cmd.killApp(id);
    } else {
      killMockProcess(id);
    }
    set((s) => {
      const { [id]: _, ...restStartedAt } = s.appStartedAt;
      return {
        apps: s.apps.map((a) =>
          a.id === id ? { ...a, status: "stopped" as const, pid: null } : a
        ),
        appRetryCount: { ...s.appRetryCount, [id]: 0 },
        appStartedAt: restStartedAt,
      };
    });
  },

  clearAppLogs: (id) =>
    set((s) => ({ appLogs: { ...s.appLogs, [id]: [] } })),

  dismissPortConflict: (id) =>
    set((s) => ({ portConflicts: { ...s.portConflicts, [id]: false } })),

  startTunnel: (id) => {
    const app = get().apps.find((a) => a.id === id);
    if (!app) return;
    set((s) => ({
      apps: s.apps.map((a) =>
        a.id === id
          ? { ...a, tunnel_provider: "cloudflare", tunnel_active: true, tunnel_url: null }
          : a
      ),
      appTunnelErrors: { ...s.appTunnelErrors, [id]: null },
    }));
    cmd.startTunnel(id, app.port).catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      set((s) => ({
        apps: s.apps.map((a) =>
          a.id === id ? { ...a, tunnel_active: false } : a
        ),
        appTunnelErrors: { ...s.appTunnelErrors, [id]: msg },
      }));
    });
  },

  stopTunnel: (id) => {
    cmd.stopTunnel(id).catch(() => {});
    set((s) => ({
      apps: s.apps.map((a) =>
        a.id === id ? { ...a, tunnel_active: false, tunnel_url: null } : a
      ),
    }));
  },

  visibleApps: () => {
    const { apps, selectedWorkspaceId } = get();
    if (selectedWorkspaceId === null) return apps;
    return apps.filter((a) => a.workspace_id === selectedWorkspaceId);
  },
});
