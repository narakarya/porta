import { useEffect, useRef, useState } from "react";
import type { App } from "../../../types";
import {
  gitBranches,
  gitRebaseOnto,
  gitRebaseAbort,
  gitRebaseContinue,
} from "../../../lib/commands";
import { Button, Select, Spinner } from "../../ui";

/**
 * Rebase tab — rebase-lite: pick a branch to rebase the current branch onto,
 * plus Abort/Continue for the conflict case. `gitRebaseOnto`/`gitRebaseContinue`
 * REJECT (throw) with git's stderr on a non-zero exit — a rebase conflict is
 * surfaced that way, not as a resolved error value — so we catch it and hold
 * the text in `conflict` state alongside Abort/Continue controls.
 *
 * `onChanged` is optional — GitTab passes its `refreshAfterMutation` so a
 * rebase onto/abort/continue (which mutates the working tree, whether it
 * finishes cleanly or stops on a conflict) also refreshes the shared
 * changed-file list / header dirty badge, not just this tab's own state.
 */
export default function RebasePanel({ app, onChanged }: { app: App; onChanged?: () => void }) {
  const [local, setLocal] = useState<string[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  function load() {
    if (!app.root_dir) return;
    setLoading(true);
    setError(null);
    gitBranches(app.root_dir)
      .then((list) => {
        if (!mounted.current) return;
        setLocal(list.local);
        setCurrent(list.current);
        const others = list.local.filter((b) => b !== list.current);
        setBranch((prev) => (prev && others.includes(prev) ? prev : others[0] ?? ""));
      })
      .catch((e) => { if (mounted.current) setError(String(e)); })
      .finally(() => { if (mounted.current) setLoading(false); });
  }

  // Reset + reload whenever the app's repo root changes.
  useEffect(() => {
    setConflict(null);
    setDone(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.root_dir]);

  const others = local.filter((b) => b !== current);

  async function doRebase() {
    if (!app.root_dir || busy || !branch) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await gitRebaseOnto(app.root_dir, branch);
      if (mounted.current) setDone(`Rebased onto ${branch}`);
      onChanged?.();
    } catch (e) {
      if (mounted.current) setConflict(String(e));
      // A rebase that stops on a conflict still mutated the working tree
      // (index + files got conflict markers) — refresh the shared status too.
      onChanged?.();
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function doAbort() {
    if (!app.root_dir || busy) return;
    setBusy(true);
    setError(null);
    try {
      await gitRebaseAbort(app.root_dir);
      if (mounted.current) {
        setConflict(null);
        setDone(null);
      }
      onChanged?.();
    } catch (e) {
      if (mounted.current) setError(String(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function doContinue() {
    if (!app.root_dir || busy) return;
    setBusy(true);
    setError(null);
    try {
      const out = await gitRebaseContinue(app.root_dir);
      if (mounted.current) {
        setConflict(null);
        setDone(out || "Rebase complete");
      }
      onChanged?.();
    } catch (e) {
      if (mounted.current) setConflict(String(e));
      onChanged?.();
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col p-3 gap-3 overflow-y-auto">
      {error && (
        <pre className="shrink-0 text-[11px] font-mono text-bad whitespace-pre-wrap break-words max-h-32 overflow-y-auto rounded-control border border-subtle bg-surface-code px-2.5 py-2">{error}</pre>
      )}

      {loading ? (
        <div className="inline-flex items-center gap-2 px-1 py-2 text-[12px] text-ink-3">
          <Spinner size={12} /> Loading branches…
        </div>
      ) : conflict !== null ? (
        <div className="flex flex-col gap-2">
          <div className="text-[12px] text-bad font-medium">Rebase stopped — conflicts need resolving.</div>
          <pre className="text-[11px] font-mono text-bad whitespace-pre-wrap break-words max-h-64 overflow-y-auto rounded-control border border-subtle bg-surface-code px-2.5 py-2">{conflict}</pre>
          <div className="text-[11px] text-ink-3">Resolve the conflicting files in the Changes tab, stage them, then Continue.</div>
          <div className="flex items-center gap-2">
            <Button variant="danger" size="sm" disabled={busy} onClick={doAbort}>
              Abort
            </Button>
            <Button variant="primary" size="sm" loading={busy} onClick={doContinue}>
              Continue
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="text-[12px] text-ink">
            Rebasing <span className="font-medium text-ink">{current ?? "HEAD"}</span> onto…
          </div>
          <Select
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            disabled={busy || others.length === 0}
            className="select-base !text-[12px] !py-1.5"
          >
            {others.length === 0 ? (
              <option value="">No other local branches</option>
            ) : (
              others.map((b) => (
                <option key={b} value={b}>{b}</option>
              ))
            )}
          </Select>

          <div className="text-[11px] text-ink-3 leading-relaxed">
            Replays this branch's commits on top of the selected branch. If conflicts arise,
            resolve them in the Changes tab, then Continue.
          </div>

          {done && (
            <div className="text-[12px] text-ok">{done}</div>
          )}

          <div>
            <Button
              variant="primary"
              size="sm"
              loading={busy}
              disabled={!branch || others.length === 0}
              onClick={doRebase}
            >
              Rebase onto {branch || "…"}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
