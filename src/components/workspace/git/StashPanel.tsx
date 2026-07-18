import { useEffect, useRef, useState } from "react";
import type { App } from "../../../types";
import { gitStashList, gitStashPush, gitStashPop, gitStashDrop, type StashEntry } from "../../../lib/commands";
import { Button, Input, Spinner } from "../../ui";

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
  const [pushing, setPushing] = useState(false);

  // Index of the stash whose Pop/Drop is in flight, and the index (if any)
  // sitting in the inline "Drop?" confirm state.
  const [busyIndex, setBusyIndex] = useState<number | null>(null);
  const [confirmDrop, setConfirmDrop] = useState<number | null>(null);

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
      await gitStashPush(app.root_dir, message.trim() === "" ? undefined : message.trim());
      if (mounted.current) setMessage("");
      load();
      onChanged?.();
    } catch (e) {
      if (mounted.current) setError(String(e));
    } finally {
      if (mounted.current) setPushing(false);
    }
  }

  async function doPop(index: number) {
    if (!app.root_dir || busyIndex !== null) return;
    setBusyIndex(index);
    setError(null);
    try {
      await gitStashPop(app.root_dir, index);
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
      load();
      onChanged?.();
    } catch (e) {
      if (mounted.current) setError(String(e));
    } finally {
      if (mounted.current) setBusyIndex(null);
    }
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
        <Button size="sm" loading={pushing} disabled={!app.root_dir} onClick={doPush} className="shrink-0">
          Stash changes
        </Button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto py-1">
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
          stashes.map((s) => {
            const busy = busyIndex === s.index;
            const confirming = confirmDrop === s.index;
            return (
              <div
                key={s.index}
                className="mx-1 mb-0.5 flex items-center gap-2 px-2 py-1.5 rounded-control hover:bg-white/[0.04] transition-colors duration-fast"
              >
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
                      onClick={() => doPop(s.index)}
                      disabled={busyIndex !== null}
                      className="text-[11px] text-ink-2 hover:text-ink hover:bg-white/[0.06] rounded-control px-2 py-1 transition-colors duration-fast disabled:opacity-40 disabled:pointer-events-none"
                    >
                      Pop
                    </button>
                    <button
                      onClick={() => setConfirmDrop(s.index)}
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
    </div>
  );
}
