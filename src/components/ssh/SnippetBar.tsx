import { useEffect, useMemo, useRef, useState } from "react";
import { usePortaStore } from "../../store";
import type { SshSnippet } from "../../lib/commands";

type Props = { hostId: string | null; sessionReady: boolean };

const field =
  "bg-surface-input border border-subtle rounded-lg px-2.5 py-1.5 text-[12.5px] text-ink placeholder:text-ink-3 outline-none focus:border-[var(--accent)] transition-colors";

function blank(hostId: string | null, scoped: boolean): SshSnippet {
  return {
    id: "",
    label: "",
    command: "",
    host_id: scoped ? hostId : null,
    created_at: 0,
    last_used_at: null,
  };
}

/** Saved commands for the active session, in a popover off the tab strip.
 *
 *  Running one writes it into the PTY, so output lands in the scrollback the
 *  user is already reading and anything interactive still prompts normally. */
export default function SnippetBar({ hostId, sessionReady }: Props) {
  const snippets = usePortaStore((s) => s.sshSnippets);
  const runSnippet = usePortaStore((s) => s.runSnippet);
  const addSnippet = usePortaStore((s) => s.addSnippet);
  const updateSnippet = usePortaStore((s) => s.updateSnippet);
  const deleteSnippet = usePortaStore((s) => s.deleteSnippet);
  const notifyError = usePortaStore((s) => s.notifyError);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<SshSnippet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);

  // Globals plus this host's own. Ordering comes from the backend so the
  // popover and any other consumer can't disagree about "most recent".
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return snippets
      .filter((s) => s.host_id === null || s.host_id === hostId)
      .filter((s) => !q || `${s.label} ${s.command}`.toLowerCase().includes(q));
  }, [snippets, hostId, query]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        setDraft(null);
      }
    };
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setDraft(null);
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  async function run(s: SshSnippet) {
    try {
      await runSnippet(s);
      setOpen(false);
    } catch (e) {
      notifyError(`Couldn't run "${s.label}"`, e);
    }
  }

  async function save() {
    if (!draft) return;
    setError(null);
    try {
      if (draft.id) await updateSnippet(draft);
      else await addSnippet(draft);
      setDraft(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        title="Snippets"
        aria-label="Snippets"
        className={`flex items-center justify-center w-6 h-6 rounded-md transition-colors ${
          open ? "text-ink bg-white/[0.08]" : "text-ink-3 hover:text-ink hover:bg-white/[0.04]"
        }`}
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 5.5 6.5 8 4 10.5" />
          <path d="M8.5 10.5H12" />
          <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-7 z-50 w-80 p-2 bg-surface-2 border border-strong rounded-card shadow-xl shadow-black/40">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search snippets…"
            className={`${field} w-full mb-1.5`}
          />

          {!sessionReady && (
            <p className="px-1 pb-1.5 text-[11px] text-warn">
              No live session — connect first to run one.
            </p>
          )}

          <div className="max-h-64 overflow-y-auto -mx-1 px-1">
            {visible.length === 0 && (
              <p className="px-1 py-2 text-[11.5px] text-ink-3">
                {snippets.length === 0
                  ? "No snippets yet. Save a command you keep retyping."
                  : "No snippet matches that."}
              </p>
            )}
            {visible.map((s) => (
              <div
                key={s.id}
                className="group/sn flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-white/[0.05] transition-colors"
              >
                <button
                  type="button"
                  disabled={!sessionReady}
                  onClick={() => run(s)}
                  className="flex-1 min-w-0 text-left disabled:opacity-45"
                  title={sessionReady ? `Run: ${s.command}` : "Connect to a host first"}
                >
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[12.5px] text-ink">{s.label}</span>
                    {s.host_id && (
                      <span className="shrink-0 text-[10px] text-ink-3">this host</span>
                    )}
                  </span>
                  <span className="block truncate text-[11px] text-ink-3 font-mono mt-0.5">
                    {s.command}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => { setDraft(s); setError(null); }}
                  title="Edit snippet"
                  aria-label="Edit snippet"
                  className="shrink-0 opacity-0 group-hover/sn:opacity-100 w-5 h-5 flex items-center justify-center rounded-control text-ink-3 hover:text-ink transition-colors"
                >
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M11.5 2.8a1.1 1.1 0 0 1 1.6 1.6L5.5 12 3 13l1-2.5z" />
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={() => deleteSnippet(s.id).catch((e) => setError(String(e)))}
                  title="Delete snippet"
                  aria-label="Delete snippet"
                  className="shrink-0 opacity-0 group-hover/sn:opacity-100 w-5 h-5 flex items-center justify-center rounded-control text-ink-3 hover:text-bad transition-colors"
                >
                  <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
                    <path d="M3 3l6 6M9 3l-6 6" />
                  </svg>
                </button>
              </div>
            ))}
          </div>

          {draft ? (
            <div className="mt-1.5 pt-1.5 border-t border-subtle space-y-2">
              <input
                className={`${field} w-full`}
                placeholder="Name (e.g. Tail app log)"
                value={draft.label}
                onChange={(e) => setDraft({ ...draft, label: e.target.value })}
              />
              <textarea
                className={`${field} w-full font-mono resize-none`}
                rows={2}
                placeholder="Command"
                value={draft.command}
                onChange={(e) => setDraft({ ...draft, command: e.target.value })}
              />
              {hostId && (
                <label className="flex items-center gap-2 text-[11.5px] text-ink-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={draft.host_id !== null}
                    onChange={(e) => setDraft({ ...draft, host_id: e.target.checked ? hostId : null })}
                    className="accent-[var(--accent)]"
                  />
                  Only on this host
                </label>
              )}
              {error && <p className="text-[11px] text-bad break-words">{error}</p>}
              <div className="flex justify-end gap-2">
                <button
                  className="px-2.5 py-1 text-[11.5px] text-ink-2 hover:text-ink transition-colors"
                  onClick={() => { setDraft(null); setError(null); }}
                >
                  Cancel
                </button>
                <button
                  className="px-2.5 py-1 text-[11.5px] font-medium bg-accent text-white rounded-control transition-colors"
                  onClick={save}
                >
                  {draft.id ? "Update" : "Save"}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => { setDraft(blank(hostId, false)); setError(null); }}
              className="mt-1.5 px-1 text-[11.5px] text-ink-3 hover:text-ink-2 transition-colors"
            >
              + New snippet
            </button>
          )}
        </div>
      )}
    </div>
  );
}
