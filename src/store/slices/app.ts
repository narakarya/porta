import type { StateCreator } from "zustand";
import type { App, HealthStatus, ImageUpdateInfo } from "../../types";
import type { GitStatus, AppInstance } from "../../lib/commands";
import type { AllSlices } from "../index";
import * as cmd from "../../lib/commands";
import { startMockProcess, stopMockProcess, killMockProcess } from "../../lib/mock-data";

export const MAX_LOG_LINES = 10000;
const MAX_TUNNEL_LOG_LINES = 500;

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// Append a synthetic marker line to an app's logs. A stop/kill leaves the log
// frozen (dead process → no more output), so without a visible marker the action
// reads as a no-op ("lognya ga berubah, jadi merasa ga kekill"). The marker shows
// up both in the full log viewer and the LogToast preview.
function withMarker(
  logs: Record<string, string[]>,
  id: string,
  text: string,
): Record<string, string[]> {
  const prev = logs[id] ?? [];
  const next = [...prev, `── ${text} ──`];
  return {
    ...logs,
    [id]: next.length > MAX_LOG_LINES ? next.slice(-MAX_LOG_LINES) : next,
  };
}

export interface AppSlice {
  apps: App[];
  appLogs: Record<string, string[]>;
  appExitCode: Record<string, number | null>;
  appRetryCount: Record<string, number>;
  portConflicts: Record<string, boolean>;
  appRestarting: Record<string, boolean>;
  appTunnelErrors: Record<string, string | null>;
  /** Apps/instances with a tunnel connect in flight (spawned, not yet
   * confirmed active or failed). Drives the card's pulsing "connecting" icon.
   * Set on `startTunnel`, cleared when the `app:tunnel:{id}` /
   * `instance:tunnel:{id}` event settles (active or error). */
  tunnelConnecting: Record<string, boolean>;
  /** Tunnel connect log lines per app/instance id, fed by the
   * `app:tunnel:log:{id}` / `instance:tunnel:log:{id}` events. Capped ring
   * buffer (`MAX_TUNNEL_LOG_LINES`). */
  appTunnelLogs: Record<string, string[]>;
  appMetrics: Record<string, { cpu: number; mem_mb: number }>;
  /** Git state per app, fed by the `app:git:{id}` event. Absent for non-repos. */
  appGit: Record<string, GitStatus>;
  /** Last `git status` failure per app, from `app:git-error:{id}`. Empty string clears it. */
  appGitError: Record<string, string>;
  /** Worktree instances per app_id, from `list_instances` + `instance:*` events. */
  instances: Record<string, AppInstance[]>;
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
  moveAppToWorkspace: (appId: string, workspaceId: string | null) => Promise<void>;
  /**
   * Optimistic, client-only reorder of the apps belonging to `workspaceId`.
   * `fromIndex`/`toIndex` are positions WITHIN that workspace group (post-removal
   * target index, same convention as `reorderWorkspaces`).
   *
   * NOTE: there is no `reorder_apps` backend/IPC command yet, so this order is
   * NOT persisted — it resets to the DB/insertion order on reload. When a
   * backend command lands, call it here mirroring `reorderWorkspaces`.
   */
  reorderApps: (workspaceId: string | null, fromIndex: number, toIndex: number) => Promise<void>;
  setAppAutoSleep: (id: string, enabled: boolean, idleTimeoutSecs: number) => Promise<void>;
  setAppMaxUploadBytes: (id: string, maxBytes: number | null) => Promise<void>;
  cloneApp: (id: string) => Promise<void>;
  deleteApp: (id: string) => Promise<void>;
  startApp: (id: string) => Promise<void>;
  stopApp: (id: string) => Promise<void>;
  restartApp: (id: string) => Promise<void>;
  killApp: (id: string) => Promise<void>;
  clearAppLogs: (id: string) => void;
  dismissPortConflict: (id: string) => void;
  startTunnel: (
    id: string,
    providerOverride?: string,
    funnel?: boolean,
    remoteOpts?: { hostId: string; subdomain: string; domain?: string | null },
  ) => Promise<void>;
  stopTunnel: (id: string) => Promise<void>;
  /** Manually flag a connect in flight — used by the instance-tunnel path,
   * which calls the raw IPC command instead of `startTunnel`. */
  setTunnelConnecting: (id: string, connecting: boolean) => void;
  appendTunnelLog: (id: string, line: string) => void;
  clearTunnelLog: (id: string) => void;
  visibleApps: () => App[];
  setImageUpdateCache: (appId: string, info: ImageUpdateInfo[]) => void;
  setAppGit: (id: string, status: GitStatus) => void;
  setAppGitError: (id: string, message: string) => void;
  setInstances: (appId: string, list: AppInstance[]) => void;
  refreshInstances: (appId: string) => Promise<void>;
  runInstance: (appId: string, worktreePath: string) => Promise<void>;
  /** Create a worktree for `branch` (optionally a new branch) then run an
   *  instance from it. Returns the created worktree path. */
  runInstanceOnBranch: (
    appId: string,
    rootDir: string,
    branch: string,
    createNew: boolean,
  ) => Promise<void>;
  stopInstanceAction: (instanceId: string, appId: string) => Promise<void>;
  killInstanceAction: (instanceId: string, appId: string) => Promise<void>;
  removeInstanceAction: (instanceId: string, appId: string) => Promise<void>;
}

export const createAppSlice: StateCreator<AllSlices, [], [], AppSlice> = (set, get) => ({
  apps: [],
  appLogs: {},
  appExitCode: {},
  appRetryCount: {},
  portConflicts: {},
  appRestarting: {},
  appTunnelErrors: {},
  tunnelConnecting: {},
  appTunnelLogs: {},
  appMetrics: {},
  appGit: {},
  appGitError: {},
  instances: {},
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
        // Intentional stop wipes any stale crash code so the button label
        // resets to "Start" — without this, a previously crashed app keeps
        // showing "Restart" forever after a bulk stop (esp. compose stacks
        // where no app:exit follows to clear it).
        appExitCode: wsAppIds.reduce((acc, id) => ({ ...acc, [id]: null }), s.appExitCode),
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
      // `tunnel_active`/`tunnel_url` are runtime-only — the DB never stores them
      // (app_repo.rs always reads them back as false/null), they live in-memory
      // via the `app:tunnel:{id}` event. Blindly replacing the app with the
      // fresh DB copy would wipe a live tunnel's state and make the UI flip to
      // "disconnected" on Save even though cloudflared keeps running. Preserve
      // them from the previous in-memory object.
      apps: s.apps.map((a) =>
        a.id === params.id
          ? { ...updated, tunnel_active: a.tunnel_active, tunnel_url: a.tunnel_url }
          : a
      ),
    }));
  },

  moveAppToWorkspace: async (appId, workspaceId) => {
    await cmd.moveAppToWorkspace(appId, workspaceId);
    set((s) => ({
      apps: s.apps.map((a) =>
        a.id === appId ? { ...a, workspace_id: workspaceId } : a
      ),
    }));
  },

  reorderApps: async (workspaceId, fromIndex, toIndex) => {
    // Positions of this workspace's apps within the flat `apps` array — we
    // reorder the group in place and leave every other app untouched.
    const prev = get().apps;
    const slots: number[] = [];
    prev.forEach((a, i) => { if (a.workspace_id === workspaceId) slots.push(i); });
    if (
      fromIndex < 0 || toIndex < 0 ||
      fromIndex >= slots.length || toIndex >= slots.length ||
      fromIndex === toIndex
    ) return;
    const group = slots.map((i) => prev[i]);
    const [moved] = group.splice(fromIndex, 1);
    group.splice(toIndex, 0, moved);
    const next = prev.slice();
    slots.forEach((slot, gi) => { next[slot] = group[gi]; });
    // Optimistic reorder for snappy UX; persist the new global order and
    // reconcile with the DB on failure.
    set({ apps: next });
    try {
      await cmd.reorderApps(next.map((a) => a.id));
    } catch (e) {
      await get().load().catch(() => {});
      set({ error: String(e) });
    }
  },

  setAppAutoSleep: async (id, enabled, idleTimeoutSecs) => {
    // Optimistic — reflect the toggle immediately, reconcile with the returned
    // (clamped) values from the backend.
    set((s) => ({
      apps: s.apps.map((a) =>
        a.id === id ? { ...a, auto_sleep_enabled: enabled, idle_timeout_secs: idleTimeoutSecs } : a
      ),
    }));
    const updated = await cmd.setAppAutoSleep(id, enabled, idleTimeoutSecs);
    set((s) => ({
      apps: s.apps.map((a) =>
        a.id === id
          ? {
              ...a,
              auto_sleep_enabled: updated.auto_sleep_enabled,
              idle_timeout_secs: updated.idle_timeout_secs,
              auto_slept: updated.auto_slept,
            }
          : a
      ),
    }));
  },

  setAppMaxUploadBytes: async (id, maxBytes) => {
    // Optimistic — reflect the new cap immediately, reconcile with the App the
    // backend returns after it re-syncs Caddy.
    set((s) => ({
      apps: s.apps.map((a) => (a.id === id ? { ...a, max_upload_bytes: maxBytes } : a)),
    }));
    const updated = await cmd.setAppMaxUploadBytes(id, maxBytes);
    set((s) => ({
      apps: s.apps.map((a) =>
        a.id === id ? { ...a, max_upload_bytes: updated.max_upload_bytes } : a
      ),
    }));
  },

  cloneApp: async (id) => {
    const cloned = await cmd.cloneApp(id);
    set((s) => ({ apps: [...s.apps, cloned] }));
  },

  deleteApp: async (id) => {
    await cmd.deleteApp(id);
    // Drop the app from `apps` *before* touching its terminal sessions.
    // TerminalWorkspace's autoSeed effect re-seeds a fresh tab the instant
    // `terminalTabs[id]` empties out (`ensureTerminalTab` keys on
    // `tabs.length`), and closeAppTerminals below is what empties it — if the
    // app were still in `apps` when that happens, the workbench for it would
    // still be mounted (App.tsx renders it off `apps.find`) and would re-seed
    // a fresh pane for an app that's mid-delete, one nothing would ever go on
    // to close. Filtering `apps` first means that component tree is already
    // gone (App.tsx stops rendering the workbench the moment `apps` no
    // longer has this id) well before closeAppTerminals's own await chain
    // (a `cmd.terminalClose` IPC round trip per pane) gets anywhere near
    // emptying `terminalTabs[id]` — there is no tick in between where a
    // mounted autoSeed effect could observe the empty list.
    set((s) => ({
      apps: s.apps.filter((a) => a.id !== id),
      appLogs: Object.fromEntries(Object.entries(s.appLogs).filter(([k]) => k !== id)),
      appExitCode: Object.fromEntries(Object.entries(s.appExitCode).filter(([k]) => k !== id)),
      appRetryCount: Object.fromEntries(Object.entries(s.appRetryCount).filter(([k]) => k !== id)),
      portConflicts: Object.fromEntries(Object.entries(s.portConflicts).filter(([k]) => k !== id)),
      appTunnelLogs: Object.fromEntries(Object.entries(s.appTunnelLogs).filter(([k]) => k !== id)),
    }));
    // Sessions are keyed by pane id in Rust and would otherwise outlive the
    // app that owns them, with no UI left to close them from.
    await get().closeAppTerminals(id);
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
      try {
        await cmd.startApp(id);
      } catch (e) {
        set((s) => ({
          apps: s.apps.map((a) =>
            a.id === id ? { ...a, status: "stopped" as const, pid: null } : a
          ),
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
        appLogs: withMarker(s.appLogs, id, "stopped (SIGTERM)"),
        appRetryCount: { ...s.appRetryCount, [id]: 0 },
        appRestarting: { ...s.appRestarting, [id]: false },
        appStartedAt: restStartedAt,
        // Intentional stop wipes any stale crash code. Without this, an app
        // that previously crashed (exitCode != 0) keeps showing "Restart" as
        // the Start button label even after the user clicks Stop — for
        // compose apps this sticks forever since no app:exit follows.
        appExitCode: { ...s.appExitCode, [id]: null },
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
        appLogs: withMarker(s.appLogs, id, "force-killed (SIGKILL)"),
        appRetryCount: { ...s.appRetryCount, [id]: 0 },
        appRestarting: { ...s.appRestarting, [id]: false },
        appStartedAt: restStartedAt,
        // Same reasoning as stopApp — force-kill is intentional, clear any
        // prior crash code so the button doesn't keep saying "Restart".
        appExitCode: { ...s.appExitCode, [id]: null },
      };
    });
  },

  clearAppLogs: (id) =>
    set((s) => ({ appLogs: { ...s.appLogs, [id]: [] } })),

  dismissPortConflict: (id) =>
    set((s) => ({ portConflicts: { ...s.portConflicts, [id]: false } })),

  startTunnel: async (id, providerOverride, funnel, remoteOpts) => {
    const app = get().apps.find((a) => a.id === id);
    if (!app) return;
    const provider = providerOverride ?? app.tunnel_provider ?? "cloudflare";
    // Persist the provider choice + clear stale error. Do NOT optimistically
    // set `tunnel_active: true` — that flips the button to "Disconnect"
    // before the connection actually succeeds, hiding the loading state and
    // making transient failures look like the tunnel "reverted to Connect".
    // The backend emits `app:tunnel:{id}` with active:true once it's real.
    get().clearTunnelLog(id);
    set((s) => ({
      apps: s.apps.map((a) =>
        a.id === id ? { ...a, tunnel_provider: provider } : a
      ),
      appTunnelErrors: { ...s.appTunnelErrors, [id]: null },
      tunnelConnecting: { ...s.tunnelConnecting, [id]: true },
    }));
    // Safety net: named-tunnel connects can take several seconds (DNS route +
    // cloudflared spawn + edge registration). The `app:tunnel:{id}` event
    // normally clears `connecting`, but if it's ever dropped we don't want the
    // icon pulsing forever — clear it after a generous timeout.
    setTimeout(() => {
      set((s) => (s.tunnelConnecting[id]
        ? { tunnelConnecting: { ...s.tunnelConnecting, [id]: false } }
        : {}));
    }, 90_000);
    try {
      if (provider === "tailscale") {
        await cmd.startTailscaleServe(id, app.port, funnel ?? false);
      } else if (provider === "remote") {
        if (!remoteOpts) {
          throw new Error("Porta Relay requires a remote host and subdomain");
        }
        await cmd.exposeRemote(id, remoteOpts.hostId, remoteOpts.subdomain, remoteOpts.domain ?? null);
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
        tunnelConnecting: { ...s.tunnelConnecting, [id]: false },
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
      tunnelConnecting: { ...s.tunnelConnecting, [id]: false },
    }));
    try {
      if (provider === "tailscale") {
        await cmd.stopTailscaleServe(id);
      } else if (provider === "remote") {
        await cmd.unexposeRemote(id);
      } else {
        await cmd.stopTunnel(id);
      }
    } catch {
      // Best-effort: state already cleared optimistically.
    }
  },

  setTunnelConnecting: (id, connecting) =>
    set((s) => ({ tunnelConnecting: { ...s.tunnelConnecting, [id]: connecting } })),

  appendTunnelLog: (id, line) =>
    set((s) => {
      const prev = s.appTunnelLogs[id] ?? [];
      const next = [...prev, line];
      return {
        appTunnelLogs: {
          ...s.appTunnelLogs,
          [id]: next.length > MAX_TUNNEL_LOG_LINES ? next.slice(-MAX_TUNNEL_LOG_LINES) : next,
        },
      };
    }),

  clearTunnelLog: (id) =>
    set((s) => ({ appTunnelLogs: { ...s.appTunnelLogs, [id]: [] } })),

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

  // Single writer for git state besides the `app:git:{id}` event listener.
  // GitBadge seeds this on mount and refreshes it after a fetch/pull/push so
  // the badge doesn't wait up to 15s for the poller's next tick.
  //
  // Writing a status also retracts any error: a `GitStatus` we could read is
  // proof the repo is readable. `appGitError` has two writers — the poller and
  // GitBadge's seeding effect — but the poller only retracts errors it recorded
  // itself, so without this an error from the seed could pin a healthy repo
  // under `git ⚠` for the rest of the session.
  setAppGit: (id, status) =>
    set((s) => ({
      appGit: { ...s.appGit, [id]: status },
      appGitError: { ...s.appGitError, [id]: "" },
    })),

  setAppGitError: (id, message) =>
    set((s) => ({ appGitError: { ...s.appGitError, [id]: message } })),

  setInstances: (appId, list) =>
    set((s) => ({ instances: { ...s.instances, [appId]: list } })),

  refreshInstances: async (appId) => {
    const list = await cmd.listInstances(appId);
    get().setInstances(appId, list);
  },

  runInstance: async (appId, worktreePath) => {
    const inst = await cmd.startInstance(appId, worktreePath);
    set((s) => {
      const cur = s.instances[appId] ?? [];
      const next = cur.filter((i) => i.id !== inst.id).concat(inst);
      return { instances: { ...s.instances, [appId]: next } };
    });
  },

  runInstanceOnBranch: async (appId, rootDir, branch, createNew) => {
    // Create (or reuse) the worktree for this branch, then run an instance from
    // its path via the existing runInstance flow.
    const entry = await cmd.gitWorktreeAdd(rootDir, branch, createNew);
    await get().runInstance(appId, entry.path);
  },

  stopInstanceAction: async (instanceId, appId) => {
    await cmd.stopInstance(instanceId);
    // Backend `stop_instance` keeps the row and flips it to "stopped" (process
    // killed, port + route retained). Mirror that here so the card stays put —
    // the user can re-run, kill a stuck port, or Remove it deliberately.
    set((s) => ({
      instances: {
        ...s.instances,
        [appId]: (s.instances[appId] ?? []).map((i) =>
          i.id === instanceId ? { ...i, status: "stopped", pid: null } : i,
        ),
      },
    }));
  },

  killInstanceAction: async (instanceId, appId) => {
    await cmd.killInstance(instanceId);
    // Backend `kill_instance` SIGKILLs the process but keeps the row (port +
    // route retained), flipping it to "stopped" — mirror stopInstanceAction.
    set((s) => ({
      instances: {
        ...s.instances,
        [appId]: (s.instances[appId] ?? []).map((i) =>
          i.id === instanceId ? { ...i, status: "stopped", pid: null } : i,
        ),
      },
    }));
  },

  removeInstanceAction: async (instanceId, appId) => {
    await cmd.removeInstance(instanceId);
    // Backend `remove_instance` deletes the row, frees the port, drops the Caddy
    // route — the instance is gone for good. Drop it from the list.
    set((s) => ({
      instances: {
        ...s.instances,
        [appId]: (s.instances[appId] ?? []).filter((i) => i.id !== instanceId),
      },
    }));
  },
});
