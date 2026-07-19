import { useEffect, useRef, useState } from "react";
import type { App } from "../../../types";
import {
  gitStashApply,
  gitStashDrop,
  gitStashList,
  gitStashPop,
  gitStashPush,
  gitStashShowOptions,
  type StashEntry,
} from "../../../lib/commands";
import { Button, Input, Spinner } from "../../ui";
import ReadOnlyDiff, { type ReadOnlyDiffOptions } from "./ReadOnlyDiff";

/**
 * Stash tab — a "Stash changes" control (optional message) on top of the
 * stash list. Each row is `stash@{index}` + the stash's own label (`message`;
 * `branch` is currently always empty upstream so it's not shown), with
 * Pop/Drop actions. Drop swaps the row into an inline confirm state rather
 * than `window.confirm` — Tauri webview dialogs are unreliable (project
 * convention, see AppCard's kill/remove confirm bars).
 *
 * `onChanged` is optional — GitTab passes its `refreshAfterMutation` so a
 * stash push/pop/drop (which mutates the working tree) also refreshes the
 * shared changed-file list / header dirty badge, not just this tab's own
 * stash list.
 */
export default function StashPanel({ app, onChanged }: { app: App; onChanged?: () => void }) {
  const [stashes, setStashes] = useState<StashEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [message, setMessage] = useState("");
  const [query, setQuery] = useState("");
  const [includeUntracked, setIncludeUntracked] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [patch, setPatch] = useState("");
  const [patchLoading, setPatchLoading] = useState(false);
  const [diffOptions, setDiffOptions] = useState<ReadOnlyDiffOptions>({
    context: 8,
    ignoreWhitespace: false,
  });

  // Index of the stash whose Pop/Drop is in flight, and the index (if any)
  // sitting in the inline "Drop?" confirm state.
  const [busyIndex, setBusyIndex] = useState<number | null>(null);
  const [confirmDrop, setConfirmDrop] = useState<number | null>(null);
  const [confirmBulkDrop, setConfirmBulkDrop] = useState(false);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  function load() {
    if (!app.root_dir) return;
    setLoading(true);
    setError(null);
    gitStashList(app.root_dir)
      .then((rows) => { if (mounted.current) setStashes(rows); })
      .catch((e) => { if (mounted.current) setError(String(e)); })
      .finally(() => { if (mounted.current) setLoading(false); });
  }

  // Reset + reload whenever the app's repo root changes.
  useEffect(() => {
    setConfirmDrop(null);
    setBusyIndex(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.root_dir]);

  async function doPush() {
    if (!app.root_dir || pushing) return;
    setPushing(true);
    setError(null);
    try {
      await gitStashPush(
        app.root_dir,
        message.trim() === "" ? undefined : message.trim(),
        includeUntracked,
      );
      if (mounted.current) setMessage("");
      load();
      onChanged?.();
    } catch (e) {
      if (mounted.current) setError(String(e));
    } finally {
      if (mounted.current) setPushing(false);
    }
  }

  async function doApply(index: number) {
    if (!app.root_dir || busyIndex !== null) return;
    setBusyIndex(index);
    setError(null);
    try {
      await gitStashApply(app.root_dir, index);
      onChanged?.();
    } catch (e) {
      if (mounted.current) setError(String(e));
    } finally {
      if (mounted.current) setBusyIndex(null);
    }
  }

  function showStash(index: number) {
    setSelected(index);
  }

  useEffect(() => {
    if (!app.root_dir || selected === null) return;
    let cancelled = false;
    setPatch("");
    setPatchLoading(true);
    setError(null);
    gitStashShowOptions(
      app.root_dir,
      selected,
      diffOptions.context,
      diffOptions.ignoreWhitespace,
    )
      .then((raw) => { if (!cancelled && mounted.current) setPatch(raw); })
      .catch((e) => { if (!cancelled && mounted.current) setError(String(e)); })
      .finally(() => { if (!cancelled && mounted.current) setPatchLoading(false); });
    return () => { cancelled = true; };
  }, [app.root_dir, selected, diffOptions]);

  async function doPop(index: number) {
    if (!app.root_dir || busyIndex !== null) return;
    setBusyIndex(index);
    setError(null);
    try {
      await gitStashPop(app.root_dir, index);
      if (mounted.current) {
        setChecked(new Set());
        setSelected(null);
        setPatch("");
      }
      load();
      onChanged?.();
    } catch (e) {
      if (mounted.current) setError(String(e));
    } finally {
      if (mounted.current) setBusyIndex(null);
    }
  }

  async function doDrop(index: number) {
    if (!app.root_dir || busyIndex !== null) return;
    setBusyIndex(index);
    setError(null);
    setConfirmDrop(null);
    try {
      await gitStashDrop(app.root_dir, index);
      if (mounted.current) {
        setChecked(new Set());
        setSelected(null);
        setPatch("");
      }
      load();
      onChanged?.();
    } catch (e) {
      if (mounted.current) setError(String(e));
    } finally {
      if (mounted.current) setBusyIndex(null);
    }
  }

  async function doBulkDrop() {
    if (!app.root_dir || checked.size === 0 || busyIndex !== null) return;
    setBusyIndex(-1);
    setError(null);
    setConfirmBulkDrop(false);
    try {
      for (const index of [...checked].sort((a, b) => b - a)) {
        await gitStashDrop(app.root_dir, index);
      }
      if (mounted.current) {
        setChecked(new Set());
        setSelected(null);
        setPatch("");
      }
      load();
      onChanged?.();
    } catch (e) {
      if (mounted.current) setError(String(e));
    } finally {
      if (mounted.current) setBusyIndex(null);
    }
  }

  function toggleChecked(index: number) {
    setChecked((previous) => {
      const next = new Set(previous);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* Stash-changes control. */}
      <div className="shrink-0 border-b border-subtle p-3 bg-surface-1 flex items-center gap-1.5">
        <Input
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !pushing) doPush(); }}
          placeholder="Stash message (optional)…"
          spellCheck={false}
          className="!py-1"
        />
        <label className="shrink-0 inline-flex items-center gap-1.5 text-[11px] text-ink-2 px-1.5">
          <input
            type="checkbox"
            checked={includeUntracked}
            onChange={(e) => setIncludeUntracked(e.target.checked)}
            className="accent-[var(--color-accent)]"
          />
          Include untracked
        </label>
        <Button size="sm" loading={pushing} disabled={!app.root_dir} onClick={doPush} className="shrink-0">
          Stash changes
        </Button>
      </div>

      <div className="shrink-0 border-b border-subtle p-2 bg-surface-1">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search stashes…"
          className="!py-1"
        />
      </div>

      {checked.size > 0 && (
        <div className="shrink-0 flex items-center gap-2 border-b border-subtle bg-surface-1 px-3 py-2">
          <span className="text-[11px] text-ink-2">{checked.size} selected</span>
          <button onClick={() => setChecked(new Set())} className="text-[11px] text-ink-3 hover:text-ink">
            Clear
          </button>
          <div className="ml-auto flex items-center gap-1.5">
            {confirmBulkDrop ? (
              <>
                <span className="text-[11px] text-bad">Drop selected stashes?</span>
                <button onClick={doBulkDrop} className="text-[11px] font-medium text-bad">Confirm</button>
                <button onClick={() => setConfirmBulkDrop(false)} className="text-[11px] text-ink-3">Cancel</button>
              </>
            ) : (
              <Button variant="danger" size="sm" onClick={() => setConfirmBulkDrop(true)}>
                Drop selected
              </Button>
            )}
          </div>
        </div>
      )}

      <div className="flex-1 min-h-0 flex">
      <div className="w-[360px] shrink-0 border-r border-subtle overflow-y-auto py-1">
        {error && (
          <pre className="shrink-0 text-[11px] font-mono text-bad whitespace-pre-wrap break-words max-h-32 overflow-y-auto rounded-control border border-subtle bg-surface-code px-2.5 py-2 m-2">{error}</pre>
        )}
        {loading ? (
          <div className="inline-flex items-center gap-2 px-3 py-3 text-[12px] text-ink-3">
            <Spinner size={12} /> Loading stashes…
          </div>
        ) : stashes.length === 0 ? (
          <div className="px-3 py-3 text-[12px] text-ink-3">No stashes.</div>
        ) : (
          stashes
            .filter((s) => {
              const q = query.trim().toLowerCase();
              return q === "" || `stash@{${s.index}} ${s.message}`.toLowerCase().includes(q);
            })
            .map((s) => {
            const busy = busyIndex === s.index;
            const confirming = confirmDrop === s.index;
            return (
              <div
                key={s.index}
                onClick={() => showStash(s.index)}
                className={`mx-1 mb-0.5 flex items-center gap-2 px-2 py-1.5 rounded-control cursor-pointer transition-colors duration-fast ${selected === s.index ? "bg-accent-bg" : "hover:bg-white/[0.04]"}`}
              >
                <input
                  type="checkbox"
                  checked={checked.has(s.index)}
                  onChange={() => toggleChecked(s.index)}
                  onClick={(event) => event.stopPropagation()}
                  className="shrink-0 accent-[var(--color-accent)]"
                  aria-label={`Select stash ${s.index}`}
                />
                <span className="shrink-0 font-mono text-[11px] text-ink-3">{`stash@{${s.index}}`}</span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-ink" title={s.message}>
                  {s.message}
                </span>
                {busy ? (
                  <Spinner size={12} className="shrink-0" />
                ) : confirming ? (
                  <div className="shrink-0 flex items-center gap-1.5">
                    <span className="text-[11px] text-bad">Drop?</span>
                    <button
                      onClick={() => doDrop(s.index)}
                      className="text-[11px] font-medium text-bad hover:brightness-125 transition-colors duration-fast"
                    >
                      Confirm
                    </button>
                    <button
                      onClick={() => setConfirmDrop(null)}
                      className="text-[11px] text-ink-3 hover:text-ink-2 transition-colors duration-fast"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div className="shrink-0 flex items-center gap-1">
                    <button
                      onClick={(e) => { e.stopPropagation(); doApply(s.index); }}
                      disabled={busyIndex !== null}
                      className="text-[11px] text-ink-2 hover:text-ink hover:bg-white/[0.06] rounded-control px-2 py-1 transition-colors duration-fast disabled:opacity-40 disabled:pointer-events-none"
                    >
                      Apply
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); doPop(s.index); }}
                      disabled={busyIndex !== null}
                      className="text-[11px] text-ink-2 hover:text-ink hover:bg-white/[0.06] rounded-control px-2 py-1 transition-colors duration-fast disabled:opacity-40 disabled:pointer-events-none"
                    >
                      Pop
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); setConfirmDrop(s.index); }}
                      disabled={busyIndex !== null}
                      className="text-[11px] text-ink-2 hover:text-bad hover:bg-bad-bg rounded-control px-2 py-1 transition-colors duration-fast disabled:opacity-40 disabled:pointer-events-none"
                    >
                      Drop
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
      <div className="flex-1 min-w-0 bg-surface-code">
        {selected === null ? (
          <div className="h-full flex items-center justify-center text-ink-3 text-[12px] font-sans">
            Select a stash to preview its changes
          </div>
        ) : (
          <ReadOnlyDiff
            diff={patch}
            loading={patchLoading}
            options={diffOptions}
            onOptionsChange={setDiffOptions}
          />
        )}
      </div>
      </div>
    </div>
  );
}
