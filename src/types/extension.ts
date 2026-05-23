// ── Extension manifest (mirrors Rust ExtensionManifest) ─────────────────────

export interface ExtensionActionContrib {
  id: string;
  label: string;
  /** Preset icon name: "box" | "terminal" | "rocket" | "gear" | "key" | "search" | "refresh" */
  icon?: string;
  /** Optional tooltip shown on hover */
  tooltip?: string;
}

export interface ExtensionContributes {
  /** Actions that appear on app cards matching this extension's activateOn filter */
  appActions?: ExtensionActionContrib[];
}

/**
 * Parsed content of porta.json in an extension folder.
 *
 * activateOn examples:
 *   - "*"              → all apps
 *   - "app:kind:phoenix"  → apps with kind tagged "phoenix" (from auto-detect)
 *   - "app:kind:elixir"
 *   - "app:kind:compose"
 *   - "app:root:*"     → any app with a root_dir (process/docker/compose)
 */
export interface ExtensionManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  /** Which apps this extension activates for. Supports glob-style wildcards. */
  activateOn: string[];
  contributes: ExtensionContributes;
  /** Required Porta permissions: "shell" | "fs:read" */
  permissions: string[];
  /** Relative path to the main HTML entry point (e.g. "dist/index.html") */
  main: string;
  minPortaVersion?: string;
  homepage?: string;
  repository?: string;
}

// ── Runtime extension info (returned by IPC) ────────────────────────────────

export interface ExtensionInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  enabled: boolean;
  /** Absolute path to the extension folder */
  path: string;
  /** Absolute path to the main HTML file */
  main_path: string;
  contributes_app_actions: ExtensionActionContrib[];
  permissions: string[];
  activate_on: string[];
}

// ── portaBridge types (injected into extension iframes) ─────────────────────

export interface ShellResult {
  stdout: string;
  stderr: string;
  code: number;
  timed_out: boolean;
}

export type PortaEvent =
  | "app:started"
  | "app:stopped"
  | "app:crashed"
  | "app:restarting";

export interface PortaBridgeApp {
  id: string;
  name: string;
  rootDir: string;
  port: number;
  status: string;
  kind: string;
}

export interface SpawnCallbacks {
  onStdout?: (line: string) => void;
  onStderr?: (line: string) => void;
}

export interface PortaBridge {
  app: PortaBridgeApp;
  shell: {
    /** Blocking: waits for full output, then resolves. */
    run(cmd: string, opts?: { cwd?: string; timeout?: number }): Promise<ShellResult>;
    /** Streaming: callbacks fire per-line; resolves with accumulated result when done. */
    spawn(
      cmd: string,
      opts?: { cwd?: string; timeout?: number },
      callbacks?: SpawnCallbacks,
    ): Promise<ShellResult>;
  };
  ui: {
    toast(msg: string, kind?: "info" | "success" | "error"): void;
    setTitle(title: string): void;
  };
  events: {
    on(event: PortaEvent, handler: (payload: unknown) => void): () => void;
  };
}
