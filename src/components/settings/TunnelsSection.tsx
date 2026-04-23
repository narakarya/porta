import { useCallback, useEffect, useState } from "react";
import {
  checkCloudflared,
  listCloudflareTunnels,
  createCloudflareTunnel,
  deleteCloudflareTunnel,
  routeTunnelDns,
  listTunnelDns,
  getCfApiToken,
  setCfApiToken,
  type CloudflareTunnel,
  type TunnelDnsRoute,
} from "../../lib/commands";
import { getCachedTunnels, setCachedTunnels, getCachedDnsRoutes, setCachedDnsRoutes } from "../../lib/tunnelCache";
import { usePortaStore } from "../../store";

/** Tunnels management — list, create, delete, route DNS. */
export default function TunnelsSection() {
  const { apps } = usePortaStore();
  const [tunnels, setTunnels] = useState<CloudflareTunnel[]>(() => getCachedTunnels());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installed, setInstalled] = useState<boolean | null>(null);

  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  const [routeTunnel, setRouteTunnel] = useState("");
  const [routeHost, setRouteHost] = useState("");
  const [routeOverwrite, setRouteOverwrite] = useState(false);
  const [routing, setRouting] = useState(false);

  const [confirmDelete, setConfirmDelete] = useState<{ name: string; force: boolean } | null>(null);
  const [deletingName, setDeletingName] = useState<string | null>(null);

  // CF API token + DNS routes (per tunnel) — optional; requires user's API token.
  const [cfToken, setCfToken] = useState("");
  const [cfTokenSaved, setCfTokenSaved] = useState<string | null>(null);
  const [showTokenInput, setShowTokenInput] = useState(false);
  const [dnsRoutes, setDnsRoutes] = useState<TunnelDnsRoute[]>(() => getCachedDnsRoutes());
  const [dnsLoading, setDnsLoading] = useState(false);
  const [dnsError, setDnsError] = useState<string | null>(null);

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

  useEffect(() => {
    refresh();
    getCfApiToken().then((t) => {
      setCfTokenSaved(t || null);
      setCfToken(t);
      if (t) refreshDnsRoutes(t);
    });
  }, [refresh, refreshDnsRoutes]);

  async function handleSaveToken() {
    await setCfApiToken(cfToken);
    setCfTokenSaved(cfToken.trim() || null);
    setShowTokenInput(false);
    if (cfToken.trim()) await refreshDnsRoutes(cfToken.trim());
    else setDnsRoutes([]);
  }

  async function handleCreate() {
    if (!newName.trim()) return;
    setCreating(true);
    setError(null);
    try {
      await createCloudflareTunnel(newName.trim());
      setNewName("");
      await refresh();
    } catch (e) {
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

  async function handleRoute() {
    if (!routeTunnel || !routeHost.trim()) return;
    setRouting(true);
    setError(null);
    try {
      await routeTunnelDns(routeTunnel, routeHost.trim(), routeOverwrite);
      setRouteHost("");
      setRouteOverwrite(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // If the error is "already exists", prompt to overwrite.
      if (msg.toLowerCase().includes("already") && !routeOverwrite) {
        setError(`${msg}\n\nTick "Overwrite existing DNS" and retry to replace it.`);
      } else {
        setError(msg);
      }
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

  return (
    <div className="flex flex-col gap-4">
      {/* Header — always visible so the section container appears instantly on tab switch. */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[16px] font-semibold text-zinc-100">Cloudflare Tunnels</h1>
          <p className="text-[12px] text-zinc-500 mt-0.5">
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
          <button
            onClick={refresh}
            disabled={loading}
            className="text-[10px] text-zinc-500 hover:text-zinc-200 transition-colors disabled:opacity-50"
          >
            {loading ? "Loading…" : "↻ Refresh"}
          </button>
        </div>
        {tunnels.length === 0 && !loading && (
          <p className="text-[11px] text-zinc-600 italic">No tunnels yet. Create one below.</p>
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
            const routes = dnsRoutes.filter((r) => r.tunnel_id === t.id);
            return (
              <div
                key={t.id}
                className="flex items-start gap-3 px-3 py-2.5 rounded-lg bg-white/[0.03] border border-white/[0.06]"
              >
                <div className={`shrink-0 w-2 h-2 rounded-full mt-1.5 ${isActive ? "bg-emerald-400" : "bg-zinc-600"}`} title={isActive ? "Has active connections" : "No active connections"} />
                <div className="flex-1 min-w-0">
                  <p className="text-[12px] font-medium text-zinc-200 truncate">{t.name}</p>
                  <p className="text-[10px] text-zinc-600 font-mono truncate">{t.id}</p>
                  <p className="text-[10px] text-zinc-500 mt-0.5">
                    {t.connection_count > 0
                      ? `${t.connection_count} active connection${t.connection_count > 1 ? "s" : ""}`
                      : "idle"}
                  </p>
                  {/* DNS routes from CF API, if token configured */}
                  {routes.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {routes.map((r) => {
                        const matchingApp = usedBy.find((u) => u.hostname === r.hostname);
                        return (
                          <span
                            key={r.hostname}
                            className="text-[10px] px-1.5 py-0.5 rounded bg-sky-500/10 border border-sky-500/20 text-sky-300 font-mono"
                            title={matchingApp ? `Used by ${matchingApp.name}` : r.zone_name}
                          >
                            {r.hostname}
                            {matchingApp && <span className="text-sky-400/60"> · {matchingApp.name}</span>}
                          </span>
                        );
                      })}
                    </div>
                  )}
                  {/* Porta apps bound without matching DNS (e.g. CF token not set) */}
                  {routes.length === 0 && usedBy.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {usedBy.map((u) => (
                        <span
                          key={u.id}
                          className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/10 border border-purple-500/20 text-purple-300"
                          title={u.hostname ?? undefined}
                        >
                          {u.name}
                          {u.hostname && <span className="text-purple-400/60"> → {u.hostname}</span>}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => setConfirmDelete({ name: t.name, force: t.connection_count > 0 })}
                  disabled={deletingName === t.name}
                  className="shrink-0 text-[11px] text-red-400 hover:text-red-300 px-2 py-1 rounded hover:bg-red-500/10 transition-colors disabled:opacity-50"
                >
                  Delete
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Create tunnel */}
      <div className="flex flex-col gap-1.5 p-3 rounded-xl bg-white/[0.03] border border-white/[0.06]">
        <p className="text-[11px] font-medium text-zinc-300">Create Tunnel</p>
        <div className="flex gap-2">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="tunnel-name"
            spellCheck={false}
            className="input-base flex-1 font-mono text-[12px]"
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCreate();
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

      {/* Route DNS */}
      <div className="flex flex-col gap-2 p-3 rounded-xl bg-white/[0.03] border border-white/[0.06]">
        <p className="text-[11px] font-medium text-zinc-300">Route DNS → Tunnel</p>
        <p className="text-[10px] text-zinc-500">
          Creates a CNAME so <code className="font-mono">&lt;hostname&gt;</code> resolves to the selected tunnel. Domain must be in your Cloudflare zone.
        </p>
        <div className="flex flex-col gap-2">
          <div className="relative">
            <select
              value={routeTunnel}
              onChange={(e) => setRouteTunnel(e.target.value)}
              className="w-full appearance-none bg-[#111113] border border-white/[0.08] rounded-lg px-3 py-2 text-[12px] text-zinc-100 outline-none focus:border-blue-500/50 transition-colors pr-8 cursor-pointer"
            >
              <option value="">Select tunnel…</option>
              {tunnels.map((t) => (
                <option key={t.id} value={t.name}>
                  {t.name}
                </option>
              ))}
            </select>
            <svg className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none" width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <input
            value={routeHost}
            onChange={(e) => setRouteHost(e.target.value)}
            placeholder="hostname.example.com"
            spellCheck={false}
            className="input-base font-mono text-[12px]"
          />
          <label className="flex items-center gap-2 text-[11px] text-zinc-400 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={routeOverwrite}
              onChange={(e) => setRouteOverwrite(e.target.checked)}
              className="rounded border-white/[0.15] bg-white/[0.05] text-blue-500 focus:ring-blue-500/30 focus:ring-offset-0"
            />
            Overwrite existing DNS (destructive — replaces existing CNAME)
          </label>
          <button
            onClick={handleRoute}
            disabled={!routeTunnel || !routeHost.trim() || routing}
            className="self-start px-3 py-1.5 text-[12px] font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg disabled:opacity-40 transition-colors"
          >
            {routing ? "Routing…" : "Route DNS"}
          </button>
        </div>
      </div>

      {/* CF API Token — enables DNS listing per tunnel */}
      <div className="flex flex-col gap-2 p-3 rounded-xl bg-white/[0.03] border border-white/[0.06]">
        <div className="flex items-center justify-between">
          <p className="text-[11px] font-medium text-zinc-300">Cloudflare API Token</p>
          <span className={`text-[10px] ${cfTokenSaved ? "text-emerald-400" : "text-zinc-600"}`}>
            {cfTokenSaved ? "● Connected" : "Not set"}
          </span>
        </div>
        <p className="text-[10px] text-zinc-500">
          Optional. Enables listing DNS records (CNAMEs) routed to each tunnel. Needs <code className="font-mono">Zone:Read</code> + <code className="font-mono">DNS:Read</code> scope. Create at <span className="text-zinc-400">dash.cloudflare.com → My Profile → API Tokens</span>.
        </p>
        {dnsError && (
          <div className="px-2.5 py-1.5 rounded-md bg-red-500/10 border border-red-500/30 text-[10px] text-red-300 font-mono">
            {dnsError}
          </div>
        )}
        {!showTokenInput && cfTokenSaved ? (
          <div className="flex items-center gap-2">
            <code className="flex-1 text-[11px] font-mono text-zinc-500 truncate">
              {cfTokenSaved.slice(0, 10)}…{cfTokenSaved.slice(-4)}
            </code>
            <button
              onClick={() => refreshDnsRoutes(cfTokenSaved)}
              disabled={dnsLoading}
              className="text-[10px] text-zinc-500 hover:text-zinc-200 transition-colors disabled:opacity-50"
            >
              {dnsLoading ? "Loading…" : "↻ Refresh DNS"}
            </button>
            <button
              onClick={() => setShowTokenInput(true)}
              className="text-[10px] text-zinc-500 hover:text-zinc-200 transition-colors"
            >
              Edit
            </button>
          </div>
        ) : (
          <div className="flex gap-2">
            <input
              type="password"
              value={cfToken}
              onChange={(e) => setCfToken(e.target.value)}
              placeholder="Paste CF API token"
              spellCheck={false}
              autoComplete="off"
              className="input-base flex-1 font-mono text-[12px]"
            />
            <button
              onClick={handleSaveToken}
              className="px-3 py-1.5 text-[12px] font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors shrink-0"
            >
              Save
            </button>
            {cfTokenSaved && (
              <button
                onClick={() => { setCfToken(cfTokenSaved); setShowTokenInput(false); }}
                className="px-3 py-1.5 text-[12px] text-zinc-400 hover:text-zinc-200 transition-colors shrink-0"
              >
                Cancel
              </button>
            )}
          </div>
        )}
      </div>

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
