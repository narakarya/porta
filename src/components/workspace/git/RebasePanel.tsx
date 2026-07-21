import { useEffect, useRef, useState } from "react";
import type { App } from "../../../types";
import {
  gitBranches,
  gitOperationState,
  gitRebaseAbort,
  gitRebaseContinue,
  gitRebasePlan,
  gitRebaseStart,
  type RebaseAction,
  type RebasePlanEntry,
  type RebaseTodoItem,
} from "../../../lib/commands";
import { Button, Select, Spinner } from "../../ui";

type PlannedCommit = RebasePlanEntry & {
  action: RebaseAction;
  message?: string;
};

const ACTIONS: RebaseAction[] = ["pick", "edit", "reword", "squash", "fixup", "drop"];

export default function RebasePanel({ app, onChanged }: { app: App; onChanged?: () => void }) {
  const [refs, setRefs] = useState<string[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [target, setTarget] = useState("");
  const [plan, setPlan] = useState<PlannedCommit[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [inProgress, setInProgress] = useState(false);
  const [pausedMessage, setPausedMessage] = useState("");
  const [done, setDone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!app.root_dir) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      gitBranches(app.root_dir),
      gitOperationState(app.root_dir),
    ])
      .then(([branches, operation]) => {
        if (cancelled) return;
        const available = [...branches.local, ...branches.remote].filter(
          (ref) => ref !== branches.current,
        );
        const preferred =
          ["main", "master", "origin/main", "origin/master"].find((ref) => available.includes(ref)) ??
          available[0] ??
          "";
        setRefs(available);
        setCurrent(branches.current);
        setTarget((previous) => previous && available.includes(previous) ? previous : preferred);
        setInProgress(operation.rebase);
        if (operation.rebase) {
          setPausedMessage("A rebase is already in progress. Resolve or amend the current commit, then continue.");
        }
      })
      .catch((cause) => { if (!cancelled) setError(String(cause)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [app.root_dir]);

  useEffect(() => {
    if (!app.root_dir || !target || inProgress) {
      if (!inProgress) setPlan([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    gitRebasePlan(app.root_dir, target)
      .then((entries) => {
        if (cancelled) return;
        setPlan(entries.map((entry) => ({ ...entry, action: "pick" })));
      })
      .catch((cause) => { if (!cancelled) setError(String(cause)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [app.root_dir, target, inProgress]);

  function updateAction(index: number, action: RebaseAction) {
    setPlan((previous) => previous.map((entry, currentIndex) =>
      currentIndex === index
        ? {
            ...entry,
            action,
            message: action === "reword" ? entry.message ?? entry.subject : undefined,
          }
        : entry,
    ));
  }

  function move(index: number, direction: -1 | 1) {
    setPlan((previous) => {
      const destination = index + direction;
      if (destination < 0 || destination >= previous.length) return previous;
      const next = [...previous];
      [next[index], next[destination]] = [next[destination], next[index]];
      return next;
    });
  }

  async function refreshOperation(message = "") {
    const state = await gitOperationState(app.root_dir);
    if (!mounted.current) return state.rebase;
    setInProgress(state.rebase);
    setPausedMessage(state.rebase ? message || "Rebase paused. Resolve the current step, then continue." : "");
    return state.rebase;
  }

  async function start() {
    if (!app.root_dir || !target || plan.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    setDone("");
    const items: RebaseTodoItem[] = plan.map(({ hash, action, message }) => ({ hash, action, message }));
    try {
      const output = await gitRebaseStart(app.root_dir, target, items);
      const active = await refreshOperation(
        "Rebase stopped for an edit step. Amend the commit if needed, then continue.",
      );
      if (mounted.current && !active) {
        setDone(output || `Rebased ${current ?? "HEAD"} onto ${target}`);
      }
      onChanged?.();
    } catch (cause) {
      if (mounted.current) setError(String(cause));
      await refreshOperation("Rebase paused because a step needs attention. Resolve and stage conflicts, then continue.");
      onChanged?.();
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function finish(kind: "continue" | "abort") {
    if (!app.root_dir || busy) return;
    setBusy(true);
    setError(null);
    try {
      const output =
        kind === "continue"
          ? await gitRebaseContinue(app.root_dir)
          : (await gitRebaseAbort(app.root_dir), "");
      await refreshOperation();
      if (mounted.current && kind === "continue") setDone(output || "Rebase complete");
      if (mounted.current && kind === "abort") setDone("Rebase aborted");
      onChanged?.();
    } catch (cause) {
      if (mounted.current) setError(String(cause));
      await refreshOperation("Rebase is still paused. Resolve and stage conflicts, then continue.");
      onChanged?.();
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="shrink-0 flex flex-wrap items-center gap-2 border-b border-subtle bg-surface-1 px-3 py-2.5">
        <span className="text-[12px] text-ink-2">
          Rebase <span className="font-mono text-ink">{current ?? "HEAD"}</span> onto
        </span>
        <Select
          value={target}
          onChange={(event) => setTarget(event.target.value)}
          disabled={busy || inProgress}
          className="select-base !text-[11px] !py-1 max-w-[240px]"
        >
          {refs.length === 0
            ? <option value="">No other branches</option>
            : refs.map((ref) => <option key={ref} value={ref}>{ref}</option>)}
        </Select>
        {!inProgress && plan.length > 0 && (
          <span className="text-[11px] text-ink-3">
            {plan.filter((entry) => entry.action !== "drop").length} of {plan.length} commits kept
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {inProgress ? (
            <>
              <Button variant="danger" size="sm" disabled={busy} onClick={() => finish("abort")}>
                Abort
              </Button>
              <Button size="sm" loading={busy} onClick={() => finish("continue")}>
                Continue
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              loading={busy}
              disabled={!target || plan.length === 0}
              onClick={start}
            >
              Start rebase
            </Button>
          )}
        </div>
      </div>

      {error && (
        <pre className="shrink-0 m-2 mb-0 max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded-control border border-subtle bg-surface-code px-2.5 py-2 font-mono text-[11px] text-bad">{error}</pre>
      )}
      {pausedMessage && (
        <div className="shrink-0 mx-2 mt-2 rounded-control border border-warn/30 bg-warn-bg px-3 py-2 text-[11px] text-warn">
          {pausedMessage}
        </div>
      )}
      {done && !inProgress && (
        <div className="shrink-0 mx-2 mt-2 rounded-control border border-ok/30 bg-ok-bg px-3 py-2 text-[11px] text-ok">
          {done}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto p-2">
        {loading ? (
          <div className="inline-flex items-center gap-2 px-2 py-3 text-[12px] text-ink-3">
            <Spinner size={12} /> Loading rebase plan…
          </div>
        ) : inProgress ? (
          <div className="h-full flex items-center justify-center text-center">
            <div>
              <div className="text-[13px] text-ink">Interactive rebase in progress</div>
              <div className="mt-1 max-w-md text-[11px] leading-relaxed text-ink-3">
                Resolve conflicts in Status or amend an edit step in Terminal, stage the result, then Continue.
              </div>
            </div>
          </div>
        ) : plan.length === 0 ? (
          <div className="px-2 py-3 text-[12px] text-ink-3">
            No commits need replaying onto {target || "the selected branch"}.
          </div>
        ) : (
          <div className="mx-auto max-w-4xl overflow-hidden rounded-card border border-subtle bg-surface-1">
            {plan.map((entry, index) => (
              <div key={entry.hash} className="border-b border-subtle last:border-b-0">
                <div className={`flex items-center gap-2 px-2.5 py-2 ${entry.action === "drop" ? "opacity-50" : ""}`}>
                  <span className="w-5 shrink-0 text-right text-[10px] tabular-nums text-ink-3">{index + 1}</span>
                  <Select
                    value={entry.action}
                    onChange={(event) => updateAction(index, event.target.value as RebaseAction)}
                    disabled={busy}
                    className="select-base !w-[92px] !text-[10px] !py-1"
                  >
                    {ACTIONS.map((action) => <option key={action} value={action}>{action}</option>)}
                  </Select>
                  <span className="shrink-0 font-mono text-[10px] text-accent">{entry.short_hash}</span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12px] text-ink" title={entry.subject}>{entry.subject}</div>
                    {entry.body && <div className="truncate text-[10px] text-ink-3">{entry.body}</div>}
                  </div>
                  <button
                    onClick={() => move(index, -1)}
                    disabled={index === 0 || busy}
                    className="rounded-control px-1.5 py-1 text-[11px] text-ink-3 hover:bg-[var(--hover)] hover:text-ink disabled:opacity-25"
                    title="Move up"
                  >
                    ↑
                  </button>
                  <button
                    onClick={() => move(index, 1)}
                    disabled={index === plan.length - 1 || busy}
                    className="rounded-control px-1.5 py-1 text-[11px] text-ink-3 hover:bg-[var(--hover)] hover:text-ink disabled:opacity-25"
                    title="Move down"
                  >
                    ↓
                  </button>
                </div>
                {entry.action === "reword" && (
                  <div className="px-10 pb-2">
                    <textarea
                      value={entry.message ?? entry.subject}
                      onChange={(event) => setPlan((previous) => previous.map((item, currentIndex) =>
                        currentIndex === index ? { ...item, message: event.target.value } : item,
                      ))}
                      rows={3}
                      className="input-base w-full resize-y font-mono text-[11px]"
                      placeholder="New commit message…"
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
