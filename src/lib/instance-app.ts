import type { App } from "../types";
import type { AppInstance } from "./commands";

/**
 * Build a synthetic App representing a running worktree instance, so the
 * existing AppCard component can render it unchanged. `id` is set to the
 * instance id so every Zustand slice keyed by app.id (appLogs, healthStatuses,
 * appExitCode, appTunnelErrors, …) resolves to instance-scoped data.
 */
export function deriveInstanceApp(parent: App, inst: AppInstance): App {
  return {
    ...parent,
    id: inst.id,
    root_dir: inst.worktree_path,
    subdomain: inst.subdomain,
    port: inst.port,
    status: inst.status as App["status"],
    name: `${parent.name} · ${inst.branch}`,
  };
}
