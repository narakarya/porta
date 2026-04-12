/**
 * Mock data for browser-only development (when Tauri backend is unavailable).
 * Only used when `window.__TAURI_INTERNALS__` is absent.
 */
import type { App, Workspace, SetupStatus, DetectResult } from "../types";

export const mockWorkspaces: Workspace[] = [
  { id: "ws-1", name: "Narakarya", domain: "narakarya.test" },
  { id: "ws-2", name: "Client Portal", domain: "portal.test" },
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
  const ws: Workspace = { id: `ws-${Date.now()}`, name, domain };
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
}): App {
  const app: App = {
    id: `app-${Date.now()}`,
    ...params,
    status: "stopped",
    pid: null,
    env_file: null,
    auto_start: false,
    env_vars: {},
    restart_policy: "on-failure",
    max_retries: 3,
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
