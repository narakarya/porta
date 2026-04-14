import type { App, Service } from "../types";
import { setMockEventCallback } from "../lib/mock-data";
import * as cmd from "../lib/commands";
import { MAX_LOG_LINES } from "./slices/app";
import type { AllSlices } from "./index";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

type SetFn = (partial: Partial<AllSlices> | ((state: AllSlices) => Partial<AllSlices>)) => void;
type GetFn = () => AllSlices;

export function subscribeToAppEvents(get: GetFn, set: SetFn): () => void {
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
          appStartedAt: { ...s.appStartedAt, [appId]: Date.now() },
        }));
      } else if (event === "exit") {
        const { [appId]: _, ...restStartedAt } = get().appStartedAt;
        set((s) => ({
          apps: s.apps.map((a) =>
            a.id === appId ? { ...a, status: "stopped" as const, pid: null } : a
          ),
          appExitCode: { ...s.appExitCode, [appId]: payload as number },
          appStartedAt: restStartedAt,
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
        const { [app.id]: _, ...restStartedAt } = get().appStartedAt;
        set((s) => ({
          apps: s.apps.map((a) =>
            a.id === app.id ? { ...a, status: "stopped" as const, pid: null } : a
          ),
          appExitCode: { ...s.appExitCode, [app.id]: e.payload },
          appStartedAt: restStartedAt,
        }));
        cmd.markAppStopped(app.id).catch(() => {});
      }).then((fn) => cancelled ? fn() : unlisteners.push(fn));

      listen(`app:ready:${app.id}`, () => {
        set((s) => ({
          apps: s.apps.map((a) =>
            a.id === app.id ? { ...a, status: "running" as const } : a
          ),
          appRestarting: { ...s.appRestarting, [app.id]: false },
          appStartedAt: { ...s.appStartedAt, [app.id]: Date.now() },
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

      // Metrics
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
  const subscribeForServices = async (services: Service[]) => {
    const { listen } = await import("@tauri-apps/api/event");
    services.forEach((svc) => {
      listen<{ status: string; container_id: string | null }>(
        `service:status:${svc.id}`,
        (e) => {
          set((s) => ({
            services: s.services.map((sv) =>
              sv.id === svc.id
                ? { ...sv, status: e.payload.status as Service["status"], container_id: e.payload.container_id }
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

  // Access the store lazily via dynamic import to avoid circular dependency at module load time.
  // By the time subscribeToAppEvents is called (from main.tsx after store creation),
  // the module will already be in the ES module cache so this is effectively synchronous.
  let unsub: () => void = () => {};
  import("./index").then(({ usePortaStore }) => {
    unsub = usePortaStore.subscribe((state) => {
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
  });

  return () => {
    cancelPending();
    unlisteners.forEach((fn) => fn());
    unsub();
  };
}
