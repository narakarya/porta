import { useCallback, useEffect, useState } from "react";
import {
  cfDnsListZones,
  cfEmailRoutingStatus,
  cfEmailRoutingEnable,
  cfEmailListAddresses,
  cfEmailCreateAddress,
  cfEmailDeleteAddress,
  cfEmailListRules,
  cfEmailCreateRule,
  cfEmailDeleteRule,
  cfEmailSetCatchall,
  getCfApiToken,
  type DnsZone,
  type EmailDestination,
  type EmailRule,
  type EmailRoutingStatus,
} from "../../lib/commands";

interface Props {
  tokenVersion?: number;
}

/** Cloudflare Email Routing — forward `whatever@yourdomain.com` to your real
 * inbox. Account-level destinations + zone-level rules + a catch-all. */
export default function CloudflareEmailSection({ tokenVersion = 0 }: Props = {}) {
  const [token, setToken] = useState<string | null>(null);
  const [zones, setZones] = useState<DnsZone[]>([]);
  const [zoneId, setZoneId] = useState("");

  const [status, setStatus] = useState<EmailRoutingStatus | null>(null);
  const [enabling, setEnabling] = useState(false);

  const [destinations, setDestinations] = useState<EmailDestination[]>([]);
  const [newDestEmail, setNewDestEmail] = useState("");
  const [creatingDest, setCreatingDest] = useState(false);

  const [rules, setRules] = useState<EmailRule[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // New-rule form (always visible at the bottom of the rules table).
  const [ruleMatcher, setRuleMatcher] = useState("");
  const [ruleForwardTo, setRuleForwardTo] = useState("");
  const [creatingRule, setCreatingRule] = useState(false);

  // Catch-all editor.
  const [catchAllForward, setCatchAllForward] = useState("");
  const [savingCatchAll, setSavingCatchAll] = useState(false);

  const [deletingTag, setDeletingTag] = useState<string | null>(null);

  useEffect(() => {
    getCfApiToken().then((t) => setToken(t || ""));
  }, [tokenVersion]);

  useEffect(() => {
    if (!token) return;
    cfDnsListZones(token).then((list) => {
      setZones(list);
      if (list.length > 0) setZoneId((p) => p || list[0].id);
    }).catch((e) => setError(e instanceof Error ? e.message : String(e)));
    cfEmailListAddresses(token).then(setDestinations).catch(() => {});
  }, [token]);

  const loadZone = useCallback(async (t: string, zid: string) => {
    setLoading(true);
    setError(null);
    // Clear stale data from the previous zone — without this, the section's
    // `loading && !status` branch never fires on a zone switch (status is
    // truthy from the prior zone) and the user sees the old zone's rules
    // until the new fetch resolves with no indication anything is happening.
    setStatus(null);
    setRules([]);
    setCatchAllForward("");
    try {
      const [s, r] = await Promise.all([
        cfEmailRoutingStatus(t, zid),
        cfEmailListRules(t, zid),
      ]);
      setStatus(s);
      setRules(r.filter((x) => !x.catch_all));
      const ca = r.find((x) => x.catch_all);
      setCatchAllForward(ca?.forward_to.join(", ") ?? "");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (token && zoneId) loadZone(token, zoneId);
  }, [token, zoneId, loadZone]);

  async function handleEnable() {
    if (!token || !zoneId) return;
    setEnabling(true);
    setError(null);
    try {
      await cfEmailRoutingEnable(token, zoneId);
      await loadZone(token, zoneId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setEnabling(false);
    }
  }

  async function handleAddDestination() {
    if (!token || !newDestEmail.trim()) return;
    setCreatingDest(true);
    setError(null);
    try {
      const dest = await cfEmailCreateAddress(token, newDestEmail.trim());
      setDestinations((prev) => [...prev, dest]);
      setNewDestEmail("");
      window.alert(`Verification email sent to ${dest.email}. Click the link in the email to activate it as a destination.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreatingDest(false);
    }
  }

  async function handleDeleteDestination(d: EmailDestination) {
    if (!token) return;
    if (!window.confirm(`Remove ${d.email} as a destination?`)) return;
    try {
      await cfEmailDeleteAddress(token, d.tag);
      setDestinations((prev) => prev.filter((x) => x.tag !== d.tag));
    } catch (e) {
      window.alert(`Delete failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function handleAddRule() {
    if (!token || !zoneId) return;
    const m = ruleMatcher.trim();
    const fwd = ruleForwardTo.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    if (!m || fwd.length === 0) {
      setError("Matcher email and at least one destination required.");
      return;
    }
    setCreatingRule(true);
    setError(null);
    try {
      const rule = await cfEmailCreateRule(token, zoneId, m, m, fwd);
      setRules((prev) => [...prev, rule]);
      setRuleMatcher("");
      setRuleForwardTo("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreatingRule(false);
    }
  }

  async function handleDeleteRule(r: EmailRule) {
    if (!token || !zoneId) return;
    if (!window.confirm(`Delete rule "${r.matcher_value}"?`)) return;
    setDeletingTag(r.tag);
    try {
      await cfEmailDeleteRule(token, zoneId, r.tag);
      setRules((prev) => prev.filter((x) => x.tag !== r.tag));
    } catch (e) {
      window.alert(`Delete failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDeletingTag(null);
    }
  }

  async function handleSaveCatchAll() {
    if (!token || !zoneId) return;
    const fwd = catchAllForward.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    setSavingCatchAll(true);
    setError(null);
    try {
      await cfEmailSetCatchall(token, zoneId, fwd);
      // Reload to get the updated rules in case CF normalizes anything.
      await loadZone(token, zoneId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingCatchAll(false);
    }
  }

  if (token === null) return <p className="text-[12px] text-zinc-500">Loading…</p>;
  if (!token) {
    return (
      <div className="px-3 py-3 rounded-lg bg-amber-500/[0.07] border border-amber-500/[0.25] text-[12px] text-amber-200">
        Add a Cloudflare API token in the bar above. Email Routing needs <span className="font-mono">Account.Email Routing Addresses:Edit + Zone.Email Routing Rules:Edit</span>.
      </div>
    );
  }

  const verifiedDestinations = destinations.filter((d) => d.verified);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-[14px] font-semibold text-zinc-100">Email Routing</h2>
            {loading && (
              <span className="inline-flex items-center gap-1 text-[10.5px] text-zinc-500">
                <svg className="animate-spin" width="10" height="10" viewBox="0 0 12 12" fill="none">
                  <path d="M6 1.5A4.5 4.5 0 1 1 1.5 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
                Loading{zones.find((z) => z.id === zoneId)?.name ? ` ${zones.find((z) => z.id === zoneId)!.name}` : ""}…
              </span>
            )}
          </div>
          <p className="text-[11.5px] text-zinc-500 mt-0.5">
            Forward email at your domain to your real inbox — no mailserver needed.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => {
              if (!token) return;
              cfDnsListZones(token).then(setZones).catch((e) => setError(e instanceof Error ? e.message : String(e)));
              cfEmailListAddresses(token).then(setDestinations).catch(() => {});
              if (zoneId) loadZone(token, zoneId);
            }}
            disabled={!token || loading}
            className="text-[11px] text-zinc-500 hover:text-zinc-200 disabled:opacity-40 transition-colors"
          >
            {loading ? "Loading…" : "↻ Refresh"}
          </button>
          <div className="min-w-[200px]">
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
      </div>

      {error && (
        <p className="text-[11px] text-red-400 font-mono whitespace-pre-wrap break-words">{error}</p>
      )}

      {loading && !status ? (
        <div className="px-3 py-6 text-center text-[12px] text-zinc-500">Loading…</div>
      ) : !status?.enabled ? (
        <div className="flex items-center justify-between gap-3 px-4 py-3 rounded-xl bg-amber-500/[0.07] border border-amber-500/[0.25]">
          <p className="text-[12px] text-amber-200">
            Email Routing is not enabled for this zone. Enabling will provision the required MX/SPF/TXT DNS records automatically.
          </p>
          <button
            type="button"
            onClick={handleEnable}
            disabled={enabling}
            className="px-3 py-1.5 text-[11.5px] rounded-md bg-amber-500/20 hover:bg-amber-500/30 text-amber-100 border border-amber-500/30 disabled:opacity-40 shrink-0 inline-flex items-center gap-1.5"
          >
            {enabling && <span className="inline-block h-3 w-3 rounded-full border-2 border-amber-400/30 border-t-amber-200 animate-spin" />}
            {enabling ? "Enabling…" : "Enable for this zone"}
          </button>
        </div>
      ) : (
        <>
          {/* Destinations (account-level) */}
          <div className="flex flex-col gap-2">
            <div>
              <h3 className="text-[12.5px] font-semibold text-zinc-200">Destinations</h3>
              <p className="text-[10.5px] text-zinc-500 mt-0.5">
                Real inbox addresses that can receive forwards. Each must be verified via the link Cloudflare emails on add.
              </p>
            </div>
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] divide-y divide-white/[0.04] overflow-hidden">
              {destinations.length === 0 ? (
                <div className="px-3 py-3 text-center text-[11px] text-zinc-500">No destinations yet.</div>
              ) : destinations.map((d) => (
                <div key={d.tag} className="flex items-center justify-between gap-3 px-3 py-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`h-1.5 w-1.5 rounded-full ${d.verified ? "bg-emerald-400" : "bg-amber-400"}`} />
                    <code className="font-mono text-[12px] text-zinc-200 truncate">{d.email}</code>
                    {!d.verified && <span className="text-[10px] text-amber-400 shrink-0">unverified</span>}
                  </div>
                  <button
                    type="button"
                    onClick={() => handleDeleteDestination(d)}
                    className="text-[11px] text-zinc-500 hover:text-red-400 transition-colors"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                type="email"
                spellCheck={false}
                value={newDestEmail}
                onChange={(e) => setNewDestEmail(e.target.value)}
                placeholder="real@gmail.com"
                className="flex-1 bg-[#111113] border border-white/[0.08] rounded-lg px-3 py-1.5 text-[12px] font-mono text-zinc-100 outline-none focus:border-blue-500/50"
              />
              <button
                type="button"
                onClick={handleAddDestination}
                disabled={creatingDest || !newDestEmail.trim()}
                className="px-3 py-1.5 text-[11.5px] rounded-md bg-blue-500/15 hover:bg-blue-500/25 text-blue-200 border border-blue-500/30 disabled:opacity-40 inline-flex items-center gap-1.5"
              >
                {creatingDest && <span className="inline-block h-3 w-3 rounded-full border-2 border-blue-400/30 border-t-blue-300 animate-spin" />}
                {creatingDest ? "Sending…" : "Add destination"}
              </button>
            </div>
          </div>

          {/* Forwarding rules (zone-level) */}
          <div className="flex flex-col gap-2">
            <div>
              <h3 className="text-[12.5px] font-semibold text-zinc-200">Forwarding rules</h3>
              <p className="text-[10.5px] text-zinc-500 mt-0.5">
                Match an exact email address and forward to a destination.
              </p>
            </div>
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] divide-y divide-white/[0.04] overflow-hidden">
              <div className="grid grid-cols-[1fr_1fr_80px] gap-2 px-3 py-2 text-[10px] uppercase tracking-wider text-zinc-500">
                <div>Match</div>
                <div>Forward to</div>
                <div className="text-right">Action</div>
              </div>
              {rules.length === 0 ? (
                <div className="px-3 py-3 text-center text-[11px] text-zinc-500">No rules yet.</div>
              ) : rules.map((r) => (
                <div key={r.tag} className="grid grid-cols-[1fr_1fr_80px] gap-2 px-3 py-2 items-center text-[12px] text-zinc-200">
                  <code className="font-mono text-[11.5px] truncate" title={r.matcher_value}>{r.matcher_value}</code>
                  <code className="font-mono text-[11.5px] text-zinc-300 truncate" title={r.forward_to.join(", ")}>{r.forward_to.join(", ")}</code>
                  <div className="text-right">
                    <button
                      type="button"
                      onClick={() => handleDeleteRule(r)}
                      disabled={deletingTag === r.tag}
                      className="text-[11px] text-red-300 hover:text-red-200 transition-colors disabled:opacity-40"
                    >
                      {deletingTag === r.tag ? "…" : "Delete"}
                    </button>
                  </div>
                </div>
              ))}
              {/* Inline new-rule row */}
              <div className="grid grid-cols-[1fr_1fr_80px] gap-2 px-3 py-2 items-center bg-blue-500/[0.04]">
                <input
                  spellCheck={false}
                  value={ruleMatcher}
                  onChange={(e) => setRuleMatcher(e.target.value)}
                  placeholder="hello@example.com"
                  className="bg-[#111113] border border-white/[0.08] rounded px-2 py-1 text-[11.5px] font-mono text-zinc-100 outline-none focus:border-blue-500/50"
                />
                <input
                  list={`fwd-suggestions-${zoneId}`}
                  spellCheck={false}
                  value={ruleForwardTo}
                  onChange={(e) => setRuleForwardTo(e.target.value)}
                  placeholder="real@gmail.com"
                  className="bg-[#111113] border border-white/[0.08] rounded px-2 py-1 text-[11.5px] font-mono text-zinc-100 outline-none focus:border-blue-500/50"
                />
                <datalist id={`fwd-suggestions-${zoneId}`}>
                  {verifiedDestinations.map((d) => <option key={d.tag} value={d.email} />)}
                </datalist>
                <div className="text-right">
                  <button
                    type="button"
                    onClick={handleAddRule}
                    disabled={creatingRule || !ruleMatcher.trim() || !ruleForwardTo.trim()}
                    className="px-2 py-0.5 text-[11px] rounded bg-blue-500/15 hover:bg-blue-500/25 text-blue-200 border border-blue-500/30 disabled:opacity-40"
                  >
                    {creatingRule ? "…" : "Add"}
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Catch-all */}
          <div className="flex flex-col gap-2 p-4 rounded-xl bg-white/[0.03] border border-white/[0.06]">
            <div>
              <h3 className="text-[12.5px] font-semibold text-zinc-200">Catch-all</h3>
              <p className="text-[10.5px] text-zinc-500 mt-0.5">
                Anything that didn't match a rule above goes here. Empty = drop unmatched mail.
              </p>
            </div>
            <div className="flex gap-2">
              <input
                list={`catchall-suggestions-${zoneId}`}
                spellCheck={false}
                value={catchAllForward}
                onChange={(e) => setCatchAllForward(e.target.value)}
                placeholder="real@gmail.com (or leave empty to drop)"
                className="flex-1 bg-[#111113] border border-white/[0.08] rounded-lg px-3 py-1.5 text-[12px] font-mono text-zinc-100 outline-none focus:border-blue-500/50"
              />
              <datalist id={`catchall-suggestions-${zoneId}`}>
                {verifiedDestinations.map((d) => <option key={d.tag} value={d.email} />)}
              </datalist>
              <button
                type="button"
                onClick={handleSaveCatchAll}
                disabled={savingCatchAll}
                className="px-3 py-1.5 text-[11.5px] rounded-md bg-white/[0.06] hover:bg-white/[0.12] text-zinc-200 disabled:opacity-40 inline-flex items-center gap-1.5"
              >
                {savingCatchAll && <span className="inline-block h-3 w-3 rounded-full border-2 border-zinc-400/30 border-t-zinc-200 animate-spin" />}
                Save
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
