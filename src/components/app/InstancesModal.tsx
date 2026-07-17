import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/react/shallow";
import { usePortaStore } from "../../store";
import type { App, Workspace } from "../../types";
import type { AppInstance, BranchList, WorktreeEntry } from "../../lib/commands";
import { gitBranches, gitWorktreeList } from "../../lib/commands";
import { deriveInstanceApp } from "../../lib/instance-app";
import { Button, Input, Spinner } from "../ui";
import AppCard from "./AppCard";

export default function InstancesModal({
  app, workspace, instances, onOpenTerminal, onClose,
}: {
  app: App; workspace: Workspace | null; instances: AppInstance[];
  onOpenTerminal?: (app: App, startupCommand?: string) => void;
  onClose: () => void;
}) {
  // Tracks whether press-and-release both started on the overlay — mirrors
  // ModalWrapper's guard against accidental close when dragging out of the
  // panel or when a native dialog re-routes its dismiss-click to the overlay.
  const downOnOverlayRef = useRef(false);

  // Run-on-branch: launch an instance BY branch without hand-creating a
  // worktree first. Creates (or reuses) a worktree for the branch, then runs.
  const { runInstanceOnBranch, refreshInstances } = usePortaStore(
    useShallow((s) => ({
      runInstanceOnBranch: s.runInstanceOnBranch,
      refreshInstances: s.refreshInstances,
    })),
  );

  const [pickerOpen, setPickerOpen] = useState(false);
  const [branches, setBranches] = useState<BranchList | null>(null);
  const [worktrees, setWorktrees] = useState<WorktreeEntry[]>([]);
  const [loadingBranches, setLoadingBranches] = useState(false);
  const [newBranch, setNewBranch] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Branch name of the existing-branch run in flight (drives its row spinner);
  // separate flag for the create-new run. Any in-flight run makes the picker
  // `busy` so we don't fire two worktree adds at once.
  const [runningBranch, setRunningBranch] = useState<string | null>(null);
  const [creatingNew, setCreatingNew] = useState(false);
  const busy = runningBranch !== null || creatingNew;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Load the repo's branches + existing worktrees when the picker opens, so we
  // can list local branches and skip ones already checked out somewhere.
  useEffect(() => {
    if (!pickerOpen) return;
    let cancelled = false;
    setLoadingBranches(true);
    setError(null);
    Promise.all([gitBranches(app.root_dir), gitWorktreeList(app.root_dir).catch(() => [] as WorktreeEntry[])])
      .then(([bl, wl]) => {
        if (cancelled) return;
        setBranches(bl);
        setWorktrees(wl);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoadingBranches(false);
      });
    return () => { cancelled = true; };
  }, [pickerOpen, app.root_dir]);

  // Branches unavailable to launch: already backing a running/known instance,
  // or already checked out in a worktree (incl. the primary checkout, whose
  // branch appears in gitWorktreeList — so the main branch is skipped too).
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

  function closePicker() {
    setPickerOpen(false);
    setNewBranch("");
    setError(null);
    setBranches(null);
    setWorktrees([]);
  }

  async function handleRunExisting(branch: string) {
    if (busy) return;
    setError(null);
    setRunningBranch(branch);
    try {
      await runInstanceOnBranch(app.id, app.root_dir, branch, false);
      await refreshInstances(app.id);
      closePicker();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunningBranch(null);
    }
  }

  async function handleCreateNew() {
    const name = newBranch.trim();
    if (!name || busy) return;
    setError(null);
    setCreatingNew(true);
    try {
      await runInstanceOnBranch(app.id, app.root_dir, name, true);
      await refreshInstances(app.id);
      closePicker();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreatingNew(false);
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center"
      onMouseDown={(e) => {
        downOnOverlayRef.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (downOnOverlayRef.current && e.target === e.currentTarget) {
          onClose();
        }
        downOnOverlayRef.current = false;
      }}
    >
      <div
        className="w-[min(1200px,92vw)] max-h-[88vh] overflow-y-auto rounded-2xl bg-[#1a1a1c] border border-white/[0.08] shadow-2xl p-4"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium text-zinc-200">
            {app.name} — Instances ({instances.length})
          </h2>
          <div className="flex items-center gap-2">
            <Button
              variant="accent"
              size="sm"
              aria-expanded={pickerOpen}
              onClick={() => (pickerOpen ? closePicker() : setPickerOpen(true))}
              icon={
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <path d="M6 2.5v7M2.5 6h7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
              }
            >
              Run on branch…
            </Button>
            <button
              onClick={onClose}
              className="p-1 rounded-lg text-zinc-600 hover:text-zinc-300 hover:bg-white/[0.06] transition-colors"
              title="Close (Esc)"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </div>

        {/* ── Run-on-branch picker ── */}
        {pickerOpen && (
          <div className="mb-3 rounded-xl border border-subtle bg-surface-1 p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[12px] font-medium text-ink">Run an instance on a branch</span>
              <button
                onClick={closePicker}
                className="p-0.5 rounded text-ink-3 hover:text-ink-2 hover:bg-white/[0.06] transition-colors"
                title="Close picker"
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

            {loadingBranches ? (
              <div className="flex items-center gap-2 py-2 text-[12px] text-ink-3">
                <Spinner size={13} /> Loading branches…
              </div>
            ) : (
              <>
                <div className="flex flex-col gap-0.5 max-h-[220px] overflow-y-auto">
                  {availableBranches.length === 0 ? (
                    <p className="py-1 text-[11px] text-ink-3">
                      No other local branches available — create one below.
                    </p>
                  ) : (
                    availableBranches.map((b) => (
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
                </div>

                <div className="mt-2 pt-2 border-t border-subtle flex items-center gap-2">
                  <Input
                    value={newBranch}
                    onChange={(e) => setNewBranch(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { e.preventDefault(); handleCreateNew(); }
                    }}
                    placeholder="new-branch-name"
                    disabled={busy}
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    className="py-1.5 text-[12px] font-mono"
                  />
                  <Button
                    variant="accent"
                    size="sm"
                    loading={creatingNew}
                    disabled={busy || newBranch.trim().length === 0}
                    onClick={handleCreateNew}
                    className="shrink-0"
                  >
                    Create &amp; run
                  </Button>
                </div>
                <p className="mt-1.5 text-[10px] text-ink-3">
                  Creates a worktree off HEAD in a sibling <span className="font-mono">-worktrees/</span> dir, then runs it.
                </p>
              </>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {instances.map((inst) => (
            <AppCard
              key={inst.id}
              app={deriveInstanceApp(app, inst)}
              workspace={workspace}
              variant="instance"
              instance={inst}
              onOpenTerminal={onOpenTerminal}
            />
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
