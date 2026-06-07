import { useState } from "react";

/** Split a textarea blob (newline- or comma-separated) into trimmed,
 * non-empty entries. Shared by every Cloudflare Access editor surface. */
export function parseList(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

interface Props {
  /** Pre-fill the emails textarea. */
  initialEmails: string[];
  /** Pre-fill the email-domains textarea. */
  initialDomains: string[];
  saving: boolean;
  /** Error to surface above the buttons (validation or IPC failure). */
  error: string | null;
  /** Primary button label, e.g. "Enable Access" | "Update" | "Protect". */
  saveLabel: string;
  onSave: (emails: string[], domains: string[]) => void;
  /** Omit to hide the Cancel button (e.g. first-time enable with nothing to revert to). */
  onCancel?: () => void;
  /** Local validation message setter — lets the parent share one error slot. */
  onValidationError?: (message: string) => void;
}

/**
 * Presentational emails + email-domains editor for a single Cloudflare Access
 * policy. No IPC: the parent owns the token, the `cf_access_protect` call, and
 * any list refresh. Reused by the per-app panel (AppSettingsModal) and the
 * global Access section.
 */
export default function AccessPolicyEditor({
  initialEmails,
  initialDomains,
  saving,
  error,
  saveLabel,
  onSave,
  onCancel,
  onValidationError,
}: Props) {
  const [emails, setEmails] = useState(initialEmails.join("\n"));
  const [domains, setDomains] = useState(initialDomains.join("\n"));

  function handleSave() {
    const emailList = parseList(emails);
    const domainList = parseList(domains);
    if (emailList.length === 0 && domainList.length === 0) {
      onValidationError?.("Add at least one allowed email or domain.");
      return;
    }
    onSave(emailList, domainList);
  }

  return (
    <div className="space-y-2">
      <label className="block">
        <span className="text-[10px] text-zinc-500 block mb-1">
          Allowed emails <span className="text-zinc-700">(one per line or comma-separated)</span>
        </span>
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
        <span className="text-[10px] text-zinc-500 block mb-1">
          Allowed email-domains <span className="text-zinc-700">(everyone with that email suffix)</span>
        </span>
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
          {saving ? "Saving…" : saveLabel}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="px-3 py-1.5 text-[11.5px] rounded-md text-zinc-400 hover:text-zinc-200 transition-colors disabled:opacity-40"
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
