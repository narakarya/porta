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
    // An instance owns only its generated subdomain, but the backend registers
    // that label under the parent's effective domain. Keep custom_domain so
    // every Open action resolves the same host Caddy actually serves; only the
    // parent's extra aliases must stay hidden from the child.
    extra_subdomains: [],
    custom_domain: parent.custom_domain,
    port: inst.port,
    status: inst.status as App["status"],
    name: `${parent.name} · ${inst.branch}`,
    // Instance tunnel state is tracked client-side via `instance:tunnel:{id}`,
    // not the parent app's state. The backend routes an instance through the
    // parent's NAMED tunnel (at a derived `<sub>.<domain>` host, direct to the
    // worktree port) when the parent has one configured, else a throwaway quick
    // tunnel. Mirror that here so the menu labels the right mode: inherit
    // `tunnel_name` only when a named tunnel is actually available, and clear
    // the inherited hostname (the instance gets its own, surfaced via the
    // connect event — not the parent's).
    tunnel_active: inst.tunnel_active ?? false,
    tunnel_url: inst.tunnel_url ?? null,
    tunnel_name:
      parent.tunnel_name?.trim() && parent.tunnel_custom_hostname?.trim()
        ? parent.tunnel_name
        : null,
    tunnel_custom_hostname: null,
  };
}
