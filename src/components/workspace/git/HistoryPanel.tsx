import { useEffect, useRef, useState } from "react";
import type { App } from "../../../types";
import { gitLog, gitShow, type CommitEntry } from "../../../lib/commands";
import { Spinner } from "../../ui";
import { DiffLines } from "./diffLines";

const PAGE_SIZE = 50;

/** Short relative time (e.g. "3h ago") for a commit's ISO-8601 date; falls
 * back to a locale date string once it's more than ~30 days old. */
function relativeDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const sec = Math.round((Date.now() - d.getTime()) / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return d.toLocaleDateString();
}

/**
 * History tab — a commit log (left) + selected-commit patch (right), the
 * same two-pane feel as the Changes tab. Backed by `gitLog`/`gitShow`; the
 * patch pane reuses the Changes tab's per-line diff colorizer via
 * `DiffLines`.
 */
export default function HistoryPanel({ app }: { app: App }) {
  const [commits, setCommits] = useState<CommitEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selected, setSelected] = useState<string | null>(null);
  const [patch, setPatch] = useState("");
  const [patchLoading, setPatchLoading] = useState(false);
  const [patchError, setPatchError] = useState<string | null>(null);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // Reset + load the first page whenever the app's repo root changes.
  useEffect(() => {
    if (!app.root_dir) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setCommits([]);
    setHasMore(true);
    setSelected(null);
    setPatch("");
    setPatchError(null);
    gitLog(app.root_dir, PAGE_SIZE, 0)
      .then((rows) => {
        if (cancelled) return;
        setCommits(rows);
        setHasMore(rows.length === PAGE_SIZE);
      })
      .catch((e) => { if (!cancelled) setError(String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [app.root_dir]);

  async function loadMore() {
    if (!app.root_dir || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const rows = await gitLog(app.root_dir, PAGE_SIZE, commits.length);
      if (!mounted.current) return;
      setCommits((prev) => [...prev, ...rows]);
      setHasMore(rows.length === PAGE_SIZE);
    } catch (e) {
      if (mounted.current) setError(String(e));
    } finally {
      if (mounted.current) setLoadingMore(false);
    }
  }

  function selectCommit(hash: string) {
    if (!app.root_dir) return;
    setSelected(hash);
    setPatchLoading(true);
    setPatch("");
    setPatchError(null);
    gitShow(app.root_dir, hash)
      .then((p) => { if (mounted.current) setPatch(p); })
      .catch((e) => { if (mounted.current) setPatchError(String(e)); })
      .finally(() => { if (mounted.current) setPatchLoading(false); });
  }

  return (
    <div className="flex-1 min-h-0 flex">
      {/* Left pane — commit list. */}
      <div className="w-[280px] shrink-0 border-r border-subtle overflow-y-auto py-1 flex flex-col">
        {error && (
          <pre className="shrink-0 text-[11px] font-mono text-bad whitespace-pre-wrap break-words max-h-32 overflow-y-auto rounded-control border border-subtle bg-surface-code px-2.5 py-2 m-2">{error}</pre>
        )}
        {loading ? (
          <div className="inline-flex items-center gap-2 px-3 py-3 text-[12px] text-ink-3">
            <Spinner size={12} /> Loading commits…
          </div>
        ) : commits.length === 0 ? (
          <div className="px-3 py-3 text-[12px] text-ink-3">No commits.</div>
        ) : (
          <>
            {commits.map((c) => (
              <button
                key={c.hash}
                onClick={() => selectCommit(c.hash)}
                className={`w-full text-left mx-1 mb-0.5 px-2 py-1.5 rounded-control transition-colors duration-fast ${selected === c.hash ? "bg-accent-bg" : "hover:bg-white/[0.04]"}`}
              >
                <div className="flex items-center gap-1.5 mb-0.5">
                  <span className="font-mono text-[11px] text-ink-3">{c.short_hash}</span>
                  {c.refs !== "" && (
                    <span
                      className="text-[10px] bg-accent-bg text-accent rounded-control px-1.5 py-0.5 truncate max-w-[16ch]"
                      title={c.refs}
                    >
                      {c.refs}
                    </span>
                  )}
                </div>
                <div className="text-[12px] text-ink truncate" title={c.subject}>{c.subject}</div>
                <div className="text-[11px] text-ink-3 truncate">
                  {c.author} · {relativeDate(c.date)}
                </div>
              </button>
            ))}
            {hasMore && (
              <button
                onClick={loadMore}
                disabled={loadingMore}
                className="inline-flex items-center gap-1.5 mx-1 mt-1 mb-2 text-[11px] text-ink-2 hover:bg-white/[0.05] rounded-control px-2 py-1.5 disabled:opacity-40 transition-colors"
              >
                {loadingMore && <Spinner size={11} />}
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            )}
          </>
        )}
      </div>

      {/* Right pane — selected commit's patch. */}
      <div className="flex-1 min-w-0 overflow-auto bg-surface-code font-mono text-[11px] leading-[1.7] px-3 py-2.5">
        {!selected ? (
          <div className="h-full flex items-center justify-center text-ink-3 text-[12px] font-sans">
            Select a commit to view its diff
          </div>
        ) : patchLoading ? (
          <div className="text-ink-3">Loading diff…</div>
        ) : patchError ? (
          <div className="text-bad whitespace-pre-wrap break-words">{patchError}</div>
        ) : patch.trim() === "" ? (
          <div className="text-ink-3">No textual diff to show.</div>
        ) : (
          <DiffLines diff={patch} />
        )}
      </div>
    </div>
  );
}
