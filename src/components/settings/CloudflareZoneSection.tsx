import { useCallback, useEffect, useState } from "react";
import {
  cfDnsListZones,
  cfDnsDiffZoneVsLocal,
  cfZoneGetSettings,
  cfZoneSetSetting,
  cfZonePurgeAll,
  cfZonePurgeHosts,
  cfZonePurgeFiles,
  getCfApiToken,
  type DnsZone,
  type ZoneSetting,
  type ZoneDnsDiff,
} from "../../lib/commands";

const SETTING_LABELS: Record<string, { label: string; hint: string }> = {
  always_use_https: { label: "Always Use HTTPS", hint: "Redirect all HTTP requests to HTTPS." },
  automatic_https_rewrites: { label: "Auto HTTPS Rewrites", hint: "Rewrite mixed-content URLs to HTTPS." },
  development_mode: { label: "Development Mode", hint: "Bypass cache for 3 hours — useful while debugging." },
  ssl: { label: "SSL Mode", hint: "How origin → CF connection is encrypted." },
  min_tls_version: { label: "Min TLS Version", hint: "Reject older TLS versions." },
  opportunistic_encryption: { label: "Opportunistic Encryption", hint: "Allow HTTPS when client supports it." },
  tls_1_3: { label: "TLS 1.3", hint: "Enable TLS 1.3 for visitors." },
  brotli: { label: "Brotli", hint: "Compress responses with Brotli." },
  security_level: { label: "Security Level", hint: "How aggressively to challenge suspicious traffic." },
  browser_cache_ttl: { label: "Browser Cache TTL", hint: "Default cache time the browser keeps responses." },
  challenge_ttl: { label: "Challenge TTL", hint: "How long a visitor's challenge solution stays valid." },
};

interface Props {
  tokenVersion?: number;
}

/** Per-zone settings (toggles + selects) and cache purge. Both operate on
 * one zone at a time, so we share the zone selector across both panels. */
export default function CloudflareZoneSection({ tokenVersion = 0 }: Props = {}) {
  const [token, setToken] = useState<string | null>(null);
  const [zones, setZones] = useState<DnsZone[]>([]);
  const [zoneId, setZoneId] = useState("");
  const [settings, setSettings] = useState<ZoneSetting[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  const [purgeMode, setPurgeMode] = useState<"all" | "hosts" | "files">("all");
  const [purgeInput, setPurgeInput] = useState("");
  const [purging, setPurging] = useState(false);
  const [purgeMsg, setPurgeMsg] = useState<string | null>(null);

  // DNS drift diff state — fetched on-demand when the user opens the panel
  // and re-fetched on zone change while open.
  const [diff, setDiff] = useState<ZoneDnsDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [driftOpen, setDriftOpen] = useState(false);
  const [openCfList, setOpenCfList] = useState(true);
  const [openLocalList, setOpenLocalList] = useState(true);
  const [openMismatchList, setOpenMismatchList] = useState(true);

  const loadDiff = useCallback(async (t: string, zid: string) => {
    setDiffLoading(true);
    setDiffError(null);
    try {
      const result = await cfDnsDiffZoneVsLocal(t, zid);
      setDiff(result);
    } catch (e) {
      setDiffError(e instanceof Error ? e.message : String(e));
    } finally {
      setDiffLoading(false);
    }
  }, []);

  useEffect(() => {
    if (driftOpen && token && zoneId) loadDiff(token, zoneId);
  }, [driftOpen, token, zoneId, loadDiff]);

  useEffect(() => {
    getCfApiToken().then((t) => setToken(t || ""));
  }, [tokenVersion]);

  useEffect(() => {
    if (!token) return;
    cfDnsListZones(token).then((list) => {
      setZones(list);
      if (list.length > 0) setZoneId((p) => p || list[0].id);
    }).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [token]);

  const loadSettings = useCallback(async (t: string, zid: string) => {
    setLoading(true);
    setError(null);
    // Clear stale settings on zone switch so the user gets a clear "loading"
    // signal instead of seeing the previous zone's values until fetch resolves.
    setSettings([]);
    try {
      const list = await cfZoneGetSettings(t, zid);
      setSettings(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (token && zoneId) loadSettings(token, zoneId);
  }, [token, zoneId, loadSettings]);

  async function handleSetSetting(s: ZoneSetting, value: string) {
    if (!token || !zoneId || s.value === value) return;
    setSavingId(s.id);
    // Optimistic update — revert on failure.
    const snapshot = settings;
    setSettings((prev) => prev.map((x) => x.id === s.id ? { ...x, value } : x));
    try {
      await cfZoneSetSetting(token, zoneId, s.id, value);
    } catch (e) {
      setSettings(snapshot);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingId(null);
    }
  }

  async function handlePurge() {
    if (!token || !zoneId) return;
    setPurging(true);
    setPurgeMsg(null);
    setError(null);
    try {
      if (purgeMode === "all") {
        if (!window.confirm(`Purge ALL cache for ${zones.find((z) => z.id === zoneId)?.name ?? "this zone"}?`)) {
          setPurging(false);
          return;
        }
        await cfZonePurgeAll(token, zoneId);
      } else if (purgeMode === "hosts") {
        const hosts = purgeInput.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
        if (hosts.length === 0) { setError("Add at least one hostname."); setPurging(false); return; }
        await cfZonePurgeHosts(token, zoneId, hosts);
      } else {
        const files = purgeInput.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
        if (files.length === 0) { setError("Add at least one URL."); setPurging(false); return; }
        await cfZonePurgeFiles(token, zoneId, files);
      }
      setPurgeInput("");
      setPurgeMsg("Cache purged.");
      window.setTimeout(() => setPurgeMsg(null), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPurging(false);
    }
  }

  if (token === null) {
    return <p className="text-[12px] text-zinc-500">Loading…</p>;
  }
  if (!token) {
    return (
      <div className="px-3 py-3 rounded-lg bg-amber-500/[0.07] border border-amber-500/[0.25] text-[12px] text-amber-200">
        Add a Cloudflare API token in the bar above first. Needs <span className="font-mono">Zone:Settings:Edit + Zone:Cache Purge</span>.
      </div>
    );
  }

  const selectedZone = zones.find((z) => z.id === zoneId);

  return (
    <div className="flex flex-col gap-5">
      {/* Zone picker */}
      <div className="flex items-center gap-3">
        <label className="text-[11px] font-medium text-zinc-400">Zone</label>
        <div className="min-w-[220px]">
          <select
            value={zoneId}
            onChange={(e) => setZoneId(e.target.value)}
            disabled={zones.length === 0}
            className="select-base !text-[12px] !py-1.5"
          >
            {zones.length === 0 && <option value="">No zones</option>}
            {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
          </select>
        </div>
      </div>

      {error && (
        <p className="text-[11px] text-red-400 font-mono whitespace-pre-wrap break-words">{error}</p>
      )}

      {/* Cache Purge */}
      <div className="flex flex-col gap-3 p-4 rounded-xl bg-orange-500/[0.04] border border-orange-500/[0.18]">
        <div>
          <h2 className="text-[14px] font-semibold text-zinc-100">Cache Purge</h2>
          <p className="text-[11.5px] text-zinc-500 mt-0.5">
            Useful right after deploying a static app — Cloudflare drops the cached copy and re-fetches from origin.
          </p>
        </div>
        <div className="flex gap-1.5 p-0.5 rounded-md bg-[#0c0c0e] border border-white/[0.06] w-fit">
          {(["all", "hosts", "files"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => { setPurgeMode(m); setPurgeInput(""); }}
              className={`px-2.5 py-1 rounded text-[11px] font-medium transition-colors ${
                purgeMode === m ? "bg-white/[0.08] text-zinc-100" : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {m === "all" ? "Everything" : m === "hosts" ? "By hostname" : "By URL"}
            </button>
          ))}
        </div>
        {purgeMode !== "all" && (
          <textarea
            spellCheck={false}
            value={purgeInput}
            onChange={(e) => setPurgeInput(e.target.value)}
            rows={2}
            placeholder={purgeMode === "hosts" ? "myapp.example.com\napi.example.com" : "https://myapp.example.com/file.css"}
            className="bg-[#111113] border border-white/[0.08] rounded-lg px-3 py-2 text-[12px] font-mono text-zinc-100 outline-none focus:border-orange-500/50"
          />
        )}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handlePurge}
            disabled={purging}
            className="px-3 py-1.5 text-[11.5px] rounded-md bg-orange-500/15 hover:bg-orange-500/25 text-orange-200 border border-orange-500/30 disabled:opacity-40 inline-flex items-center gap-1.5"
          >
            {purging && <span className="inline-block h-3 w-3 rounded-full border-2 border-orange-400/30 border-t-orange-300 animate-spin" />}
            {purging ? "Purging…" : purgeMode === "all" ? "Purge everything" : "Purge"}
          </button>
          {purgeMsg && <span className="text-[11px] text-emerald-400">{purgeMsg}</span>}
        </div>
      </div>

      {/* DNS drift */}
      <div className="flex flex-col gap-3 p-4 rounded-xl bg-sky-500/[0.04] border border-sky-500/[0.18]">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-[14px] font-semibold text-zinc-100">DNS drift</h2>
            <p className="text-[11.5px] text-zinc-500 mt-0.5">
              Compare records in {selectedZone ? <span className="font-mono text-zinc-400">{selectedZone.name}</span> : "the selected zone"} against your local Caddy + dnsmasq config.
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {driftOpen && (
              <button
                type="button"
                onClick={() => token && zoneId && loadDiff(token, zoneId)}
                disabled={diffLoading || !zoneId}
                className="text-[11px] text-zinc-500 hover:text-zinc-200 disabled:opacity-40 transition-colors"
              >
                {diffLoading ? "Loading…" : "↻ Refresh"}
              </button>
            )}
            <button
              type="button"
              onClick={() => setDriftOpen((v) => !v)}
              className="text-[11px] font-medium text-sky-300 hover:text-sky-200 transition-colors"
            >
              {driftOpen ? "× Hide" : "→ Compare"}
            </button>
          </div>
        </div>
        {driftOpen && (
          <>
            {diffError && (
              <p className="text-[11px] text-red-400 font-mono whitespace-pre-wrap break-words">{diffError}</p>
            )}
            {diffLoading && !diff && (
              <div className="flex flex-col gap-1.5">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-7 rounded bg-white/[0.03] animate-pulse" />
                ))}
              </div>
            )}
            {diff && (
              <div className="flex flex-col gap-2">
                {/* Only in CF */}
                <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setOpenCfList((v) => !v)}
                    className="w-full flex items-center justify-between px-3 py-2 hover:bg-white/[0.03] transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-[12px] text-zinc-200">Only in Cloudflare</span>
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30">
                        {diff.only_in_cf.length}
                      </span>
                    </div>
                    <span className="text-[10px] text-zinc-500">{openCfList ? "▾" : "▸"}</span>
                  </button>
                  {openCfList && diff.only_in_cf.length > 0 && (
                    <div className="border-t border-white/[0.04] divide-y divide-white/[0.04]">
                      {diff.only_in_cf.map((r) => (
                        <div key={r.id} className="flex items-center gap-2 px-3 py-1.5">
                          <span className="text-[10px] font-mono uppercase text-zinc-500 w-12 shrink-0">{r.record_type}</span>
                          <span className="text-[11px] font-mono text-zinc-200 truncate flex-1">{r.name}</span>
                          <span className="text-[10px] font-mono text-zinc-500 truncate max-w-[200px]" title={r.content}>{r.content}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Only local */}
                <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setOpenLocalList((v) => !v)}
                    className="w-full flex items-center justify-between px-3 py-2 hover:bg-white/[0.03] transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-[12px] text-zinc-200">Only local</span>
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-300 border border-purple-500/30">
                        {diff.only_local.length}
                      </span>
                    </div>
                    <span className="text-[10px] text-zinc-500">{openLocalList ? "▾" : "▸"}</span>
                  </button>
                  {openLocalList && diff.only_local.length > 0 && (
                    <div className="border-t border-white/[0.04] divide-y divide-white/[0.04]">
                      {diff.only_local.map((r) => (
                        <div key={`${r.name}-${r.source}`} className="flex items-center gap-2 px-3 py-1.5">
                          <span className="text-[10px] font-mono uppercase text-zinc-500 w-12 shrink-0">{r.record_type}</span>
                          <span className="text-[11px] font-mono text-zinc-200 truncate flex-1">{r.name}</span>
                          <span className="text-[10px] font-mono text-zinc-500 truncate max-w-[120px]">{r.content}</span>
                          <span className="text-[9px] uppercase tracking-wide text-zinc-600 shrink-0">{r.source}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Mismatched */}
                <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setOpenMismatchList((v) => !v)}
                    className="w-full flex items-center justify-between px-3 py-2 hover:bg-white/[0.03] transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-[12px] text-zinc-200">Mismatched</span>
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-red-500/15 text-red-300 border border-red-500/30">
                        {diff.mismatched.length}
                      </span>
                    </div>
                    <span className="text-[10px] text-zinc-500">{openMismatchList ? "▾" : "▸"}</span>
                  </button>
                  {openMismatchList && diff.mismatched.length > 0 && (
                    <div className="border-t border-white/[0.04] divide-y divide-white/[0.04]">
                      {diff.mismatched.map((m) => (
                        <div key={m.cf.id} className="px-3 py-2">
                          <div className="text-[11px] font-mono text-zinc-200 truncate">{m.name}</div>
                          <div className="text-[10px] text-zinc-500 mt-0.5 leading-snug">{m.reason}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Zone settings */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-[14px] font-semibold text-zinc-100">Zone Settings</h2>
              {loading && (
                <span className="inline-flex items-center gap-1 text-[10.5px] text-zinc-500">
                  <svg className="animate-spin" width="10" height="10" viewBox="0 0 12 12" fill="none">
                    <path d="M6 1.5A4.5 4.5 0 1 1 1.5 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                  </svg>
                  Loading{selectedZone ? ` ${selectedZone.name}` : ""}…
                </span>
              )}
            </div>
            <p className="text-[11.5px] text-zinc-500 mt-0.5">
              Per-zone toggles for HTTPS, caching, security, and TLS — applied to {selectedZone ? <span className="font-mono text-zinc-400">{selectedZone.name}</span> : "the selected zone"}.
            </p>
          </div>
          <button
            type="button"
            onClick={() => token && zoneId && loadSettings(token, zoneId)}
            disabled={loading || !zoneId}
            className="text-[11px] text-zinc-500 hover:text-zinc-200 disabled:opacity-40 transition-colors"
          >
            {loading ? "Loading…" : "↻ Refresh"}
          </button>
        </div>

        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] divide-y divide-white/[0.04] overflow-hidden">
          {loading && settings.length === 0 ? (
            <div className="px-3 py-6 text-center text-[12px] text-zinc-500">Loading settings…</div>
          ) : settings.length === 0 ? (
            <div className="px-3 py-6 text-center text-[12px] text-zinc-500">No settings to show.</div>
          ) : (
            settings.map((s) => {
              const meta = SETTING_LABELS[s.id] ?? { label: s.id, hint: "" };
              const saving = savingId === s.id;
              return (
                <div key={s.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="text-[12px] text-zinc-200">{meta.label}</p>
                    {meta.hint && <p className="text-[10.5px] text-zinc-500 mt-0.5 leading-snug">{meta.hint}</p>}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {saving && <span className="inline-block h-3 w-3 rounded-full border-2 border-blue-400/30 border-t-blue-300 animate-spin" />}
                    {s.kind === "toggle" ? (
                      <button
                        type="button"
                        disabled={!s.editable || saving}
                        onClick={() => handleSetSetting(s, s.value === "on" ? "off" : "on")}
                        className={`relative inline-flex items-center h-5 w-9 rounded-full transition-colors disabled:opacity-40 ${
                          s.value === "on" ? "bg-emerald-500/60" : "bg-zinc-700"
                        }`}
                      >
                        <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                          s.value === "on" ? "translate-x-5" : "translate-x-0.5"
                        }`} />
                      </button>
                    ) : s.kind === "select" ? (
                      <select
                        value={s.value}
                        disabled={!s.editable || saving}
                        onChange={(e) => handleSetSetting(s, e.target.value)}
                        className="select-base !text-[11px] !py-1 !pl-2 !pr-6 !rounded w-[120px]"
                      >
                        {s.options.map((opt) => (
                          <option key={opt} value={opt}>{opt}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type="number"
                        value={s.value}
                        disabled={!s.editable || saving}
                        onBlur={(e) => handleSetSetting(s, e.target.value)}
                        onChange={(e) => setSettings((prev) => prev.map((x) => x.id === s.id ? { ...x, value: e.target.value } : x))}
                        className="number-no-spin bg-[#111113] border border-white/[0.08] rounded px-2 py-1 text-[11px] text-zinc-100 outline-none focus:border-blue-500/50 w-[100px] disabled:opacity-40"
                      />
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
