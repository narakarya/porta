import { useEffect, useRef, useState } from "react";
import { cfAccessGetApp, cfAccessProtect, cfAccessUnprotect, type AccessAppInfo } from "../../lib/commands";
import AccessPolicyEditor from "../settings/AccessPolicyEditor";

interface Props {
  /** Public hostname that's already been SAVED for this app
   * (`app.tunnel_custom_hostname`). The only value the panel fetches against —
   * never the live input — so typing a subdomain triggers no network calls. */
  savedHostname: string;
  /** Live hostname input. Used only to detect the "you've edited but not saved"
   * state; never fetched. */
  liveHostname: string;
  /** Cloudflare API token. Null disables the panel and shows a setup hint. */
  cfToken: string | null;
}

/**
 * Collapsible Cloudflare Access editor for a single SAVED hostname. Talks to the
 * `cf_access_*` Tauri commands. Decoupled from the tunnel form: it keys off the
 * committed hostname and only fetches when expanded, so editing the subdomain
 * field no longer spins this panel.
 *
 * Scope intentionally narrow: emails + email-domains, single allow policy.
 * Anything richer (Google OAuth, IP rules, country gating, service tokens)
 * lives in the Cloudflare dashboard — we surface a deep-link instead of
 * cloning that surface here.
 */
export default function CloudflareAccessPanel({ savedHostname, liveHostname, cfToken }: Props) {
  const saved = savedHostname.trim();
  const dirty = liveHostname.trim() !== saved;

  const [open, setOpen] = useState(false);
  const [accessApp, setAccessApp] = useState<AccessAppInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Hostname we last successfully fetched, so re-expanding the same host skips
  // a redundant list call but a new saved host always refetches.
  const loadedFor = useRef<string | null>(null);

  // Reset cache when the saved hostname changes (e.g. user saved a new host).
  useEffect(() => {
    loadedFor.current = null;
    setAccessApp(null);
    setEditMode(false);
    setError(null);
  }, [saved]);

  // Lazy fetch: only when expanded, with a saved host + token, and not already
  // loaded for this host. Nothing here watches the live input.
  useEffect(() => {
    if (!open || !saved || !cfToken) return;
    if (loadedFor.current === saved) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    cfAccessGetApp(cfToken, saved)
      .then((info) => {
        if (cancelled) return;
        setAccessApp(info);
        setEditMode(false);
        loadedFor.current = saved;
      })
      .catch((e) => {
        if (cancelled) return;
        setAccessApp(null);
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, saved, cfToken]);

  async function handleSave(emailList: string[], domainList: string[]) {
    if (!cfToken || !saved) return;
    setSaving(true);
    setError(null);
    try {
      const info = await cfAccessProtect(cfToken, saved, emailList, domainList);
      setAccessApp(info);
      loadedFor.current = saved;
      setEditMode(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove() {
    if (!cfToken || !saved) return;
    if (!window.confirm(`Remove Cloudflare Access protection from ${saved}?`)) return;
    setSaving(true);
    setError(null);
    try {
      await cfAccessUnprotect(cfToken, saved);
      setAccessApp(null);
      setEditMode(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const wrap = (children: React.ReactNode) => (
    <div className="mt-2 pt-4 border-t border-subtle">{children}</div>
  );

  // 1. No token → setup hint.
  if (!cfToken) {
    return wrap(
      <p className="text-[10.5px] text-ink-3 px-1">
        Add a Cloudflare API token in <span className="text-ink-2">Settings → Cloudflare → Tunnels</span> to enable Cloudflare Access (login wall).
      </p>
    );
  }

  // 2. No saved hostname yet → static hint, no fetch.
  if (!saved) {
    return wrap(
      <p className="text-[10.5px] text-ink-3 px-1">
        Save a named-tunnel hostname first to protect it with Cloudflare Access (login wall).
      </p>
    );
  }

  // 3. Saved host exists but the input was edited away → ask to save first.
  if (dirty) {
    return wrap(
      <p className="text-[10.5px] text-amber-300/80 px-1">
        You changed the hostname. Save the tunnel config to manage Cloudflare Access for{" "}
        <span className="font-mono text-amber-200">{saved}</span>.
      </p>
    );
  }

  // 4. Saved host, not dirty → collapsible Access section.
  const showViewMode = !!accessApp && !editMode;

  return (
    <div className="mt-2 pt-4 border-t border-subtle">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-start gap-3 text-left group"
      >
        <span className="mt-0.5 inline-block h-2 w-2 rounded-full bg-[rgba(96,165,250,0.70)] shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[12px] font-medium text-ink group-hover:text-ink">Cloudflare Access</span>
            {accessApp ? (
              <span className="text-[9.5px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 leading-none">
                Protected
              </span>
            ) : loadedFor.current === saved ? (
              <span className="text-[9.5px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-surface-2 text-ink-3 border border-subtle leading-none">
                Unprotected
              </span>
            ) : null}
            {loading && (
              <span className="inline-block h-3 w-3 rounded-full border-2 border-[rgba(96,165,250,0.30)] border-t-accent animate-spin" />
            )}
          </div>
          <p className="text-[10.5px] text-ink-3 mt-0.5 break-words">
            Require login before users can reach <span className="font-mono text-ink-2">{saved}</span>. Identity: one-time PIN via email.
          </p>
        </div>
        <span className={`mt-0.5 text-ink-3 transition-transform ${open ? "rotate-90" : ""}`}>›</span>
      </button>

      {open && (
        <div className="mt-3 pl-5">
          {error && !showViewMode && !editMode && (
            <p className="text-[11px] text-red-400 whitespace-pre-wrap break-words mb-2">{error}</p>
          )}

          {showViewMode && (
            <div className="space-y-2">
              {accessApp.allowed_emails.length > 0 && (
                <div>
                  <p className="text-[10px] text-ink-3 mb-1">Allowed emails</p>
                  <div className="flex flex-wrap gap-1">
                    {accessApp.allowed_emails.map((e) => (
                      <span key={e} className="font-mono text-[10.5px] px-1.5 py-0.5 rounded bg-surface-2 text-ink-2 border border-subtle">
                        {e}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {accessApp.allowed_domains.length > 0 && (
                <div>
                  <p className="text-[10px] text-ink-3 mb-1">Allowed email-domains</p>
                  <div className="flex flex-wrap gap-1">
                    {accessApp.allowed_domains.map((d) => (
                      <span key={d} className="font-mono text-[10.5px] px-1.5 py-0.5 rounded bg-surface-2 text-ink-2 border border-subtle">
                        @{d.replace(/^@/, "")}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              <p className="text-[10px] text-ink-3 leading-snug">
                Session: {accessApp.session_duration}. Need IP rules, OAuth, or country gating? Manage advanced policies in the{" "}
                <a
                  href={`https://one.dash.cloudflare.com/?to=/:account/access/apps`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent-ink hover:text-accent-ink underline-offset-2 hover:underline"
                >
                  Cloudflare Zero Trust dashboard
                </a>
                .
              </p>
              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setEditMode(true)}
                  disabled={saving}
                  className="px-3 py-1.5 text-[11.5px] rounded-md bg-surface-2 hover:bg-white/[0.12] text-ink transition-colors disabled:opacity-40"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={handleRemove}
                  disabled={saving}
                  className="px-3 py-1.5 text-[11.5px] rounded-md bg-red-500/[0.1] hover:bg-red-500/[0.18] text-red-300 transition-colors disabled:opacity-40 inline-flex items-center gap-1.5"
                >
                  {saving && <span className="inline-block h-3 w-3 rounded-full border-2 border-red-400/30 border-t-red-300 animate-spin" />}
                  Remove
                </button>
              </div>
            </div>
          )}

          {!showViewMode && !loading && (
            <AccessPolicyEditor
              key={`${saved}:${editMode}`}
              initialEmails={accessApp?.allowed_emails ?? []}
              initialDomains={accessApp?.allowed_domains ?? []}
              saving={saving}
              error={error}
              saveLabel={accessApp ? "Update" : "Enable Access"}
              onSave={handleSave}
              onCancel={accessApp ? () => { setEditMode(false); setError(null); } : undefined}
              onValidationError={setError}
            />
          )}
        </div>
      )}
    </div>
  );
}
