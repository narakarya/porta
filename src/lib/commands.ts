import { invoke } from "@tauri-apps/api/core";
import type {
  App,
  AddAppParams,
  UpdateAppParams,
  DetectResult,
  SetupStatus,
  Workspace,
} from "../types";

// ── Setup ────────────────────────────────────────────────────────────────────

export const checkSetup = (): Promise<SetupStatus> =>
  invoke("check_setup");

export const runSetup = (): Promise<void> =>
  invoke("run_setup");

export const startCaddy = (): Promise<void> =>
  invoke("start_caddy");

export const reloadCaddy = (): Promise<void> =>
  invoke("reload_caddy");

// ── Workspaces ───────────────────────────────────────────────────────────────

export const listWorkspaces = (): Promise<Workspace[]> =>
  invoke("list_workspaces");

export const addWorkspace = (name: string, domain: string): Promise<Workspace> =>
  invoke("add_workspace", { name, domain });

export const updateWorkspace = (id: string, name: string, domain: string): Promise<Workspace> =>
  invoke("update_workspace", { id, name, domain });

export const deleteWorkspace = (id: string): Promise<void> =>
  invoke("delete_workspace", { id });

// ── Apps ─────────────────────────────────────────────────────────────────────

export const listApps = (): Promise<App[]> =>
  invoke("list_apps");

export const detectStartCommand = (rootDir: string): Promise<DetectResult> =>
  invoke("detect_start_command", { rootDir });

export const nextAvailablePort = (): Promise<number> =>
  invoke("next_available_port");

export const addApp = (params: AddAppParams): Promise<App> =>
  invoke("add_app", {
    workspaceId: params.workspace_id,
    name: params.name,
    rootDir: params.root_dir,
    port: params.port,
    subdomain: params.subdomain,
    startCommand: params.start_command,
    startCommandSource: params.start_command_source,
  });

export const updateApp = (params: UpdateAppParams): Promise<App> =>
  invoke("update_app", {
    id: params.id,
    name: params.name,
    port: params.port,
    subdomain: params.subdomain,
    startCommand: params.start_command,
    envFile: params.env_file,
    autoStart: params.auto_start,
  });

export const deleteApp = (id: string): Promise<void> =>
  invoke("delete_app", { id });

export const saveFile = (path: string, contents: string): Promise<void> =>
  invoke("save_file", { path, contents });

export const revealInFinder = (path: string): Promise<void> =>
  invoke("reveal_in_finder", { path });

export const openInEditor = (rootDir: string): Promise<void> =>
  invoke("open_in_editor", { rootDir });

export const startApp = (id: string): Promise<void> =>
  invoke("start_app", { id });

export const stopApp = (id: string): Promise<void> =>
  invoke("stop_app", { id });

export const killApp = (id: string): Promise<void> =>
  invoke("kill_app", { id });

export const killPortHolder = (port: number): Promise<number> =>
  invoke("kill_port_holder", { port });

export const killPid = (pid: number): Promise<void> =>
  invoke("kill_pid", { pid });

export const markAppStopped = (id: string): Promise<void> =>
  invoke("mark_app_stopped", { id });

export const markAppReady = (id: string): Promise<void> =>
  invoke("mark_app_ready", { id });

// ── Backup / Export / Import ─────────────────────────────────────────────────

export const exportData = (): Promise<string> =>
  invoke("export_data");

export const importData = (json: string, replace: boolean): Promise<void> =>
  invoke("import_data", { json, replace });

export const listBackups = (): Promise<string[]> =>
  invoke("list_backups");

export const restoreBackup = (filename: string): Promise<void> =>
  invoke("restore_backup", { filename });
