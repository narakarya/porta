export interface Workspace {
  id: string;
  name: string;
  domain: string;
}

export interface App {
  id: string;
  workspace_id: string | null;
  name: string;
  root_dir: string;
  port: number;
  subdomain: string | null;
  start_command: string;
  start_command_source: string;
  status: "stopped" | "running";
  pid: number | null;
  env_file: string | null;
  auto_start: boolean;
}

export interface DetectResult {
  command: string | null;
  source: string;
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
};

export type UpdateAppParams = {
  id: string;
  name: string;
  port: number;
  subdomain: string | null;
  start_command: string;
  env_file: string | null;
  auto_start: boolean;
};
