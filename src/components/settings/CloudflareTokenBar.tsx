import { useEffect, useRef, useState } from "react";
import { setCfApiToken, openExternalUrl } from "../../lib/commands";

// Required scopes — kept here so the popover stays in sync with what the rest
// of the CF integration actually calls.
const REQUIRED_SCOPES: { group: string; items: string[] }[] = [
  { group: "Zone", items: ["Zone:Read", "Zone Settings:Edit", "DNS:Edit", "Cache Purge", "Email Routing Rules:Edit"] },
  { group: "Account", items: ["Access: Apps:Edit", "Email Routing Addresses:Edit", "Account Settings:Read"] },
];

interface Props {
  /** Current saved token. `null` = not loaded yet, `""` = unset. */
  token: string | null;
  /** Called after a save / clear so the parent can bump tokenVersion and
   * trigger sibling tabs (DNS, Tunnels, Access) to re-fetch with the new
   * value. The parent should also update its own state from the new token. */
  onChange: (next: string) => void;
}

/** Compact API-token panel that lives above the Cloudflare sub-tabs. Why
 * here and not buried in Tunnels: every CF tab depends on this token, so
 * editing it once at the top makes the dependency obvious and saves the
 * user from hunting for "where do I set the token". */
export default function CloudflareTokenBar({ token, onChange }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scopesOpen, setScopesOpen] = useState(false);
  const scopesRef = useRef<HTMLDivElement>(null);

  // Close popover on outside click / Escape — same pattern as the tunnel menu.
  useEffect(() => {
    if (!scopesOpen) return;
    function onDown(e: MouseEvent) {
      if (!scopesRef.current?.contains(e.target as Node)) setScopesOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setScopesOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [scopesOpen]);

  if (token === null) {
    // Skeleton while we load the persisted value — same height as the resting
    // state so the tab area below doesn't shift.
    return <div className="h-[42px] rounded-card bg-surface-1 border border-subtle animate-pulse" />;
  }

  const hasToken = token.length > 0;
  const showInput = editing || !hasToken;

  async function save() {
    const trimmed = draft.trim();
    setSaving(true);
    setError(null);
    try {
      await setCfApiToken(trimmed);
      onChange(trimmed);
      setEditing(false);
      setDraft("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 px-3 py-2.5 rounded-card bg-surface-1 border border-subtle">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1.5">
          <span className={`h-1.5 w-1.5 rounded-full ${hasToken ? "bg-ok" : "bg-white/[0.14]"}`} />
          <span className="text-[11.5px] font-medium text-ink">API Token</span>
          {/* Info trigger — always available, even when token is set, so users
              who want to rotate or check required scopes can find it without
              having to clear the token first. */}
          <div className="relative" ref={scopesRef}>
            <button
              type="button"
              onClick={() => setScopesOpen((v) => !v)}
              className="inline-flex items-center justify-center w-4 h-4 rounded-full text-ink-3 hover:text-ink hover:bg-white/[0.06] transition-colors"
              aria-label="Token info — required scopes and create-token link"
              title="Required scopes & create token"
            >
              <svg width="10" height="10" viewBox="0 0 11 11" fill="none">
                <circle cx="5.5" cy="5.5" r="4.5" stroke="currentColor" strokeWidth="1.1" />
                <path d="M5.5 4.7v2.4" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
                <circle cx="5.5" cy="3.4" r="0.5" fill="currentColor" />
              </svg>
            </button>
            {scopesOpen && (
              <div className="absolute left-0 top-full mt-1.5 z-50 w-[300px] bg-surface-2 border border-strong rounded-card shadow-xl p-3 text-[11px]">
                <p className="text-ink-2 mb-2 leading-snug">
                  Token needs these scopes for full access:
                </p>
                <div className="flex flex-col gap-2.5 mb-3">
                  {REQUIRED_SCOPES.map((bucket) => (
                    <div key={bucket.group}>
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-3 mb-1">
                        {bucket.group}
                      </p>
                      <ul className="flex flex-col gap-0.5">
                        {bucket.items.map((scope) => (
                          <li key={scope} className="font-mono text-[10.5px] text-ink-2 flex items-start gap-1.5">
                            <span className="text-ok mt-0.5 shrink-0">✓</span>
                            <span>{scope}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
                <div className="pt-2 border-t border-subtle">
                  <button
                    type="button"
                    onClick={() => {
                      openExternalUrl("https://dash.cloudflare.com/profile/api-tokens").catch(() => {});
                      setScopesOpen(false);
                    }}
                    className="inline-flex items-center gap-1 text-[11px] text-accent hover:opacity-90 transition-colors"
                  >
                    Create token on Cloudflare
                    <svg width="9" height="9" viewBox="0 0 11 11" fill="none">
                      <path d="M4.5 2H3a.5.5 0 00-.5.5v6a.5.5 0 00.5.5h5a.5.5 0 00.5-.5V7M6.5 2H9M9 2v2.5M9 2L5.5 5.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {!showInput && hasToken && (
          <>
            <code className="font-mono text-[10.5px] text-ink-3 px-1.5 py-0.5 rounded bg-white/[0.04]">
              {token.slice(0, 8)}…{token.slice(-4)}
            </code>
            <button
              type="button"
              onClick={() => { setDraft(token); setEditing(true); }}
              className="ml-auto text-[10.5px] text-ink-3 hover:text-ink transition-colors"
            >
              Edit
            </button>
          </>
        )}

        {showInput && (
          <div className="flex gap-2 flex-1 min-w-[280px]">
            <input
              type="password"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Paste Cloudflare API token"
              spellCheck={false}
              autoComplete="off"
              className="flex-1 bg-surface-input border border-subtle rounded-control px-2.5 py-1 text-[11.5px] font-mono text-ink outline-none focus:border-[rgba(96,165,250,0.5)] transition-colors"
            />
            <button
              type="button"
              onClick={save}
              disabled={saving || (!draft.trim() && !hasToken)}
              className="px-3 py-1 text-[11px] font-medium bg-accent hover:opacity-90 text-white rounded-control disabled:opacity-40 transition-colors shrink-0 inline-flex items-center gap-1.5"
            >
              {saving && <span className="inline-block h-3 w-3 rounded-full border-2 border-white/30 border-t-white animate-spin" />}
              {saving ? "Saving…" : "Save"}
            </button>
            {hasToken && (
              <button
                type="button"
                onClick={() => { setEditing(false); setDraft(""); setError(null); }}
                disabled={saving}
                className="px-2.5 py-1 text-[11px] text-ink-2 hover:text-ink transition-colors shrink-0 disabled:opacity-40"
              >
                Cancel
              </button>
            )}
          </div>
        )}
      </div>

      {!hasToken && !editing && (
        <p className="text-[10px] text-ink-3">
          Required for DNS, Tunnels, Access, and Email features. Click the
          <span className="inline-block mx-1 align-middle">
            <svg width="9" height="9" viewBox="0 0 11 11" fill="none" className="inline-block text-ink-2">
              <circle cx="5.5" cy="5.5" r="4.5" stroke="currentColor" strokeWidth="1.1" />
              <path d="M5.5 4.7v2.4" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
              <circle cx="5.5" cy="3.4" r="0.5" fill="currentColor" />
            </svg>
          </span>
          icon above for required scopes & a link to create one.
        </p>
      )}

      {error && (
        <p className="text-[10px] text-bad font-mono whitespace-pre-wrap break-words">{error}</p>
      )}
    </div>
  );
}
