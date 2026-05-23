import type { StateCreator } from "zustand";
import type { App, HealthStatus, ImageUpdateInfo } from "../../types";
import type { AllSlices } from "../index";
import * as cmd from "../../lib/commands";
import { startMockProcess, stopMockProcess, killMockProcess } from "../../lib/mock-data";

export const MAX_LOG_LINES = 10000;

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
  imageUpdateCache: Record<string, ImageUpdateInfo[]>;
  imageUpdateLastChecked: Record<string, number>;

  refreshHealth: () => Promise<void>;
  refreshApp: (id: string) => Promise<void>;
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
  startTunnel: (id: string, providerOverride?: string, funnel?: boolean) => Promise<void>;
  stopTunnel: (id: string) => Promise<void>;
  visibleApps: () => App[];
  setImageUpdateCache: (appId: string, info: ImageUpdateInfo[]) => void;
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
  imageUpdateCache: {},
  imageUpdateLastChecked: {},

  refreshHealth: async () => {
    try {
      const statuses = await cmd.checkAllHealth();
      set({ healthStatuses: statuses });
    } catch {}
  },

  refreshApp: async (id) => {
    try {
      const all = await cmd.listApps();
      const found = all.find((a) => a.id === id);
      if (found) {
        set((s) => ({
          apps: s.apps.map((a) => (a.id === id ? found : a)),
        }));
      }
    } catch {}
  },

  startAllInWorkspace: async (workspaceId) => {
    const { apps } = get();
    const wsAppIds = apps
      .filter((a) => a.workspace_id === workspaceId && a.status === "stopped" && (a.start_command || (a.kind === "docker" && a.docker_image) || (a.kind === "compose" && a.compose_file)))
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
      apps: s.apps.map((a) => (a.id === id ? { ...a, status: "starting" as const } : a)),
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
      // Re-affirm "starting" only in mock mode — for Tauri this would race
      // with the app:ready event and leave static/proxy apps stuck as "starting".
      set((s) => ({
        apps: s.apps.map((a) =>
          a.id === id ? { ...a, status: "starting" as const } : a
        ),
      }));
    }
  },

  stopApp: async (id) => {
    // Optimistic update — `cmd.stopApp` blocks until `docker compose down`
    // finishes (5-30s for stacks like Cap), so without this the user would
    // click Stop and see no change until the wait is over. Flipping locally
    // first also wins races against an in-flight restart's port watcher.
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
    if (isTauri) {
      await cmd.stopApp(id);
    } else {
      stopMockProcess(id);
    }
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
      try {
        await cmd.restartApp(id);
      } catch (e) {
        // If the IPC itself fails (e.g. compose down hangs and Tauri rejects),
        // clear the restarting flag so the UI doesn't stay frozen. The user
        // can then hit Stop / Restart again.
        set((s) => ({
          appRestarting: { ...s.appRestarting, [id]: false },
        }));
        throw e;
      }
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

  startTunnel: async (id, providerOverride, funnel) => {
    const app = get().apps.find((a) => a.id === id);
    if (!app) return;
    const provider = providerOverride ?? app.tunnel_provider ?? "cloudflare";
    // Persist the provider choice + clear stale error. Do NOT optimistically
    // set `tunnel_active: true` — that flips the button to "Disconnect"
    // before the connection actually succeeds, hiding the loading state and
    // making transient failures look like the tunnel "reverted to Connect".
    // The backend emits `app:tunnel:{id}` with active:true once it's real.
    set((s) => ({
      apps: s.apps.map((a) =>
        a.id === id ? { ...a, tunnel_provider: provider } : a
      ),
      appTunnelErrors: { ...s.appTunnelErrors, [id]: null },
    }));
    try {
      if (provider === "tailscale") {
        await cmd.startTailscaleServe(id, app.port, funnel ?? false);
      } else {
        await cmd.startTunnel(id, app.port);
      }
    } catch (e) {
      // Backend already emits an error event, but set defensively in case
      // the event is dropped (e.g. listener attached late).
      const msg = e instanceof Error ? e.message : String(e);
      set((s) => ({
        apps: s.apps.map((a) =>
          a.id === id ? { ...a, tunnel_active: false } : a
        ),
        appTunnelErrors: { ...s.appTunnelErrors, [id]: msg },
      }));
      throw e;
    }
  },

  stopTunnel: async (id) => {
    const app = get().apps.find((a) => a.id === id);
    const provider = app?.tunnel_provider ?? "cloudflare";
    set((s) => ({
      apps: s.apps.map((a) =>
        a.id === id ? { ...a, tunnel_active: false, tunnel_url: null } : a
      ),
    }));
    try {
      if (provider === "tailscale") {
        await cmd.stopTailscaleServe(id);
      } else {
        await cmd.stopTunnel(id);
      }
    } catch {
      // Best-effort: state already cleared optimistically.
    }
  },

  visibleApps: () => {
    const { apps, selectedWorkspaceId } = get();
    if (selectedWorkspaceId === null) return apps;
    return apps.filter((a) => a.workspace_id === selectedWorkspaceId);
  },

  setImageUpdateCache: (appId, info) =>
    set((s) => ({
      imageUpdateCache: { ...s.imageUpdateCache, [appId]: info },
      imageUpdateLastChecked: { ...s.imageUpdateLastChecked, [appId]: Date.now() },
    })),
});
