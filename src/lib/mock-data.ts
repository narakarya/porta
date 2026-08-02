/**
 * Mock data for browser-only development (when Tauri backend is unavailable).
 * Only used when `window.__TAURI_INTERNALS__` is absent.
 */
import type { App, Workspace, Service, SetupStatus, DetectResult } from "../types";
import type {
  AppInstance,
  SftpEntry,
  SftpFileContent,
  SftpListing,
  SshConfigCandidate,
  SshHost,
  SshPortForward,
  RemoteContainerReport,
  SshSnippet,
} from "./commands";

export const mockWorkspaces: Workspace[] = [
  { id: "ws-1", name: "Narakarya", domain: "narakarya.test", deployment: null },
  { id: "ws-2", name: "Client Portal", domain: "portal.test", deployment: null },
];

export const mockApps: App[] = [
  {
    id: "app-1",
    workspace_id: "ws-1",
    name: "frontend",
    root_dir: "/Users/dev/narakarya/frontend",
    port: 3000,
    subdomain: "app",
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
    extra_subdomains: ["admin", "platform"],
    custom_domain: null,
    tunnel_provider: "cloudflare", tunnel_auto_start: false,
    tunnel_url: "https://brief-river-82.trycloudflare.com",
    tunnel_active: true,
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
    name: "api",
    root_dir: "/Users/dev/narakarya/api",
    port: 4000,
    subdomain: "api",
    start_command: "mix phx.server",
    start_command_source: "mix.exs",
    status: "stopped",
    pid: null,
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
    workspace_id: "ws-2",
    name: "dashboard",
    root_dir: "/Users/dev/portal/dashboard",
    port: 3001,
    subdomain: "dash",
    start_command: "npm run dev",
    start_command_source: "package.json",
    status: "starting",
    pid: 12400,
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
    workspace_id: "ws-1",
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
  tmux_installed: true,
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
  {
    id: "svc-1",
    name: "postgres",
    image: "postgres",
    tag: "16",
    port: 5432,
    env_vars: { POSTGRES_PASSWORD: "postgres", POSTGRES_USER: "postgres", POSTGRES_DB: "app" },
    volumes: ["pgdata:/var/lib/postgresql/data"],
    scope: "global",
    status: "running",
    container_id: "c0ffee123456",
  },
  {
    id: "svc-2",
    name: "redis",
    image: "redis",
    tag: "7-alpine",
    port: 6379,
    env_vars: {},
    volumes: ["redisdata:/data"],
    scope: "ws-1",
    status: "running",
    container_id: "beef98765432",
  },
  {
    id: "svc-3",
    name: "mailhog",
    image: "mailhog/mailhog",
    tag: "latest",
    port: 8025,
    env_vars: {},
    volumes: [],
    scope: "global",
    status: "stopped",
    container_id: null,
  },
];

// ── Mock worktree instances ───────────────────────────────────────────────────
// app-1 (frontend) runs two branch instances so the child-instance UX is
// demonstrable in browser dev.
export const mockInstances: AppInstance[] = [
  {
    id: "app-1:feat-checkout",
    app_id: "app-1",
    worktree_path: "/Users/dev/narakarya/frontend-worktrees/feat-checkout",
    branch: "feat/checkout",
    subdomain: "app-feat-checkout",
    port: 3010,
    pid: 41201,
    status: "running",
  },
  {
    id: "app-1:fix-auth",
    app_id: "app-1",
    worktree_path: "/Users/dev/narakarya/frontend-worktrees/fix-auth",
    branch: "fix/auth",
    subdomain: "app-fix-auth",
    port: 3011,
    pid: null,
    status: "stopped",
  },
];

// ── Mock SSH hosts ────────────────────────────────────────────────────────────
export const mockSshHosts: SshHost[] = [
  {
    id: "host-1",
    label: "prod-web",
    group: "Production",
    hostname: "web.narakarya.id",
    port: 22,
    username: "deploy",
    auth: { kind: "agent" },
    jump_host_id: null,
    created_at: 1_720_000_000,
    last_used_at: 1_752_700_000,
    workspace_ids: ["ws-1"],
    detected_os: "Ubuntu 22.04",
  },
  {
    id: "host-2",
    label: "db-primary",
    group: "Production",
    hostname: "db.narakarya.id",
    port: 22,
    username: "root",
    auth: { kind: "key_file", path: "~/.ssh/id_ed25519" },
    jump_host_id: "host-1",
    created_at: 1_720_000_000,
    last_used_at: null,
    workspace_ids: ["ws-1"],
    detected_os: "Debian 12",
  },
  {
    id: "host-3",
    label: "staging",
    group: null,
    hostname: "staging.portal.test",
    port: 2222,
    username: "dev",
    auth: { kind: "agent" },
    jump_host_id: null,
    created_at: 1_730_000_000,
    last_used_at: 1_751_000_000,
    workspace_ids: [],
    detected_os: null,
  },
];

/** Browser-dev stand-in for a remote directory listing. */
export function mockSftpListing(path: string): SftpListing {
  const dir = (name: string): SftpEntry => ({
    name,
    path: `${path.replace(/\/$/, "")}/${name}`,
    kind: "dir",
    size: null,
    mtime: 1_752_800_000,
    permissions: 0o40755,
    modeStr: "drwxr-xr-x",
    lossyName: false,
  });
  const file = (name: string, size: number, mode = 0o100644): SftpEntry => ({
    name,
    path: `${path.replace(/\/$/, "")}/${name}`,
    kind: "file",
    size,
    mtime: 1_752_900_000,
    permissions: mode,
    modeStr: "-rw-r--r--",
    lossyName: false,
  });
  const entries: SftpEntry[] =
    path === "/"
      ? [dir("etc"), dir("home"), dir("var")]
      : [dir("releases"), dir("shared"), file(".env", 412, 0o100600), file("docker-compose.yml", 1_842), file("nginx.conf", 2_310)];
  return { path, entries, truncated: false, totalSeen: entries.length + 2 };
}

export function mockSftpRead(path: string): SftpFileContent {
  const body = path.endsWith(".env")
    ? "DATABASE_URL=postgres://localhost/app_prod\nSECRET_KEY_BASE=n0t-a-real-secret\nPORT=4000\n"
    : "server {\n  listen 80;\n  server_name app.narakarya.id;\n}\n";
  return {
    path,
    content: body,
    size: body.length,
    mtime: 1_752_900_000,
    permissions: 0o100644,
    binary: false,
  };
}

/** Browser-dev stand-in for a read-only remote Docker listing. */
export const mockRemoteContainers: RemoteContainerReport[] = [
  {
    name: "shop-api-1",
    image: "ghcr.io/narakarya/api:1.4.2",
    status: "Up 3 days",
    state: "running",
    project: "shop",
    update: {
      image: "ghcr.io/narakarya/api:1.4.2",
      service_name: "shop",
      repo: "narakarya/api",
      tag: "1.4.2",
      status: "ok",
      message: null,
      local_digest: "sha256:aaa",
      remote_digest: "sha256:bbb",
      has_digest_update: true,
      suggested_tag: "1.5.0",
    },
    major_bump: false,
  },
  {
    name: "shop-db-1",
    image: "postgres:16.2",
    status: "Up 3 days",
    state: "running",
    project: "shop",
    update: {
      image: "postgres:16.2",
      service_name: "shop",
      repo: "library/postgres",
      tag: "16.2",
      status: "ok",
      message: null,
      local_digest: "sha256:ccc",
      remote_digest: "sha256:ccc",
      has_digest_update: false,
      suggested_tag: "17.0",
    },
    major_bump: true,
  },
  {
    name: "shop-cache-1",
    image: "redis:7-alpine",
    status: "Up 3 days",
    state: "running",
    project: "shop",
    update: {
      image: "redis:7-alpine",
      service_name: "shop",
      repo: "library/redis",
      tag: "7-alpine",
      status: "ok",
      message: null,
      local_digest: "sha256:ddd",
      remote_digest: "sha256:ddd",
      has_digest_update: false,
      suggested_tag: null,
    },
    major_bump: false,
  },
];

export const mockSshSnippets: SshSnippet[] = [
  {
    id: "snip-1",
    label: "Disk usage",
    command: "df -h",
    host_id: null,
    created_at: 1_752_000_000,
    last_used_at: 1_752_900_000,
  },
  {
    id: "snip-2",
    label: "Tail nginx errors",
    command: "sudo tail -f /var/log/nginx/error.log",
    host_id: null,
    created_at: 1_752_000_000,
    last_used_at: null,
  },
  {
    id: "snip-3",
    label: "Restart app",
    command: "sudo systemctl restart narakarya-web",
    host_id: "host-1",
    created_at: 1_752_100_000,
    last_used_at: null,
  },
];

export const mockSshForwards: SshPortForward[] = [
  {
    id: "fwd-1",
    host_id: "host-1",
    kind: "local",
    label: "Postgres",
    bind_address: "127.0.0.1",
    local_port: 15432,
    remote_host: "127.0.0.1",
    remote_port: 5432,
    auto_start: true,
    created_at: 1_752_000_000,
  },
  {
    id: "fwd-2",
    host_id: "host-1",
    kind: "local",
    label: null,
    bind_address: "127.0.0.1",
    local_port: 0,
    remote_host: "redis.internal",
    remote_port: 6379,
    auto_start: false,
    created_at: 1_752_100_000,
  },
];

/** Browser-dev stand-in for a `~/.ssh/config` scan. `prod-web` is deliberately
 *  a duplicate of `mockSshHosts[0]` so the import modal's already-in-vault
 *  state is reachable without a real config file. */
export const mockSshConfigCandidates: SshConfigCandidate[] = [
  {
    alias: "prod-web",
    hostname: "web.narakarya.id",
    port: 22,
    username: "deploy",
    identity_file: null,
    proxy_jump: null,
    already_in_vault: true,
  },
  {
    alias: "bastion",
    hostname: "bastion.narakarya.id",
    port: 22,
    username: "jump",
    identity_file: "~/.ssh/id_ed25519",
    proxy_jump: null,
    already_in_vault: false,
  },
  {
    alias: "analytics",
    hostname: "10.20.0.14",
    port: 22,
    username: "ubuntu",
    identity_file: "~/.ssh/id_analytics",
    proxy_jump: "bastion",
    already_in_vault: false,
  },
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
