import { useEffect, useState } from "react";
import { cfAccessGetApp, cfAccessProtect, cfAccessUnprotect, type AccessAppInfo } from "../../lib/commands";

interface Props {
  /** Public hostname being protected (e.g. "myapp.example.com"). */
  hostname: string;
  /** Cloudflare API token. Null disables the panel and shows a setup hint. */
  cfToken: string | null;
}

function parseList(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Preset-driven Cloudflare Access editor for a single hostname. Talks to the
 * `cf_access_*` Tauri commands; no shared state with the rest of the modal.
 *
 * Scope intentionally narrow: emails + email-domains, single allow policy.
 * Anything richer (Google OAuth, IP rules, country gating, service tokens)
 * lives in the Cloudflare dashboard — we surface a deep-link instead of
 * cloning that surface here.
 */
export default function CloudflareAccessPanel({ hostname, cfToken }: Props) {
  const trimmedHost = hostname.trim();
  const [accessApp, setAccessApp] = useState<AccessAppInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [emails, setEmails] = useState("");
  const [domains, setDomains] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Debounce the hostname before fetching — every keystroke would otherwise
  // fire a `cf_access_get_app` IPC and rerender this panel mid-typing, which
  // looked like the panel was "constantly reloading" while the user was just
  // editing a subdomain. Empty bypasses the debounce so clearing the input
  // hides the panel instantly.
  const [debouncedHost, setDebouncedHost] = useState(trimmedHost);
  useEffect(() => {
    if (!trimmedHost) {
      setDebouncedHost("");
      return;
    }
    const t = setTimeout(() => setDebouncedHost(trimmedHost), 400);
    return () => clearTimeout(t);
  }, [trimmedHost]);

  // Fetch the current Access app whenever the *debounced* hostname (or token)
  // changes. The render keeps the previous result during typing so the panel
  // doesn't flash empty between keystrokes.
  useEffect(() => {
    if (!debouncedHost || !cfToken) {
      setAccessApp(null);
      setEditMode(false);
      setEmails("");
      setDomains("");
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    cfAccessGetApp(cfToken, debouncedHost)
      .then((info) => {
        if (cancelled) return;
        setAccessApp(info);
        if (info) {
          setEmails(info.allowed_emails.join("\n"));
          setDomains(info.allowed_domains.join("\n"));
        } else {
          setEmails("");
          setDomains("");
        }
        setEditMode(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setAccessApp(null);
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [debouncedHost, cfToken]);

  async function handleSave() {
    if (!cfToken || !trimmedHost) return;
    const emailList = parseList(emails);
    const domainList = parseList(domains);
    if (emailList.length === 0 && domainList.length === 0) {
      setError("Add at least one allowed email or domain.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const info = await cfAccessProtect(cfToken, trimmedHost, emailList, domainList);
      setAccessApp(info);
      setEmails(info.allowed_emails.join("\n"));
      setDomains(info.allowed_domains.join("\n"));
      setEditMode(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove() {
    if (!cfToken || !trimmedHost) return;
    if (!window.confirm(`Remove Cloudflare Access protection from ${trimmedHost}?`)) return;
    setSaving(true);
    setError(null);
    try {
      await cfAccessUnprotect(cfToken, trimmedHost);
      setAccessApp(null);
      setEmails("");
      setDomains("");
      setEditMode(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  if (!trimmedHost) return null;

  if (!cfToken) {
    return (
      <p className="text-[10.5px] text-zinc-600 px-1">
        Add a Cloudflare API token in <span className="text-zinc-400">Settings → Tunnels</span> to enable Cloudflare Access (login wall).
      </p>
    );
  }

  const showViewMode = !!accessApp && !editMode;

  return (
    <div className="flex flex-col gap-3 mt-2 pt-4 border-t border-white/[0.06]">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 inline-block h-2 w-2 rounded-full bg-violet-400/70 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[12px] font-medium text-zinc-200">Cloudflare Access</span>
            {accessApp && (
              <span className="text-[9.5px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 leading-none">
                Protected
              </span>
            )}
            {loading && (
              <span className="inline-block h-3 w-3 rounded-full border-2 border-violet-400/30 border-t-violet-300 animate-spin" />
            )}
          </div>
          <p className="text-[10.5px] text-zinc-500 mt-0.5 break-words">
            Require login before users can reach <span className="font-mono text-zinc-400">{trimmedHost}</span>. Identity: one-time PIN via email.
          </p>
        </div>
      </div>

      {showViewMode && (
        <div className="space-y-2">
          {accessApp.allowed_emails.length > 0 && (
            <div>
              <p className="text-[10px] text-zinc-500 mb-1">Allowed emails</p>
              <div className="flex flex-wrap gap-1">
                {accessApp.allowed_emails.map((e) => (
                  <span key={e} className="font-mono text-[10.5px] px-1.5 py-0.5 rounded bg-white/[0.05] text-zinc-300 border border-white/[0.06]">
                    {e}
                  </span>
                ))}
              </div>
            </div>
          )}
          {accessApp.allowed_domains.length > 0 && (
            <div>
              <p className="text-[10px] text-zinc-500 mb-1">Allowed email-domains</p>
              <div className="flex flex-wrap gap-1">
                {accessApp.allowed_domains.map((d) => (
                  <span key={d} className="font-mono text-[10.5px] px-1.5 py-0.5 rounded bg-white/[0.05] text-zinc-300 border border-white/[0.06]">
                    @{d.replace(/^@/, "")}
                  </span>
                ))}
              </div>
            </div>
          )}
          <p className="text-[10px] text-zinc-600 leading-snug">
            Session: {accessApp.session_duration}. Need IP rules, OAuth, or country gating? Manage advanced policies in the{" "}
            <a
              href={`https://one.dash.cloudflare.com/?to=/:account/access/apps`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-violet-300 hover:text-violet-200 underline-offset-2 hover:underline"
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
              className="px-3 py-1.5 text-[11.5px] rounded-md bg-white/[0.06] hover:bg-white/[0.12] text-zinc-200 transition-colors disabled:opacity-40"
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
        <div className="space-y-2">
          <label className="block">
            <span className="text-[10px] text-zinc-500 block mb-1">Allowed emails <span className="text-zinc-700">(one per line or comma-separated)</span></span>
            <textarea
              spellCheck={false}
              value={emails}
              onChange={(e) => setEmails(e.target.value)}
              rows={2}
              className="w-full bg-[#111113] border border-white/[0.08] rounded-lg px-3 py-2 text-[12px] text-zinc-100 outline-none focus:border-violet-500/50 transition-colors font-mono"
              placeholder="you@example.com"
            />
          </label>
          <label className="block">
            <span className="text-[10px] text-zinc-500 block mb-1">Allowed email-domains <span className="text-zinc-700">(everyone with that email suffix)</span></span>
            <textarea
              spellCheck={false}
              value={domains}
              onChange={(e) => setDomains(e.target.value)}
              rows={2}
              className="w-full bg-[#111113] border border-white/[0.08] rounded-lg px-3 py-2 text-[12px] text-zinc-100 outline-none focus:border-violet-500/50 transition-colors font-mono"
              placeholder="narakarya.com"
            />
          </label>
          {error && (
            <p className="text-[11px] text-red-400 whitespace-pre-wrap break-words">{error}</p>
          )}
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 text-[12.5px] font-medium rounded-lg bg-violet-500/20 hover:bg-violet-500/30 text-violet-100 border border-violet-500/40 transition-colors disabled:opacity-40 inline-flex items-center gap-2"
            >
              {saving && <span className="inline-block h-3 w-3 rounded-full border-2 border-violet-400/30 border-t-violet-300 animate-spin" />}
              {saving ? "Saving…" : accessApp ? "Update" : "Enable Access"}
            </button>
            {accessApp && (
              <button
                type="button"
                onClick={() => {
                  setEditMode(false);
                  setEmails(accessApp.allowed_emails.join("\n"));
                  setDomains(accessApp.allowed_domains.join("\n"));
                  setError(null);
                }}
                className="px-3 py-1.5 text-[11.5px] rounded-md text-zinc-400 hover:text-zinc-200 transition-colors"
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
