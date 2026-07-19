import { useEffect, useRef, useState } from "react";
import type { App } from "../../../types";
import {
  gitCreateTag,
  gitDeleteRemoteTag,
  gitDeleteTag,
  gitPushTag,
  gitTags,
  type TagEntry,
} from "../../../lib/commands";
import { Button, Input, Select, Spinner } from "../../ui";

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
  const [annotated, setAnnotated] = useState(false);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);

  // Name of the tag whose Delete is in flight, and the name (if any) sitting
  // in the inline "Delete?" confirm state.
  const [busyName, setBusyName] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ name: string; remote: boolean } | null>(null);

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
      await gitCreateTag(
        app.root_dir,
        name.trim(),
        annotated ? message.trim() : undefined,
      );
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

  async function doDelete(tagName: string, remote: boolean) {
    if (!app.root_dir || busyName !== null) return;
    setBusyName(tagName);
    setError(null);
    setConfirmDelete(null);
    try {
      if (remote) await gitDeleteRemoteTag(app.root_dir, tagName);
      else await gitDeleteTag(app.root_dir, tagName);
      load();
    } catch (e) {
      if (mounted.current) setError(String(e));
    } finally {
      if (mounted.current) setBusyName(null);
    }
  }

  async function doPush(tagName: string) {
    if (!app.root_dir || busyName !== null) return;
    setBusyName(tagName);
    setError(null);
    try {
      await gitPushTag(app.root_dir, tagName);
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
        <Select
          value={annotated ? "annotated" : "lightweight"}
          onChange={(event) => setAnnotated(event.target.value === "annotated")}
          className="select-base !w-28 !py-1 !text-[11px]"
        >
          <option value="lightweight">Lightweight</option>
          <option value="annotated">Annotated</option>
        </Select>
        {annotated && (
          <Input
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !creating) doCreate(); }}
            placeholder="Annotation message…"
            spellCheck={false}
            className="!py-1"
          />
        )}
        <Button
          size="sm"
          loading={creating}
          disabled={!app.root_dir || name.trim() === "" || (annotated && message.trim() === "")}
          onClick={doCreate}
          className="shrink-0"
        >
          Create tag
        </Button>
      </div>

      <div className="shrink-0 border-b border-subtle p-2 bg-surface-1">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search tags…"
          className="!py-1"
        />
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
          tags
            .filter((t) => {
              const q = query.trim().toLowerCase();
              return q === "" || `${t.name} ${t.subject}`.toLowerCase().includes(q);
            })
            .map((t) => {
            const busy = busyName === t.name;
            const confirming = confirmDelete?.name === t.name;
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
                    <span className="text-[11px] text-bad">
                      Delete {confirmDelete.remote ? "on origin" : "locally"}?
                    </span>
                    <button
                      onClick={() => doDelete(t.name, confirmDelete.remote)}
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
                      onClick={() => doPush(t.name)}
                      disabled={busyName !== null}
                      className="text-[11px] text-ink-2 hover:text-ink hover:bg-white/[0.06] rounded-control px-2 py-1 transition-colors duration-fast disabled:opacity-40 disabled:pointer-events-none"
                    >
                      Push
                    </button>
                    <button
                      onClick={() => setConfirmDelete({ name: t.name, remote: false })}
                      disabled={busyName !== null}
                      className="text-[11px] text-ink-2 hover:text-bad hover:bg-bad-bg rounded-control px-2 py-1 transition-colors duration-fast disabled:opacity-40 disabled:pointer-events-none"
                    >
                      Delete
                    </button>
                    <button
                      onClick={() => setConfirmDelete({ name: t.name, remote: true })}
                      disabled={busyName !== null}
                      className="text-[11px] text-ink-2 hover:text-bad hover:bg-bad-bg rounded-control px-2 py-1 transition-colors duration-fast disabled:opacity-40 disabled:pointer-events-none"
                    >
                      Delete remote
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
