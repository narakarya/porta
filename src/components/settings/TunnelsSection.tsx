import { useCallback, useEffect, useRef, useState } from "react";
import {
  checkCloudflared,
  listCloudflareTunnels,
  createCloudflareTunnel,
  deleteCloudflareTunnel,
  routeTunnelDns,
  listTunnelDns,
  getCfApiToken,
  openExternalUrl,
  cfDnsDeleteRecord,
  tunnelMetrics,
  type CloudflareTunnel,
  type TunnelDnsRoute,
  type TunnelMetrics,
  type TunnelMetricsErrorPayload,
} from "../../lib/commands";
import { getCachedTunnels, setCachedTunnels, getCachedDnsRoutes, setCachedDnsRoutes } from "../../lib/tunnelCache";
import { usePortaStore } from "../../store";

interface Props {
  /** Bumped by parent when API token changes — triggers DNS-routes refresh. */
  tokenVersion?: number;
}

/** Tunnels management — list, create, delete, route DNS. Token + zone certs
 * live in their own pieces of the parent CloudflareSection, so this view
 * focuses on the tunnel CRUD itself. */

// Local view types — `_pending` marks an optimistically-inserted entry that
// will be replaced once the next refresh completes. Cached values from
// localStorage never have it, refresh responses never have it; only the
// optimistic helpers in this file set it.
type TunnelView = CloudflareTunnel & { _pending?: boolean };
type RouteView = TunnelDnsRoute & { _pending?: boolean };

export default function TunnelsSection({ tokenVersion = 0 }: Props = {}) {
  const { apps } = usePortaStore();
  const [tunnels, setTunnels] = useState<TunnelView[]>(() => getCachedTunnels());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installed, setInstalled] = useState<boolean | null>(null);

  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  // Inline per-tunnel "Add DNS route" affordance — only one open at a time.
  const [routingFor, setRoutingFor] = useState<string | null>(null);
  const [routeHost, setRouteHost] = useState("");
  const [routeOverwrite, setRouteOverwrite] = useState(false);
  const [routing, setRouting] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);

  const [confirmDelete, setConfirmDelete] = useState<{ name: string; force: boolean } | null>(null);
  const [deletingName, setDeletingName] = useState<string | null>(null);

  // Per-route delete confirm — keyed by `${zone_id}:${record_id}` so repeated
  // hostnames across zones (rare but possible) don't collide.
  const [confirmDeleteRoute, setConfirmDeleteRoute] = useState<
    { hostname: string; zoneId: string; recordId: string; appName: string | null } | null
  >(null);
  const [deletingRouteKey, setDeletingRouteKey] = useState<string | null>(null);

  // Per-tunnel overflow menu (one open at a time, click outside closes).
  const [menuOpenFor, setMenuOpenFor] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const createInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!menuOpenFor) return;
    function onMouseDown(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (!target.closest("[data-tunnel-menu]")) setMenuOpenFor(null);
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [menuOpenFor]);

  async function copyToClipboard(value: string, key: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedId(key);
      window.setTimeout(() => setCopiedId((cur) => (cur === key ? null : cur)), 1500);
    } catch {
      // Clipboard blocked — silently ignore.
    }
  }

  function openInCloudflareDashboard() {
    // No account id is exposed by `cloudflared tunnel list`; the `:account`
    // placeholder gets resolved on dash.cloudflare.com after auth.
    // `window.open` no-ops in Tauri WebView for external URLs without scope
    // config — shell out to the OS opener instead.
    openExternalUrl("https://one.dash.cloudflare.com/?to=/:account/networks/tunnels").catch(() => {});
    setMenuOpenFor(null);
  }

  // DNS routes per tunnel — fetched via the API token managed by the parent
  // CloudflareSection's token bar. Cache hydrates instantly on mount; the
  // network refresh happens in a useEffect below tied to tokenVersion.
  const [dnsRoutes, setDnsRoutes] = useState<RouteView[]>(() => getCachedDnsRoutes());
  const [dnsLoading, setDnsLoading] = useState(false);
  const [dnsError, setDnsError] = useState<string | null>(null);

  // Per-tunnel metrics. `null` = not yet fetched, error type marks "metrics
  // not enabled" so we can show the restart hint instead of a network error.
  const [metricsByTunnel, setMetricsByTunnel] = useState<
    Record<string, { data: TunnelMetrics | null; error: TunnelMetricsErrorPayload | null }>
  >({});

  const refreshMetrics = useCallback(async (names: string[]) => {
    if (names.length === 0) return;
    const results = await Promise.all(
      names.map(async (name) => {
        try {
          const m = await tunnelMetrics(name);
          return { name, data: m, error: null as TunnelMetricsErrorPayload | null };
        } catch (e) {
          // Tauri serializes our tagged enum as `{ kind: "...", ... }`.
          const payload =
            typeof e === "object" && e !== null && "kind" in e
              ? (e as TunnelMetricsErrorPayload)
              : ({ kind: "scrape", message: e instanceof Error ? e.message : String(e) } as TunnelMetricsErrorPayload);
          return { name, data: null as TunnelMetrics | null, error: payload };
        }
      }),
    );
    setMetricsByTunnel((prev) => {
      const next = { ...prev };
      for (const r of results) next[r.name] = { data: r.data, error: r.error };
      return next;
    });
  }, []);

  // Poll every 5s while the panel is mounted. Skips tunnels with zero
  // connections to avoid spamming `/metrics` for idle tunnels — the moment
  // they go active the next tunnel-list refresh re-includes them.
  useEffect(() => {
    const active = tunnels.filter((t) => !t._pending && t.connection_count > 0).map((t) => t.name);
    if (active.length === 0) return;
    refreshMetrics(active);
    const id = window.setInterval(() => refreshMetrics(active), 5000);
    return () => window.clearInterval(id);
  }, [tunnels, refreshMetrics]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const inst = await checkCloudflared();
      setInstalled(inst);
      if (!inst) {
        setTunnels([]);
        return;
      }
      const list = await listCloudflareTunnels();
      setTunnels(list);
      setCachedTunnels(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // Don't clobber the cached list on error — keep showing what we had.
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshDnsRoutes = useCallback(async (token: string) => {
    if (!token.trim()) {
      setDnsRoutes([]);
      return;
    }
    setDnsLoading(true);
    setDnsError(null);
    try {
      const list = await listTunnelDns(token);
      setDnsRoutes(list);
      setCachedDnsRoutes(list);
    } catch (e) {
      setDnsError(e instanceof Error ? e.message : String(e));
    } finally {
      setDnsLoading(false);
    }
  }, []);

  // User-facing "↻ Refresh" — reloads BOTH the tunnel list (cloudflared CLI)
  // AND the DNS routes (CF API). Without this, deleting a route from the CF
  // dashboard left a stale row that only Refresh-on-tab-switch could clear.
  const refreshAll = useCallback(async () => {
    await refresh();
    const t = await getCfApiToken().catch(() => "");
    if (t) await refreshDnsRoutes(t);
  }, [refresh, refreshDnsRoutes]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Re-fetch DNS routes whenever the parent's tokenVersion changes (i.e.
  // user saved a new token in the bar above the tabs). Also runs on mount
  // for the initial fetch.
  useEffect(() => {
    getCfApiToken().then((t) => {
      if (t) refreshDnsRoutes(t);
    });
  }, [tokenVersion, refreshDnsRoutes]);

  async function handleCreate() {
    const trimmed = newName.trim();
    if (!trimmed) return;
    setCreating(true);
    setError(null);
    // Optimistic: drop in a placeholder tunnel immediately so the list
    // reacts to the click. The next refresh replaces it with the real CF
    // entry (whose UUID we don't know yet).
    const placeholderId = `pending-${Date.now()}`;
    const optimistic: TunnelView = { id: placeholderId, name: trimmed, connection_count: 0, _pending: true };
    setTunnels((prev) => [...prev, optimistic]);
    setNewName("");
    try {
      await createCloudflareTunnel(trimmed);
      setCreateOpen(false);
      // Fire-and-forget refresh: the placeholder gets replaced with the
      // real entry whenever `cloudflared tunnel list` returns. Don't await
      // so the Create button unblocks the moment cloudflared confirms.
      refresh();
    } catch (e) {
      setTunnels((prev) => prev.filter((t) => t.id !== placeholderId));
      setNewName(trimmed); // restore typed name so user can retry
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(name: string, force: boolean) {
    setDeletingName(name);
    setError(null);
    // Optimistic: remove from list immediately so UI feels instant.
    const snapshot = tunnels;
    setTunnels((prev) => prev.filter((t) => t.name !== name));
    setConfirmDelete(null);
    try {
      await deleteCloudflareTunnel(name, force);
      // Refresh in background — don't await so UI doesn't freeze.
      refresh();
    } catch (e) {
      // Revert optimistic remove on error.
      setTunnels(snapshot);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeletingName(null);
    }
  }

  async function handleDeleteRoute(zoneId: string, recordId: string, hostname: string) {
    const key = `${zoneId}:${recordId}`;
    setDeletingRouteKey(key);
    setDnsError(null);
    // Optimistic remove — restore on failure.
    const snapshot = dnsRoutes;
    setDnsRoutes((prev) => prev.filter((r) => r.record_id !== recordId));
    setConfirmDeleteRoute(null);
    try {
      const token = await getCfApiToken();
      if (!token.trim()) throw new Error("Cloudflare API token required");
      await cfDnsDeleteRecord(token, zoneId, recordId);
      // Background refresh — keeps cache in sync if CF replicates slowly.
      refreshDnsRoutes(token);
    } catch (e) {
      setDnsRoutes(snapshot);
      setDnsError(`Failed to delete ${hostname}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDeletingRouteKey(null);
    }
  }

  async function handleRoute(tunnelName: string) {
    const host = routeHost.trim();
    if (!tunnelName || !host) return;
    setRouting(true);
    setRouteError(null);
    // Optimistic: insert a pending row pointing at the right tunnel so the
    // list reacts immediately. Cleared if the call fails; replaced by the
    // confirmed entry once `refreshDnsRoutes` returns from the CF API.
    const tunnelId = tunnels.find((t) => t.name === tunnelName)?.id ?? "";
    const placeholder: RouteView = {
      hostname: host,
      zone_name: "",
      tunnel_id: tunnelId,
      zone_id: "",
      record_id: "",
      _pending: true,
    };
    setDnsRoutes((prev) => [...prev, placeholder]);
    setRouteHost("");
    setRoutingFor(null);
    try {
      await routeTunnelDns(tunnelName, host, routeOverwrite);
      setRouteOverwrite(false);
      // Background refresh — fire-and-forget so we don't make the user
      // wait on /zones + /dns_records before the inline form closes.
      getCfApiToken().then((t) => { if (t) refreshDnsRoutes(t); });
    } catch (e) {
      // Roll back optimistic + reopen the form so the user can adjust and retry.
      setDnsRoutes((prev) => prev.filter((r) => !(r.hostname === host && r._pending)));
      setRoutingFor(tunnelName);
      setRouteHost(host);
      const msg = e instanceof Error ? e.message : String(e);
      setRouteError(msg);
    } finally {
      setRouting(false);
    }
  }

  // Map tunnel name → apps using it (from Porta DB).
  const appsByTunnel = new Map<string, { id: string; name: string; hostname: string | null }[]>();
  for (const a of apps) {
    if (!a.tunnel_name) continue;
    const list = appsByTunnel.get(a.tunnel_name) ?? [];
    list.push({ id: a.id, name: a.name, hostname: a.tunnel_custom_hostname });
    appsByTunnel.set(a.tunnel_name, list);
  }

  // Initial paint: show only the header + skeleton until the cheap install
  // check resolves. Avoids a frame where the heavy 600+ line UI tree mounts
  // synchronously and makes tab switching feel laggy.
  const initialLoading = installed === null && tunnels.length === 0;

  if (initialLoading) {
    return (
      <div className="flex flex-col gap-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-14 rounded-xl bg-white/[0.03] border border-white/[0.05] animate-pulse" style={{ animationDelay: `${i * 80}ms` }} />
        ))}
        <div className="flex items-center gap-2 text-[11px] text-zinc-500 mt-1">
          <svg className="animate-spin" width="11" height="11" viewBox="0 0 12 12" fill="none">
            <path d="M6 1.5A4.5 4.5 0 1 1 1.5 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
          Checking cloudflared…
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Sub-tab header — outer CloudflareSection already shows "Cloudflare"
          as the main title, so this sub-tab just needs a one-liner subtitle. */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-[14px] font-semibold text-zinc-100">Tunnels</h2>
          <p className="text-[11.5px] text-zinc-500 mt-0.5">
            Manage named tunnels, DNS routes, and the apps that use them.
          </p>
        </div>
        {(loading || dnsLoading) && (
          <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-white/[0.03] border border-white/[0.06]">
            <svg className="animate-spin text-zinc-500" width="10" height="10" viewBox="0 0 12 12" fill="none">
              <path d="M6 1.5A4.5 4.5 0 1 1 1.5 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
            <span className="text-[10px] text-zinc-500">Loading…</span>
          </div>
        )}
      </div>

      {installed === false && (
        <div className="flex flex-col gap-3 px-3 py-3 rounded-xl bg-amber-500/[0.06] border border-amber-500/20">
          <p className="text-[12px] text-amber-300">cloudflared CLI not found on PATH.</p>
          <code className="text-[11px] font-mono bg-black/30 px-2.5 py-1.5 rounded">
            brew install cloudflare/cloudflare/cloudflared
          </code>
          <button
            onClick={refresh}
            className="self-start px-3 py-1 text-[11px] font-medium rounded-md bg-amber-500/15 hover:bg-amber-500/25 text-amber-200"
          >
            ↻ Check again
          </button>
        </div>
      )}

      {installed !== false && (<>

      {/* Global error */}
      {error && (
        <div className="relative px-3 py-2 pr-14 rounded-lg bg-red-500/10 border border-red-500/30 text-[11px] text-red-300 font-mono whitespace-pre-wrap break-words">
          {error}
          <button
            onClick={() => setError(null)}
            className="absolute top-1.5 right-1.5 px-2 py-0.5 text-[10px] rounded bg-red-500/20 hover:bg-red-500/30 text-red-200"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Tunnel list */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <p className="text-[11px] font-medium text-zinc-400 uppercase tracking-wide">Tunnels</p>
          <div className="flex items-center gap-3">
            <button
              onClick={() => {
                setCreateOpen((v) => !v);
                if (!createOpen) setTimeout(() => createInputRef.current?.focus(), 0);
              }}
              className="text-[10px] font-medium text-blue-400 hover:text-blue-300 transition-colors"
            >
              {createOpen ? "× Cancel" : "+ New tunnel"}
            </button>
            <button
              onClick={refreshAll}
              disabled={loading || dnsLoading}
              className="text-[10px] text-zinc-500 hover:text-zinc-200 transition-colors disabled:opacity-50"
            >
              {loading || dnsLoading ? "Loading…" : "↻ Refresh"}
            </button>
          </div>
        </div>

        {/* Inline create form — collapsed by default, opens via "+ New tunnel"
            in the header above or the empty-state CTA below. */}
        {createOpen && (
          <div className="flex flex-col gap-1.5 p-3 mb-2 rounded-xl bg-white/[0.03] border border-white/[0.06]">
            <p className="text-[11px] font-medium text-zinc-300">Create tunnel</p>
            <div className="flex gap-2">
              <input
                ref={createInputRef}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="tunnel-name"
                spellCheck={false}
                className="input-base flex-1 font-mono text-[12px]"
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreate();
                  if (e.key === "Escape") { setCreateOpen(false); setNewName(""); }
                }}
              />
              <button
                onClick={handleCreate}
                disabled={!newName.trim() || creating}
                className="px-3 py-1.5 text-[12px] font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg disabled:opacity-40 transition-colors shrink-0"
              >
                {creating ? "Creating…" : "Create"}
              </button>
            </div>
          </div>
        )}
        {tunnels.length === 0 && !loading && (
          <div className="flex flex-col items-center justify-center py-10 px-4 rounded-xl bg-white/[0.02] border border-dashed border-white/[0.08]">
            <div className="w-9 h-9 rounded-full bg-white/[0.04] flex items-center justify-center mb-2.5">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="text-zinc-500">
                <path d="M2 8h3m6 0h3M8 2v3m0 6v3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
                <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.4"/>
              </svg>
            </div>
            <p className="text-[12px] font-medium text-zinc-300">No tunnels yet</p>
            <p className="text-[11px] text-zinc-500 mt-0.5 mb-3 text-center max-w-[300px]">
              Tunnels expose local apps to the internet via Cloudflare. Create your first to start publishing.
            </p>
            <button
              onClick={() => {
                setCreateOpen(true);
                setTimeout(() => createInputRef.current?.focus(), 0);
              }}
              className="px-3 py-1.5 text-[11px] font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-md transition-colors"
            >
              + Create tunnel
            </button>
          </div>
        )}
        {tunnels.length === 0 && loading && (
          <div className="flex flex-col gap-2">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-14 rounded-lg bg-white/[0.02] border border-white/[0.04] animate-pulse"
              />
            ))}
          </div>
        )}
        <div className="flex flex-col gap-2">
          {tunnels.map((t) => {
            const usedBy = appsByTunnel.get(t.name) ?? [];
            const isActive = t.connection_count > 0;
            const isTunnelPending = !!t._pending;
            const routes = dnsRoutes.filter((r) => r.tunnel_id === t.id);
            // Merged rows: prefer DNS-API routes (overlay app match), fall back
            // to Porta-bound apps when no token / no routes returned yet.
            const rows: {
              hostname: string;
              app: string | null;
              isDns: boolean;
              key: string;
              isPending: boolean;
              zoneId?: string;
              recordId?: string;
            }[] =
              routes.length > 0
                ? routes.map((r) => ({
                    hostname: r.hostname,
                    app: usedBy.find((u) => u.hostname === r.hostname)?.name ?? null,
                    isDns: true,
                    key: `dns-${r.hostname}`,
                    isPending: !!r._pending,
                    zoneId: r.zone_id,
                    recordId: r.record_id,
                  }))
                : usedBy
                    .filter((u) => u.hostname)
                    .map((u) => ({ hostname: u.hostname!, app: u.name, isDns: false, key: `app-${u.id}`, isPending: false }));
            const isMenuOpen = menuOpenFor === t.id;
            return (
              <div
                key={t.id}
                className={`rounded-lg bg-white/[0.03] border border-white/[0.06] transition-opacity ${
                  isTunnelPending ? "opacity-60" : ""
                }`}
              >
                {/* Header row: status, name, connections, overflow menu */}
                <div className="flex items-center gap-2.5 px-3 py-2.5">
                  {isTunnelPending ? (
                    <svg className="shrink-0 animate-spin text-blue-400/70" width="10" height="10" viewBox="0 0 12 12" fill="none">
                      <path d="M6 1.5A4.5 4.5 0 1 1 1.5 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                  ) : (
                    <div
                      className={`shrink-0 w-2 h-2 rounded-full ${isActive ? "bg-emerald-400" : "bg-zinc-600"}`}
                      title={isActive ? "Has active connections" : "No active connections"}
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2">
                      <span className="text-[12px] font-medium text-zinc-200 truncate">{t.name}</span>
                      <span className="text-[10px] text-zinc-500 shrink-0">
                        {isTunnelPending
                          ? "creating…"
                          : t.connection_count > 0
                            ? `${t.connection_count} active`
                            : "idle"}
                      </span>
                    </div>
                    <p className="text-[10px] text-zinc-600 font-mono truncate">
                      {isTunnelPending ? "waiting for cloudflared…" : t.id}
                    </p>
                  </div>
                  {/* Overflow menu */}
                  <div className="relative shrink-0" data-tunnel-menu>
                    <button
                      onClick={() => setMenuOpenFor(isMenuOpen ? null : t.id)}
                      disabled={isTunnelPending || deletingName === t.name}
                      className="p-1 rounded hover:bg-white/[0.06] text-zinc-500 hover:text-zinc-200 transition-colors disabled:opacity-30 disabled:hover:bg-transparent"
                      title="More actions"
                      aria-label="Tunnel actions"
                    >
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
                        <circle cx="3" cy="7" r="1.2" />
                        <circle cx="7" cy="7" r="1.2" />
                        <circle cx="11" cy="7" r="1.2" />
                      </svg>
                    </button>
                    {isMenuOpen && (
                      <div className="absolute right-0 top-full mt-1 z-20 w-48 rounded-lg bg-[#1c1c1e] border border-white/[0.08] shadow-xl py-1 text-[11px]">
                        <button
                          onClick={() => { copyToClipboard(t.id, `id-${t.id}`); setMenuOpenFor(null); }}
                          className="w-full text-left px-3 py-1.5 text-zinc-300 hover:bg-white/[0.05] flex items-center justify-between"
                        >
                          <span>Copy tunnel ID</span>
                          {copiedId === `id-${t.id}` && <span className="text-emerald-400 text-[10px]">Copied</span>}
                        </button>
                        <button
                          onClick={openInCloudflareDashboard}
                          className="w-full text-left px-3 py-1.5 text-zinc-300 hover:bg-white/[0.05]"
                        >
                          Open in Cloudflare ↗
                        </button>
                        <div className="my-1 border-t border-white/[0.06]" />
                        <button
                          onClick={() => { setMenuOpenFor(null); setConfirmDelete({ name: t.name, force: t.connection_count > 0 }); }}
                          className="w-full text-left px-3 py-1.5 text-red-400 hover:bg-red-500/10 hover:text-red-300"
                        >
                          Delete tunnel
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                {/* Per-tunnel mini-stats */}
                {!isTunnelPending && t.connection_count > 0 && (() => {
                  const m = metricsByTunnel[t.name];
                  if (!m) {
                    return (
                      <div className="border-t border-white/[0.04] px-3 py-1 text-[10px] text-zinc-500 font-mono">
                        metrics: loading…
                      </div>
                    );
                  }
                  if (m.error) {
                    if (m.error.kind === "not_enabled") {
                      return (
                        <div className="border-t border-white/[0.04] px-3 py-1 text-[10px] text-amber-400/80 font-mono">
                          metrics: not enabled — restart this tunnel to expose stats.
                        </div>
                      );
                    }
                    if (m.error.kind === "not_running") {
                      return (
                        <div className="border-t border-white/[0.04] px-3 py-1 text-[10px] text-zinc-500 font-mono">
                          metrics: tunnel not running
                        </div>
                      );
                    }
                    return (
                      <div className="border-t border-white/[0.04] px-3 py-1 text-[10px] text-red-400/80 font-mono truncate" title={m.error.message ?? ""}>
                        metrics: {m.error.message ?? "error"}
                      </div>
                    );
                  }
                  const d = m.data!;
                  const errRate = d.requests_total > 0
                    ? ((d.errors_total / d.requests_total) * 100).toFixed(2)
                    : "0.00";
                  return (
                    <div className="border-t border-white/[0.04] px-3 py-1 flex items-center gap-3 text-[10px] font-mono text-zinc-400">
                      <span><span className="text-zinc-500">req</span> {d.requests_total.toLocaleString()}</span>
                      <span className={d.errors_total > 0 ? "text-red-400" : ""}>
                        <span className="text-zinc-500">err</span> {errRate}%
                      </span>
                      <span><span className="text-zinc-500">conns</span> {d.active_connections}</span>
                      <span><span className="text-zinc-500">p99</span> {d.response_latency_p99_ms.toFixed(1)}ms</span>
                    </div>
                  );
                })()}

                {/* DNS route rows */}
                {rows.length > 0 && (
                  <div className="border-t border-white/[0.04] px-1 py-1">
                    {rows.map((row) => {
                      const dot = row.hostname.indexOf(".");
                      const root = dot === -1 ? row.hostname : row.hostname.slice(0, dot);
                      const tld = dot === -1 ? "" : row.hostname.slice(dot);
                      return (
                        <div
                          key={row.key}
                          className={`group flex items-center gap-2.5 px-2 py-1 rounded transition-colors ${
                            row.isPending ? "opacity-50" : "hover:bg-white/[0.02]"
                          }`}
                        >
                          <span
                            className={`text-[9px] font-mono uppercase tracking-wide shrink-0 w-9 ${
                              row.isDns ? "text-sky-400/70" : "text-purple-400/70"
                            }`}
                          >
                            https
                          </span>
                          <span className="text-[11px] font-mono truncate flex-1 min-w-0">
                            <span className="text-zinc-200 font-medium">{root}</span>
                            <span className="text-zinc-500">{tld}</span>
                          </span>
                          {row.app && (
                            <span className="text-[10px] text-zinc-500 shrink-0">
                              → <span className="text-zinc-300">{row.app}</span>
                            </span>
                          )}
                          {row.isPending ? (
                            <svg className="animate-spin text-zinc-500 shrink-0 mr-1" width="10" height="10" viewBox="0 0 12 12" fill="none">
                              <path d="M6 1.5A4.5 4.5 0 1 1 1.5 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                            </svg>
                          ) : (
                            <div className="flex items-center gap-0.5 shrink-0">
                              <button
                                onClick={() => copyToClipboard(`https://${row.hostname}`, `url-${row.key}`)}
                                className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-white/[0.06] text-zinc-500 hover:text-zinc-300"
                                title="Copy URL"
                              >
                                {copiedId === `url-${row.key}` ? (
                                  <svg width="11" height="11" viewBox="0 0 11 11" fill="none" className="text-emerald-400">
                                    <path d="M2 5.5l2.5 2.5 4.5-4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                                  </svg>
                                ) : (
                                  <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                                    <rect x="3" y="3" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.2"/>
                                    <path d="M3 8.5V3.5A1.5 1.5 0 0 1 4.5 2H8.5" stroke="currentColor" strokeWidth="1.2"/>
                                  </svg>
                                )}
                              </button>
                              {row.isDns && row.zoneId && row.recordId && (
                                <button
                                  onClick={() =>
                                    setConfirmDeleteRoute({
                                      hostname: row.hostname,
                                      zoneId: row.zoneId!,
                                      recordId: row.recordId!,
                                      appName: row.app,
                                    })
                                  }
                                  disabled={deletingRouteKey === `${row.zoneId}:${row.recordId}`}
                                  className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-red-500/10 text-zinc-500 hover:text-red-400 disabled:opacity-30"
                                  title="Delete DNS route"
                                >
                                  {deletingRouteKey === `${row.zoneId}:${row.recordId}` ? (
                                    <svg className="animate-spin" width="11" height="11" viewBox="0 0 12 12" fill="none">
                                      <path d="M6 1.5A4.5 4.5 0 1 1 1.5 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                                    </svg>
                                  ) : (
                                    <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                                      <path d="M2.5 3.5h7m-5.5 0V2.5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1m-4 0v6.5a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1V3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                                    </svg>
                                  )}
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Inline DNS route adder / "+ Add" trigger */}
                <div className="border-t border-white/[0.04] px-3 py-1.5">
                  {routingFor === t.name ? (
                    <div className="flex flex-col gap-1.5 py-1">
                      <div className="flex gap-1.5">
                        <input
                          autoFocus
                          value={routeHost}
                          onChange={(e) => setRouteHost(e.target.value)}
                          placeholder="hostname.example.com"
                          spellCheck={false}
                          className="input-base flex-1 font-mono text-[11px] py-1"
                          onKeyDown={(e) => {
                            if (e.key === "Enter") handleRoute(t.name);
                            if (e.key === "Escape") { setRoutingFor(null); setRouteHost(""); setRouteError(null); }
                          }}
                        />
                        <button
                          onClick={() => handleRoute(t.name)}
                          disabled={!routeHost.trim() || routing}
                          className="px-2.5 py-1 text-[11px] font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-md disabled:opacity-40 transition-colors"
                        >
                          {routing ? "…" : "Add"}
                        </button>
                        <button
                          onClick={() => { setRoutingFor(null); setRouteHost(""); setRouteError(null); setRouteOverwrite(false); }}
                          className="px-2 py-1 text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                      {routeError && (
                        <div className="text-[10px] text-red-300 font-mono whitespace-pre-wrap break-words">
                          {routeError}
                        </div>
                      )}
                      {routeError && routeError.toLowerCase().includes("already") && (
                        <label className="flex items-center gap-1.5 text-[10px] text-zinc-400 cursor-pointer select-none">
                          <input
                            type="checkbox"
                            checked={routeOverwrite}
                            onChange={(e) => setRouteOverwrite(e.target.checked)}
                            className="rounded border-white/[0.15] bg-white/[0.05] text-blue-500 focus:ring-blue-500/30 focus:ring-offset-0"
                          />
                          Overwrite existing DNS (replaces current CNAME)
                        </label>
                      )}
                    </div>
                  ) : (
                    <button
                      onClick={() => { setRoutingFor(t.name); setRouteError(null); }}
                      disabled={isTunnelPending}
                      className="text-[10px] text-zinc-500 hover:text-blue-400 transition-colors disabled:opacity-30 disabled:hover:text-zinc-500"
                    >
                      + Add DNS route
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {dnsError && (
        <div className="px-2.5 py-1.5 rounded-md bg-red-500/10 border border-red-500/30 text-[10px] text-red-300 font-mono">
          DNS routes: {dnsError}
        </div>
      )}

      {/* Per-route delete confirm */}
      {confirmDeleteRoute && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-[2px] flex items-center justify-center z-[60]"
          onClick={(e) => {
            if (e.target === e.currentTarget) setConfirmDeleteRoute(null);
          }}
        >
          <div className="bg-[#1c1c1e] border border-white/[0.08] rounded-2xl w-[400px] p-5 shadow-2xl flex flex-col gap-3">
            <h3 className="text-[14px] font-semibold text-zinc-100">Delete DNS route?</h3>
            <p className="text-[12px] text-zinc-400">
              Removes the CNAME for{" "}
              <code className="font-mono text-zinc-200">{confirmDeleteRoute.hostname}</code> from
              your Cloudflare zone.
              {confirmDeleteRoute.appName && (
                <>
                  {" "}App <span className="text-zinc-200">{confirmDeleteRoute.appName}</span> will
                  stop receiving traffic at this hostname.
                </>
              )}
            </p>
            <div className="flex justify-end gap-2 mt-1">
              <button
                onClick={() => setConfirmDeleteRoute(null)}
                className="px-3 py-1.5 text-[12px] text-zinc-400 hover:text-zinc-200 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() =>
                  handleDeleteRoute(
                    confirmDeleteRoute.zoneId,
                    confirmDeleteRoute.recordId,
                    confirmDeleteRoute.hostname,
                  )
                }
                disabled={deletingRouteKey === `${confirmDeleteRoute.zoneId}:${confirmDeleteRoute.recordId}`}
                className="px-3 py-1.5 text-[12px] font-medium bg-red-600 hover:bg-red-500 text-white rounded-lg disabled:opacity-50 transition-colors"
              >
                {deletingRouteKey === `${confirmDeleteRoute.zoneId}:${confirmDeleteRoute.recordId}`
                  ? "Deleting…"
                  : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation modal */}
      {confirmDelete && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-[2px] flex items-center justify-center z-[60]"
          onClick={(e) => {
            if (e.target === e.currentTarget) setConfirmDelete(null);
          }}
        >
          <div className="bg-[#1c1c1e] border border-white/[0.08] rounded-2xl w-[400px] p-5 shadow-2xl flex flex-col gap-3">
            <h3 className="text-[14px] font-semibold text-zinc-100">Delete tunnel?</h3>
            <p className="text-[12px] text-zinc-400">
              This removes <code className="font-mono text-zinc-200">{confirmDelete.name}</code> from your Cloudflare account. Apps using it will stop working until re-pointed.
            </p>
            <label className="flex items-start gap-2 text-[11px] text-zinc-300 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={confirmDelete.force}
                onChange={(e) => setConfirmDelete({ ...confirmDelete, force: e.target.checked })}
                className="mt-0.5 rounded border-white/[0.15] bg-white/[0.05] text-red-500 focus:ring-red-500/30 focus:ring-offset-0"
              />
              <span>
                <span className="font-medium">Force delete</span>
                <span className="block text-zinc-500 text-[10px]">
                  Revoke active connections. Required if the tunnel has running cloudflared instances.
                </span>
              </span>
            </label>
            <div className="flex justify-end gap-2 mt-1">
              <button
                onClick={() => setConfirmDelete(null)}
                className="px-3 py-1.5 text-[12px] text-zinc-400 hover:text-zinc-200 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => handleDelete(confirmDelete.name, confirmDelete.force)}
                disabled={deletingName === confirmDelete.name}
                className="px-3 py-1.5 text-[12px] font-medium bg-red-600 hover:bg-red-500 text-white rounded-lg disabled:opacity-50 transition-colors"
              >
                {deletingName === confirmDelete.name ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
      </>)}
    </div>
  );
}
