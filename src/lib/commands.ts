import type {
  App,
  AddAppParams,
  UpdateAppParams,
  DetectResult,
  SetupStatus,
  Workspace,
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
} from "./mock-data";

// ── Tauri detection ──────────────────────────────────────────────────────────

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

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
        return ws ?? { id, name, domain };
      })());

export const deleteWorkspace = (id: string): Promise<void> =>
  isTauri ? invoke("delete_workspace", { id }) : Promise.resolve(mockDeleteWorkspace(id));

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
      })
    : Promise.resolve((() => {
        const app = getMockState().apps.find((a) => a.id === params.id);
        if (app) Object.assign(app, params);
        return app ?? ({ ...params, workspace_id: null, root_dir: "", start_command_source: "", status: "stopped", pid: null, env_file: null, auto_start: false, env_vars: {}, restart_policy: "on-failure", max_retries: 3 } as App);
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

export const killApp = (id: string): Promise<void> =>
  isTauri ? invoke("kill_app", { id }) : Promise.resolve();

export const killPortHolder = (port: number): Promise<number> =>
  isTauri ? invoke("kill_port_holder", { port }) : Promise.resolve(0);

export const killPid = (pid: number): Promise<void> =>
  isTauri ? invoke("kill_pid", { pid }) : Promise.resolve();

export const markAppStopped = (id: string): Promise<void> =>
  isTauri ? invoke("mark_app_stopped", { id }) : Promise.resolve();

export const markAppReady = (id: string): Promise<void> =>
  isTauri ? invoke("mark_app_ready", { id }) : Promise.resolve();

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
