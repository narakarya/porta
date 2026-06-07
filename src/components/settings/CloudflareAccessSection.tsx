import { useCallback, useEffect, useState } from "react";
import { cfAccessListApps, cfAccessProtect, cfAccessUnprotect, getCfApiToken, openExternalUrl, type AccessAppInfo } from "../../lib/commands";
import AccessPolicyEditor from "./AccessPolicyEditor";

interface Props {
  /** Bumped by parent when the API token changes — triggers re-fetch. */
  tokenVersion?: number;
}

/** Full CRUD view of every Cloudflare Access app in the account: protect a new
 * hostname, edit allowed emails/domains inline, or remove protection. Mirrors
 * the per-app panel in each app's Tunneling tab — both edit the same policies. */
export default function CloudflareAccessSection({ tokenVersion = 0 }: Props = {}) {
  const [token, setToken] = useState<string | null>(null);
  const [apps, setApps] = useState<AccessAppInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removingUid, setRemovingUid] = useState<string | null>(null);
  const [editingUid, setEditingUid] = useState<string | null>(null);
  const [rowSaving, setRowSaving] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  // Add-new state.
  const [adding, setAdding] = useState(false);
  const [newHost, setNewHost] = useState("");
  const [addSaving, setAddSaving] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  useEffect(() => {
    getCfApiToken().then((t) => setToken(t || ""));
  }, [tokenVersion]);

  const refresh = useCallback(async (t: string) => {
    setLoading(true);
    setError(null);
    try {
      const list = await cfAccessListApps(t);
      // Stable order — domain alphabetical so rerenders don't shuffle rows.
      list.sort((a, b) => a.domain.localeCompare(b.domain));
      setApps(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (token) refresh(token);
  }, [token, refresh]);

  async function handleRemove(app: AccessAppInfo) {
    if (!token) return;
    if (!window.confirm(`Remove Cloudflare Access protection from ${app.domain}?`)) return;
    setRemovingUid(app.uid);
    try {
      await cfAccessUnprotect(token, app.domain);
      setApps((prev) => prev.filter((a) => a.uid !== app.uid));
    } catch (e) {
      window.alert(`Remove failed:\n${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRemovingUid(null);
    }
  }

  async function handleRowSave(app: AccessAppInfo, emails: string[], domains: string[]) {
    if (!token) return;
    setRowSaving(true);
    setRowError(null);
    try {
      const info = await cfAccessProtect(token, app.domain, emails, domains);
      setApps((prev) => prev.map((a) => (a.uid === app.uid ? info : a)));
      setEditingUid(null);
    } catch (e) {
      setRowError(e instanceof Error ? e.message : String(e));
    } finally {
      setRowSaving(false);
    }
  }

  async function handleAddSave(emails: string[], domains: string[]) {
    if (!token) return;
    const host = newHost.trim();
    if (!host) {
      setAddError("Enter a hostname to protect.");
      return;
    }
    setAddSaving(true);
    setAddError(null);
    try {
      await cfAccessProtect(token, host, emails, domains);
      setAdding(false);
      setNewHost("");
      await refresh(token);
    } catch (e) {
      setAddError(e instanceof Error ? e.message : String(e));
    } finally {
      setAddSaving(false);
    }
  }

  if (token === null) {
    return <p className="text-[12px] text-zinc-500">Loading…</p>;
  }

  if (!token) {
    return (
      <div className="px-3 py-3 rounded-lg bg-amber-500/[0.07] border border-amber-500/[0.25] text-[12px] text-amber-200">
        Add a Cloudflare API token in the <span className="font-medium">Tunnels</span> tab first.
        Token needs <span className="font-mono">Account.Access: Apps and Policies:Edit</span> + <span className="font-mono">Account Settings:Read</span> scopes.
      </div>
    );
  }

  const filtered = search.trim()
    ? apps.filter((a) => a.domain.toLowerCase().includes(search.trim().toLowerCase()))
    : apps;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-[14px] font-semibold text-zinc-100">Cloudflare Access apps</h2>
          <p className="text-[11.5px] text-zinc-500 mt-0.5">
            Hostnames protected by an Access login wall. Protect a new hostname or edit allowed emails/domains right here — or from each app's Tunneling tab.
          </p>
        </div>
        <button
          type="button"
          onClick={() => refresh(token)}
          disabled={loading}
          className="text-[11px] text-zinc-500 hover:text-zinc-200 disabled:opacity-40 transition-colors"
        >
          {loading ? "Loading…" : "↻ Refresh"}
        </button>
      </div>

      <div className="flex items-center justify-between gap-3">
        <input
          spellCheck={false}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter by hostname…"
          className="bg-[#111113] border border-white/[0.08] rounded-lg px-3 py-1.5 text-[12px] text-zinc-100 outline-none focus:border-violet-500/50 transition-colors w-full max-w-[300px]"
        />
        {!adding && (
          <button
            type="button"
            onClick={() => { setAdding(true); setAddError(null); }}
            className="shrink-0 px-3 py-1.5 text-[12px] font-medium rounded-lg bg-violet-500/20 hover:bg-violet-500/30 text-violet-100 border border-violet-500/40 transition-colors"
          >
            + Protect hostname
          </button>
        )}
      </div>

      {adding && (
        <div className="rounded-xl border border-violet-500/[0.2] bg-violet-500/[0.04] p-3 space-y-2">
          <label className="block">
            <span className="text-[10px] text-zinc-500 block mb-1">Hostname to protect</span>
            <input
              spellCheck={false}
              autoFocus
              value={newHost}
              onChange={(e) => setNewHost(e.target.value)}
              placeholder="app.example.com"
              className="w-full bg-[#111113] border border-white/[0.08] rounded-lg px-3 py-2 text-[12px] text-zinc-100 outline-none focus:border-violet-500/50 transition-colors font-mono"
            />
          </label>
          <AccessPolicyEditor
            initialEmails={[]}
            initialDomains={[]}
            saving={addSaving}
            error={addError}
            saveLabel="Protect"
            onSave={handleAddSave}
            onCancel={() => { setAdding(false); setNewHost(""); setAddError(null); }}
            onValidationError={setAddError}
          />
        </div>
      )}

      {error && (
        <p className="text-[11px] text-red-400 font-mono whitespace-pre-wrap break-words">{error}</p>
      )}

      <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
        <div className="grid grid-cols-[2fr_1fr_1fr_90px_140px] gap-2 px-3 py-2 text-[10px] uppercase tracking-wider text-zinc-500 border-b border-white/[0.06]">
          <div>Hostname</div>
          <div>Allowed emails</div>
          <div>Allowed domains</div>
          <div>Session</div>
          <div className="text-right">Actions</div>
        </div>
        {loading && apps.length === 0 ? (
          <div className="px-3 py-6 text-center text-[12px] text-zinc-500">Loading Access apps…</div>
        ) : filtered.length === 0 ? (
          <div className="px-3 py-6 text-center text-[12px] text-zinc-500">
            {search.trim() ? "No apps match." : apps.length === 0 ? "No Access apps yet. Protect a hostname above or from an app's Tunneling tab." : "No apps match."}
          </div>
        ) : (
          filtered.map((app) => {
            const editing = editingUid === app.uid;
            return (
              <div key={app.uid} className="border-b border-white/[0.04] last:border-0">
                <div className="grid grid-cols-[2fr_1fr_1fr_90px_140px] gap-2 px-3 py-2 items-center text-[12px] text-zinc-200 hover:bg-white/[0.02]">
                  <div className="font-mono truncate" title={app.domain}>{app.domain}</div>
                  <div className="text-zinc-300" title={app.allowed_emails.join(", ")}>
                    {app.allowed_emails.length === 0 ? (
                      <span className="text-zinc-600">—</span>
                    ) : (
                      <span className="text-[11px]">{app.allowed_emails.length} email{app.allowed_emails.length === 1 ? "" : "s"}</span>
                    )}
                  </div>
                  <div className="text-zinc-300" title={app.allowed_domains.join(", ")}>
                    {app.allowed_domains.length === 0 ? (
                      <span className="text-zinc-600">—</span>
                    ) : (
                      <span className="text-[11px]">{app.allowed_domains.map((d) => `@${d.replace(/^@/, "")}`).join(", ")}</span>
                    )}
                  </div>
                  <div className="text-[11px] text-zinc-500 font-mono">{app.session_duration}</div>
                  <div className="flex justify-end gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        setRowError(null);
                        setEditingUid(editing ? null : app.uid);
                      }}
                      className="px-2 py-0.5 text-[11px] rounded text-zinc-300 hover:text-zinc-100 hover:bg-white/[0.06] transition-colors"
                    >
                      {editing ? "Close" : "Edit"}
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        openExternalUrl("https://one.dash.cloudflare.com/?to=/:account/access/apps").catch(() => {})
                      }
                      className="px-2 py-0.5 text-[11px] rounded text-zinc-300 hover:text-zinc-100 hover:bg-white/[0.06] transition-colors"
                      title="Open in Cloudflare dashboard"
                    >
                      Open
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRemove(app)}
                      disabled={removingUid === app.uid}
                      className="px-2 py-0.5 text-[11px] rounded text-red-300 hover:text-red-200 hover:bg-red-500/[0.1] transition-colors disabled:opacity-40"
                    >
                      {removingUid === app.uid ? "…" : "Remove"}
                    </button>
                  </div>
                </div>
                {editing && (
                  <div className="px-3 pb-3 pt-1 bg-white/[0.01]">
                    <AccessPolicyEditor
                      key={app.uid}
                      initialEmails={app.allowed_emails}
                      initialDomains={app.allowed_domains}
                      saving={rowSaving}
                      error={rowError}
                      saveLabel="Update"
                      onSave={(emails, domains) => handleRowSave(app, emails, domains)}
                      onCancel={() => { setEditingUid(null); setRowError(null); }}
                      onValidationError={setRowError}
                    />
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
