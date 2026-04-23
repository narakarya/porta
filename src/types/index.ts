export interface Workspace {
  id: string;
  name: string;
  domain: string;
  deployment: DeploymentConfig | null;
}

export type AppKind = "process" | "static" | "docker" | "compose";

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
  tunnel_url: string | null;
  tunnel_active: boolean;
  // deploy
  deploy_config_path: string | null;
  deploy_custom_commands: CustomDeployCmd[];
}

export type HealthStatus = "healthy" | "unhealthy" | "unknown";

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

export interface EnvProfile {
  id: string;
  name: string;
  env_file: string | null;
  env_vars: Record<string, string>;
}

export interface CustomDeployCmd {
  id: string;
  label: string;
  args: string[];
  interactive: boolean;
}
