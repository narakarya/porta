import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { usePortaStore } from "../../store";
import type { App } from "../../types";
import type { AppInstance, BranchList, WorktreeEntry } from "../../lib/commands";
import { gitBranches, gitWorktreeList } from "../../lib/commands";
import { Button, Input, Spinner } from "../ui";

/**
 * Inline "run an instance on a branch" picker — the compact replacement for the
 * old full-screen InstancesModal. Lists local branches not already checked out
 * (or backing an instance) and a create-new-branch row. Runs the branch via
 * `runInstanceOnBranch`, which creates/reuses a sibling worktree then launches.
 * Rendered inline inside the workbench Overview, not as a modal.
 */
export default function RunOnBranchPicker({
  app,
  instances,
  onClose,
}: {
  app: App;
  instances: AppInstance[];
  onClose: () => void;
}) {
  const { runInstanceOnBranch, refreshInstances } = usePortaStore(
    useShallow((s) => ({
      runInstanceOnBranch: s.runInstanceOnBranch,
      refreshInstances: s.refreshInstances,
    })),
  );

  const [branches, setBranches] = useState<BranchList | null>(null);
  const [worktrees, setWorktrees] = useState<WorktreeEntry[]>([]);
  const [loading, setLoading] = useState(false);
  // One field for both jobs, mirroring GitBadge's switch-branch flyout: typing
  // filters the list, and a query that matches nothing offers to create it.
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Branch of the existing-branch run in flight (drives its row spinner);
  // separate flag for create-new. Either makes the whole picker `busy`.
  const [runningBranch, setRunningBranch] = useState<string | null>(null);
  const [creatingNew, setCreatingNew] = useState(false);
  const busy = runningBranch !== null || creatingNew;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      gitBranches(app.root_dir),
      gitWorktreeList(app.root_dir).catch(() => [] as WorktreeEntry[]),
    ])
      .then(([bl, wl]) => {
        if (cancelled) return;
        setBranches(bl);
        setWorktrees(wl);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [app.root_dir]);

  // Branches unavailable to launch: already backing an instance, or already
  // checked out in a worktree (incl. the primary checkout → main is skipped too).
  const takenBranches = useMemo(() => {
    const set = new Set<string>();
    for (const inst of instances) if (inst.branch) set.add(inst.branch);
    for (const wt of worktrees) if (wt.branch) set.add(wt.branch);
    return set;
  }, [instances, worktrees]);

  const availableBranches = useMemo(
    () => (branches ? branches.local.filter((b) => !takenBranches.has(b)) : []),
    [branches, takenBranches],
  );

  // Same shape as the branch switcher: unfiltered shows a short head of the
  // list, typing searches the whole thing.
  const LIST_CAP = 6;
  const q = query.trim();
  const filtered = useMemo(
    () => availableBranches.filter((b) => q === "" || b.toLowerCase().includes(q.toLowerCase())),
    [availableBranches, q],
  );
  const capped = q === "" ? filtered.slice(0, LIST_CAP) : filtered;
  const hiddenCount = filtered.length - capped.length;
  // Offer create only when nothing in the repo already answers to that name —
  // including branches that are taken, which can't be created a second time.
  const knownBranches = useMemo(() => {
    const set = new Set(branches?.local ?? []);
    for (const b of takenBranches) set.add(b);
    return set;
  }, [branches, takenBranches]);
  const showCreate = q !== "" && !knownBranches.has(q);

  async function handleRunExisting(branch: string) {
    if (busy) return;
    setError(null);
    setRunningBranch(branch);
    try {
      await runInstanceOnBranch(app.id, app.root_dir, branch, false);
      await refreshInstances(app.id);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunningBranch(null);
    }
  }

  async function handleCreateNew() {
    const name = query.trim();
    if (!name || busy) return;
    setError(null);
    setCreatingNew(true);
    try {
      await runInstanceOnBranch(app.id, app.root_dir, name, true);
      await refreshInstances(app.id);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreatingNew(false);
    }
  }

  return (
    <div className="rounded-[9px] border border-subtle bg-surface-1 p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[12px] font-medium text-ink">Run an instance on a branch</span>
        <button
          onClick={onClose}
          className="p-0.5 rounded text-ink-3 hover:text-ink-2 hover:bg-white/[0.06] transition-colors"
          title="Close"
          aria-label="Close picker"
        >
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
            <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {error && (
        <div className="mb-2 rounded-lg border border-[rgba(248,113,113,0.3)] bg-[rgba(248,113,113,0.12)] px-2.5 py-1.5 text-[11px] text-bad">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 py-2 text-[12px] text-ink-3">
          <Spinner size={13} /> Loading branches…
        </div>
      ) : (
        <>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              // Enter runs the single remaining match, else creates the query.
              if (capped.length === 1) void handleRunExisting(capped[0]);
              else if (showCreate) void handleCreateNew();
            }}
            placeholder="Search or create branch…"
            disabled={busy}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            autoFocus
            className="mb-1.5 py-1.5 text-[12px] font-mono"
          />

          <div className="flex flex-col gap-0.5 max-h-[220px] overflow-y-auto">
            {capped.length === 0 ? (
              <p className="py-1 text-[11px] text-ink-3">
                {availableBranches.length === 0
                  ? "No other local branches available — type a name to create one."
                  : "No matching branch."}
              </p>
            ) : (
              capped.map((b) => (
                <button
                  key={b}
                  onClick={() => handleRunExisting(b)}
                  disabled={busy}
                  className="group flex items-center gap-2 rounded-control px-2 py-1.5 text-left transition-colors hover:bg-white/[0.05] disabled:pointer-events-none disabled:opacity-40"
                >
                  {runningBranch === b ? (
                    <Spinner size={12} className="text-accent" />
                  ) : (
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="text-ink-3 shrink-0" aria-hidden="true">
                      <circle cx="3" cy="3" r="1.5" stroke="currentColor" strokeWidth="1.1" />
                      <circle cx="3" cy="9" r="1.5" stroke="currentColor" strokeWidth="1.1" />
                      <circle cx="9" cy="3" r="1.5" stroke="currentColor" strokeWidth="1.1" />
                      <path d="M3 4.5v3M9 4.5c0 2-2 2.5-4.5 2.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
                    </svg>
                  )}
                  <span className="text-[12px] text-ink truncate font-mono">{b}</span>
                  <span className="ml-auto text-[10px] text-accent opacity-0 group-hover:opacity-100 transition-opacity">
                    {runningBranch === b ? "Running…" : "Run"}
                  </span>
                </button>
              ))
            )}
            {hiddenCount > 0 && (
              <p className="px-2 py-1 text-[10px] text-ink-3">
                {hiddenCount} more — type to search
              </p>
            )}
          </div>

          {showCreate && (
            <div className="mt-2 pt-2 border-t border-subtle">
              <Button
                variant="accent"
                size="sm"
                loading={creatingNew}
                disabled={busy}
                onClick={handleCreateNew}
                className="w-full"
              >
                Create &amp; run <span className="font-mono">{q}</span>
              </Button>
            </div>
          )}
          <p className="mt-1.5 text-[10px] text-ink-3">
            Creates a worktree off HEAD in a sibling <span className="font-mono">-worktrees/</span> dir, then runs it.
          </p>
        </>
      )}
    </div>
  );
}
