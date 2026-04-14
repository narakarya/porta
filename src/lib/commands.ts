import type {
  App,
  AddAppParams,
  UpdateAppParams,
  DetectResult,
  SetupStatus,
  Workspace,
  Service,
  AddServiceParams,
  CustomDeployCmd,
  HealthStatus,
} from "../types";
import {
  getMockState,
  mockSetupStatus,
  mockDetectResult,
  mockAddWorkspace,
  mockAddApp,
  mockDeleteApp,
  mockDeleteWorkspace,
  mockNextPort,
  mockServices,
  startMockService,
  stopMockService,
} from "./mock-data";

// ── Tauri detection ──────────────────────────────────────────────────────────

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri) {
    throw new Error(`[mock] invoke("${cmd}") — Tauri not available`);
  }
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke<T>(cmd, args);
}

// ── Setup ────────────────────────────────────────────────────────────────────

export const checkSetup = (): Promise<SetupStatus> =>
  isTauri ? invoke("check_setup") : Promise.resolve(mockSetupStatus);

export const runSetup = (): Promise<void> =>
  isTauri ? invoke("run_setup") : Promise.resolve();

export const startCaddy = (): Promise<void> =>
  isTauri ? invoke("start_caddy") : Promise.resolve();

export const reloadCaddy = (): Promise<void> =>
  isTauri ? invoke("reload_caddy") : Promise.resolve();

// ── Workspaces ───────────────────────────────────────────────────────────────

export const listWorkspaces = (): Promise<Workspace[]> =>
  isTauri ? invoke("list_workspaces") : Promise.resolve(getMockState().workspaces);

export const addWorkspace = (name: string, domain: string): Promise<Workspace> =>
  isTauri ? invoke("add_workspace", { name, domain }) : Promise.resolve(mockAddWorkspace(name, domain));

export const updateWorkspace = (id: string, name: string, domain: string): Promise<Workspace> =>
  isTauri
    ? invoke("update_workspace", { id, name, domain })
    : Promise.resolve((() => {
        const ws = getMockState().workspaces.find((w) => w.id === id);
        if (ws) { ws.name = name; ws.domain = domain; }
        return ws ?? { id, name, domain, deployment: null };
      })());

export const deleteWorkspace = (id: string): Promise<void> =>
  isTauri ? invoke("delete_workspace", { id }) : Promise.resolve(mockDeleteWorkspace(id));

export const reorderWorkspaces = (ids: string[]): Promise<void> =>
  isTauri ? invoke("reorder_workspaces", { ids }) : Promise.resolve();

// ── Apps ─────────────────────────────────────────────────────────────────────

export const listApps = (): Promise<App[]> =>
  isTauri ? invoke("list_apps") : Promise.resolve(getMockState().apps);

export const detectStartCommand = (rootDir: string): Promise<DetectResult> =>
  isTauri ? invoke("detect_start_command", { rootDir }) : Promise.resolve(mockDetectResult);

export const nextAvailablePort = (): Promise<number> =>
  isTauri ? invoke("next_available_port") : Promise.resolve(mockNextPort());

export const addApp = (params: AddAppParams): Promise<App> =>
  isTauri
    ? invoke("add_app", {
        workspaceId: params.workspace_id,
        name: params.name,
        rootDir: params.root_dir,
        port: params.port,
        subdomain: params.subdomain,
        startCommand: params.start_command,
        startCommandSource: params.start_command_source,
      })
    : Promise.resolve(mockAddApp(params));

export const updateApp = (params: UpdateAppParams): Promise<App> =>
  isTauri
    ? invoke("update_app", {
        id: params.id,
        name: params.name,
        port: params.port,
        subdomain: params.subdomain,
        startCommand: params.start_command,
        envFile: params.env_file,
        autoStart: params.auto_start,
        envVars: params.env_vars,
        restartPolicy: params.restart_policy,
        maxRetries: params.max_retries,
        healthCheckPath: params.health_check_path,
        dependsOn: params.depends_on,
        extraSubdomains: params.extra_subdomains,
        customDomain: params.custom_domain,
        portBindings: params.port_bindings,
        envProfiles: params.env_profiles,
        activeProfileId: params.active_profile_id,
      })
    : Promise.resolve((() => {
        const app = getMockState().apps.find((a) => a.id === params.id);
        if (app) Object.assign(app, params);
        return app ?? ({ ...params, workspace_id: null, root_dir: "", start_command_source: "", status: "stopped" as const, pid: null, env_file: null, auto_start: false, env_vars: {}, restart_policy: "on-failure" as const, max_retries: 3, extra_subdomains: [], custom_domain: null, port_bindings: [], env_profiles: [], active_profile_id: null, tunnel_provider: null, tunnel_url: null, tunnel_active: false, deploy_config_path: null, deploy_custom_commands: [] } as App);
      })());

export const deleteApp = (id: string): Promise<void> =>
  isTauri ? invoke("delete_app", { id }) : Promise.resolve(mockDeleteApp(id));

export const saveFile = (_path: string, _contents: string): Promise<void> =>
  isTauri ? invoke("save_file", { path: _path, contents: _contents }) : Promise.resolve();

export const revealInFinder = (path: string): Promise<void> =>
  isTauri ? invoke("reveal_in_finder", { path }) : Promise.resolve();

export const openInEditor = (rootDir: string): Promise<void> =>
  isTauri ? invoke("open_in_editor", { rootDir }) : Promise.resolve();

export const openInTerminal = (rootDir: string): Promise<void> =>
  isTauri ? invoke("open_in_terminal", { rootDir }) : Promise.resolve();

export const startApp = (id: string): Promise<void> =>
  isTauri ? invoke("start_app", { id }) : Promise.resolve();

export const stopApp = (id: string): Promise<void> =>
  isTauri ? invoke("stop_app", { id }) : Promise.resolve();

export const restartApp = (id: string): Promise<void> =>
  isTauri ? invoke("restart_app", { id }) : Promise.resolve();

export const killApp = (id: string): Promise<void> =>
  isTauri ? invoke("kill_app", { id }) : Promise.resolve();

export interface PortCheckResult {
  available: boolean;
  pid: number | null;
  process_name: string | null;
}

export const checkPortAvailable = (port: number): Promise<PortCheckResult> =>
  isTauri
    ? invoke("check_port_available", { port })
    : Promise.resolve({ available: true, pid: null, process_name: null });

export const killPortHolder = (port: number): Promise<number> =>
  isTauri ? invoke("kill_port_holder", { port }) : Promise.resolve(0);

export const killPid = (pid: number): Promise<void> =>
  isTauri ? invoke("kill_pid", { pid }) : Promise.resolve();

export const markAppStopped = (id: string): Promise<void> =>
  isTauri ? invoke("mark_app_stopped", { id }) : Promise.resolve();

export const markAppReady = (id: string): Promise<void> =>
  isTauri ? invoke("mark_app_ready", { id }) : Promise.resolve();

export const getAppLogs = (id: string): Promise<string[]> =>
  isTauri ? invoke("get_app_logs", { id }) : Promise.resolve([]);

// ── Health checks ───────────────────────────────────────────────────────────

export const checkAppHealth = (id: string): Promise<HealthStatus> =>
  isTauri ? invoke("check_app_health", { id }) : Promise.resolve("unknown" as HealthStatus);

export const checkAllHealth = (): Promise<Record<string, HealthStatus>> =>
  isTauri ? invoke("check_all_health") : Promise.resolve({});

// ── Workspace bulk start / stop ──────────────────────────────────────────────

export const startWorkspaceApps = (workspaceId: string): Promise<void> =>
  isTauri ? invoke("start_workspace_apps", { workspaceId }) : Promise.resolve();

export const stopWorkspaceApps = (workspaceId: string): Promise<void> =>
  isTauri ? invoke("stop_workspace_apps", { workspaceId }) : Promise.resolve();

// ── Settings ─────────────────────────────────────────────────────────────────

export const getNotificationsEnabled = (): Promise<boolean> =>
  isTauri ? invoke("get_notifications_enabled") : Promise.resolve(true);

export const setNotificationsEnabled = (enabled: boolean): Promise<void> =>
  isTauri ? invoke("set_notifications_enabled", { enabled }) : Promise.resolve();

// ── Backup / Export / Import ─────────────────────────────────────────────────

export const exportData = (): Promise<string> =>
  isTauri ? invoke("export_data") : Promise.resolve(JSON.stringify(getMockState(), null, 2));

export const importData = (json: string, _replace: boolean): Promise<void> =>
  isTauri ? invoke("import_data", { json, replace: _replace }) : Promise.resolve();

export const listBackups = (): Promise<string[]> =>
  isTauri ? invoke("list_backups") : Promise.resolve([]);

export const restoreBackup = (filename: string): Promise<void> =>
  isTauri ? invoke("restore_backup", { filename }) : Promise.resolve();

// ── Clone App ─────────────────────────────────────────────────────────────────

export const cloneApp = (id: string): Promise<App> =>
  isTauri
    ? invoke("clone_app", { id })
    : Promise.reject(new Error("clone_app not available in browser mode"));

// ── Services (Docker-backed via Tauri) ────────────────────────────────────────

// Browser fallback: in-memory mock store
let _mockServiceStore = [...mockServices];
let _mockCancelMap = new Map<string, () => void>();

export const listServices = (): Promise<Service[]> =>
  isTauri
    ? invoke("list_services")
    : Promise.resolve([..._mockServiceStore]);

export const addService = (params: AddServiceParams): Promise<Service> =>
  isTauri
    ? invoke("add_service", {
        name: params.name,
        image: params.image,
        tag: params.tag,
        port: params.port,
        envVars: params.env_vars,
        volumes: params.volumes,
        scope: params.scope,
      })
    : Promise.resolve((() => {
        const svc: Service = {
          id: `svc-${Date.now().toString(36)}`,
          name: params.name, image: params.image, tag: params.tag,
          port: params.port, env_vars: params.env_vars, volumes: params.volumes,
          scope: params.scope, status: "stopped", container_id: null,
        };
        _mockServiceStore.push(svc);
        return svc;
      })());

export const updateService = (id: string, params: Partial<AddServiceParams>): Promise<Service> => {
  if (isTauri) {
    const idx = _mockServiceStore.findIndex((s) => s.id === id);
    const base = idx !== -1 ? _mockServiceStore[idx] : {} as Service;
    return invoke("update_service", {
      id,
      name: params.name ?? base.name,
      image: params.image ?? base.image,
      tag: params.tag ?? base.tag,
      port: params.port ?? base.port,
      envVars: params.env_vars ?? base.env_vars ?? {},
      volumes: params.volumes ?? base.volumes ?? [],
      scope: params.scope ?? base.scope,
    });
  }
  const idx = _mockServiceStore.findIndex((s) => s.id === id);
  if (idx === -1) return Promise.reject(new Error(`Service ${id} not found`));
  _mockServiceStore[idx] = { ..._mockServiceStore[idx], ...params };
  return Promise.resolve({ ..._mockServiceStore[idx] });
};

export const deleteService = (id: string): Promise<void> => {
  if (isTauri) return invoke("delete_service", { id });
  _mockCancelMap.get(id)?.();
  _mockCancelMap.delete(id);
  _mockServiceStore = _mockServiceStore.filter((s) => s.id !== id);
  return Promise.resolve();
};

export const reorderServices = (ids: string[]): Promise<void> =>
  isTauri ? invoke("reorder_services", { ids }) : Promise.resolve();

/**
 * Start a Docker service.
 * In Tauri mode: fires `start_service` invoke (returns immediately) and
 *   updates arrive via `service:status:{id}` / `service:log:{id}` events.
 * In browser mode: uses the mock callback path for demo purposes.
 */
export const startService = (
  id: string,
  onStatusChange?: (status: Service["status"], containerId: string | null) => void
): Promise<void> => {
  if (isTauri) return invoke("start_service", { id });
  // Browser mock path
  _mockCancelMap.get(id)?.();
  const cancel = startMockService(id, (status, containerId) => {
    const idx = _mockServiceStore.findIndex((s) => s.id === id);
    if (idx !== -1) _mockServiceStore[idx] = { ..._mockServiceStore[idx], status, container_id: containerId };
    onStatusChange?.(status, containerId);
  });
  _mockCancelMap.set(id, cancel);
  return Promise.resolve();
};

export const stopService = (id: string): Promise<void> => {
  if (isTauri) return invoke("stop_service", { id });
  _mockCancelMap.get(id)?.();
  _mockCancelMap.delete(id);
  stopMockService((status, containerId) => {
    const idx = _mockServiceStore.findIndex((s) => s.id === id);
    if (idx !== -1) _mockServiceStore[idx] = { ..._mockServiceStore[idx], status, container_id: containerId };
  });
  return Promise.resolve();
};

// ── Git Sync ─────────────────────────────────────────────────────────────────

export const gitSyncCheck = (): Promise<boolean> =>
  isTauri ? invoke("git_sync_check") : Promise.resolve(true);

export const gitSyncGetRepo = (): Promise<string | null> =>
  isTauri ? invoke("git_sync_get_repo") : Promise.resolve(null);

export const gitSyncSetRepo = (url: string): Promise<void> =>
  isTauri ? invoke("git_sync_set_repo", { url }) : Promise.resolve();

export const gitSyncTest = (): Promise<void> =>
  isTauri ? invoke("git_sync_test") : Promise.resolve();

export const gitSyncPush = (): Promise<string> =>
  isTauri ? invoke("git_sync_push") : Promise.resolve(new Date().toISOString());

export const gitSyncPull = (): Promise<string | null> =>
  isTauri ? invoke("git_sync_pull") : Promise.resolve(null);

export const gitSyncDisconnect = (): Promise<void> =>
  isTauri ? invoke("git_sync_disconnect") : Promise.resolve();

// ── Tunneling (cloudflared) ───────────────────────────────────────────────────

export const checkCloudflared = (): Promise<boolean> =>
  isTauri ? invoke("check_cloudflared") : Promise.resolve(false);

export const startTunnel = (id: string, port: number): Promise<void> =>
  isTauri ? invoke("start_tunnel", { id, port }) : Promise.resolve();

export const stopTunnel = (id: string): Promise<void> =>
  isTauri ? invoke("stop_tunnel", { id }) : Promise.resolve();

// ── Launch at Login ───────────────────────────────────────────────────────────

export const getLaunchAtLogin = (): Promise<boolean> =>
  isTauri ? invoke("get_launch_at_login") : Promise.resolve(false);

export const setLaunchAtLogin = (enabled: boolean): Promise<void> =>
  isTauri ? invoke("set_launch_at_login", { enabled }) : Promise.resolve();

// ── Script detection ──────────────────────────────────────────────────────────

export interface CommandSuggestion { label: string; source: string; }

export const listAvailableCommands = (rootDir: string): Promise<CommandSuggestion[]> =>
  isTauri
    ? invoke("list_available_commands", { rootDir })
    : Promise.resolve([]);

// ── Caddy ─────────────────────────────────────────────────────────────────────

export const caddyStatusCheck = (): Promise<boolean> =>
  isTauri ? invoke("caddy_status") : Promise.resolve(false);

// ── In-app terminal ───────────────────────────────────────────────────────────

export const terminalOpen = (appId: string, rootDir: string, rows: number, cols: number): Promise<void> =>
  isTauri ? invoke("terminal_open", { appId, rootDir, rows, cols }) : Promise.resolve();

export const terminalWrite = (appId: string, data: number[]): Promise<void> =>
  isTauri ? invoke("terminal_write", { appId, data }) : Promise.resolve();

export const terminalResize = (appId: string, rows: number, cols: number): Promise<void> =>
  isTauri ? invoke("terminal_resize", { appId, rows, cols }) : Promise.resolve();

export const terminalClose = (appId: string): Promise<void> =>
  isTauri ? invoke("terminal_close", { appId }) : Promise.resolve();

// ── Certificate management ────────────────────────────────────────────────────

export const regenerateCerts = (): Promise<void> =>
  isTauri ? invoke("regenerate_certs") : Promise.resolve();

// ── Kamal deployment ──────────────────────────────────────────────────────────

export const checkKamal = (): Promise<{ installed: boolean; version: string | null }> =>
  isTauri
    ? invoke("check_kamal")
    : Promise.resolve({ installed: false, version: null });

export const kamalRun = (
  appId: string,
  configPath: string,
  args: string[],
  runId: string,
): Promise<void> =>
  isTauri
    ? invoke("kamal_run", { appId, configPath, args, runId })
    : Promise.reject(new Error("kamal_run not available in browser mode"));

export const installKamal = (appId: string, runId: string): Promise<void> =>
  isTauri
    ? invoke("install_kamal", { appId, runId })
    : Promise.reject(new Error("install_kamal not available in browser mode"));

export const parseKamalAccessories = (configPath: string): Promise<string[]> =>
  isTauri
    ? invoke("parse_kamal_accessories", { configPath })
    : Promise.resolve([]);

export const addDeployCustomCmd = (appId: string, cmd: CustomDeployCmd): Promise<void> =>
  isTauri
    ? invoke("add_deploy_custom_cmd", { appId, cmd })
    : Promise.reject(new Error("add_deploy_custom_cmd not available in browser mode"));

export const updateDeployCustomCmd = (appId: string, cmd: CustomDeployCmd): Promise<void> =>
  isTauri
    ? invoke("update_deploy_custom_cmd", { appId, cmd })
    : Promise.reject(new Error("update_deploy_custom_cmd not available in browser mode"));

export const deleteDeployCustomCmd = (appId: string, cmdId: string): Promise<void> =>
  isTauri
    ? invoke("delete_deploy_custom_cmd", { appId, cmdId })
    : Promise.reject(new Error("delete_deploy_custom_cmd not available in browser mode"));
