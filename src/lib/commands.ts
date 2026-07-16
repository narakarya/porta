import type {
  App,
  AddAppParams,
  UpdateAppParams,
  DetectResult,
  SetupStatus,
  Workspace,
  Service,
  AddServiceParams,
  ServiceTemplate,
  HealthStatus,
  ImageUpdateInfo,
  UpdateRisk,
  UpdateOptions,
  AppSnapshotSummary,
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

export const saveComposeYaml = (appId: string, content: string): Promise<string> =>
  isTauri ? invoke("save_compose_yaml", { appId, content }) : Promise.resolve("");

export const loadComposeYaml = (path: string): Promise<string> =>
  isTauri ? invoke("load_compose_yaml", { path }) : Promise.resolve("");

export interface ImageTagUpdateSummary {
  services_updated: string[];
  path: string;
}

/**
 * Bump every compose service whose `image` matches `currentImage` to a new
 * tag. Used by the docker-update preflight to apply the recommended LTS
 * detour (e.g. mysql:8.0 → 8.4) directly to the compose file on disk so the
 * next compose-up uses the safer tag.
 */
export const updateComposeImageFor = (
  path: string,
  currentImage: string,
  newTag: string,
): Promise<ImageTagUpdateSummary> =>
  isTauri
    ? invoke("update_compose_image_for", { path, currentImage, newTag })
    : Promise.resolve({ services_updated: [], path });

export const updateComposeImageTag = (
  path: string,
  serviceName: string,
  newTag: string,
): Promise<string> =>
  isTauri
    ? invoke("update_compose_image_tag", { path, serviceName, newTag })
    : Promise.resolve(path);

export interface ParsedComposeService {
  name: string;
  image: string | null;
  build_context: string | null;
  ports: [number, number][];
  environment: Record<string, string>;
  volumes: string[];
  depends_on: string[];
  command: string | null;
}
export interface ParsedComposeProject {
  services: ParsedComposeService[];
}

export const parseComposeString = (content: string): Promise<ParsedComposeProject> =>
  isTauri ? invoke("parse_compose_string", { content }) : Promise.reject(new Error("not tauri"));

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
        kind: params.kind,
        dockerImage: params.docker_image ?? null,
        dockerContainerPort: params.docker_container_port ?? null,
        dockerArgs: params.docker_args ?? null,
        dockerVolumes: params.docker_volumes ?? [],
        composeFile: params.compose_file ?? null,
        composeYaml: params.compose_yaml ?? null,
        networkShare: params.network_share ?? false,
        tunnelName: params.tunnel_name ?? null,
        tunnelCustomHostname: params.tunnel_custom_hostname ?? null,
      })
    : Promise.resolve(mockAddApp(params));

export const updateApp = (params: UpdateAppParams): Promise<App> =>
  isTauri
    ? invoke("update_app", {
        id: params.id,
        name: params.name,
        rootDir: params.root_dir,
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
        dockerImage: params.docker_image ?? null,
        dockerContainerPort: params.docker_container_port ?? null,
        dockerArgs: params.docker_args ?? null,
        dockerVolumes: params.docker_volumes ?? [],
        composeFile: params.compose_file ?? null,
        composeYaml: params.compose_yaml ?? null,
        networkShare: params.network_share ?? false,
        tunnelName: params.tunnel_name ?? null,
        tunnelCustomHostname: params.tunnel_custom_hostname ?? null,
        basicAuthEnabled: params.basic_auth_enabled ?? false,
        basicAuthUsername: params.basic_auth_username ?? null,
        basicAuthPassword: params.basic_auth_password ?? null,
        hostAuthOverrides: params.host_auth_overrides ?? null,
        tunnelAliasDomain: params.tunnel_alias_domain ?? null,
        tunnelAliasRewriteHost: params.tunnel_alias_rewrite_host ?? true,
      })
    : Promise.resolve((() => {
        const app = getMockState().apps.find((a) => a.id === params.id);
        if (app) Object.assign(app, params);
        return app ?? ({ ...params, workspace_id: null, root_dir: "", start_command_source: "", status: "stopped" as const, pid: null, env_file: null, auto_start: false, env_vars: {}, restart_policy: "on-failure" as const, max_retries: 3, extra_subdomains: [], custom_domain: null, port_bindings: [], env_profiles: [], active_profile_id: null, tunnel_provider: null, tunnel_auto_start: false, tunnel_url: null, tunnel_active: false, kind: "process" as const, docker_image: null, docker_container_port: null, docker_args: null, docker_volumes: [], compose_file: null, network_share: false, tunnel_name: null, tunnel_custom_hostname: null, basic_auth_enabled: false, basic_auth_username: null, basic_auth_password_set: false, host_auth_overrides: [], auto_sleep_enabled: false, idle_timeout_secs: 1800, auto_slept: false, max_upload_bytes: null } as App);
      })());

export const deleteApp = (id: string): Promise<void> =>
  isTauri ? invoke("delete_app", { id }) : Promise.resolve(mockDeleteApp(id));

/** Persist per-app auto-sleep config. Returns the refreshed App. */
export const setAppAutoSleep = (
  id: string,
  enabled: boolean,
  idleTimeoutSecs: number
): Promise<App> =>
  isTauri
    ? invoke("set_app_auto_sleep", { id, enabled, idleTimeoutSecs })
    : Promise.resolve((() => {
        const app = getMockState().apps.find((a) => a.id === id);
        if (app) {
          app.auto_sleep_enabled = enabled;
          app.idle_timeout_secs = idleTimeoutSecs;
        }
        return app as App;
      })());

export const saveFile = (_path: string, _contents: string): Promise<void> =>
  isTauri ? invoke("save_file", { path: _path, contents: _contents }) : Promise.resolve();

export const revealInFinder = (path: string): Promise<void> =>
  isTauri ? invoke("reveal_in_finder", { path }) : Promise.resolve();

export const openExternalUrl = (url: string): Promise<void> =>
  isTauri ? invoke("open_external_url", { url }) : Promise.resolve();

export const openInEditor = (rootDir: string): Promise<void> =>
  isTauri ? invoke("open_in_editor", { rootDir }) : Promise.resolve();

export interface ConfigFileInfo {
  path: string;
  name: string;
  size: number;
  modified_at: number | null;
  is_in_compose: boolean;
  /** "env" → rows/secret editor; "generic" → code editor. */
  kind: "env" | "generic";
  /** Syntax-highlight hint for the generic editor. */
  language: "env" | "toml" | "json" | "text";
  /**
   * Absolute path this file would create if used as a template
   * (`.env.example` → `.env`). Only set when that target doesn't exist yet.
   */
  template_target: string | null;
}

export const listAppConfigFiles = (appId: string): Promise<ConfigFileInfo[]> =>
  isTauri ? invoke("list_app_config_files", { appId }) : Promise.resolve([]);

export const readConfigFile = (absolutePath: string): Promise<string> =>
  isTauri ? invoke("read_config_file", { absolutePath }) : Promise.resolve("");

export const writeConfigFile = (absolutePath: string, content: string): Promise<void> =>
  isTauri ? invoke("write_config_file", { absolutePath, content }) : Promise.resolve();

/** Copy a template to its target with secret values blanked. Rejects if the
 *  target already exists. Resolves with the newly written content. */
export const createConfigFromTemplate = (
  sourcePath: string,
  targetPath: string,
): Promise<string> =>
  isTauri
    ? invoke("create_config_from_template", { sourcePath, targetPath })
    : Promise.resolve("");

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

export interface PortHolder {
  pid: number;
  process_name: string;
  command: string;
}

export const findFreePort = (startingAt: number, maxTries: number): Promise<number | null> =>
  isTauri
    ? invoke("find_free_port", { startingAt, maxTries })
    : Promise.resolve(null);

export const whoUsesPort = (port: number): Promise<PortHolder | null> =>
  isTauri ? invoke("who_uses_port", { port }) : Promise.resolve(null);

export const suggestAlternativePort = (currentPort: number): Promise<number> =>
  isTauri
    ? invoke("suggest_alternative_port", { currentPort })
    : Promise.resolve(currentPort);

export const applyPortChange = (
  appId: string,
  oldPort: number,
  newPort: number,
): Promise<void> =>
  isTauri
    ? invoke("apply_port_change", { appId, oldPort, newPort })
    : Promise.resolve();

export const killPid = (pid: number): Promise<void> =>
  isTauri ? invoke("kill_pid", { pid }) : Promise.resolve();

export const markAppStopped = (id: string): Promise<void> =>
  isTauri ? invoke("mark_app_stopped", { id }) : Promise.resolve();

export const markAppReady = (id: string): Promise<void> =>
  isTauri ? invoke("mark_app_ready", { id }) : Promise.resolve();

export const getAppLogs = (id: string): Promise<string[]> =>
  isTauri ? invoke("get_app_logs", { id }) : Promise.resolve([]);

// ── Docker image updates ────────────────────────────────────────────────────

export const checkAppImageUpdates = (id: string): Promise<ImageUpdateInfo[]> =>
  isTauri ? invoke("check_app_image_updates", { id }) : Promise.resolve([]);

/**
 * Pull updated images and recreate containers. `tagReplacements` lets the
 * caller swap pinned tags for newer ones (e.g. `["nginx:1.25.3", "1.26.0"]`).
 * Pass `[]` to just pull whatever the current tag points to.
 *
 * `options` opts in to the safer flow: snapshot named volumes, verify the
 * recreated container(s) reach a healthy state, and roll back the change
 * if they don't. Defaults to the legacy flow (no snapshot, no rollback).
 */
export const updateAppImages = (
  id: string,
  tagReplacements: [string, string][] = [],
  options?: UpdateOptions,
): Promise<void> =>
  isTauri
    ? invoke("update_app_images", { id, tagReplacements, options: options ?? null })
    : Promise.resolve();

/** Pre-flight risk assessment for an upcoming `updateAppImages` call. */
export const classifyImageUpdate = (
  id: string,
  serviceName: string | null,
  targetTag: string | null,
): Promise<UpdateRisk> =>
  isTauri
    ? invoke("classify_image_update", { id, serviceName, targetTag })
    : Promise.resolve({
        level: "safe",
        reasons: [],
        dependents: [],
        volumes: [],
        stateful_label: null,
        is_major_bump: null,
        recommend_intermediate_tag: null,
        recommend_snapshot: false,
        current_image: "",
        target_image: "",
      } satisfies UpdateRisk);

export const listAppVolumeSnapshots = (
  appId: string,
): Promise<AppSnapshotSummary[]> =>
  isTauri ? invoke("list_app_volume_snapshots", { appId }) : Promise.resolve([]);

export const deleteAppVolumeSnapshot = (
  appId: string,
  timestamp: string,
): Promise<void> =>
  isTauri
    ? invoke("delete_app_volume_snapshot", { appId, timestamp })
    : Promise.resolve();

// ── Docker disk usage / prune ────────────────────────────────────────────────

export interface DiskSection {
  kind: string;
  total_count: number;
  active_count: number;
  size_bytes: number;
  reclaimable_bytes: number;
}

export interface SystemDiskUsage {
  images: DiskSection;
  containers: DiskSection;
  volumes: DiskSection;
  build_cache: DiskSection;
  dangling_image_bytes: number;
}

export interface AppDiskUsage {
  image_bytes: number;
  volume_bytes: number;
  container_bytes: number;
  stale_image_count: number;
}

export interface PruneResult {
  removed_count: number;
  freed_bytes: number;
}

const emptySection: DiskSection = {
  kind: "",
  total_count: 0,
  active_count: 0,
  size_bytes: 0,
  reclaimable_bytes: 0,
};

export const systemDiskUsage = (): Promise<SystemDiskUsage> =>
  isTauri
    ? invoke("system_disk_usage")
    : Promise.resolve({
        images: { ...emptySection },
        containers: { ...emptySection },
        volumes: { ...emptySection },
        build_cache: { ...emptySection },
        dangling_image_bytes: 0,
      });

export const appDiskUsage = (appId: string): Promise<AppDiskUsage> =>
  isTauri
    ? invoke("app_disk_usage", { appId })
    : Promise.resolve({ image_bytes: 0, volume_bytes: 0, container_bytes: 0, stale_image_count: 0 });

export interface ImageDetail {
  id: string;
  repository: string;
  tag: string;
  size_bytes: number;
  category: "dangling" | "unused" | "used";
}

export interface DockerImageList {
  dangling: ImageDetail[];
  unused: ImageDetail[];
  used: ImageDetail[];
  dangling_bytes: number;
  unused_bytes: number;
  used_bytes: number;
}

export const listDockerImages = (): Promise<DockerImageList> =>
  isTauri
    ? invoke("list_docker_images")
    : Promise.resolve({ dangling: [], unused: [], used: [], dangling_bytes: 0, unused_bytes: 0, used_bytes: 0 });

export const pruneDanglingImages = (): Promise<PruneResult> =>
  isTauri ? invoke("prune_dangling_images") : Promise.resolve({ removed_count: 0, freed_bytes: 0 });

export const pruneUnusedImages = (): Promise<PruneResult> =>
  isTauri ? invoke("prune_unused_images") : Promise.resolve({ removed_count: 0, freed_bytes: 0 });

export const pruneAppOldImages = (appId: string): Promise<PruneResult> =>
  isTauri
    ? invoke("prune_app_old_images", { appId })
    : Promise.resolve({ removed_count: 0, freed_bytes: 0 });

// ── Health checks ───────────────────────────────────────────────────────────

export const checkAppHealth = (id: string): Promise<HealthStatus> =>
  isTauri ? invoke("check_app_health", { id }) : Promise.resolve("unknown" as HealthStatus);

export const checkAllHealth = (): Promise<Record<string, HealthStatus>> =>
  isTauri ? invoke("check_all_health") : Promise.resolve({});

// ── Per-app custom health probes ────────────────────────────────────────────

export type ProbeKind = "http" | "tcp" | "cmd";

export interface HealthProbe {
  kind: ProbeKind;
  target: string;
  interval_sec: number;
  timeout_sec: number;
  expected_http_status?: number | null;
  expected_exit_code?: number | null;
  enabled: boolean;
}

export interface ProbeResult {
  ok: boolean;
  latency_ms: number;
  message: string;
  checked_at: number;
}

export const getAppHealthProbe = (appId: string): Promise<HealthProbe | null> =>
  isTauri
    ? invoke<HealthProbe | null>("get_app_health_probe", { appId })
    : Promise.resolve(null);

export const setAppHealthProbe = (appId: string, probe: HealthProbe): Promise<void> =>
  isTauri ? invoke("set_app_health_probe", { appId, probe }) : Promise.resolve();

export const clearAppHealthProbe = (appId: string): Promise<void> =>
  isTauri ? invoke("clear_app_health_probe", { appId }) : Promise.resolve();

export const runAppHealthProbe = (appId: string): Promise<ProbeResult> =>
  isTauri
    ? invoke("run_app_health_probe", { appId })
    : Promise.resolve({ ok: false, latency_ms: 0, message: "not tauri", checked_at: 0 });

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

export type NotificationPermissionState = "granted" | "denied" | "prompt" | "prompt-with-rationale";

export const getNotificationPermissionState = (): Promise<NotificationPermissionState> =>
  isTauri ? invoke("get_notification_permission_state") : Promise.resolve("prompt");

export const requestNotificationPermissionAccess = (): Promise<NotificationPermissionState> =>
  isTauri ? invoke("request_notification_permission_access") : Promise.resolve("granted");

export const sendTestNotification = (): Promise<void> =>
  isTauri ? invoke("send_test_notification") : Promise.resolve();

export const getImageUpdateNotifyEnabled = (): Promise<boolean> =>
  isTauri ? invoke("get_image_update_notify_enabled") : Promise.resolve(true);

export const setImageUpdateNotifyEnabled = (enabled: boolean): Promise<void> =>
  isTauri ? invoke("set_image_update_notify_enabled", { enabled }) : Promise.resolve();

export const notifyImageUpdatesFound = (appNames: string[]): Promise<void> =>
  isTauri ? invoke("notify_image_updates_found", { appNames }) : Promise.resolve();

// ── Backup ───────────────────────────────────────────────────────────────────

export const listBackups = (): Promise<string[]> =>
  isTauri ? invoke("list_backups") : Promise.resolve([]);

export const restoreBackup = (filename: string): Promise<void> =>
  isTauri ? invoke("restore_backup", { filename }) : Promise.resolve();

export const exportFullBackup = (destPath: string): Promise<void> =>
  isTauri ? invoke("export_full_backup", { destPath }) : Promise.resolve();

export const importFullBackup = (srcPath: string): Promise<void> =>
  isTauri ? invoke("import_full_backup", { srcPath }) : Promise.resolve();

export const getPortaEnv = (): Promise<string> =>
  isTauri ? invoke("get_porta_env") : Promise.resolve("dev");

// ── Backup schedule ──────────────────────────────────────────────────────────

export type ScheduleFreq = "hourly" | "daily" | "weekly";

export interface BackupSchedule {
  enabled: boolean;
  frequency: ScheduleFreq;
  hour: number;
  minute: number;
  day_of_week: number;
  retain_count: number;
  last_run_at: number | null;
  next_run_at: number | null;
}

const DEFAULT_BACKUP_SCHEDULE: BackupSchedule = {
  enabled: false,
  frequency: "daily",
  hour: 3,
  minute: 0,
  day_of_week: 0,
  retain_count: 10,
  last_run_at: null,
  next_run_at: null,
};

export const getBackupSchedule = (): Promise<BackupSchedule> =>
  isTauri ? invoke("get_backup_schedule") : Promise.resolve({ ...DEFAULT_BACKUP_SCHEDULE });

export const setBackupSchedule = (schedule: BackupSchedule): Promise<void> =>
  isTauri ? invoke("set_backup_schedule", { schedule }) : Promise.resolve();

export const nextBackupAt = (): Promise<number | null> =>
  isTauri ? invoke("next_backup_at") : Promise.resolve(null);

export const runBackupNowViaSchedule = (): Promise<void> =>
  isTauri ? invoke("run_backup_now_via_schedule") : Promise.resolve();

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

// ── Tunneling (cloudflared) ───────────────────────────────────────────────────

export const checkCloudflared = (): Promise<boolean> =>
  isTauri ? invoke("check_cloudflared") : Promise.resolve(false);

export interface CloudflareTunnel {
  id: string;
  name: string;
  connection_count: number;
}

export const listCloudflareTunnels = (): Promise<CloudflareTunnel[]> =>
  isTauri ? invoke("list_cloudflare_tunnels") : Promise.resolve([]);

export const createCloudflareTunnel = (name: string): Promise<void> =>
  isTauri ? invoke("create_cloudflare_tunnel", { name }) : Promise.resolve();

export const deleteCloudflareTunnel = (name: string, force: boolean): Promise<void> =>
  isTauri ? invoke("delete_cloudflare_tunnel", { name, force }) : Promise.resolve();

export const routeTunnelDns = (tunnelName: string, hostname: string, overwrite: boolean): Promise<void> =>
  isTauri ? invoke("route_tunnel_dns", { tunnelName, hostname, overwrite }) : Promise.resolve();

export interface TunnelDnsRoute {
  zone_name: string;
  hostname: string;
  tunnel_id: string;
  zone_id: string;
  record_id: string;
}

export const listTunnelDns = (apiToken: string): Promise<TunnelDnsRoute[]> =>
  isTauri ? invoke("list_tunnel_dns", { apiToken }) : Promise.resolve([]);

export const getCfApiToken = (): Promise<string> =>
  isTauri ? invoke("get_cf_api_token") : Promise.resolve("");

export const setCfApiToken = (token: string): Promise<void> =>
  isTauri ? invoke("set_cf_api_token", { token }) : Promise.resolve();

// ── Cloudflare Access (Zero Trust) ────────────────────────────────────────────

export interface AccessAppInfo {
  uid: string;
  name: string;
  domain: string;
  session_duration: string;
  allowed_emails: string[];
  allowed_domains: string[];
}

export const cfAccessGetApp = (
  apiToken: string,
  hostname: string,
): Promise<AccessAppInfo | null> =>
  isTauri ? invoke("cf_access_get_app", { apiToken, hostname }) : Promise.resolve(null);

export const cfAccessListApps = (apiToken: string): Promise<AccessAppInfo[]> =>
  isTauri ? invoke("cf_access_list_apps", { apiToken }) : Promise.resolve([]);

export const cfAccessProtect = (
  apiToken: string,
  hostname: string,
  allowedEmails: string[],
  allowedDomains: string[],
  sessionDuration?: string,
): Promise<AccessAppInfo> =>
  isTauri
    ? invoke("cf_access_protect", { apiToken, hostname, allowedEmails, allowedDomains, sessionDuration: sessionDuration ?? null })
    : Promise.reject(new Error("Tauri only"));

export const cfAccessUnprotect = (apiToken: string, hostname: string): Promise<void> =>
  isTauri ? invoke("cf_access_unprotect", { apiToken, hostname }) : Promise.resolve();

// ── Cloudflare DNS records ────────────────────────────────────────────────────

export interface DnsZone {
  id: string;
  name: string;
  status: string;
}

export interface DnsRecord {
  id: string;
  record_type: string;
  name: string;
  content: string;
  ttl: number;
  proxied: boolean;
  proxiable: boolean;
  priority: number | null;
}

export interface DnsRecordInput {
  record_type: string;
  name: string;
  content: string;
  ttl: number;
  proxied: boolean;
  priority: number | null;
}

export const cfDnsListZones = (apiToken: string): Promise<DnsZone[]> =>
  isTauri ? invoke("cf_dns_list_zones", { apiToken }) : Promise.resolve([]);

export const cfDnsListRecords = (
  apiToken: string,
  zoneId: string,
  search?: string,
): Promise<DnsRecord[]> =>
  isTauri
    ? invoke("cf_dns_list_records", { apiToken, zoneId, search: search ?? null })
    : Promise.resolve([]);

export const cfDnsCreateRecord = (
  apiToken: string,
  zoneId: string,
  record: DnsRecordInput,
): Promise<DnsRecord> =>
  isTauri
    ? invoke("cf_dns_create_record", { apiToken, zoneId, record })
    : Promise.reject(new Error("Tauri only"));

export const cfDnsUpdateRecord = (
  apiToken: string,
  zoneId: string,
  recordId: string,
  record: DnsRecordInput,
): Promise<DnsRecord> =>
  isTauri
    ? invoke("cf_dns_update_record", { apiToken, zoneId, recordId, record })
    : Promise.reject(new Error("Tauri only"));

export const cfDnsDeleteRecord = (
  apiToken: string,
  zoneId: string,
  recordId: string,
): Promise<void> =>
  isTauri ? invoke("cf_dns_delete_record", { apiToken, zoneId, recordId }) : Promise.resolve();

// ── DNS drift diff ────────────────────────────────────────────────────────────

export interface LocalDnsRecord {
  name: string;
  record_type: string;
  content: string;
  /** Where the local record came from: "caddy" | "dnsmasq". */
  source: string;
}

export interface DnsRecordMismatch {
  name: string;
  cf: DnsRecord;
  local: LocalDnsRecord;
  reason: string;
}

export interface ZoneDnsDiff {
  zone_name: string;
  only_in_cf: DnsRecord[];
  only_local: LocalDnsRecord[];
  mismatched: DnsRecordMismatch[];
}

export const cfDnsDiffZoneVsLocal = (apiToken: string, zoneId: string): Promise<ZoneDnsDiff> =>
  isTauri
    ? invoke("cf_dns_diff_zone_vs_local", { apiToken, zoneId })
    : Promise.resolve({ zone_name: "", only_in_cf: [], only_local: [], mismatched: [] });

// ── Cloudflare Zone settings + cache purge ───────────────────────────────────

export interface ZoneSetting {
  id: string;
  value: string;
  kind: "toggle" | "select" | "number" | string;
  options: string[];
  editable: boolean;
}

export const cfZoneGetSettings = (apiToken: string, zoneId: string): Promise<ZoneSetting[]> =>
  isTauri ? invoke("cf_zone_get_settings", { apiToken, zoneId }) : Promise.resolve([]);

export const cfZoneSetSetting = (
  apiToken: string,
  zoneId: string,
  settingId: string,
  value: string,
): Promise<ZoneSetting> =>
  isTauri
    ? invoke("cf_zone_set_setting", { apiToken, zoneId, settingId, value })
    : Promise.reject(new Error("Tauri only"));

export const cfZonePurgeAll = (apiToken: string, zoneId: string): Promise<void> =>
  isTauri ? invoke("cf_zone_purge_all", { apiToken, zoneId }) : Promise.resolve();

export const cfZonePurgeHosts = (apiToken: string, zoneId: string, hosts: string[]): Promise<void> =>
  isTauri ? invoke("cf_zone_purge_hosts", { apiToken, zoneId, hosts }) : Promise.resolve();

export const cfZonePurgeFiles = (apiToken: string, zoneId: string, files: string[]): Promise<void> =>
  isTauri ? invoke("cf_zone_purge_files", { apiToken, zoneId, files }) : Promise.resolve();

// ── Cloudflare Email Routing ─────────────────────────────────────────────────

export interface EmailRoutingStatus {
  enabled: boolean;
  status: string;
  mx_count: number;
}

export interface EmailDestination {
  tag: string;
  email: string;
  verified: boolean;
}

export interface EmailRule {
  tag: string;
  name: string;
  matcher_value: string;
  forward_to: string[];
  enabled: boolean;
  priority: number;
  catch_all: boolean;
}

export const cfEmailRoutingStatus = (apiToken: string, zoneId: string): Promise<EmailRoutingStatus> =>
  isTauri
    ? invoke("cf_email_routing_status", { apiToken, zoneId })
    : Promise.resolve({ enabled: false, status: "", mx_count: 0 });

export const cfEmailRoutingEnable = (apiToken: string, zoneId: string): Promise<void> =>
  isTauri ? invoke("cf_email_routing_enable", { apiToken, zoneId }) : Promise.resolve();

export const cfEmailListAddresses = (apiToken: string): Promise<EmailDestination[]> =>
  isTauri ? invoke("cf_email_list_addresses", { apiToken }) : Promise.resolve([]);

export const cfEmailCreateAddress = (apiToken: string, email: string): Promise<EmailDestination> =>
  isTauri
    ? invoke("cf_email_create_address", { apiToken, email })
    : Promise.reject(new Error("Tauri only"));

export const cfEmailDeleteAddress = (apiToken: string, tag: string): Promise<void> =>
  isTauri ? invoke("cf_email_delete_address", { apiToken, tag }) : Promise.resolve();

export const cfEmailListRules = (apiToken: string, zoneId: string): Promise<EmailRule[]> =>
  isTauri ? invoke("cf_email_list_rules", { apiToken, zoneId }) : Promise.resolve([]);

export const cfEmailCreateRule = (
  apiToken: string,
  zoneId: string,
  name: string,
  matcherValue: string,
  forwardTo: string[],
): Promise<EmailRule> =>
  isTauri
    ? invoke("cf_email_create_rule", { apiToken, zoneId, name, matcherValue, forwardTo })
    : Promise.reject(new Error("Tauri only"));

export const cfEmailDeleteRule = (apiToken: string, zoneId: string, tag: string): Promise<void> =>
  isTauri ? invoke("cf_email_delete_rule", { apiToken, zoneId, tag }) : Promise.resolve();

export const cfEmailSetCatchall = (apiToken: string, zoneId: string, forwardTo: string[]): Promise<void> =>
  isTauri ? invoke("cf_email_set_catchall", { apiToken, zoneId, forwardTo }) : Promise.resolve();

export const setTunnelConfig = (
  id: string,
  tunnelProvider: string | null,
  tunnelName: string | null,
  tunnelCustomHostname: string | null,
  tunnelAutoStart: boolean | null = null
): Promise<void> =>
  isTauri
    ? invoke("set_tunnel_config", { id, tunnelProvider, tunnelName, tunnelCustomHostname, tunnelAutoStart })
    : Promise.resolve();

export const startTunnel = (id: string, port: number): Promise<void> =>
  isTauri ? invoke("start_tunnel", { id, port }) : Promise.resolve();

export const stopTunnel = (id: string): Promise<void> =>
  isTauri ? invoke("stop_tunnel", { id }) : Promise.resolve();

// Per-instance quick (trycloudflare) tunnel — no named-tunnel/DNS support,
// mirrors the app quick-tunnel path but scoped to a worktree instance's own
// local endpoint.
export const startInstanceTunnel = (instanceId: string): Promise<void> =>
  isTauri ? invoke("start_instance_tunnel", { instanceId }) : Promise.resolve();

export const stopInstanceTunnel = (instanceId: string): Promise<void> =>
  isTauri ? invoke("stop_instance_tunnel", { instanceId }) : Promise.resolve();

export interface TunnelMetrics {
  requests_total: number;
  errors_total: number;
  active_connections: number;
  response_latency_p50_ms: number;
  response_latency_p99_ms: number;
}

/** Tagged error from `tunnel_metrics`. `not_enabled` means the tunnel is
 * running but Porta didn't capture a metrics port (legacy / restart needed). */
export interface TunnelMetricsErrorPayload {
  kind: "not_enabled" | "not_running" | "scrape";
  tunnel_name?: string;
  message?: string;
}

export const tunnelMetrics = (tunnelName: string): Promise<TunnelMetrics> =>
  isTauri
    ? invoke("tunnel_metrics", { tunnelName })
    : Promise.reject(new Error("Tauri only"));

export interface ZoneCert {
  zone: string;
  path: string;
}

export const listCloudflareZoneCerts = (): Promise<ZoneCert[]> =>
  isTauri ? invoke("list_cloudflare_zone_certs") : Promise.resolve([]);

export const importCloudflareZoneCert = (zone: string, sourcePath: string): Promise<string> =>
  isTauri ? invoke("import_cloudflare_zone_cert", { zone, sourcePath }) : Promise.resolve("");

export const deleteCloudflareZoneCert = (zone: string): Promise<void> =>
  isTauri ? invoke("delete_cloudflare_zone_cert", { zone }) : Promise.resolve();

export const previewZoneForHostname = (hostname: string): Promise<string | null> =>
  isTauri ? invoke("preview_zone_for_hostname", { hostname }) : Promise.resolve(null);

// ── Tunneling (tailscale) ─────────────────────────────────────────────────────

export interface TailscaleStatus {
  installed: boolean;
  running: boolean;
  logged_in: boolean;
  host: string | null;
  error: string | null;
}

export const checkTailscale = (): Promise<boolean> =>
  isTauri ? invoke("check_tailscale") : Promise.resolve(false);

export const getTailscaleStatus = (): Promise<TailscaleStatus> =>
  isTauri
    ? invoke("tailscale_status")
    : Promise.resolve({ installed: false, running: false, logged_in: false, host: null, error: null });

export interface TailscaleServeEntry {
  port: number;
  upstream: string;
  funnel: boolean;
}

export const listTailscaleServes = (): Promise<TailscaleServeEntry[]> =>
  isTauri ? invoke("list_tailscale_serves") : Promise.resolve([]);

export const startTailscaleServe = (id: string, port: number, funnel = false): Promise<void> =>
  isTauri ? invoke("start_tailscale_serve", { id, port, funnel }) : Promise.resolve();

export const stopTailscaleServe = (id: string): Promise<void> =>
  isTauri ? invoke("stop_tailscale_serve", { id }) : Promise.resolve();

export const resetTailscaleServes = (): Promise<void> =>
  isTauri ? invoke("reset_tailscale_serves") : Promise.resolve();

export const stopAllPortaTailscaleServes = (): Promise<void> =>
  isTauri ? invoke("stop_all_porta_tailscale_serves") : Promise.resolve();

/** HEAD request to verify a tunnel URL is actually reachable (not just configured). */
export const checkTunnelReachable = (url: string): Promise<boolean> =>
  isTauri ? invoke("check_tunnel_reachable", { url }) : Promise.resolve(true);

// ── Tunneling (Porta Relay — self-hosted VPS) ─────────────────────────────────

export interface RemoteHost {
  id: string;
  name: string;
  tunnel_ip: string;
  admin_port: number;
  base_domain: string;
  wg_interface: string | null;
  mac_tunnel_ip: string;
  created_at: number;
  extra_domains: string[];
  public_ip: string | null;
  auto_dns: boolean;
  ssh_user: string | null;
  remote_log_path: string | null;
}

export interface RemoteRoute {
  id: string;
  app_id: string;
  host_id: string;
  subdomain: string;
  port: number;
  status: string;
  created_at: number;
  domain: string | null;
}

export interface RemoteHostTest {
  reachable: boolean;
  message: string;
}

export const listRemoteHosts = (): Promise<RemoteHost[]> =>
  isTauri ? invoke("list_remote_hosts") : Promise.resolve([]);

export const addRemoteHost = (host: RemoteHost): Promise<RemoteHost> =>
  isTauri ? invoke("add_remote_host", { host }) : Promise.resolve(host);

export const updateRemoteHost = (host: RemoteHost): Promise<void> =>
  isTauri ? invoke("update_remote_host", { host }) : Promise.resolve();

export const deleteRemoteHost = (id: string): Promise<void> =>
  isTauri ? invoke("delete_remote_host", { id }) : Promise.resolve();

export const testRemoteHost = (id: string): Promise<RemoteHostTest> =>
  isTauri
    ? invoke("test_remote_host", { id })
    : Promise.resolve({ reachable: false, message: "Not available in browser mode" });

export const listRemoteRoutes = (): Promise<RemoteRoute[]> =>
  isTauri ? invoke("list_remote_routes") : Promise.resolve([]);

export const exposeRemote = (
  appId: string,
  hostId: string,
  subdomain: string,
  domain?: string | null,
): Promise<string> =>
  isTauri
    ? invoke("expose_remote", { appId, hostId, subdomain, domain: domain ?? null })
    : Promise.resolve(`https://${subdomain}.${domain ?? "example.com"}`);

export const unexposeRemote = (appId: string): Promise<void> =>
  isTauri ? invoke("unexpose_remote", { appId }) : Promise.resolve();

export interface WgStatus {
  interface: string;
  up: boolean;
  peer_found: boolean;
  endpoint: string | null;
  handshake_age_secs: number | null;
  rx_bytes: number;
  tx_bytes: number;
}

export interface DiffReport {
  matched: string[];
  missing_on_vps: string[];
  foreign_on_vps: string[];
}

export const remoteDiff = (hostId: string): Promise<DiffReport> =>
  isTauri
    ? invoke("remote_diff", { hostId })
    : Promise.resolve({ matched: [], missing_on_vps: [], foreign_on_vps: [] });

export const remotePushHost = (hostId: string): Promise<void> =>
  isTauri ? invoke("remote_push_host", { hostId }) : Promise.resolve();

export const remoteRemoveForeign = (hostId: string, publicHost: string): Promise<void> =>
  isTauri ? invoke("remote_remove_foreign", { hostId, publicHost }) : Promise.resolve();

export const remoteLogTail = (hostId: string, lines: number): Promise<AccessLogEntry[]> =>
  isTauri ? invoke("remote_log_tail", { hostId, lines }) : Promise.resolve([]);

export const remoteLogLiveStart = (hostId: string): Promise<string> =>
  isTauri ? invoke("remote_log_live_start", { hostId }) : Promise.resolve("");

export const remoteLogLiveStop = (streamId: string): Promise<void> =>
  isTauri ? invoke("remote_log_live_stop", { streamId }) : Promise.resolve();

export const wgStatus = (hostId: string): Promise<WgStatus> =>
  isTauri
    ? invoke("wg_status", { hostId })
    : Promise.resolve({
        interface: "",
        up: false,
        peer_found: false,
        endpoint: null,
        handshake_age_secs: null,
        rx_bytes: 0,
        tx_bytes: 0,
      });

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

export const detectAppTags = (rootDir: string): Promise<string[]> =>
  isTauri
    ? invoke("detect_app_tags", { rootDir })
    : Promise.resolve([]);

// ── Caddy ─────────────────────────────────────────────────────────────────────

export const caddyStatusCheck = (): Promise<boolean> =>
  isTauri ? invoke("caddy_status") : Promise.resolve(false);

// ── In-app terminal ───────────────────────────────────────────────────────────

export const terminalOpen = (
  appId: string,
  rootDir: string,
  rows: number,
  cols: number,
  startupCmd?: string | null,
): Promise<void> =>
  isTauri
    ? invoke("terminal_open", { appId, rootDir, rows, cols, startupCmd: startupCmd ?? null })
    : Promise.resolve();

export const terminalWrite = (appId: string, data: number[]): Promise<void> =>
  isTauri ? invoke("terminal_write", { appId, data }) : Promise.resolve();

export const terminalResize = (appId: string, rows: number, cols: number): Promise<void> =>
  isTauri ? invoke("terminal_resize", { appId, rows, cols }) : Promise.resolve();

export const terminalClose = (appId: string): Promise<void> =>
  isTauri ? invoke("terminal_close", { appId }) : Promise.resolve();

// ── Container observability (logs streaming + stats) ────────────────────────

export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: string;
}

export interface ContainerStats {
  cpu_pct: number;
  mem_usage_bytes: number;
  mem_limit_bytes: number;
  mem_pct: number;
  net_rx_bytes: number;
  net_tx_bytes: number;
  block_read_bytes: number;
  block_write_bytes: number;
}

export interface ContainerLogLine {
  stream: "stdout" | "stderr";
  text: string;
  ts: number;
}

export const containersForApp = (appId: string): Promise<ContainerInfo[]> =>
  isTauri ? invoke("containers_for_app", { appId }) : Promise.resolve([]);

export const containerStats = (containerName: string): Promise<ContainerStats> =>
  isTauri
    ? invoke("container_stats", { containerName })
    : Promise.reject(new Error("container_stats not available in browser mode"));

export const startContainerLogs = (containerName: string, tail: number): Promise<string> =>
  isTauri
    ? invoke("start_container_logs", { containerName, tail })
    : Promise.reject(new Error("start_container_logs not available in browser mode"));

export const stopContainerLogs = (streamId: string): Promise<void> =>
  isTauri ? invoke("stop_container_logs", { streamId }) : Promise.resolve();

// ── Docker Compose import ────────────────────────────────────────────────────

export interface ComposeService {
  name: string;
  image: string | null;
  build_context: string | null;
  ports: [number, number][];
  environment: Record<string, string>;
  volumes: string[];
  depends_on: string[];
  command: string | null;
}

export interface ComposeProject {
  services: ComposeService[];
}

export const parseDockerCompose = (path: string): Promise<ComposeProject> =>
  isTauri
    ? invoke("parse_docker_compose", { path })
    : Promise.reject(new Error("parse_docker_compose not available in browser mode"));

// ── Porta Config (team sharing) ──────────────────────────────────────────────

export const exportPortaConfig = (workspaceId: string, destPath: string): Promise<void> =>
  isTauri ? invoke("export_porta_config", { workspaceId, destPath }) : Promise.resolve();

export const importPortaConfig = (srcPath: string): Promise<void> =>
  isTauri ? invoke("import_porta_config", { srcPath }) : Promise.resolve();

// ── Certificate management ────────────────────────────────────────────────────

export const regenerateCerts = (): Promise<void> =>
  isTauri ? invoke("regenerate_certs") : Promise.resolve();

// ── Service Templates ────────────────────────────────────────────────────────

let _mockTemplateStore: ServiceTemplate[] = [];

export const listServiceTemplates = (): Promise<ServiceTemplate[]> =>
  isTauri
    ? invoke("list_service_templates")
    : Promise.resolve([..._mockTemplateStore]);

export const saveServiceTemplate = (template: ServiceTemplate): Promise<ServiceTemplate> => {
  if (isTauri) return invoke("save_service_template", { template });
  const idx = _mockTemplateStore.findIndex((t) => t.id === template.id);
  if (idx === -1) _mockTemplateStore.push(template);
  else _mockTemplateStore[idx] = template;
  return Promise.resolve(template);
};

export const deleteServiceTemplate = (id: string): Promise<void> => {
  if (isTauri) return invoke("delete_service_template", { id });
  _mockTemplateStore = _mockTemplateStore.filter((t) => t.id !== id);
  return Promise.resolve();
};

// ── Log management ──────────────────────────────────────────────────────────

export interface AppLogSize {
  app_id: string;
  bytes: number;
}

export interface LogsDiskUsage {
  total_bytes: number;
  per_app: AppLogSize[];
}

export interface RotateSummary {
  files_rotated: number;
  bytes_freed: number;
}

export interface ClearSummary {
  files_cleared: number;
  bytes_freed: number;
}

export const appLogsDiskUsage = (): Promise<LogsDiskUsage> =>
  isTauri ? invoke("app_logs_disk_usage") : Promise.resolve({ total_bytes: 0, per_app: [] });

export const rotateAppLogs = (): Promise<RotateSummary> =>
  isTauri ? invoke("rotate_app_logs") : Promise.resolve({ files_rotated: 0, bytes_freed: 0 });

export const clearAppLogFile = (appId: string): Promise<number> =>
  isTauri ? invoke("clear_app_log_file", { appId }) : Promise.resolve(0);

export const clearAllAppLogs = (): Promise<ClearSummary> =>
  isTauri ? invoke("clear_all_app_logs") : Promise.resolve({ files_cleared: 0, bytes_freed: 0 });

export const getMaxLogBytes = (): Promise<number> =>
  isTauri ? invoke("get_max_log_bytes") : Promise.resolve(5 * 1024 * 1024);

export const setMaxLogBytes = (maxBytes: number): Promise<void> =>
  isTauri ? invoke("set_max_log_bytes", { maxBytes }) : Promise.resolve();

// ── Proxy upload limit (request body size) ──────────────────────────────────

/** Global default cap (bytes) on request bodies the proxy forwards to an app. */
export const getDefaultMaxUploadBytes = (): Promise<number> =>
  isTauri ? invoke("get_default_max_upload_bytes") : Promise.resolve(100 * 1024 * 1024);

export const setDefaultMaxUploadBytes = (maxBytes: number): Promise<void> =>
  isTauri ? invoke("set_default_max_upload_bytes", { maxBytes }) : Promise.resolve();

/**
 * Persist a single app's max upload body size and re-sync Caddy. `maxBytes`
 * null clears the override (inherit the global default); 0 means unlimited.
 * Returns the refreshed App.
 */
export const setAppMaxUploadBytes = (
  id: string,
  maxBytes: number | null
): Promise<App> =>
  isTauri
    ? invoke("set_app_max_upload_bytes", { id, maxBytes })
    : Promise.resolve((() => {
        const app = getMockState().apps.find((a) => a.id === id);
        if (app) app.max_upload_bytes = maxBytes;
        return app as App;
      })());

// ── Per-app HTTP access log (Traffic Inspector) ─────────────────────────────

export interface AccessLogEntry {
  ts: number;
  method: string;
  host: string;
  uri: string;
  status: number;
  duration_ms: number;
  remote_ip: string;
  req_headers: Record<string, string[]>;
  resp_headers: Record<string, string[]>;
  req_body?: string | null;
  resp_size_bytes: number;
}

export interface AccessLogChunk {
  entries: AccessLogEntry[];
  next_offset: number;
}

export interface AccessLogStreamEvent {
  entries: AccessLogEntry[];
}

export const tailAccessLog = (appId: string, fromOffset: number): Promise<AccessLogChunk> =>
  isTauri
    ? invoke("tail_access_log", { appId, fromOffset })
    : Promise.resolve({ entries: [], next_offset: 0 });

export const clearAccessLog = (appId: string): Promise<void> =>
  isTauri ? invoke("clear_access_log", { appId }) : Promise.resolve();

export const liveAccessLogStart = (appId: string): Promise<string> =>
  isTauri
    ? invoke("live_access_log_start", { appId })
    : Promise.reject(new Error("live_access_log_start not available in browser mode"));

export const liveAccessLogStop = (streamId: string): Promise<void> =>
  isTauri ? invoke("live_access_log_stop", { streamId }) : Promise.resolve();

// ── Extensions ───────────────────────────────────────────────────────────────

export type { ExtensionInfo, ExtensionActionContrib } from "../types/extension";
import type { ExtensionInfo } from "../types/extension";

export const listExtensions = (): Promise<ExtensionInfo[]> =>
  isTauri ? invoke("list_extensions") : Promise.resolve([]);

export const getExtensionsForApp = (appKind: string, appTags: string[]): Promise<ExtensionInfo[]> =>
  isTauri ? invoke("get_extensions_for_app", { appKind, appTags }) : Promise.resolve([]);

export const rescanExtensions = (): Promise<ExtensionInfo[]> =>
  isTauri ? invoke("rescan_extensions") : Promise.resolve([]);

export const installExtensionFromFolder = (path: string): Promise<ExtensionInfo> =>
  isTauri ? invoke("install_extension_from_folder", { path }) : Promise.reject(new Error("not available"));

export const installExtensionFromGithub = (url: string): Promise<ExtensionInfo> =>
  isTauri ? invoke("install_extension_from_github", { url }) : Promise.reject(new Error("not available"));

export const updateExtension = (id: string): Promise<ExtensionInfo> =>
  isTauri ? invoke("update_extension", { id }) : Promise.reject(new Error("not available"));

export const setExtensionEnabled = (id: string, enabled: boolean): Promise<void> =>
  isTauri ? invoke("set_extension_enabled_cmd", { id, enabled }) : Promise.resolve();

export const setExtensionSource = (id: string, source: string | null): Promise<ExtensionInfo> =>
  isTauri ? invoke("set_extension_source_cmd", { id, source }) : Promise.reject(new Error("not available"));

export const uninstallExtension = (id: string): Promise<void> =>
  isTauri ? invoke("uninstall_extension_cmd", { id }) : Promise.resolve();

export const extensionShellRun = (
  appId: string,
  extensionId: string,
  cmd: string,
  opts?: { cwdOverride?: string; timeoutMs?: number },
): Promise<import("../types/extension").ShellResult> =>
  isTauri
    ? invoke("extension_shell_run", {
        appId,
        extensionId,
        cmd,
        cwdOverride: opts?.cwdOverride ?? null,
        timeoutMs: opts?.timeoutMs ?? null,
      })
    : Promise.reject(new Error("extension_shell_run not available in browser mode"));

// ── Extension storage (per-extension KV) ────────────────────────────────────
export const extensionStorageGet = (extensionId: string, key: string): Promise<unknown> =>
  isTauri ? invoke("extension_storage_get", { extensionId, key }) : Promise.resolve(null);

export const extensionStorageSet = (extensionId: string, key: string, value: unknown): Promise<void> =>
  isTauri ? invoke("extension_storage_set", { extensionId, key, value }) : Promise.resolve();

export const extensionStorageRemove = (extensionId: string, key: string): Promise<void> =>
  isTauri ? invoke("extension_storage_remove", { extensionId, key }) : Promise.resolve();

export const extensionStorageKeys = (extensionId: string): Promise<string[]> =>
  isTauri ? invoke("extension_storage_keys", { extensionId }) : Promise.resolve([]);

export const readExtensionFile = (path: string): Promise<string> =>
  isTauri
    ? invoke("read_extension_file", { path })
    : Promise.reject(new Error("read_extension_file not available in browser mode"));

// ── Git ───────────────────────────────────────────────────────────────────────

export interface GitStatus {
  /** Branch name, or a short SHA when HEAD is detached. */
  branch: string;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  dirty: number;
}

/**
 * Resolves `null` when `rootDir` isn't a git repo — the common case, not an
 * error. REJECTS with git's own stderr when git ran and failed for a reason
 * worth showing, e.g. `detected dubious ownership`.
 */
export const gitStatus = (rootDir: string): Promise<GitStatus | null> =>
  isTauri ? invoke("git_status", { rootDir }) : Promise.resolve(null);

export const gitFetch = (rootDir: string): Promise<void> =>
  isTauri ? invoke("git_fetch", { rootDir }) : Promise.resolve();

export const gitPull = (rootDir: string): Promise<string> =>
  isTauri ? invoke("git_pull", { rootDir }) : Promise.resolve("");

export const gitPush = (rootDir: string): Promise<string> =>
  isTauri ? invoke("git_push", { rootDir }) : Promise.resolve("");

export interface BranchList {
  local: string[];
  remote: string[];
  /** Current branch short name; null when HEAD is detached. */
  current: string | null;
}

/** Local + remote-tracking branch names for a repo. REJECTS with git's stderr. */
export const gitBranches = (rootDir: string): Promise<BranchList> =>
  isTauri
    ? invoke("git_branches", { rootDir })
    : Promise.resolve({ local: [], remote: [], current: null });

/**
 * Switch the primary checkout to `branch`. Pass the short name (`foo`, not
 * `origin/foo`) — git DWIM creates a local tracking branch from a remote-only
 * match. `create` uses `git switch -c` to branch from current HEAD.
 * REJECTS with git's stderr (dirty-tree conflict, already-checked-out, etc.).
 */
export const gitSwitchBranch = (rootDir: string, branch: string, create: boolean): Promise<void> =>
  isTauri ? invoke("git_switch_branch", { rootDir, branch, create }) : Promise.resolve();

export const getGitAutofetchEnabled = (): Promise<boolean> =>
  isTauri ? invoke("get_git_autofetch_enabled") : Promise.resolve(true);

export const setGitAutofetchEnabled = (enabled: boolean): Promise<void> =>
  isTauri ? invoke("set_git_autofetch_enabled", { enabled }) : Promise.resolve();

export const getGitAutofetchIntervalSecs = (): Promise<number> =>
  isTauri ? invoke("get_git_autofetch_interval_secs") : Promise.resolve(180);

export const setGitAutofetchIntervalSecs = (secs: number): Promise<void> =>
  isTauri ? invoke("set_git_autofetch_interval_secs", { secs }) : Promise.resolve();

// ── Worktree instances ────────────────────────────────────────────────────────

export interface WorktreeEntry {
  path: string;
  branch: string | null;
  head: string;
  detached: boolean;
}

export interface AppInstance {
  id: string;
  app_id: string;
  worktree_path: string;
  branch: string;
  subdomain: string;
  port: number;
  pid: number | null;
  status: string; // "stopped" | "starting" | "running"
  // Populated client-side from `instance:tunnel:{id}` events (not persisted —
  // Rust's AppInstance/list_instances has no tunnel fields). Optional so
  // instances predating a tunnel connect still type-check.
  tunnel_active?: boolean;
  tunnel_url?: string | null;
}

export const gitWorktreeList = (rootDir: string): Promise<WorktreeEntry[]> =>
  isTauri ? invoke("git_worktree_list", { rootDir }) : Promise.resolve([]);

export const listInstances = (appId: string): Promise<AppInstance[]> =>
  isTauri ? invoke("list_instances", { appId }) : Promise.resolve([]);

export const startInstance = (appId: string, worktreePath: string): Promise<AppInstance> =>
  isTauri
    ? invoke("start_instance", { appId, worktreePath })
    : Promise.reject(new Error("[mock] start_instance"));

export const stopInstance = (instanceId: string): Promise<void> =>
  isTauri ? invoke("stop_instance", { instanceId }) : Promise.resolve();

export const killInstance = (instanceId: string): Promise<void> =>
  isTauri ? invoke("kill_instance", { instanceId }) : Promise.resolve();

export const removeInstance = (instanceId: string): Promise<void> =>
  isTauri ? invoke("remove_instance", { instanceId }) : Promise.resolve();
