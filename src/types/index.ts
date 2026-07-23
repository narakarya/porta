export interface Workspace {
  id: string;
  name: string;
  domain: string;
  deployment: DeploymentConfig | null;
}

export type AppKind = "process" | "static" | "docker" | "compose" | "proxy";

export interface App {
  id: string;
  workspace_id: string | null;
  name: string;
  root_dir: string;
  port: number;
  subdomain: string | null;
  start_command: string;
  start_command_source: string;
  status: "stopped" | "running" | "starting";
  pid: number | null;
  env_file: string | null;
  auto_start: boolean;
  /** "process" (default) — start_command spawned, Caddy reverse-proxies to port.
   *  "static" — Caddy file_server serves root_dir directly, no process.
   *  "docker" — Porta runs a docker container; Caddy reverse-proxies to port. */
  kind: AppKind;
  // docker
  docker_image: string | null;
  docker_container_port: number | null;
  docker_args: string | null;
  docker_volumes: string[];
  // compose
  compose_file: string | null;
  // shared workspace docker network
  network_share: boolean;
  // named tunnel — when set, start_tunnel uses `cloudflared tunnel run <name>` instead of a quick tunnel
  tunnel_name: string | null;
  tunnel_custom_hostname: string | null;
  // v0.2 additions
  env_vars: Record<string, string>;
  restart_policy: "never" | "always" | "on-failure";
  max_retries: number;
  // dependency graph
  health_check_path: string | null;
  depends_on: string[];
  // multiple subdomains
  extra_subdomains: string[];
  // custom domain (overrides workspace domain)
  custom_domain: string | null;
  // multi-port bindings
  port_bindings: PortBinding[];
  // environment profiles
  env_profiles: EnvProfile[];
  active_profile_id: string | null;
  // tunnel
  tunnel_provider: string | null;
  /** When true, app-ready triggers tunnel start automatically. */
  tunnel_auto_start: boolean;
  tunnel_url: string | null;
  tunnel_active: boolean;
  // basic auth — opt-in HTTP Basic Auth in front of the Caddy route.
  basic_auth_enabled: boolean;
  basic_auth_username: string | null;
  /** Backend never exposes the bcrypt hash — this is just a "is one stored?"
   *  flag so the UI can render "password set ✓ — leave blank to keep". */
  basic_auth_password_set: boolean;
  /** Per-host overrides of the Basic Auth default. Only hosts that deviate
   *  from the default appear here. */
  host_auth_overrides: HostAuthOverride[];
  /** Alternate hostname pattern to expose this app under (e.g. `*.foo.com`).
   *  Used together with a Cloudflare tunnel for multi-tenant apps. */
  tunnel_alias_domain: string | null;
  /** When true (default), Caddy rewrites the upstream Host header on alias
   *  requests so the app sees its native domain. Disable when the app
   *  itself accepts the alias domain. */
  tunnel_alias_rewrite_host: boolean;
  /** When true, Porta stops this app after `idle_timeout_secs` without HTTP
   *  traffic and transparently wakes it on the next request. Opt-in per app. */
  auto_sleep_enabled: boolean;
  /** Idle window before sleeping (seconds). Default 1800 (30 min). */
  idle_timeout_secs: number;
  /** True when the idle watcher put the app to sleep (vs. a manual stop).
   *  Drives the 💤 badge; cleared on next start/wake. */
  auto_slept: boolean;
  /** Max request body (bytes) Porta's proxy accepts for this app's routes.
   *  null inherits the global `proxy_max_body_bytes` default; 0 means unlimited.
   *  Larger uploads get a 413 from Caddy. */
  max_upload_bytes: number | null;
}

/** Per-host Basic Auth override (read shape from the backend — never the hash). */
export interface HostAuthOverride {
  /** Fully resolved host this applies to, e.g. `admin.sidiq.sch.id`. */
  host: string;
  /** "off" → host stays public; "custom" → host uses its own credentials. */
  mode: "off" | "custom";
  username: string | null;
  /** True when a custom password hash is stored (leave blank to keep it). */
  password_set: boolean;
}

/** Per-host override as sent to the backend — carries the plaintext password
 *  (blank/omitted ⇒ keep the stored hash). */
export interface HostAuthOverrideInput {
  host: string;
  mode: "off" | "custom";
  username?: string | null;
  password?: string | null;
}

export type HealthStatus = "healthy" | "unhealthy" | "unknown";

export interface ImageUpdateInfo {
  /** Original image ref as stored on the app (e.g. `nginx:1.25.3`). */
  image: string;
  /** Compose service name when this image came from a compose file; null for single docker apps. */
  service_name: string | null;
  /** Normalized repo, e.g. `library/nginx`. */
  repo: string;
  tag: string;
  /** "ok" — check ran. "skipped" — non-Docker-Hub or digest-pinned. "error" — network/parse failure. */
  status: "ok" | "skipped" | "error";
  message: string | null;
  local_digest: string | null;
  remote_digest: string | null;
  /** True when the registry's current digest differs from what we have locally. */
  has_digest_update: boolean;
  /** For semver-pinned tags only — a higher version with the same suffix, if any. */
  suggested_tag: string | null;
}

export type RiskLevel = "safe" | "caution" | "danger";

export interface VolumeMount {
  source: string;
  container_path: string;
  is_named: boolean;
  is_stateful_path: boolean;
}

export interface UpdateRisk {
  level: RiskLevel;
  reasons: string[];
  dependents: string[];
  volumes: VolumeMount[];
  stateful_label: string | null;
  is_major_bump: boolean | null;
  recommend_intermediate_tag: string | null;
  recommend_snapshot: boolean;
  current_image: string;
  target_image: string;
}

export interface UpdateOptions {
  snapshot_first?: boolean;
  auto_rollback?: boolean;
  restore_on_rollback?: boolean;
  /** Local volume names (compose `cap_db`) or fully-qualified docker volume names. */
  snapshot_volumes?: string[];
  verify_timeout_secs?: number | null;
}

export interface VolumeSnapshotEntry {
  volume: string;
  docker_volume: string;
  archive_path: string;
  size_bytes: number;
}

export interface AppSnapshotSummary {
  timestamp: string;
  entries: VolumeSnapshotEntry[];
  total_bytes: number;
}

export interface DetectResult {
  command: string | null;
  source: string;
  kind: AppKind;
}

export interface SetupStatus {
  caddy_installed: boolean;
  dnsmasq_installed: boolean;
  test_resolver_exists: boolean;
  caddy_running: boolean;
  mkcert_installed: boolean;
  certs_generated: boolean;
}

export type AddAppParams = {
  workspace_id: string | null;
  name: string;
  root_dir: string;
  port: number;
  subdomain: string | null;
  start_command: string;
  start_command_source: string;
  kind: AppKind;
  docker_image?: string | null;
  docker_container_port?: number | null;
  docker_args?: string | null;
  docker_volumes?: string[];
  compose_file?: string | null;
  compose_yaml?: string | null;
  network_share?: boolean;
  tunnel_name?: string | null;
  tunnel_custom_hostname?: string | null;
};

export type UpdateAppParams = {
  id: string;
  name: string;
  root_dir?: string;
  port: number;
  subdomain: string | null;
  start_command: string;
  env_file: string | null;
  auto_start: boolean;
  env_vars: Record<string, string>;
  restart_policy: "never" | "always" | "on-failure";
  max_retries: number;
  health_check_path: string | null;
  depends_on: string[];
  extra_subdomains: string[];
  custom_domain: string | null;
  port_bindings?: PortBinding[];
  env_profiles?: EnvProfile[];
  active_profile_id?: string | null;
  docker_image?: string | null;
  docker_container_port?: number | null;
  docker_args?: string | null;
  docker_volumes?: string[];
  compose_file?: string | null;
  compose_yaml?: string | null;
  network_share?: boolean;
  tunnel_name?: string | null;
  tunnel_custom_hostname?: string | null;
  basic_auth_enabled?: boolean;
  basic_auth_username?: string | null;
  /** Plaintext password. null/empty leaves the existing hash intact —
   *  send only when the user actually retyped the secret. */
  basic_auth_password?: string | null;
  /** Full, authoritative per-host override set. Omit to keep the stored set. */
  host_auth_overrides?: HostAuthOverrideInput[];
  tunnel_alias_domain?: string | null;
  tunnel_alias_rewrite_host?: boolean;
};

// ── Services ─────────────────────────────────────────────────────────────────

export interface Service {
  id: string;
  name: string;
  image: string;
  tag: string;
  port: number;
  env_vars: Record<string, string>;
  volumes: string[]; // "source:target" pairs, e.g. "pgdata:/var/lib/postgresql/data"
  scope: "global" | string; // "global" or workspace_id
  status: "stopped" | "running" | "pulling" | "starting";
  container_id: string | null;
}

export type AddServiceParams = {
  name: string;
  image: string;
  tag: string;
  port: number;
  env_vars: Record<string, string>;
  volumes: string[];
  scope: "global" | string;
};

export interface ServiceTemplate {
  id: string;
  label: string;
  icon: string;
  image: string;
  tag: string;
  versions: string[];
  port: number;
  env_vars: Record<string, string>;
  volumes: string[];
}

// ── Port Bindings ────────────────────────────────────────────────────────────

export interface PortBinding {
  id: string;
  label: string;
  port: number;
  subdomain: string | null;
  custom_domain: string | null;
}

// ── Deployment ────────────────────────────────────────────────────────────────

export interface DeployRole {
  name: string;
  instances: number;
  version: string | null;
  status: "live" | "stale" | "failed";
}

export interface DeployEnvironment {
  name: string;
  last_deployed_at: string | null;
  deployed_version: string | null;
  status: "live" | "stale" | "failed" | "deploying" | "unknown";
  roles: DeployRole[];
}

export interface DeploymentConfig {
  provider: "kamal";
  config_path: string;
  environments: DeployEnvironment[];
}

// ── Deploy custom commands ─────────────────────────────────────────────────────

/** A named run profile (dev, prod, staging, …). Beyond the environment it can
 *  override the app's start command and prepend a build step, so "run as prod"
 *  is a profile switch rather than a separate mode axis. Both commands are null
 *  on the profiles that predate them, meaning "use the app's own command" and
 *  "no build step". */
export interface EnvProfile {
  id: string;
  name: string;
  env_file: string | null;
  env_vars: Record<string, string>;
  start_command?: string | null;
  build_command?: string | null;
}
