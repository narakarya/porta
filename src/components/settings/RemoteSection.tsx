import { useEffect, useState } from "react";
import { usePortaStore } from "../../store";
import { useShallow } from "zustand/react/shallow";
import type { RemoteHost, RemoteHostTest } from "../../lib/commands";

const EMPTY_HOST: RemoteHost = {
  id: "",
  name: "",
  tunnel_ip: "10.0.0.1",
  admin_port: 2019,
  base_domain: "",
  wg_interface: null,
  mac_tunnel_ip: "10.0.0.2",
  created_at: 0,
};

const inputCls =
  "w-full rounded-lg bg-white/[0.04] border border-white/[0.08] px-3 py-2 text-sm text-white placeholder-white/30 focus:outline-none focus:border-white/25";

/**
 * Porta Relay — manage the user-owned VPS hosts Porta pushes public routes to.
 * Each host is a WireGuard peer running Caddy whose admin API is reachable over
 * the tunnel. The Test button probes that admin API.
 */
export default function RemoteSection() {
  const { remoteHosts, loadRemoteHosts, addRemoteHost, updateRemoteHost, deleteRemoteHost, testRemoteHost } =
    usePortaStore(
      useShallow((s) => ({
        remoteHosts: s.remoteHosts,
        loadRemoteHosts: s.loadRemoteHosts,
        addRemoteHost: s.addRemoteHost,
        updateRemoteHost: s.updateRemoteHost,
        deleteRemoteHost: s.deleteRemoteHost,
        testRemoteHost: s.testRemoteHost,
      })),
    );

  const [draft, setDraft] = useState<RemoteHost | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, RemoteHostTest & { loading?: boolean }>>({});

  useEffect(() => {
    loadRemoteHosts();
  }, [loadRemoteHosts]);

  const editing = draft !== null && draft.id !== "";

  async function save() {
    if (!draft) return;
    if (!draft.name.trim() || !draft.base_domain.trim() || !draft.tunnel_ip.trim() || !draft.mac_tunnel_ip.trim()) {
      setError("Name, tunnel IP, Mac tunnel IP, and base domain are required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (editing) {
        await updateRemoteHost(draft);
      } else {
        await addRemoteHost({ ...draft, wg_interface: draft.wg_interface?.trim() || null });
      }
      setDraft(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function runTest(id: string) {
    setTests((t) => ({ ...t, [id]: { reachable: false, message: "", loading: true } }));
    try {
      const res = await testRemoteHost(id);
      setTests((t) => ({ ...t, [id]: { ...res, loading: false } }));
    } catch (e) {
      setTests((t) => ({
        ...t,
        [id]: { reachable: false, message: e instanceof Error ? e.message : String(e), loading: false },
      }));
    }
  }

  return (
    <div className="flex flex-col gap-5 max-w-2xl">
      <div>
        <h2 className="text-lg font-semibold text-white">Remote Servers</h2>
        <p className="text-sm text-white/50 mt-1">
          Expose local apps to the internet through your own VPS (WireGuard + Caddy) — the “Porta Relay” backend.
          Porta manages the public <code className="text-white/70">:443</code> entrypoint on each server via its
          Caddy admin API, reached over the tunnel.
        </p>
      </div>

      {remoteHosts.length === 0 && !draft && (
        <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-4 text-sm text-white/50">
          No remote servers yet. Add one to enable “Expose via Porta Relay” on your apps.
        </div>
      )}

      {remoteHosts.map((h) => {
        const t = tests[h.id];
        return (
          <div key={h.id} className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-medium text-white">{h.name}</div>
                <div className="text-xs text-white/40 mt-0.5">
                  {h.tunnel_ip}:{h.admin_port} · *.{h.base_domain} · dial {h.mac_tunnel_ip}:443
                  {h.wg_interface ? ` · ${h.wg_interface}` : ""}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => runTest(h.id)}
                  disabled={t?.loading}
                  className="text-xs rounded-lg px-2.5 py-1.5 bg-white/[0.06] hover:bg-white/[0.1] text-white/80 disabled:opacity-50"
                >
                  {t?.loading ? "Testing…" : "Test"}
                </button>
                <button
                  onClick={() => setDraft(h)}
                  className="text-xs rounded-lg px-2.5 py-1.5 bg-white/[0.06] hover:bg-white/[0.1] text-white/80"
                >
                  Edit
                </button>
                <button
                  onClick={() => deleteRemoteHost(h.id)}
                  className="text-xs rounded-lg px-2.5 py-1.5 bg-red-500/10 hover:bg-red-500/20 text-red-300"
                >
                  Delete
                </button>
              </div>
            </div>
            {t && !t.loading && (
              <div className={`mt-2 text-xs ${t.reachable ? "text-emerald-400" : "text-red-400"}`}>
                {t.reachable ? "✓ " : "✕ "}
                {t.message}
              </div>
            )}
          </div>
        );
      })}

      {draft ? (
        <div className="rounded-xl bg-white/[0.03] border border-white/[0.08] p-4 flex flex-col gap-3">
          <div className="text-sm font-medium text-white">{editing ? "Edit server" : "Add server"}</div>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-white/50">Name</span>
            <input className={inputCls} placeholder="my-vps" value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-white/50">VPS tunnel IP</span>
              <input className={inputCls} placeholder="10.0.0.1" value={draft.tunnel_ip}
                onChange={(e) => setDraft({ ...draft, tunnel_ip: e.target.value })} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-white/50">Caddy admin port</span>
              <input className={inputCls} type="number" value={draft.admin_port}
                onChange={(e) => setDraft({ ...draft, admin_port: Number(e.target.value) || 2019 })} />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-white/50">Base domain</span>
              <input className={inputCls} placeholder="example.com" value={draft.base_domain}
                onChange={(e) => setDraft({ ...draft, base_domain: e.target.value })} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-white/50">Mac tunnel IP</span>
              <input className={inputCls} placeholder="10.0.0.2" value={draft.mac_tunnel_ip}
                onChange={(e) => setDraft({ ...draft, mac_tunnel_ip: e.target.value })} />
            </label>
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-white/50">WireGuard interface (optional — auto-detected if blank)</span>
            <input className={inputCls} placeholder="utun6" value={draft.wg_interface ?? ""}
              onChange={(e) => setDraft({ ...draft, wg_interface: e.target.value })} />
          </label>
          {error && <div className="text-xs text-red-400">{error}</div>}
          <div className="flex items-center gap-2">
            <button onClick={save} disabled={saving}
              className="text-xs rounded-lg px-3 py-2 bg-white text-black font-medium hover:bg-white/90 disabled:opacity-50">
              {saving ? "Saving…" : editing ? "Save changes" : "Add server"}
            </button>
            <button onClick={() => { setDraft(null); setError(null); }}
              className="text-xs rounded-lg px-3 py-2 bg-white/[0.06] hover:bg-white/[0.1] text-white/80">
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button onClick={() => setDraft({ ...EMPTY_HOST })}
          className="self-start text-xs rounded-lg px-3 py-2 bg-white/[0.06] hover:bg-white/[0.1] text-white/80">
          + Add remote server
        </button>
      )}
    </div>
  );
}
