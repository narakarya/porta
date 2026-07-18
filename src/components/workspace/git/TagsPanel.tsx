import { useEffect, useRef, useState } from "react";
import type { App } from "../../../types";
import { gitTags, gitCreateTag, gitDeleteTag, type TagEntry } from "../../../lib/commands";
import { Button, Input, Spinner } from "../../ui";

/**
 * Tags tab — a "Create tag" control (name + optional message) on top of the
 * tag list. Each row is the tag name (mono) + its subject line (when
 * non-empty), with a Delete action. Delete swaps the row into an inline
 * confirm state rather than `window.confirm` — Tauri webview dialogs are
 * unreliable (project convention, see StashPanel's Drop confirm).
 */
export default function TagsPanel({ app }: { app: App }) {
  const [tags, setTags] = useState<TagEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [creating, setCreating] = useState(false);

  // Name of the tag whose Delete is in flight, and the name (if any) sitting
  // in the inline "Delete?" confirm state.
  const [busyName, setBusyName] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  function load() {
    if (!app.root_dir) return;
    setLoading(true);
    setError(null);
    gitTags(app.root_dir)
      .then((rows) => { if (mounted.current) setTags(rows); })
      .catch((e) => { if (mounted.current) setError(String(e)); })
      .finally(() => { if (mounted.current) setLoading(false); });
  }

  // Reset + reload whenever the app's repo root changes.
  useEffect(() => {
    setConfirmDelete(null);
    setBusyName(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.root_dir]);

  async function doCreate() {
    if (!app.root_dir || creating || name.trim() === "") return;
    setCreating(true);
    setError(null);
    try {
      await gitCreateTag(app.root_dir, name.trim(), message.trim() === "" ? undefined : message.trim());
      if (mounted.current) {
        setName("");
        setMessage("");
      }
      load();
    } catch (e) {
      if (mounted.current) setError(String(e));
    } finally {
      if (mounted.current) setCreating(false);
    }
  }

  async function doDelete(tagName: string) {
    if (!app.root_dir || busyName !== null) return;
    setBusyName(tagName);
    setError(null);
    setConfirmDelete(null);
    try {
      await gitDeleteTag(app.root_dir, tagName);
      load();
    } catch (e) {
      if (mounted.current) setError(String(e));
    } finally {
      if (mounted.current) setBusyName(null);
    }
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* Create-tag control. */}
      <div className="shrink-0 border-b border-subtle p-3 bg-surface-1 flex items-center gap-1.5">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !creating) doCreate(); }}
          placeholder="Tag name…"
          spellCheck={false}
          className="!py-1 font-mono"
        />
        <Input
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !creating) doCreate(); }}
          placeholder="Message (optional)…"
          spellCheck={false}
          className="!py-1"
        />
        <Button size="sm" loading={creating} disabled={!app.root_dir || name.trim() === ""} onClick={doCreate} className="shrink-0">
          Create tag
        </Button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto py-1">
        {error && (
          <pre className="shrink-0 text-[11px] font-mono text-bad whitespace-pre-wrap break-words max-h-32 overflow-y-auto rounded-control border border-subtle bg-surface-code px-2.5 py-2 m-2">{error}</pre>
        )}
        {loading ? (
          <div className="inline-flex items-center gap-2 px-3 py-3 text-[12px] text-ink-3">
            <Spinner size={12} /> Loading tags…
          </div>
        ) : tags.length === 0 ? (
          <div className="px-3 py-3 text-[12px] text-ink-3">No tags.</div>
        ) : (
          tags.map((t) => {
            const busy = busyName === t.name;
            const confirming = confirmDelete === t.name;
            return (
              <div
                key={t.name}
                className="mx-1 mb-0.5 flex items-center gap-2 px-2 py-1.5 rounded-control hover:bg-white/[0.04] transition-colors duration-fast"
              >
                <span className="shrink-0 font-mono text-[11px] text-ink-1">{t.name}</span>
                {t.subject && (
                  <span className="min-w-0 flex-1 truncate text-[12px] text-ink-3" title={t.subject}>
                    {t.subject}
                  </span>
                )}
                {!t.subject && <span className="flex-1" />}
                {busy ? (
                  <Spinner size={12} className="shrink-0" />
                ) : confirming ? (
                  <div className="shrink-0 flex items-center gap-1.5">
                    <span className="text-[11px] text-bad">Delete?</span>
                    <button
                      onClick={() => doDelete(t.name)}
                      className="text-[11px] font-medium text-bad hover:brightness-125 transition-colors duration-fast"
                    >
                      Confirm
                    </button>
                    <button
                      onClick={() => setConfirmDelete(null)}
                      className="text-[11px] text-ink-3 hover:text-ink-2 transition-colors duration-fast"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div className="shrink-0 flex items-center gap-1">
                    <button
                      onClick={() => setConfirmDelete(t.name)}
                      disabled={busyName !== null}
                      className="text-[11px] text-ink-2 hover:text-bad hover:bg-bad-bg rounded-control px-2 py-1 transition-colors duration-fast disabled:opacity-40 disabled:pointer-events-none"
                    >
                      Delete
                    </button>
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
