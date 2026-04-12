import { invoke } from "@tauri-apps/api/core";
import type {
  App,
  AddAppParams,
  DetectResult,
  SetupStatus,
  Workspace,
} from "../types";

// ── Setup ────────────────────────────────────────────────────────────────────

export const checkSetup = (): Promise<SetupStatus> =>
  invoke("check_setup");

export const runSetup = (): Promise<void> =>
  invoke("run_setup");

// ── Workspaces ───────────────────────────────────────────────────────────────

export const listWorkspaces = (): Promise<Workspace[]> =>
  invoke("list_workspaces");

export const addWorkspace = (name: string, domain: string): Promise<Workspace> =>
  invoke("add_workspace", { name, domain });

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

export const deleteApp = (id: string): Promise<void> =>
  invoke("delete_app", { id });

export const startApp = (id: string): Promise<void> =>
  invoke("start_app", { id });

export const stopApp = (id: string): Promise<void> =>
  invoke("stop_app", { id });

// ── Backup / Export / Import ─────────────────────────────────────────────────

export const exportData = (): Promise<string> =>
  invoke("export_data");

export const importData = (json: string, replace: boolean): Promise<void> =>
  invoke("import_data", { json, replace });

export const listBackups = (): Promise<string[]> =>
  invoke("list_backups");

export const restoreBackup = (filename: string): Promise<void> =>
  invoke("restore_backup", { filename });
