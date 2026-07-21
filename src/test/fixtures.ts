import type { App, Workspace } from "../types";

export function makeWorkspace(over: Partial<Workspace> = {}): Workspace {
  return { id: "ws1", name: "Dev", domain: "narakarya.test", deployment: null, ...over };
}

/** A minimal but complete `App`. Only override what a test actually asserts on. */
export function makeApp(over: Partial<App> = {}): App {
  return {
    id: "app1",
    workspace_id: "ws1",
    name: "web",
    root_dir: "/Users/dev/web",
    port: 4000,
    subdomain: "web",
    start_command: "mix phx.server",
    start_command_source: "manual",
    status: "stopped",
    pid: null,
    env_file: null,
    auto_start: false,
    kind: "process",
    docker_image: null,
    docker_container_port: null,
    docker_args: null,
    docker_volumes: [],
    compose_file: null,
    network_share: false,
    tunnel_name: null,
    tunnel_custom_hostname: null,
    env_vars: {},
    restart_policy: "never",
    max_retries: 0,
    health_check_path: null,
    depends_on: [],
    extra_subdomains: [],
    custom_domain: null,
    port_bindings: [],
    env_profiles: [],
    active_profile_id: null,
    tunnel_provider: null,
    tunnel_auto_start: false,
    tunnel_url: null,
    tunnel_active: false,
    basic_auth_enabled: false,
    basic_auth_username: null,
    basic_auth_password_set: false,
    host_auth_overrides: [],
    tunnel_alias_domain: null,
    tunnel_alias_rewrite_host: true,
    auto_sleep_enabled: false,
    idle_timeout_secs: 1800,
    auto_slept: false,
    max_upload_bytes: null,
    ...over,
  };
}
