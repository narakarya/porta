/**
 * Mock data for browser-only development (when Tauri backend is unavailable).
 * Only used when `window.__TAURI_INTERNALS__` is absent.
 */
import type { App, Workspace, Service, SetupStatus, DetectResult } from "../types";

export const mockWorkspaces: Workspace[] = [
  { id: "ws-1", name: "UQ", domain: "uq.test", deployment: null },
  { id: "ws-2", name: "Tanya Obat", domain: "tanyaobat.test", deployment: null },
  { id: "ws-3", name: "Mediapress", domain: "mediapress.test", deployment: null },
  { id: "ws-4", name: "Interblade", domain: "interblade.test", deployment: null },
  { id: "ws-5", name: "Tigger", domain: "tigger.test", deployment: null },
  { id: "ws-6", name: "Tools", domain: "tools.test", deployment: null },
  { id: "ws-7", name: "SpreadGrid", domain: "spreadgrid.test", deployment: null },
  { id: "ws-8", name: "Narakarya", domain: "narakarya.test", deployment: null },
];

export const mockApps: App[] = [
  {
    id: "app-1",
    workspace_id: "ws-1",
    name: "smartuq",
    root_dir: "/Users/dev/narakarya_academic",
    port: 3001,
    subdomain: "smartuq",
    start_command: "npm run dev",
    start_command_source: "package.json",
    status: "running",
    pid: 12345,
    env_file: null,
    auto_start: true,
    env_vars: {},
    restart_policy: "on-failure",
    max_retries: 3,
    health_check_path: null,
    depends_on: [],
    extra_subdomains: [],
    custom_domain: null,
    tunnel_provider: null, tunnel_auto_start: false,
    tunnel_url: null,
    tunnel_active: false,
    port_bindings: [],
    env_profiles: [],
    active_profile_id: null,
    kind: "process",
    docker_image: null,
    docker_container_port: null,
    docker_args: null,
    docker_volumes: [],
    compose_file: null,
    network_share: false,
    tunnel_name: null,
    tunnel_custom_hostname: null,
    basic_auth_enabled: false,
    basic_auth_username: null,
    basic_auth_password_set: false,
    host_auth_overrides: [],    tunnel_alias_domain: null,
    tunnel_alias_rewrite_host: true,
    auto_sleep_enabled: false,
    idle_timeout_secs: 1800,
    auto_slept: false,
    max_upload_bytes: null,
  },
  {
    id: "app-2",
    workspace_id: "ws-1",
    name: "uq_people_hub",
    root_dir: "/Users/dev/uq/people_hub",
    port: 3111,
    subdomain: "people",
    start_command: "mix phx.server",
    start_command_source: "mix.exs",
    status: "running",
    pid: 12346,
    env_file: ".env",
    auto_start: false,
    env_vars: { DATABASE_URL: "postgres://localhost/mydb_dev" },
    restart_policy: "on-failure",
    max_retries: 3,
    health_check_path: "/health",
    depends_on: [],
    extra_subdomains: [],
    custom_domain: null,
    tunnel_provider: null, tunnel_auto_start: false,
    tunnel_url: null,
    tunnel_active: false,
    // This app has a deploy config so the Deploy tab appears in mock mode
    port_bindings: [],
    env_profiles: [],
    active_profile_id: null,
    kind: "process",
    docker_image: null,
    docker_container_port: null,
    docker_args: null,
    docker_volumes: [],
    compose_file: null,
    network_share: false,
    tunnel_name: null,
    tunnel_custom_hostname: null,
    basic_auth_enabled: false,
    basic_auth_username: null,
    basic_auth_password_set: false,
    host_auth_overrides: [],    tunnel_alias_domain: null,
    tunnel_alias_rewrite_host: true,
    auto_sleep_enabled: false,
    idle_timeout_secs: 1800,
    auto_slept: false,
    max_upload_bytes: null,
  },
  {
    id: "app-3",
    workspace_id: "ws-1",
    name: "sidiq-brand",
    root_dir: "/Users/dev/uq/sidiq-brand",
    port: 3002,
    subdomain: "brand",
    start_command: "npm run dev",
    start_command_source: "package.json",
    status: "stopped",
    pid: null,
    env_file: null,
    auto_start: false,
    env_vars: {},
    restart_policy: "on-failure",
    max_retries: 3,
    health_check_path: null,
    depends_on: [],
    extra_subdomains: [],
    custom_domain: null,
    tunnel_provider: null, tunnel_auto_start: false,
    tunnel_url: null,
    tunnel_active: false,
    port_bindings: [],
    env_profiles: [],
    active_profile_id: null,
    kind: "process",
    docker_image: null,
    docker_container_port: null,
    docker_args: null,
    docker_volumes: [],
    compose_file: null,
    network_share: false,
    tunnel_name: null,
    tunnel_custom_hostname: null,
    basic_auth_enabled: false,
    basic_auth_username: null,
    basic_auth_password_set: false,
    host_auth_overrides: [],    tunnel_alias_domain: null,
    tunnel_alias_rewrite_host: true,
    auto_sleep_enabled: false,
    idle_timeout_secs: 1800,
    auto_slept: false,
    max_upload_bytes: null,
  },
  {
    id: "app-4",
    workspace_id: null,
    name: "standalone-tool",
    root_dir: "/Users/dev/tools/standalone",
    port: 8080,
    subdomain: null,
    start_command: "cargo run",
    start_command_source: "Cargo.toml",
    status: "stopped",
    pid: null,
    env_file: null,
    auto_start: false,
    env_vars: {},
    restart_policy: "never",
    max_retries: 0,
    health_check_path: null,
    depends_on: [],
    extra_subdomains: [],
    custom_domain: null,
    tunnel_provider: null, tunnel_auto_start: false,
    tunnel_url: null,
    tunnel_active: false,
    port_bindings: [],
    env_profiles: [],
    active_profile_id: null,
    kind: "process",
    docker_image: null,
    docker_container_port: null,
    docker_args: null,
    docker_volumes: [],
    compose_file: null,
    network_share: false,
    tunnel_name: null,
    tunnel_custom_hostname: null,
    basic_auth_enabled: false,
    basic_auth_username: null,
    basic_auth_password_set: false,
    host_auth_overrides: [],    tunnel_alias_domain: null,
    tunnel_alias_rewrite_host: true,
    auto_sleep_enabled: false,
    idle_timeout_secs: 1800,
    auto_slept: false,
    max_upload_bytes: null,
  },
];

export const mockSetupStatus: SetupStatus = {
  caddy_installed: true,
  dnsmasq_installed: true,
  test_resolver_exists: true,
  caddy_running: true,
  mkcert_installed: true,
  certs_generated: true,
};

export const mockDetectResult: DetectResult = {
  command: "npm run dev",
  source: "package.json",
  kind: "process",
};

let nextPort = 8081;

// Simulated in-memory state for mutations
const state = {
  workspaces: [...mockWorkspaces],
  apps: [...mockApps],
};

export function getMockState() {
  return state;
}

export function mockAddWorkspace(name: string, domain: string): Workspace {
  const ws: Workspace = { id: `ws-${Date.now()}`, name, domain, deployment: null };
  state.workspaces.push(ws);
  return ws;
}

export function mockAddApp(params: {
  workspace_id: string | null;
  name: string;
  root_dir: string;
  port: number;
  subdomain: string | null;
  start_command: string;
  start_command_source: string;
  kind?: App["kind"];
}): App {
  const app: App = {
    id: `app-${Date.now()}`,
    ...params,
    kind: params.kind ?? "process",
    status: "stopped",
    pid: null,
    env_file: null,
    auto_start: false,
    env_vars: {},
    restart_policy: "on-failure",
    max_retries: 3,
    health_check_path: null,
    depends_on: [],
    extra_subdomains: [],
    custom_domain: null,
    tunnel_provider: null, tunnel_auto_start: false,
    tunnel_url: null,
    tunnel_active: false,
    port_bindings: [],
    env_profiles: [],
    active_profile_id: null,
    docker_image: null,
    docker_container_port: null,
    docker_args: null,
    docker_volumes: [],
    compose_file: null,
    network_share: false,
    tunnel_name: null,
    tunnel_custom_hostname: null,
    basic_auth_enabled: false,
    basic_auth_username: null,
    basic_auth_password_set: false,
    host_auth_overrides: [],    tunnel_alias_domain: null,
    tunnel_alias_rewrite_host: true,
    auto_sleep_enabled: false,
    idle_timeout_secs: 1800,
    auto_slept: false,
    max_upload_bytes: null,
  };
  state.apps.push(app);
  return app;
}

export function mockDeleteApp(id: string) {
  state.apps = state.apps.filter((a) => a.id !== id);
}

export function mockDeleteWorkspace(id: string) {
  state.workspaces = state.workspaces.filter((w) => w.id !== id);
  state.apps = state.apps.filter((a) => a.workspace_id !== id);
}

export function mockNextPort(): number {
  return nextPort++;
}

// ── Mock app process simulation ───────────────────────────────────────────────

type MockEvent = "log" | "ready" | "exit" | "crashed" | "max-retries" | "port-conflict";
type MockEventCallback = (event: MockEvent, appId: string, payload: unknown) => void;

let _mockEventCallback: MockEventCallback = () => {};

export function setMockEventCallback(fn: MockEventCallback) {
  _mockEventCallback = fn;
}

const _mockProcessTimers: Record<string, ReturnType<typeof setTimeout>[]> = {};
const _mockProcessCancelled = new Set<string>();

export function startMockProcess(id: string) {
  _mockProcessCancelled.delete(id);
  const timers: ReturnType<typeof setTimeout>[] = [];
  _mockProcessTimers[id] = timers;

  // Log lines
  const lines = [
    `[mock] Starting process for ${id}...`,
    `[mock] Waiting for port...`,
    `[mock] Server listening on port`,
  ];

  lines.forEach((line, i) => {
    timers.push(
      setTimeout(() => {
        if (_mockProcessCancelled.has(id)) return;
        _mockEventCallback("log", id, line);
      }, (i + 1) * 80)
    );
  });

  // Ready after logs
  timers.push(
    setTimeout(() => {
      if (_mockProcessCancelled.has(id)) return;
      _mockEventCallback("ready", id, null);
    }, 400)
  );

  // Periodic log lines while running
  let logCount = 0;
  const logInterval = setInterval(() => {
    if (_mockProcessCancelled.has(id)) {
      clearInterval(logInterval);
      return;
    }
    logCount++;
    _mockEventCallback("log", id, `[mock] ${new Date().toISOString()} — request #${logCount}`);
  }, 3000);
  timers.push(logInterval as unknown as ReturnType<typeof setTimeout>);
}

export function stopMockProcess(id: string) {
  _mockProcessCancelled.add(id);
  const timers = _mockProcessTimers[id];
  if (timers) {
    timers.forEach((t) => clearTimeout(t));
    delete _mockProcessTimers[id];
  }
  _mockEventCallback("exit", id, 0);
}

export function killMockProcess(id: string) {
  _mockProcessCancelled.add(id);
  const timers = _mockProcessTimers[id];
  if (timers) {
    timers.forEach((t) => clearTimeout(t));
    delete _mockProcessTimers[id];
  }
  _mockEventCallback("exit", id, 9);
}

// ── Mock tunnel helpers ───────────────────────────────────────────────────────

const TUNNEL_WORDS = [
  "brave", "calm", "dawn", "echo", "fern", "glow", "haze", "iris",
  "jade", "keen", "lark", "mint", "nova", "opal", "pine", "rain",
];

function randomTunnelUrl(): string {
  const pick = () => TUNNEL_WORDS[Math.floor(Math.random() * TUNNEL_WORDS.length)];
  return `https://${pick()}-${pick()}-${Math.floor(Math.random() * 9000) + 1000}.trycloudflare.com`;
}

const _tunnelTimers: Record<string, ReturnType<typeof setTimeout>> = {};

export function startMockTunnel(appId: string, onReady: (url: string) => void): void {
  if (_tunnelTimers[appId]) clearTimeout(_tunnelTimers[appId]);
  _tunnelTimers[appId] = setTimeout(() => {
    onReady(randomTunnelUrl());
    delete _tunnelTimers[appId];
  }, 2000);
}

export function stopMockTunnel(appId: string): void {
  if (_tunnelTimers[appId]) {
    clearTimeout(_tunnelTimers[appId]);
    delete _tunnelTimers[appId];
  }
}

// ── Mock services ─────────────────────────────────────────────────────────────

export const mockServices: Service[] = [
  { id: "svc-db", name: "Databases", image: "postgres", tag: "16", port: 5432, env_vars: {}, volumes: [], scope: "global", status: "running", container_id: "mock-postgres" },
  { id: "svc-broker", name: "Message Brokers", image: "rabbitmq", tag: "3", port: 5672, env_vars: {}, volumes: [], scope: "global", status: "running", container_id: "mock-rabbitmq" },
  { id: "svc-cache", name: "Caches", image: "redis", tag: "7", port: 6379, env_vars: {}, volumes: [], scope: "global", status: "running", container_id: "mock-redis" },
];

export function startMockService(
  serviceId: string,
  onStatusChange: (status: Service["status"], containerId: string | null) => void
): () => void {
  let cancelled = false;
  const timers: ReturnType<typeof setTimeout>[] = [];

  onStatusChange("pulling", null);

  const pullTimer = setTimeout(() => {
    if (cancelled) return;
    onStatusChange("starting", null);

    const startTimer = setTimeout(() => {
      if (cancelled) return;
      const fakeId = `container_${serviceId}_${Date.now().toString(36)}`;
      onStatusChange("running", fakeId);
    }, 800);
    timers.push(startTimer);
  }, 1200);
  timers.push(pullTimer);

  return () => {
    cancelled = true;
    timers.forEach(clearTimeout);
  };
}

export function stopMockService(
  onStatusChange: (status: Service["status"], containerId: string | null) => void
): void {
  onStatusChange("stopped", null);
}
