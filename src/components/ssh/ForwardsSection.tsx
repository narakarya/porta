import { useEffect, useState } from "react";
import { usePortaStore } from "../../store";
import type { SshPortForward } from "../../lib/commands";

type Props = { hostId: string | null };

const field =
  "bg-surface-input border border-subtle rounded-lg px-2.5 py-1.5 text-[12.5px] text-ink placeholder:text-ink-3 outline-none focus:border-[var(--accent)] transition-colors";

/** Blank rule for the inline editor. `local_port: 0` means "let the system
 *  pick", which is the friendlier default than guessing a port that might
 *  already be taken. */
function blank(hostId: string): SshPortForward {
  return {
    id: "",
    host_id: hostId,
    kind: "local",
    label: null,
    bind_address: "127.0.0.1",
    local_port: 0,
    remote_host: "127.0.0.1",
    remote_port: 0,
    auto_start: true,
    created_at: 0,
  };
}

/** Port-forward rules for one host, edited inside the host form.
 *
 *  Rules only — starting and stopping happens in the sidebar, where the live
 *  session is. A modal is the wrong place to put controls whose result you
 *  can't see while it's open. */
export default function ForwardsSection({ hostId }: Props) {
  const forwards = usePortaStore((s) => (hostId ? (s.sshForwards[hostId] ?? []) : []));
  const loadForwards = usePortaStore((s) => s.loadForwards);
  const addForward = usePortaStore((s) => s.addForward);
  const updateForward = usePortaStore((s) => s.updateForward);
  const deleteForward = usePortaStore((s) => s.deleteForward);

  const [draft, setDraft] = useState<SshPortForward | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (hostId) loadForwards(hostId).catch(() => {});
  }, [hostId, loadForwards]);

  // A forward needs a host_id, and a host that hasn't been saved has no id yet.
  // Say so rather than rendering an editor whose Save can't work.
  if (!hostId) {
    return (
      <div>
        <div className="text-[10px] uppercase tracking-wide text-ink-3 mb-1.5">Port forwards</div>
        <p className="text-[11px] text-ink-3">Save the host first, then reopen it to add forwards.</p>
      </div>
    );
  }

  async function save() {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      if (draft.id) await updateForward(draft);
      else await addForward(draft);
      setDraft(null);
    } catch (e) {
      // The backend validator owns the rules (privileged ports, empty target,
      // unsupported kinds); echo its message rather than paraphrasing it.
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-ink-3 mb-1.5">Port forwards</div>

      <div className="space-y-1">
        {forwards.length === 0 && !draft && (
          <p className="text-[11px] text-ink-3">
            No forwards yet. Add one to reach a service on the remote host from your machine.
          </p>
        )}

        {forwards.map((f) => (
          <div
            key={f.id}
            className="group flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-white/[0.04] transition-colors"
          >
            <button
              type="button"
              onClick={() => { setDraft(f); setError(null); }}
              className="flex-1 min-w-0 text-left"
            >
              <span className="block truncate text-[12.5px] text-ink">
                {f.label || `${f.remote_host}:${f.remote_port}`}
              </span>
              <span className="block truncate text-[11px] text-ink-3 font-mono mt-0.5">
                {f.local_port === 0 ? "auto" : `:${f.local_port}`} → {f.remote_host}:{f.remote_port}
                {!f.auto_start && <span className="font-sans"> · manual</span>}
              </span>
            </button>
            <button
              type="button"
              onClick={() => deleteForward(f).catch((e) => setError(String(e)))}
              title="Remove forward"
              aria-label="Remove forward"
              className="shrink-0 opacity-0 group-hover:opacity-100 w-6 h-6 flex items-center justify-center rounded-control text-ink-3 hover:text-bad transition-colors"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
                <path d="M3 3l6 6M9 3l-6 6" />
              </svg>
            </button>
          </div>
        ))}
      </div>

      {draft ? (
        <div className="mt-1.5 p-2 bg-surface-1 border border-subtle rounded-lg space-y-2">
          <input
            className={`${field} w-full`}
            placeholder="Name (optional, e.g. Postgres)"
            value={draft.label ?? ""}
            onChange={(e) => setDraft({ ...draft, label: e.target.value || null })}
          />
          <div className="flex items-center gap-2">
            <input
              className={`${field} w-20 shrink-0`}
              placeholder="auto"
              title="Local port — leave empty to let the system pick"
              value={draft.local_port === 0 ? "" : String(draft.local_port)}
              onChange={(e) => setDraft({ ...draft, local_port: Number(e.target.value) || 0 })}
            />
            <span className="shrink-0 text-ink-3 text-[12px]">→</span>
            <input
              className={`${field} flex-1 min-w-0`}
              placeholder="Remote host"
              value={draft.remote_host}
              onChange={(e) => setDraft({ ...draft, remote_host: e.target.value })}
            />
            <input
              className={`${field} w-20 shrink-0`}
              placeholder="Port"
              value={draft.remote_port === 0 ? "" : String(draft.remote_port)}
              onChange={(e) => setDraft({ ...draft, remote_port: Number(e.target.value) || 0 })}
            />
          </div>
          <label className="flex items-center gap-2 text-[11.5px] text-ink-2 cursor-pointer">
            <input
              type="checkbox"
              checked={draft.auto_start}
              onChange={(e) => setDraft({ ...draft, auto_start: e.target.checked })}
              className="accent-[var(--accent)]"
            />
            Open automatically when this host connects
          </label>

          {error && <p className="text-[11px] text-bad break-words">{error}</p>}

          <div className="flex items-center gap-2">
            <p className="flex-1 min-w-0 text-[10.5px] text-ink-3 leading-snug">
              Remote host is resolved on the server, so 127.0.0.1 means the remote machine itself.
            </p>
            <button
              type="button"
              className="px-2.5 py-1 text-[11.5px] text-ink-2 hover:text-ink transition-colors"
              onClick={() => { setDraft(null); setError(null); }}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={saving}
              className="px-2.5 py-1 text-[11.5px] font-medium bg-accent text-white rounded-control disabled:opacity-40 transition-colors"
              onClick={save}
            >
              {saving ? "Saving…" : draft.id ? "Update" : "Add"}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => { setDraft(blank(hostId)); setError(null); }}
          className="mt-1.5 text-[11.5px] text-ink-3 hover:text-ink-2 transition-colors"
        >
          + Add forward
        </button>
      )}

      <p className="mt-2 text-[11px] text-ink-3 leading-snug">
        Porta binds these on 127.0.0.1 and closes them when the session ends.
      </p>
    </div>
  );
}
