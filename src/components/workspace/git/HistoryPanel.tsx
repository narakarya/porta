import { useEffect, useRef, useState } from "react";
import type { App } from "../../../types";
import {
  gitBranches,
  gitCherryPick,
  gitCherryPickAbort,
  gitCherryPickContinue,
  gitLogRef,
  gitResetTo,
  gitShow,
  type CommitEntry,
} from "../../../lib/commands";
import { Button, Input, Select, Spinner } from "../../ui";
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
export default function HistoryPanel({ app, onChanged }: { app: App; onChanged?: () => void }) {
  const [commits, setCommits] = useState<CommitEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selected, setSelected] = useState<string | null>(null);
  const [patch, setPatch] = useState("");
  const [patchLoading, setPatchLoading] = useState(false);
  const [patchError, setPatchError] = useState<string | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [source, setSource] = useState("");
  const [query, setQuery] = useState("");
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [cherryPaused, setCherryPaused] = useState(false);
  const [mainline, setMainline] = useState(1);
  const [confirmReset, setConfirmReset] = useState<"soft" | "mixed" | "hard" | null>(null);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!app.root_dir) return;
    gitBranches(app.root_dir)
      .then((list) => {
        if (!mounted.current) return;
        setBranches(list.local);
        setSource((prev) => prev && list.local.includes(prev) ? prev : list.current ?? "");
      })
      .catch(() => setBranches([]));
  }, [app.root_dir]);

  // Reset + load the first page whenever the repo, source branch, or search changes.
  useEffect(() => {
    if (!app.root_dir) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      setCommits([]);
      setHasMore(true);
      setSelected(null);
      setPatch("");
      setPatchError(null);
      gitLogRef(app.root_dir, source, query.trim(), PAGE_SIZE, 0)
        .then((rows) => {
          if (cancelled) return;
          setCommits(rows);
          setHasMore(rows.length === PAGE_SIZE);
        })
        .catch((e) => { if (!cancelled) setError(String(e)); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [app.root_dir, source, query]);

  async function loadMore() {
    if (!app.root_dir || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const rows = await gitLogRef(
        app.root_dir,
        source,
        query.trim(),
        PAGE_SIZE,
        commits.length,
      );
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
    setMainline(1);
    gitShow(app.root_dir, hash)
      .then((p) => { if (mounted.current) setPatch(p); })
      .catch((e) => { if (mounted.current) setPatchError(String(e)); })
      .finally(() => { if (mounted.current) setPatchLoading(false); });
  }

  const selectedCommit = commits.find((c) => c.hash === selected) ?? null;

  async function cherryPick() {
    if (!app.root_dir || !selected || actionBusy) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await gitCherryPick(
        app.root_dir,
        selected,
        selectedCommit && selectedCommit.parent_count > 1 ? mainline : undefined,
      );
      setCherryPaused(false);
      onChanged?.();
    } catch (e) {
      if (mounted.current) {
        setActionError(String(e));
        setCherryPaused(true);
      }
      onChanged?.();
    } finally {
      if (mounted.current) setActionBusy(false);
    }
  }

  async function finishCherryPick(kind: "continue" | "abort") {
    if (!app.root_dir || actionBusy) return;
    setActionBusy(true);
    setActionError(null);
    try {
      if (kind === "continue") await gitCherryPickContinue(app.root_dir);
      else await gitCherryPickAbort(app.root_dir);
      if (mounted.current) setCherryPaused(false);
      onChanged?.();
    } catch (e) {
      if (mounted.current) setActionError(String(e));
      onChanged?.();
    } finally {
      if (mounted.current) setActionBusy(false);
    }
  }

  async function resetTo(mode: "soft" | "mixed" | "hard") {
    if (!app.root_dir || !selected || actionBusy) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await gitResetTo(app.root_dir, selected, mode);
      if (mounted.current) setConfirmReset(null);
      onChanged?.();
    } catch (e) {
      if (mounted.current) setActionError(String(e));
    } finally {
      if (mounted.current) setActionBusy(false);
    }
  }

  return (
    <div className="flex-1 min-h-0 flex">
      {/* Left pane — commit list. */}
      <div className="w-[280px] shrink-0 border-r border-subtle overflow-y-auto py-1 flex flex-col">
        <div className="shrink-0 sticky top-0 z-10 bg-surface-2 border-b border-subtle p-2 flex flex-col gap-1.5">
          <Select
            value={source}
            onChange={(e) => setSource(e.target.value)}
            className="select-base !text-[11px] !py-1"
          >
            {branches.map((b) => <option key={b} value={b}>{b}</option>)}
          </Select>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search commit messages…"
            className="!py-1"
          />
        </div>
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

      {/* Right pane — commit metadata, actions, and patch. */}
      <div className="flex-1 min-w-0 flex flex-col bg-surface-code">
        {!selected ? (
          <div className="h-full flex items-center justify-center text-ink-3 text-[12px]">
            Select a commit to view its diff
          </div>
        ) : (
          <>
            <div className="shrink-0 border-b border-subtle bg-surface-1 px-3 py-2.5">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] text-ink font-medium">{selectedCommit?.subject}</div>
                  {selectedCommit?.body && (
                    <div className="text-[11px] text-ink-2 whitespace-pre-wrap mt-1 max-h-20 overflow-y-auto">
                      {selectedCommit.body}
                    </div>
                  )}
                  <div className="text-[11px] text-ink-3 mt-1">
                    {selectedCommit?.author} · <span className="font-mono">{selectedCommit?.short_hash}</span>
                    {selectedCommit && selectedCommit.parent_count > 1 && " · merge commit"}
                  </div>
                </div>
                <div className="shrink-0 flex items-center gap-1.5">
                  {selectedCommit && selectedCommit.parent_count > 1 && (
                    <Select
                      value={String(mainline)}
                      onChange={(e) => setMainline(Number(e.target.value))}
                      disabled={actionBusy}
                      title="Merge parent to use as mainline"
                      className="select-base !text-[11px] !py-1"
                    >
                      {Array.from({ length: selectedCommit.parent_count }, (_, index) => (
                        <option key={index + 1} value={index + 1}>Parent {index + 1}</option>
                      ))}
                    </Select>
                  )}
                  <Button size="sm" loading={actionBusy && !confirmReset} onClick={cherryPick}>
                    Cherry-pick
                  </Button>
                  {confirmReset ? (
                    <>
                      <span className="text-[11px] text-bad">Reset {confirmReset}?</span>
                      <button
                        onClick={() => resetTo(confirmReset)}
                        className="text-[11px] font-medium text-bad hover:brightness-125"
                      >
                        Confirm
                      </button>
                      <button
                        onClick={() => setConfirmReset(null)}
                        className="text-[11px] text-ink-3 hover:text-ink-2"
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <Select
                      value=""
                      onChange={(e) => {
                        const mode = e.target.value as "soft" | "mixed" | "hard";
                        if (mode) setConfirmReset(mode);
                      }}
                      disabled={actionBusy}
                      className="select-base !text-[11px] !py-1"
                    >
                      <option value="">Reset to…</option>
                      <option value="soft">Soft</option>
                      <option value="mixed">Mixed</option>
                      <option value="hard">Hard</option>
                    </Select>
                  )}
                </div>
              </div>
              {actionError && (
                <pre className="mt-2 text-[11px] font-mono text-bad whitespace-pre-wrap break-words max-h-24 overflow-y-auto">{actionError}</pre>
              )}
              {cherryPaused && (
                <div className="mt-2 flex items-center gap-2">
                  <span className="text-[11px] text-warn">Cherry-pick paused. Resolve and stage conflicts, then continue.</span>
                  <Button size="sm" onClick={() => finishCherryPick("continue")} disabled={actionBusy}>Continue</Button>
                  <Button variant="danger" size="sm" onClick={() => finishCherryPick("abort")} disabled={actionBusy}>Abort</Button>
                </div>
              )}
            </div>
            <div className="flex-1 min-h-0 overflow-auto font-mono text-[11px] leading-[1.7] px-3 py-2.5">
              {patchLoading ? (
                <div className="text-ink-3">Loading diff…</div>
              ) : patchError ? (
                <div className="text-bad whitespace-pre-wrap break-words">{patchError}</div>
              ) : patch.trim() === "" ? (
                <div className="text-ink-3">No textual diff to show.</div>
              ) : (
                <DiffLines diff={patch} />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
