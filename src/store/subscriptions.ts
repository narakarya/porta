import type { App, Service } from "../types";
import { setMockEventCallback } from "../lib/mock-data";
import * as cmd from "../lib/commands";
import type { GitStatus, AppInstance } from "../lib/commands";
import { isDockerRuntimeUnavailable } from "../lib/docker-errors";
import { MAX_LOG_LINES, METRIC_HISTORY } from "./slices/app";
import type { AllSlices } from "./index";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

type SetFn = (partial: Partial<AllSlices> | ((state: AllSlices) => Partial<AllSlices>)) => void;
type GetFn = () => AllSlices;

// Persists for the session; resets on page reload. Prevents spamming the same
// "update available" notification on every periodic check cycle.
const notifiedUpdateApps = new Set<string>();
const SILENT_START_FAILED_PREFIX = "__porta_silent_start_failed__:";

// ── Log batching ───────────────────────────────────────────────────────────
// The backend emits one Tauri event per log line. Writing straight to the
// store per line meant every single line of a booting dev server (hundreds per
// second for Phoenix/Next/Vite) did an O(MAX_LOG_LINES) array copy, a spread of
// the whole logs map, a full Zustand subscriber notification (including the
// map/join id-diff below) and a React render pass. That's what froze the entire
// window — not just the starting app's card — for the duration of a start.
//
// Buffering into a Map and flushing on a timer collapses a burst of N lines
// into one store write, so render pressure is bounded at ~10/s regardless of
// how loud the app is.
const LOG_FLUSH_MS = 100;

type LogKey = "appLogs" | "serviceLogs";

function makeLogBatcher(set: SetFn, key: LogKey) {
  const pending = new Map<string, string[]>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    timer = null;
    if (pending.size === 0) return;
    const batch = Array.from(pending.entries());
    pending.clear();
    set((s) => {
      const next: Record<string, string[]> = { ...s[key] };
      for (const [id, lines] of batch) {
        const merged = (next[id] ?? []).concat(lines);
        next[id] = merged.length > MAX_LOG_LINES ? merged.slice(-MAX_LOG_LINES) : merged;
      }
      return { [key]: next } as Partial<AllSlices>;
    });
  };

  return (id: string, line: string) => {
    const buf = pending.get(id);
    if (buf) buf.push(line);
    else pending.set(id, [line]);
    // A burst longer than the buffer is pointless to keep — the tail wins.
    if (buf && buf.length > MAX_LOG_LINES) buf.splice(0, buf.length - MAX_LOG_LINES);
    if (timer === null) timer = setTimeout(flush, LOG_FLUSH_MS);
  };
}

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

  // Instances reuse the appLogs map (ids are UUIDs, no collision), so they
  // share the same batcher.
  const pushAppLog = makeLogBatcher(set, "appLogs");
  const pushServiceLog = makeLogBatcher(set, "serviceLogs");

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
        pushAppLog(app.id, e.payload);
      }).then((fn) => cancelled ? fn() : unlisteners.push(fn));

      listen<number>(`app:exit:${app.id}`, (e) => {
        // Guard against a stale exit racing a fresh start. Docker restart
        // does stop+rm then immediately runs the new container with the same
        // name — the *old* exit watcher fires `app:exit:0` AFTER `app:starting`
        // for the new run has already arrived. Without this guard, that
        // overwrites the optimistic "starting" status back to "stopped" and
        // the UI flashes "Start" until `app:ready` finally fires seconds
        // later. Only clean exits get this guard; failed starts (`exit:-1`)
        // must still fall back to stopped immediately.
        const current = get().apps.find((a) => a.id === app.id);
        const inFlightStart = current?.status === "starting" && e.payload === 0;
        const { [app.id]: _, ...restStartedAt } = get().appStartedAt;
        set((s) => ({
          apps: s.apps.map((a) =>
            a.id === app.id
              ? inFlightStart
                ? a  // keep "starting" — the new run is still booting
                : { ...a, status: "stopped" as const, pid: null }
              : a
          ),
          appExitCode: { ...s.appExitCode, [app.id]: e.payload },
          appStartedAt: restStartedAt,
          // Clear restarting flag — without this, a failed restart (compose
          // start error, port conflict, etc.) leaves the UI stuck in
          // "restarting" forever even though the process is gone.
          appRestarting: { ...s.appRestarting, [app.id]: false },
        }));
        // Only mirror "stopped" to the DB when we actually transitioned —
        // otherwise we'd race the start's own `update_app_status("starting")`.
        if (!inFlightStart) {
          cmd.markAppStopped(app.id).catch(() => {});
        }
      }).then((fn) => cancelled ? fn() : unlisteners.push(fn));

      // The backend emits `app:starting:{id}` from `start_single` right after
      // it flips the DB to "starting" — listening here lets us re-assert the
      // "starting" status if a stale `app:exit` from the old run wins the
      // race and momentarily flips us to "stopped".
      listen(`app:starting:${app.id}`, () => {
        set((s) => ({
          // A new run gets a new line — splicing the previous process's samples
          // onto this one's would draw a cliff that never happened.
          appMetricHistory: { ...s.appMetricHistory, [app.id]: { cpu: [], mem: [] } },
          apps: s.apps.map((a) =>
            a.id === app.id ? { ...a, status: "starting" as const, auto_slept: false } : a
          ),
          appExitCode: { ...s.appExitCode, [app.id]: null },
        }));
      }).then((fn) => cancelled ? fn() : unlisteners.push(fn));

      // A run profile's build step is running (or just finished). The app stays
      // "starting" throughout; this only relabels the card so a long prod build
      // reads as progress rather than a stall.
      listen<boolean>(`app:building:${app.id}`, (e) => {
        set((s) => ({ appBuilding: { ...s.appBuilding, [app.id]: e.payload } }));
      }).then((fn) => cancelled ? fn() : unlisteners.push(fn));

      // The app's process was killed but something was still holding its port —
      // Porta reaped it. Say so explicitly: a silent kill of a PID the user
      // didn't ask about is exactly the kind of thing they need to know.
      listen<number>(`app:orphan-reaped:${app.id}`, (e) => {
        get().notify({
          kind: "info",
          message: `Freed port :${app.port}`,
          detail: `${app.name} left a process behind (pid ${e.payload}) — killed it so the port is usable again.`,
        });
      }).then((fn) => cancelled ? fn() : unlisteners.push(fn));

      // Idle watcher put the app to sleep — flip to stopped and badge it 💤.
      // (We don't emit app:exit for sleeps, so this is the sole status source.)
      listen(`app:slept:${app.id}`, () => {
        const { [app.id]: _, ...restStartedAt } = get().appStartedAt;
        set((s) => ({
          apps: s.apps.map((a) =>
            a.id === app.id ? { ...a, status: "stopped" as const, pid: null, auto_slept: true } : a
          ),
          appStartedAt: restStartedAt,
          appExitCode: { ...s.appExitCode, [app.id]: 0 },
        }));
      }).then((fn) => cancelled ? fn() : unlisteners.push(fn));

      listen(`app:ready:${app.id}`, () => {
        set((s) => ({
          apps: s.apps.map((a) =>
            a.id === app.id ? { ...a, status: "running" as const, auto_slept: false } : a
          ),
          appRestarting: { ...s.appRestarting, [app.id]: false },
          appStartedAt: { ...s.appStartedAt, [app.id]: Date.now() },
        }));
        cmd.markAppReady(app.id).catch(() => {});
        // Kick off the tunnel if the user opted into auto-start. Reads the
        // latest app snapshot so a just-toggled flag is honored.
        //
        // For Cloudflare, only auto-start a *named* tunnel (tunnel_name set).
        // Without a name, start_tunnel falls back to a throwaway quick tunnel
        // with a random trycloudflare URL — useless for a webhook and, once
        // live, it hides the named-tunnel config UI (gated on !tunnel_active),
        // locking the user out of switching to named. So skip auto-start until
        // a named tunnel is configured; the user can still connect manually.
        const current = get().apps.find((a) => a.id === app.id);
        const cloudflareReady =
          current?.tunnel_provider !== "cloudflare" || !!current?.tunnel_name?.trim();
        if (current?.tunnel_auto_start && !current.tunnel_active && cloudflareReady) {
          get().startTunnel(app.id);
        }
      }).then((fn) => cancelled ? fn() : unlisteners.push(fn));

      // Docker/compose start errors arrive here (image pull fail, invalid yml, etc.)
      listen<string>(`app:start-failed:${app.id}`, (e) => {
        const raw = e.payload || "Failed to start";
        const silent = raw.startsWith(SILENT_START_FAILED_PREFIX);
        const msg = silent ? raw.slice(SILENT_START_FAILED_PREFIX.length) : raw;
        const suppressAlert = silent || isDockerRuntimeUnavailable(msg);
        const short = msg.length > 400 ? `${msg.slice(0, 400)}…\n\n(see logs for full output)` : msg;
        // Drop the restarting flag here too — `app:exit` follows but on some
        // failure paths it races with this and the UI looks frozen otherwise.
        set((s) => ({
          apps: s.apps.map((a) =>
            a.id === app.id ? { ...a, status: "stopped" as const, pid: null } : a
          ),
          appRestarting: { ...s.appRestarting, [app.id]: false },
        }));
        // Was a blocking `window.alert` — a modal wall that halts the whole
        // WebView (and, per the extension guidance, wedges automation) for
        // something the user can read and dismiss at their own pace.
        if (!suppressAlert) {
          get().notify({
            kind: "error",
            message: `Failed to start ${app.name}`,
            detail: short,
          });
        }
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

      // Metrics — latest sample plus the rolling history the sparklines draw.
      // History is accumulated here, not in the workbench tile, so switching
      // tabs (which unmounts the tile) no longer wipes the line.
      listen<{ cpu: number; mem_mb: number }>(`app:metrics:${app.id}`, (e) => {
        set((s) => {
          const prev = s.appMetricHistory[app.id] ?? { cpu: [], mem: [] };
          return {
            appMetrics: { ...s.appMetrics, [app.id]: e.payload },
            appMetricHistory: {
              ...s.appMetricHistory,
              [app.id]: {
                cpu: [...prev.cpu, e.payload.cpu].slice(-METRIC_HISTORY),
                mem: [...prev.mem, e.payload.mem_mb].slice(-METRIC_HISTORY),
              },
            },
          };
        });
      }).then((fn) => cancelled ? fn() : unlisteners.push(fn));

      // Git status — emitted by the Rust poller every 15s per repo app. A status
      // we could read retracts any error, for the same reason `setAppGit` does:
      // the poller only retracts errors it recorded itself, and GitBadge's
      // seeding effect can record one it never saw.
      listen<GitStatus>(`app:git:${app.id}`, (e) => {
        set((s) => ({
          appGit: { ...s.appGit, [app.id]: e.payload },
          appGitError: { ...s.appGitError, [app.id]: "" },
        }));
      }).then((fn) => cancelled ? fn() : unlisteners.push(fn));

      // Git status failure — e.g. dubious ownership. An empty payload means the
      // poller recovered and the badge should stop warning.
      listen<string>(`app:git-error:${app.id}`, (e) => {
        set((s) => ({
          appGitError: { ...s.appGitError, [app.id]: e.payload },
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
          // Any definitive tunnel event settles a pending connect.
          tunnelConnecting: { ...s.tunnelConnecting, [app.id]: false },
        }));
      }).then((fn) => cancelled ? fn() : unlisteners.push(fn));

      // Tunnel connect log lines (cloudflared/tailscale stdout/stderr) for the
      // Publish log stream panel.
      listen<{ line: string }>(`app:tunnel:log:${app.id}`, (e) => {
        get().appendTunnelLog(app.id, e.payload.line);
      }).then((fn) => (cancelled ? fn() : unlisteners.push(fn)));
    });
  };

  // ── Instance event subscriptions ───────────────────────────────────────
  // Mirrors subscribeForApps but keyed by instance id. Instance ids never
  // collide with app ids (UUIDs), so reusing appLogs/appExitCode is safe.
  const instanceUnlisteners: Array<() => void> = [];
  let cancelInstancePending = () => {};

  const subscribeForInstances = async (instances: AppInstance[]) => {
    const { listen } = await import("@tauri-apps/api/event");
    cancelInstancePending();
    instanceUnlisteners.forEach((fn) => fn());
    instanceUnlisteners.length = 0;

    let cancelled = false;
    cancelInstancePending = () => { cancelled = true; };

    instances.forEach((inst) => {
      listen<string>(`instance:log:${inst.id}`, (e) => {
        pushAppLog(inst.id, e.payload);
      }).then((fn) => cancelled ? fn() : instanceUnlisteners.push(fn));

      listen<number>(`instance:exit:${inst.id}`, (e) => {
        set((s) => ({
          appExitCode: { ...s.appExitCode, [inst.id]: e.payload },
          instances: {
            ...s.instances,
            [inst.app_id]: (s.instances[inst.app_id] ?? []).map((i) =>
              i.id === inst.id ? { ...i, status: "stopped", pid: null } : i
            ),
          },
        }));
      }).then((fn) => cancelled ? fn() : instanceUnlisteners.push(fn));

      listen(`instance:ready:${inst.id}`, () => {
        set((s) => ({
          appExitCode: { ...s.appExitCode, [inst.id]: null },
          instances: {
            ...s.instances,
            [inst.app_id]: (s.instances[inst.app_id] ?? []).map((i) =>
              i.id === inst.id ? { ...i, status: "running" } : i
            ),
          },
        }));
      }).then((fn) => cancelled ? fn() : instanceUnlisteners.push(fn));

      // Quick tunnel URL from cloudflared — mirrors the app:tunnel handler
      // above, keyed by instance id.
      listen<{ active: boolean; url?: string | null; error?: string }>(`instance:tunnel:${inst.id}`, (e) => {
        set((s) => ({
          instances: {
            ...s.instances,
            [inst.app_id]: (s.instances[inst.app_id] ?? []).map((i) =>
              i.id === inst.id ? { ...i, tunnel_active: e.payload.active, tunnel_url: e.payload.url ?? null } : i
            ),
          },
          appTunnelErrors: { ...s.appTunnelErrors, [inst.id]: e.payload.error ?? null },
          tunnelConnecting: { ...s.tunnelConnecting, [inst.id]: false },
        }));
      }).then((fn) => cancelled ? fn() : instanceUnlisteners.push(fn));

      // Tunnel connect log lines, keyed by instance id — mirrors the app
      // listener above. Instances share the same appTunnelLogs map.
      listen<{ line: string }>(`instance:tunnel:log:${inst.id}`, (e) => {
        get().appendTunnelLog(inst.id, e.payload.line);
      }).then((fn) => (cancelled ? fn() : instanceUnlisteners.push(fn)));
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
        pushServiceLog(svc.id, e.payload);
      }).then((fn) => unlisteners.push(fn));
    });
  };

  // Flattens the per-app instance map into a single list for subscribeForInstances.
  const flattenInstances = (m: Record<string, AppInstance[]>) => Object.values(m).flat();

  subscribeForApps(get().apps);
  subscribeForServices(get().services);
  subscribeForInstances(flattenInstances(get().instances));

  // Only re-subscribe when the apps/services/instances list itself changes
  // (added/removed), not on every status update — avoids thrashing listeners
  // on start/stop.
  const subscribedIds = () => get().apps.map((a) => a.id).join(",");
  const subscribedSvcIds = () => get().services.map((s) => s.id).join(",");
  const subscribedInstanceIds = () => flattenInstances(get().instances).map((i) => i.id).join(",");
  let lastIds = subscribedIds();
  let lastSvcIds = subscribedSvcIds();
  let lastInstanceIds = subscribedInstanceIds();

  // ── Periodic Docker image update polling ───────────────────────────────────
  const IMAGE_CHECK_INTERVAL = 4 * 60 * 60 * 1000; // 4 hours
  let imageCheckIntervalId: ReturnType<typeof setInterval> | null = null;
  let hasRunInitialImageCheck = false;

  function checkDockerUpdates() {
    if (!isTauri) return;
    const dockerApps = get().apps.filter(
      (a) => a.kind === "docker" || a.kind === "compose"
    );
    for (const app of dockerApps) {
      cmd.checkAppImageUpdates(app.id)
        .then((info) => {
          get().setImageUpdateCache(app.id, info);
          const hasUpdate = info.some(
            (i) => i.status === "ok" && (i.has_digest_update || !!i.suggested_tag)
          );
          if (hasUpdate && !notifiedUpdateApps.has(app.id)) {
            notifiedUpdateApps.add(app.id);
            cmd.notifyImageUpdatesFound([app.name]).catch(() => {});
          }
          if (!hasUpdate) notifiedUpdateApps.delete(app.id);
        })
        .catch(() => {});
    }
  }

  // Access the store lazily via dynamic import to avoid circular dependency at module load time.
  // By the time subscribeToAppEvents is called (from main.tsx after store creation),
  // the module will already be in the ES module cache so this is effectively synchronous.
  let unsub: () => void = () => {};
  import("./index").then(({ usePortaStore }) => {
    // This fires on EVERY store write (logs, metrics, tunnel lines…). Diffing
    // by id string meant three map+join passes per write; gate on array
    // identity first so the common case is three reference compares.
    let lastAppsRef = get().apps;
    let lastSvcRef = get().services;
    let lastInstancesRef = get().instances;
    unsub = usePortaStore.subscribe((state) => {
      if (state.apps !== lastAppsRef) {
        lastAppsRef = state.apps;
        const ids = state.apps.map((a) => a.id).join(",");
        if (ids !== lastIds) {
          lastIds = ids;
          subscribeForApps(state.apps);
        }
      }
      if (state.services !== lastSvcRef) {
        lastSvcRef = state.services;
        const svcIds = state.services.map((s) => s.id).join(",");
        if (svcIds !== lastSvcIds) {
          lastSvcIds = svcIds;
          subscribeForServices(state.services);
        }
      }
      if (state.instances !== lastInstancesRef) {
        lastInstancesRef = state.instances;
        const instanceIds = flattenInstances(state.instances).map((i) => i.id).join(",");
        if (instanceIds !== lastInstanceIds) {
          lastInstanceIds = instanceIds;
          subscribeForInstances(flattenInstances(state.instances));
        }
      }
      // Run first image check once apps are loaded, then schedule repeating interval
      if (!hasRunInitialImageCheck && state.apps.length > 0) {
        hasRunInitialImageCheck = true;
        checkDockerUpdates();
        imageCheckIntervalId = setInterval(checkDockerUpdates, IMAGE_CHECK_INTERVAL);
      }
    });
  });

  return () => {
    cancelPending();
    unlisteners.forEach((fn) => fn());
    cancelInstancePending();
    instanceUnlisteners.forEach((fn) => fn());
    unsub();
    if (imageCheckIntervalId) clearInterval(imageCheckIntervalId);
  };
}
