import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { usePortaStore } from "../../store";
import { useShallow } from "zustand/react/shallow";
import {
  remoteLogTail,
  remoteLogLiveStart,
  remoteLogLiveStop,
  type RemoteHost,
  type RemoteHostTest,
  type WgStatus,
  type AccessLogEntry,
  type AccessLogStreamEvent,
} from "../../lib/commands";

const EMPTY_HOST: RemoteHost = {
  id: "",
  name: "",
  tunnel_ip: "10.0.0.1",
  admin_port: 2019,
  base_domain: "",
  wg_interface: null,
  mac_tunnel_ip: "10.0.0.2",
  created_at: 0,
  extra_domains: [],
  public_ip: null,
  auto_dns: false,
  ssh_user: null,
  remote_log_path: null,
};

const inputCls =
  "w-full rounded-control bg-surface-input border border-subtle px-3 py-2 text-sm text-ink placeholder-white/30 focus:outline-none focus:border-strong";

/**
 * Native confirmation dialog via the Tauri dialog plugin. `window.confirm` is
 * unreliable inside the WKWebView (it can return without ever showing a dialog),
 * so use the plugin's async `confirm`, falling back to `window.confirm` in a
 * plain browser (dev/preview).
 */
async function confirmDialog(message: string, title: string): Promise<boolean> {
  try {
    const { confirm } = await import("@tauri-apps/plugin-dialog");
    return await confirm(message, { title, kind: "warning" });
  } catch {
    return window.confirm(message);
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

/** Color + label for a host's WireGuard handshake age (green <2m, amber <5m, red ≥5m). */
function wgHealth(st: WgStatus | undefined): { dot: string; label: string } {
  if (!st || !st.up) return { dot: "bg-white/[0.14]", label: "interface down / unavailable" };
  if (!st.peer_found) return { dot: "bg-white/[0.14]", label: "no peer" };
  const age = st.handshake_age_secs;
  if (age === null) return { dot: "bg-bad", label: "never handshaked" };
  const ago = age < 60 ? `${age}s ago` : `${Math.floor(age / 60)}m ago`;
  if (age < 120) return { dot: "bg-ok", label: `handshake ${ago}` };
  if (age < 300) return { dot: "bg-warn", label: `handshake ${ago}` };
  return { dot: "bg-bad", label: `handshake ${ago}` };
}

/**
 * Porta Relay — manage the user-owned VPS hosts Porta pushes public routes to.
 * Each host is a WireGuard peer running Caddy whose admin API is reachable over
 * the tunnel. The Test button probes that admin API.
 */
export default function RemoteSection() {
  const {
    remoteHosts, loadRemoteHosts, addRemoteHost, updateRemoteHost, deleteRemoteHost, testRemoteHost,
    wgStatuses, loadAllWgStatuses,
    remoteDiffs, loadRemoteDiff, pushRemoteHost, removeForeign,
  } = usePortaStore(
    useShallow((s) => ({
      remoteHosts: s.remoteHosts,
      loadRemoteHosts: s.loadRemoteHosts,
      addRemoteHost: s.addRemoteHost,
      updateRemoteHost: s.updateRemoteHost,
      deleteRemoteHost: s.deleteRemoteHost,
      testRemoteHost: s.testRemoteHost,
      wgStatuses: s.wgStatuses,
      loadAllWgStatuses: s.loadAllWgStatuses,
      remoteDiffs: s.remoteDiffs,
      loadRemoteDiff: s.loadRemoteDiff,
      pushRemoteHost: s.pushRemoteHost,
      removeForeign: s.removeForeign,
    })),
  );
  const [syncing, setSyncing] = useState<string | null>(null);
  // Per-host activity log so the user sees what each action actually does.
  const [activity, setActivity] = useState<Record<string, string[]>>({});
  function logLine(id: string, line: string) {
    const t = new Date().toLocaleTimeString();
    setActivity((a) => ({ ...a, [id]: [...(a[id] || []), `${t}  ${line}`].slice(-40) }));
  }
  const adminUrlFor = (h: RemoteHost) => `http://${h.tunnel_ip}:${h.admin_port}`;

  async function runSync(h: RemoteHost) {
    const id = h.id;
    setSyncing(id);
    logLine(id, `Sync → GET ${adminUrlFor(h)}/config/apps/http/servers/porta …`);
    try {
      const d = await loadRemoteDiff(id);
      logLine(id, `Compared: ${d.matched.length} in sync, ${d.missing_on_vps.length} missing on VPS, ${d.foreign_on_vps.length} foreign`);
      if (d.missing_on_vps.length) logLine(id, `  missing → ${d.missing_on_vps.join(", ")}`);
      if (d.foreign_on_vps.length) logLine(id, `  foreign → ${d.foreign_on_vps.join(", ")}`);
      if (!d.missing_on_vps.length && !d.foreign_on_vps.length) logLine(id, `✓ no drift`);
    } catch (e) {
      logLine(id, `✕ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSyncing(null);
    }
  }

  async function runPush(id: string) {
    logLine(id, `Push → PUT porta server (re-applying Porta routes to VPS) …`);
    try {
      await pushRemoteHost(id);
      logLine(id, `✓ pushed; re-synced`);
    } catch (e) {
      logLine(id, `✕ ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function runRemoveForeign(id: string, fh: string) {
    logLine(id, `Remove → re-asserting Porta routes, dropping unmanaged (${fh}) …`);
    try {
      await removeForeign(id, fh);
      logLine(id, `✓ removed; re-synced`);
    } catch (e) {
      logLine(id, `✕ ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const [draft, setDraft] = useState<RemoteHost | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, RemoteHostTest & { loading?: boolean }>>({});

  useEffect(() => {
    loadRemoteHosts();
  }, [loadRemoteHosts]);

  // Poll WireGuard status every 15s while this section is mounted and the
  // window is visible, so the panel reflects tunnel health without manual
  // refresh. Pauses when hidden to avoid wasted `wg show` calls.
  const intervalRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    loadAllWgStatuses();
    function start() {
      if (intervalRef.current !== undefined) return;
      intervalRef.current = window.setInterval(loadAllWgStatuses, 15_000);
    }
    function stop() {
      if (intervalRef.current !== undefined) {
        clearInterval(intervalRef.current);
        intervalRef.current = undefined;
      }
    }
    function onVisibility() {
      if (document.hidden) stop();
      else { loadAllWgStatuses(); start(); }
    }
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [loadAllWgStatuses]);

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

  async function runTest(h: RemoteHost) {
    const id = h.id;
    setTests((t) => ({ ...t, [id]: { reachable: false, message: "", loading: true } }));
    logLine(id, `Test → probing Caddy admin API at ${adminUrlFor(h)}/config/ …`);
    try {
      const res = await testRemoteHost(id);
      setTests((t) => ({ ...t, [id]: { ...res, loading: false } }));
      logLine(id, res.reachable ? `✓ ${res.message}` : `✕ ${res.message}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setTests((t) => ({ ...t, [id]: { reachable: false, message: msg, loading: false } }));
      logLine(id, `✕ ${msg}`);
    }
  }

  return (
    <div className="flex flex-col gap-5 max-w-2xl">
      <div>
        <h2 className="text-lg font-semibold text-ink">Remote Servers</h2>
        <p className="text-sm text-white/50 mt-1">
          Expose local apps to the internet through your own VPS (WireGuard + Caddy) — the “Porta Relay” backend.
          Porta manages the public <code className="text-white/70">:443</code> entrypoint on each server via its
          Caddy admin API, reached over the tunnel.
        </p>
      </div>

      {remoteHosts.length === 0 && !draft && (
        <div className="rounded-card bg-surface-1 border border-subtle p-4 text-sm text-white/50">
          No remote servers yet. Add one to enable “Expose via Porta Relay” on your apps.
        </div>
      )}

      {remoteHosts.map((h) => {
        const t = tests[h.id];
        const wg = wgStatuses[h.id];
        const health = wgHealth(wg);
        return (
          <div key={h.id} className="rounded-card bg-surface-1 border border-subtle p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-medium text-ink">{h.name}</div>
                <div className="text-xs text-white/40 mt-0.5">
                  {h.tunnel_ip}:{h.admin_port} · *.{h.base_domain} · dial {h.mac_tunnel_ip}:443
                  {h.wg_interface ? ` · ${h.wg_interface}` : ""}
                </div>
                <div className="flex items-center gap-2 mt-2 text-xs text-white/50">
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${health.dot}`} />
                  <span>{health.label}</span>
                  {wg?.up && wg.peer_found && (
                    <span className="text-white/30">
                      · ↓{formatBytes(wg.rx_bytes)} ↑{formatBytes(wg.tx_bytes)}
                      {wg.endpoint ? ` · ${wg.endpoint}` : ""}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => runTest(h)}
                  disabled={t?.loading}
                  className="text-xs rounded-control px-2.5 py-1.5 bg-white/[0.06] hover:bg-white/[0.1] text-white/80 disabled:opacity-50"
                >
                  {t?.loading ? "Testing…" : "Test"}
                </button>
                <button
                  onClick={() => runSync(h)}
                  disabled={syncing === h.id}
                  className="text-xs rounded-control px-2.5 py-1.5 bg-white/[0.06] hover:bg-white/[0.1] text-white/80 disabled:opacity-50"
                >
                  {syncing === h.id ? "Syncing…" : "Sync"}
                </button>
                <button
                  onClick={() => { setError(null); setDraft((cur) => (cur?.id === h.id ? null : h)); }}
                  className={`text-xs rounded-control px-2.5 py-1.5 hover:bg-white/[0.1] ${draft?.id === h.id ? "bg-white/[0.14] text-ink" : "bg-white/[0.06] text-white/80"}`}
                >
                  {draft?.id === h.id ? "Close" : "Edit"}
                </button>
                <button
                  onClick={async () => {
                    if (await confirmDialog(`Delete remote server “${h.name}”? Any routes exposed through it stay live on the VPS until you unexpose them.`, "Delete remote server"))
                      deleteRemoteHost(h.id);
                  }}
                  className="text-xs rounded-control px-2.5 py-1.5 bg-bad-bg hover:bg-[rgba(248,113,113,0.25)] text-bad"
                >
                  Delete
                </button>
              </div>
            </div>
            <RemoteLogViewer hostId={h.id} hasSsh={!!h.ssh_user} />
            {remoteDiffs[h.id] && (() => {
              const d = remoteDiffs[h.id];
              return (
                <div className="mt-2 rounded-card bg-black/20 border border-subtle p-2.5 text-xs flex flex-col gap-1.5">
                  <div className="text-white/50">
                    {d.matched.length} in sync
                    {d.missing_on_vps.length === 0 && d.foreign_on_vps.length === 0 && " · no drift"}
                  </div>
                  {d.missing_on_vps.length > 0 && (
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-warn truncate">
                        Missing on VPS: {d.missing_on_vps.join(", ")}
                      </span>
                      <button
                        onClick={() => runPush(h.id)}
                        className="shrink-0 rounded px-2 py-1 bg-warn-bg hover:bg-[rgba(251,191,36,0.25)] text-warn"
                      >
                        Push
                      </button>
                    </div>
                  )}
                  {d.foreign_on_vps.map((fh) => (
                    <div key={fh} className="flex items-center justify-between gap-2">
                      <span className="text-white/40 truncate" title="Not managed by Porta (CI/manual)">
                        Foreign: {fh}
                      </span>
                      <button
                        onClick={async () => {
                          if (await confirmDialog(`Remove unmanaged routes from ${h.name}? This re-asserts Porta's routes and drops any not managed by Porta (e.g. CI preview envs).`, "Remove foreign routes"))
                            runRemoveForeign(h.id, fh);
                        }}
                        className="shrink-0 rounded px-2 py-1 bg-bad-bg hover:bg-[rgba(248,113,113,0.25)] text-bad"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              );
            })()}
            {(activity[h.id]?.length ?? 0) > 0 && (
              <div className="mt-2 rounded-card bg-black/30 border border-subtle p-2">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] uppercase tracking-wider text-white/40">Activity</span>
                  <button
                    onClick={() => setActivity((a) => ({ ...a, [h.id]: [] }))}
                    className="text-[10px] text-white/40 hover:text-white/70"
                  >
                    Clear
                  </button>
                </div>
                <div className="max-h-[150px] overflow-y-auto font-mono text-[10.5px] leading-relaxed flex flex-col gap-0.5">
                  {activity[h.id].map((line, i) => (
                    <div
                      key={i}
                      className={line.includes("✕") ? "text-bad" : line.includes("✓") ? "text-ok" : "text-white/55"}
                    >
                      {line}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })}

      {draft ? (
        <div className="rounded-card bg-surface-1 border border-subtle p-4 flex flex-col gap-3">
          <div className="text-sm font-medium text-ink">{editing ? "Edit server" : "Add server"}</div>
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
              <span className="text-xs text-white/50">Base domain (primary)</span>
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
            <span className="text-xs text-white/50">Additional domains (comma-separated — all must point at this VPS)</span>
            <input className={inputCls} placeholder="klien-a.id, klien-b.my.id"
              value={draft.extra_domains.join(", ")}
              onChange={(e) => setDraft({ ...draft, extra_domains: e.target.value.split(",").map((d) => d.trim()).filter(Boolean) })} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-white/50">WireGuard interface (optional — auto-detected if blank)</span>
            <input className={inputCls} placeholder="utun6" value={draft.wg_interface ?? ""}
              onChange={(e) => setDraft({ ...draft, wg_interface: e.target.value })} />
          </label>

          <div className="border-t border-subtle pt-3 mt-1 flex flex-col gap-3">
            <div className="text-xs font-medium text-white/70">Integrations (optional)</div>
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-xs text-white/50">VPS public IP (for DNS)</span>
                <input className={inputCls} placeholder="203.0.113.5" value={draft.public_ip ?? ""}
                  onChange={(e) => setDraft({ ...draft, public_ip: e.target.value })} />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-white/50">SSH user (for remote logs)</span>
                <input className={inputCls} placeholder="deploy" value={draft.ssh_user ?? ""}
                  onChange={(e) => setDraft({ ...draft, ssh_user: e.target.value })} />
              </label>
            </div>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-white/50">Remote Caddy log path (optional — default /var/log/caddy/porta-access.log)</span>
              <input className={inputCls} placeholder="/var/log/caddy/porta-access.log" value={draft.remote_log_path ?? ""}
                onChange={(e) => setDraft({ ...draft, remote_log_path: e.target.value })} />
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={draft.auto_dns}
                onChange={(e) => setDraft({ ...draft, auto_dns: e.target.checked })} />
              <span className="text-xs text-white/60">Auto-create DNS via Cloudflare on expose (DNS-only A record)</span>
            </label>
          </div>
          {error && <div className="text-xs text-bad">{error}</div>}
          <div className="flex items-center gap-2">
            <button onClick={save} disabled={saving}
              className="text-xs rounded-control px-3 py-2 bg-white text-black font-medium hover:bg-white/90 disabled:opacity-50">
              {saving ? "Saving…" : editing ? "Save changes" : "Add server"}
            </button>
            <button onClick={() => { setDraft(null); setError(null); }}
              className="text-xs rounded-control px-3 py-2 bg-white/[0.06] hover:bg-white/[0.1] text-white/80">
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button onClick={() => setDraft({ ...EMPTY_HOST })}
          className="self-start text-xs rounded-control px-3 py-2 bg-white/[0.06] hover:bg-white/[0.1] text-white/80">
          + Add remote server
        </button>
      )}
    </div>
  );
}

/** Per-host viewer for the VPS Caddy access log, tailed over SSH (R8). */
function RemoteLogViewer({ hostId, hasSsh }: { hostId: string; hasSsh: boolean }) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<AccessLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const streamRef = useRef<string | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);

  async function loadRecent() {
    setLoading(true);
    setError(null);
    try {
      setEntries(await remoteLogTail(hostId, 100));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function toggleLive() {
    if (live) {
      setLive(false);
      unlistenRef.current?.();
      unlistenRef.current = null;
      if (streamRef.current) {
        remoteLogLiveStop(streamRef.current).catch(() => {});
        streamRef.current = null;
      }
      return;
    }
    setError(null);
    try {
      unlistenRef.current = await listen<AccessLogStreamEvent>(`access-log:remote:${hostId}`, (e) => {
        setEntries((prev) => [...e.payload.entries, ...prev].slice(0, 500));
      });
      streamRef.current = await remoteLogLiveStart(hostId);
      setLive(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      unlistenRef.current?.();
      unlistenRef.current = null;
    }
  }

  // Clean up the live stream on unmount.
  useEffect(() => {
    return () => {
      unlistenRef.current?.();
      if (streamRef.current) remoteLogLiveStop(streamRef.current).catch(() => {});
    };
  }, []);

  if (!open) {
    return (
      <button
        onClick={() => { setOpen(true); void loadRecent(); }}
        disabled={!hasSsh}
        title={hasSsh ? "" : "Set an SSH user on this host to enable remote logs"}
        className="mt-2 text-xs text-white/50 hover:text-white/80 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {hasSsh ? "▸ Remote access logs" : "▸ Remote access logs (set SSH user)"}
      </button>
    );
  }

  return (
    <div className="mt-2 rounded-card bg-black/20 border border-subtle p-2.5">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-white/60">Remote access logs</span>
        <div className="flex items-center gap-2">
          <button onClick={() => void loadRecent()} disabled={loading}
            className="text-[11px] rounded px-2 py-1 bg-white/[0.06] hover:bg-white/[0.1] text-white/70 disabled:opacity-50">
            {loading ? "Loading…" : "Load recent"}
          </button>
          <button onClick={() => void toggleLive()}
            className={`text-[11px] rounded px-2 py-1 ${live ? "bg-ok-bg text-ok" : "bg-white/[0.06] text-white/70 hover:bg-white/[0.1]"}`}>
            {live ? "● Live" : "Go live"}
          </button>
          <button onClick={() => setOpen(false)} className="text-[11px] text-white/40 hover:text-white/70">Close</button>
        </div>
      </div>
      {error && <div className="text-[11px] text-bad mb-1.5 break-words">{error}</div>}
      {entries.length === 0 && !error && !loading && (
        <div className="text-[11px] text-white/30">No entries yet.</div>
      )}
      <div className="max-h-[200px] overflow-y-auto font-mono text-[10.5px] flex flex-col gap-0.5">
        {entries.map((e, i) => (
          <div key={i} className="flex items-center gap-2 text-white/60">
            <span className={e.status >= 500 ? "text-bad" : e.status >= 400 ? "text-warn" : "text-ok"}>
              {e.status}
            </span>
            <span className="text-white/40 w-10 shrink-0">{e.method}</span>
            <span className="truncate">{e.host}{e.uri}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
