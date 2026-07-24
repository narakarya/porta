import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { usePortaStore } from "../../store";
import type { App } from "../../types";
import type { AppInstance, BranchList, WorktreeEntry } from "../../lib/commands";
import { gitBranches, gitFetch, gitWorktreeList } from "../../lib/commands";
import { Button, Input, Spinner } from "../ui";
import Tooltip from "../shared/Tooltip";

/** A branch the picker can launch: a local one, or a fetched remote-only one. */
type Candidate = {
  /** Local branch name — what the instance will be called. */
  name: string;
  /** What to hand `git worktree add`: the local name, or `origin/<name>`. */
  ref: string;
  remote: boolean;
};

/**
 * Inline "run an instance on a branch" picker — the compact replacement for the
 * old full-screen InstancesModal. Lists branches not already checked out (or
 * backing an instance) and a create-new-branch row. Runs the branch via
 * `runInstanceOnBranch`, which creates/reuses a sibling worktree then launches.
 * Rendered inline inside the workbench Overview, not as a modal.
 *
 * Two things keep the list honest about the remote, which a one-shot read of
 * local branches never was: remote-only branches are offered directly (a
 * teammate's branch has no local ref until someone checks it out), and the list
 * reloads on `git:fetched` — so a fetch from the header badge, the Git tab, or
 * the autofetch poller lands here too. The Fetch button is the same op, placed
 * where you're already looking.
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
  const [fetching, setFetching] = useState(false);
  // One field for both jobs, mirroring GitBadge's switch-branch flyout: typing
  // filters the list, and a query that matches nothing offers to create it.
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Branch of the existing-branch run in flight (drives its row spinner);
  // separate flag for create-new. Either makes the whole picker `busy`.
  const [runningBranch, setRunningBranch] = useState<string | null>(null);
  const [creatingNew, setCreatingNew] = useState(false);
  const busy = runningBranch !== null || creatingNew;

  // Reloads are also fired by events, which can outlive the picker — a ref, not
  // a per-effect `cancelled` flag, is what stops a late response setting state.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const reload = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!opts?.silent) setLoading(true);
      try {
        const [bl, wl] = await Promise.all([
          gitBranches(app.root_dir),
          gitWorktreeList(app.root_dir).catch(() => [] as WorktreeEntry[]),
        ]);
        if (!mountedRef.current) return;
        setBranches(bl);
        setWorktrees(wl);
        setError(null);
      } catch (e) {
        if (mountedRef.current) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (mountedRef.current && !opts?.silent) setLoading(false);
      }
    },
    [app.root_dir],
  );

  useEffect(() => { void reload(); }, [reload]);

  // A fetch from anywhere — the header badge, the Git tab, the autofetch poller
  // — republishes this repo's refs, which is exactly when a new branch becomes
  // launchable. Silent: the list is already on screen, so swap it in place.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let dropped = false;
    import("@tauri-apps/api/event").then(({ listen }) =>
      listen<string>("git:fetched", (e) => {
        if (e.payload === app.root_dir) void reload({ silent: true });
      }).then((fn) => {
        if (dropped) fn();
        else unlisten = fn;
      }),
    );
    return () => { dropped = true; unlisten?.(); };
  }, [app.root_dir, reload]);

  async function handleFetch() {
    if (fetching) return;
    setFetching(true);
    try {
      await gitFetch(app.root_dir);
      // The `git:fetched` listener normally reloads us, but only inside Tauri —
      // reload explicitly so the button means the same thing everywhere.
      await reload({ silent: true });
    } catch (e) {
      if (mountedRef.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mountedRef.current) setFetching(false);
    }
  }

  // Branches unavailable to launch: already backing an instance, or already
  // checked out in a worktree (incl. the primary checkout → main is skipped too).
  const takenBranches = useMemo(() => {
    const set = new Set<string>();
    for (const inst of instances) if (inst.branch) set.add(inst.branch);
    for (const wt of worktrees) if (wt.branch) set.add(wt.branch);
    return set;
  }, [instances, worktrees]);

  // Local branches first, then remote-only ones (`origin/x` with no local `x`),
  // which is how a branch someone else pushed shows up: fetched, never checked
  // out. Launching one makes the local branch off the tracking ref.
  const availableBranches = useMemo<Candidate[]>(() => {
    if (!branches) return [];
    const local = branches.local
      .filter((b) => !takenBranches.has(b))
      .map<Candidate>((b) => ({ name: b, ref: b, remote: false }));
    const localNames = new Set(branches.local);
    const seen = new Set(local.map((c) => c.name));
    const remote: Candidate[] = [];
    for (const r of branches.remote) {
      const short = r.slice(r.indexOf("/") + 1);
      if (!short || localNames.has(short) || takenBranches.has(short) || seen.has(short)) continue;
      seen.add(short);
      remote.push({ name: short, ref: r, remote: true });
    }
    return [...local, ...remote];
  }, [branches, takenBranches]);

  // Same shape as the branch switcher: unfiltered shows a short head of the
  // list, typing searches the whole thing.
  const LIST_CAP = 6;
  const q = query.trim();
  const filtered = useMemo(
    () => availableBranches.filter((b) => q === "" || b.name.toLowerCase().includes(q.toLowerCase())),
    [availableBranches, q],
  );
  const capped = q === "" ? filtered.slice(0, LIST_CAP) : filtered;
  const hiddenCount = filtered.length - capped.length;
  // Offer create only when nothing in the repo already answers to that name —
  // including branches that are taken, which can't be created a second time.
  const knownBranches = useMemo(() => {
    const set = new Set(branches?.local ?? []);
    for (const b of takenBranches) set.add(b);
    // A name that only exists on the remote can't be created either — it's
    // offered as a launchable branch a few rows up.
    for (const r of branches?.remote ?? []) set.add(r.slice(r.indexOf("/") + 1));
    return set;
  }, [branches, takenBranches]);
  const showCreate = q !== "" && !knownBranches.has(q);

  async function handleRunExisting(branch: Candidate) {
    if (busy) return;
    setError(null);
    setRunningBranch(branch.name);
    try {
      await runInstanceOnBranch(app.id, app.root_dir, branch.ref, false);
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
        <div className="flex items-center gap-1">
          <Tooltip label="Fetch from the remote and refresh this list" side="bottom" className="inline-flex">
          <button
            onClick={handleFetch}
            disabled={fetching || busy}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-ink-3 hover:text-ink-2 hover:bg-white/[0.06] transition-colors disabled:pointer-events-none disabled:opacity-40"
          >
            {fetching ? (
              <Spinner size={11} />
            ) : (
              <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <path d="M6 1.5a4.5 4.5 0 1 1-4.24 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                <path d="M1.5 2.2v2.4h2.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
            {fetching ? "Fetching…" : "Fetch"}
          </button>
          </Tooltip>
          <Tooltip label="Close" side="bottom" className="inline-flex">
          <button
            onClick={onClose}
            className="p-0.5 rounded text-ink-3 hover:text-ink-2 hover:bg-white/[0.06] transition-colors"
            aria-label="Close picker"
          >
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
              <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
          </Tooltip>
        </div>
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
                  ? "No other branches available — type a name to create one."
                  : "No matching branch."}
              </p>
            ) : (
              capped.map((b) => (
                <button
                  key={b.ref}
                  onClick={() => handleRunExisting(b)}
                  disabled={busy}
                  className="group flex items-center gap-2 rounded-control px-2 py-1.5 text-left transition-colors hover:bg-white/[0.05] disabled:pointer-events-none disabled:opacity-40"
                >
                  {runningBranch === b.name ? (
                    <Spinner size={12} className="text-accent" />
                  ) : (
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="text-ink-3 shrink-0" aria-hidden="true">
                      <circle cx="3" cy="3" r="1.5" stroke="currentColor" strokeWidth="1.1" />
                      <circle cx="3" cy="9" r="1.5" stroke="currentColor" strokeWidth="1.1" />
                      <circle cx="9" cy="3" r="1.5" stroke="currentColor" strokeWidth="1.1" />
                      <path d="M3 4.5v3M9 4.5c0 2-2 2.5-4.5 2.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
                    </svg>
                  )}
                  <span className="text-[12px] text-ink truncate font-mono">{b.name}</span>
                  {b.remote && (
                    // Not checked out anywhere yet — running it creates the local
                    // branch tracking this ref.
                    <span className="shrink-0 rounded bg-white/[0.06] px-1 py-px text-[9px] font-mono text-ink-3">
                      {b.ref.slice(0, b.ref.indexOf("/"))}
                    </span>
                  )}
                  <span className="ml-auto text-[10px] text-accent opacity-0 group-hover:opacity-100 transition-opacity">
                    {runningBranch === b.name ? "Running…" : "Run"}
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
