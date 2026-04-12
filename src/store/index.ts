import { create } from "zustand";
import type { App, Service, SetupStatus, Workspace } from "../types";
import * as cmd from "../lib/commands";
import { setMockEventCallback, startMockProcess, stopMockProcess, killMockProcess } from "../lib/mock-data";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const MAX_LOG_LINES = 2000;

// ── Deploy session state ──────────────────────────────────────────────────────
export interface KamalCmdState {
  logs: string[];
  running: boolean;
  exitCode: number | null;
  startedAt: number | null;
  runId: string | null;
}

export interface AppDeploySession {
  cmdStates: Record<string, KamalCmdState>;
  selectedCmdId: string;
}

interface PortaState {
  // ── Data ─────────────────────────────────────────────────────────────────
  workspaces: Workspace[];
  apps: App[];
  services: Service[];
  selectedWorkspaceId: string | null;
  setupStatus: SetupStatus | null;

  // ── Per-app logs & exit info ──────────────────────────────────────────────
  appLogs: Record<string, string[]>;
  appExitCode: Record<string, number | null>; // null = running / clean stop
  appRetryCount: Record<string, number>; // auto-restart attempt count
  portConflicts: Record<string, boolean>; // app IDs with active port conflicts
  appRestarting: Record<string, boolean>; // app IDs currently mid-restart
  appTunnelErrors: Record<string, string | null>; // last tunnel error per app

  // ── Per-app resource metrics (from agent-a7a6ec3b) ────────────────────────
  appMetrics: Record<string, { cpu: number; mem_mb: number }>;

  // ── Per-service logs (from agent-a3728d7d) ────────────────────────────────
  serviceLogs: Record<string, string[]>;

  // ── Deploy session state ──────────────────────────────────────────────────
  deploySessions: Record<string, AppDeploySession>;
  setDeploySelectedCmd: (appId: string, cmdId: string) => void;
  updateDeployCmdState: (appId: string, cmdId: string, patch: Partial<KamalCmdState>) => void;
  appendDeployLog: (appId: string, cmdId: string, line: string) => void;

  // ── Toast stacking ──────────────────────────────────────────────────────
  openToasts: string[]; // ordered list of app IDs with open log toasts
  registerToast: (id: string) => void;
  unregisterToast: (id: string) => void;
  getToastIndex: (id: string) => number;

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
  reorderWorkspaces: (fromIndex: number, toIndex: number) => void;
  reorderServices: (fromIndex: number, toIndex: number) => void;

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
  setNotificationsEnabled: (enabled: boolean) => Promise<void>;

  // ── Tunnel actions (from agent-a02c9388) ─────────────────────────────────
  startTunnel: (id: string) => void;
  stopTunnel: (id: string) => void;

  // ── Service actions (from agent-a3728d7d) ────────────────────────────────
  loadServices: () => Promise<void>;
  addService: (params: Parameters<typeof cmd.addService>[0]) => Promise<void>;
  updateService: (id: string, params: Parameters<typeof cmd.updateService>[1]) => Promise<void>;
  deleteService: (id: string) => Promise<void>;
  startService: (id: string) => void;
  stopService: (id: string) => Promise<void>;
  clearServiceLogs: (id: string) => void;

  // ── Derived helpers ───────────────────────────────────────────────────────
  visibleApps: () => App[];

  // ── Internal ─────────────────────────────────────────────────────────────
  _subscribeToAppEvents: () => () => void;
}

export const usePortaStore = create<PortaState>((set, get) => ({
  workspaces: [],
  apps: [],
  services: [],
  selectedWorkspaceId: null,
  setupStatus: null,
  appLogs: {},
  appExitCode: {},
  appRetryCount: {},
  portConflicts: {},
  appRestarting: {},
  appTunnelErrors: {},
  appMetrics: {},
  serviceLogs: {},
  deploySessions: {},

  setDeploySelectedCmd: (appId, cmdId) =>
    set((s) => ({
      deploySessions: {
        ...s.deploySessions,
        [appId]: {
          ...(s.deploySessions[appId] ?? { cmdStates: {} }),
          selectedCmdId: cmdId,
        },
      },
    })),

  updateDeployCmdState: (appId, cmdId, patch) =>
    set((s) => {
      const session = s.deploySessions[appId] ?? { cmdStates: {}, selectedCmdId: "" };
      const prev = session.cmdStates[cmdId] ?? { logs: [], running: false, exitCode: null, startedAt: null, runId: null };
      return {
        deploySessions: {
          ...s.deploySessions,
          [appId]: {
            ...session,
            cmdStates: { ...session.cmdStates, [cmdId]: { ...prev, ...patch } },
          },
        },
      };
    }),

  appendDeployLog: (appId, cmdId, line) =>
    set((s) => {
      const session = s.deploySessions[appId] ?? { cmdStates: {}, selectedCmdId: "" };
      const prev = session.cmdStates[cmdId] ?? { logs: [], running: false, exitCode: null, startedAt: null, runId: null };
      return {
        deploySessions: {
          ...s.deploySessions,
          [appId]: {
            ...session,
            cmdStates: {
              ...session.cmdStates,
              [cmdId]: { ...prev, logs: [...prev.logs, line] },
            },
          },
        },
      };
    }),
  openToasts: [],
  registerToast: (id) =>
    set((s) => ({
      openToasts: s.openToasts.includes(id) ? s.openToasts : [...s.openToasts, id],
    })),
  unregisterToast: (id) =>
    set((s) => ({ openToasts: s.openToasts.filter((t) => t !== id) })),
  getToastIndex: (id) => get().openToasts.indexOf(id),

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
      const [workspaces, apps, services] = await Promise.all([
        cmd.listWorkspaces(),
        cmd.listApps(),
        cmd.listServices().catch(() => [] as import("../types").Service[]),
      ]);
      // Auto-select first workspace if nothing is selected yet
      const currentId = get().selectedWorkspaceId;
      const selectedWorkspaceId =
        currentId !== null
          ? currentId
          : workspaces.length > 0
          ? workspaces[0].id
          : null;
      set({ workspaces, apps, services, selectedWorkspaceId, loading: false });

      // Replay persisted logs for apps that were already running when Porta starts.
      // Each app's log file is truncated on every fresh start so these are from the current run.
      if (isTauri) {
        for (const app of apps) {
          if (app.status === "running" || app.status === "starting") {
            cmd.getAppLogs(app.id).then((logs) => {
              if (logs.length === 0) return;
              set((s) => ({
                appLogs: {
                  ...s.appLogs,
                  [app.id]: logs.slice(-MAX_LOG_LINES),
                },
              }));
            }).catch(() => {});
          }
        }
      }
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  selectWorkspace: (id) => set({ selectedWorkspaceId: id }),

  reorderWorkspaces: (fromIndex, toIndex) => {
    const list = [...get().workspaces];
    const [moved] = list.splice(fromIndex, 1);
    list.splice(toIndex, 0, moved);
    set({ workspaces: list });
    cmd.reorderWorkspaces(list.map((w) => w.id));
  },

  reorderServices: (fromIndex, toIndex) => {
    const list = [...get().services];
    const [moved] = list.splice(fromIndex, 1);
    list.splice(toIndex, 0, moved);
    set({ services: list });
    cmd.reorderServices(list.map((s) => s.id));
  },

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
    set((s) => ({
      apps: s.apps.map((a) =>
        a.id === id ? { ...a, status: "stopped" as const, pid: null } : a
      ),
      appRetryCount: { ...s.appRetryCount, [id]: 0 },
      appRestarting: { ...s.appRestarting, [id]: false },
    }));
  },

  restartApp: async (id) => {
    // Mark as restarting atomically with status/log reset — no race with Zustand sync renders
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
    } else {
      stopMockProcess(id);
      startMockProcess(id);
      // Re-mark as starting so isActive=true immediately (stopMockProcess set it to stopped)
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

  // ── Tunnel actions ────────────────────────────────────────────────────────

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

  // ── Service actions (from agent-a3728d7d) ─────────────────────────────────

  loadServices: async () => {
    const services = await cmd.listServices();
    set({ services });
  },

  addService: async (params) => {
    const svc = await cmd.addService(params);
    set((s) => ({ services: [...s.services, svc] }));
  },

  updateService: async (id, params) => {
    const updated = await cmd.updateService(id, params);
    set((s) => ({
      services: s.services.map((svc) => (svc.id === id ? updated : svc)),
    }));
  },

  deleteService: async (id) => {
    await cmd.deleteService(id);
    set((s) => ({
      services: s.services.filter((svc) => svc.id !== id),
      serviceLogs: Object.fromEntries(
        Object.entries(s.serviceLogs).filter(([k]) => k !== id)
      ),
    }));
  },

  startService: async (id) => {
    set((s) => ({
      services: s.services.map((svc) =>
        svc.id === id ? { ...svc, status: "pulling" as const } : svc
      ),
      serviceLogs: { ...s.serviceLogs, [id]: [] },
    }));

    if (isTauri) {
      // Real Docker path — status/log updates arrive via service:status and service:log events
      await cmd.startService(id);
    } else {
      // Browser mock path — uses callback
      cmd.startService(id, (status, containerId) => {
        set((s) => ({
          services: s.services.map((svc) =>
            svc.id === id ? { ...svc, status, container_id: containerId } : svc
          ),
        }));
      });
    }
  },

  stopService: async (id) => {
    await cmd.stopService(id);
    set((s) => ({
      services: s.services.map((svc) =>
        svc.id === id ? { ...svc, status: "stopped" as const, container_id: null } : svc
      ),
    }));
  },

  clearServiceLogs: (id) =>
    set((s) => ({ serviceLogs: { ...s.serviceLogs, [id]: [] } })),

  visibleApps: () => {
    const { apps, selectedWorkspaceId } = get();
    if (selectedWorkspaceId === null) return apps;
    return apps.filter((a) => a.workspace_id === selectedWorkspaceId);
  },

  _subscribeToAppEvents: () => {
    // In browser-only mode, use mock event system instead of Tauri events.
    if (!isTauri) {
      setMockEventCallback((event, appId, payload) => {
        if (event === "log") {
          set((s) => {
            const prev = s.appLogs[appId] ?? [];
            const next = [...prev, payload as string];
            return {
              appLogs: {
                ...s.appLogs,
                [appId]: next.length > MAX_LOG_LINES ? next.slice(-MAX_LOG_LINES) : next,
              },
            };
          });
        } else if (event === "ready") {
          set((s) => ({
            apps: s.apps.map((a) =>
              a.id === appId ? { ...a, status: "running" as const } : a
            ),
            appRestarting: { ...s.appRestarting, [appId]: false },
          }));
        } else if (event === "exit") {
          set((s) => ({
            apps: s.apps.map((a) =>
              a.id === appId ? { ...a, status: "stopped" as const, pid: null } : a
            ),
            appExitCode: { ...s.appExitCode, [appId]: payload as number },
          }));
        } else if (event === "crashed") {
          const p = payload as { exit_code: number; attempt: number; max: number };
          set((s) => ({
            appRetryCount: { ...s.appRetryCount, [appId]: p.attempt },
            apps: s.apps.map((a) =>
              a.id === appId ? { ...a, status: "starting" as const } : a
            ),
          }));
        } else if (event === "max-retries") {
          set((s) => ({
            appRetryCount: { ...s.appRetryCount, [appId]: 0 },
            appRestarting: { ...s.appRestarting, [appId]: false },
          }));
        } else if (event === "port-conflict") {
          set((s) => ({
            portConflicts: { ...s.portConflicts, [appId]: true },
          }));
        }
      });
      return () => setMockEventCallback(() => {});
    }

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
            appRestarting: { ...s.appRestarting, [app.id]: false },
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
            appRestarting: { ...s.appRestarting, [app.id]: false },
          }));
        }).then((fn) => cancelled ? fn() : unlisteners.push(fn));

        // Port conflict detected before start
        listen<number>(`app:port-conflict:${app.id}`, () => {
          set((s) => ({
            portConflicts: { ...s.portConflicts, [app.id]: true },
          }));
        }).then((fn) => cancelled ? fn() : unlisteners.push(fn));

        // Metrics (from agent-a7a6ec3b)
        listen<{ cpu: number; mem_mb: number }>(`app:metrics:${app.id}`, (e) => {
          set((s) => ({
            appMetrics: { ...s.appMetrics, [app.id]: e.payload },
          }));
        }).then((fn) => cancelled ? fn() : unlisteners.push(fn));

        // Tunnel URL from cloudflared
        listen<{ active: boolean; url?: string | null; error?: string }>(`app:tunnel:${app.id}`, (e) => {
          set((s) => ({
            apps: s.apps.map((a) =>
              a.id === app.id
                ? { ...a, tunnel_active: e.payload.active, tunnel_url: e.payload.url ?? null }
                : a
            ),
            appTunnelErrors: {
              ...s.appTunnelErrors,
              [app.id]: e.payload.error ?? null,
            },
          }));
        }).then((fn) => cancelled ? fn() : unlisteners.push(fn));
      });
    };

    // ── Service event subscriptions ────────────────────────────────────────
    const subscribeForServices = async (services: import("../types").Service[]) => {
      const { listen } = await import("@tauri-apps/api/event");
      services.forEach((svc) => {
        listen<{ status: string; container_id: string | null }>(
          `service:status:${svc.id}`,
          (e) => {
            set((s) => ({
              services: s.services.map((sv) =>
                sv.id === svc.id
                  ? { ...sv, status: e.payload.status as import("../types").Service["status"], container_id: e.payload.container_id }
                  : sv
              ),
            }));
          }
        ).then((fn) => unlisteners.push(fn));

        listen<string>(`service:log:${svc.id}`, (e) => {
          set((s) => {
            const prev = s.serviceLogs[svc.id] ?? [];
            const next = [...prev, e.payload];
            return {
              serviceLogs: {
                ...s.serviceLogs,
                [svc.id]: next.length > MAX_LOG_LINES ? next.slice(-MAX_LOG_LINES) : next,
              },
            };
          });
        }).then((fn) => unlisteners.push(fn));
      });
    };

    subscribeForApps(get().apps);
    subscribeForServices(get().services);

    // Only re-subscribe when the apps/services list itself changes (added/removed),
    // not on every status update — avoids thrashing listeners on start/stop.
    const subscribedIds = () => get().apps.map((a) => a.id).join(",");
    const subscribedSvcIds = () => get().services.map((s) => s.id).join(",");
    let lastIds = subscribedIds();
    let lastSvcIds = subscribedSvcIds();

    const unsub = usePortaStore.subscribe((state) => {
      const ids = state.apps.map((a) => a.id).join(",");
      if (ids !== lastIds) {
        lastIds = ids;
        subscribeForApps(state.apps);
      }
      const svcIds = state.services.map((s) => s.id).join(",");
      if (svcIds !== lastSvcIds) {
        lastSvcIds = svcIds;
        subscribeForServices(state.services);
      }
    });

    return () => {
      cancelPending();
      unlisteners.forEach((fn) => fn());
      unsub();
    };
  },
}));
