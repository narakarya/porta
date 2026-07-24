import { useCallback, useEffect, useRef, useState } from "react";
import { gitBranches, gitWorktreeList, type BranchList, type WorktreeEntry } from "../lib/commands";

/**
 * A repo's branches + worktrees, kept current across fetches.
 *
 * Both surfaces that offer branches — the header badge's switcher and the
 * run-on-branch picker — read the same two commands, and both are only correct
 * for as long as nobody fetches. `git_fetch` (manual or from the autofetch
 * poller) emits `git:fetched`, so the reload belongs here rather than in each
 * consumer: the badge used to load its list once when its popover opened, which
 * meant clicking Fetch right there in the popover updated the ahead/behind
 * counts but never the branch list. A branch a teammate pushed stayed invisible
 * until the popover was closed and reopened, while the picker — which did
 * listen — showed it immediately. Same op, two answers.
 *
 * `enabled` gates the work for surfaces that only need refs while open (the
 * badge) or for apps where branch operations don't apply at all.
 */
export function useGitRefs(rootDir: string, enabled = true) {
  const [branches, setBranches] = useState<BranchList | null>(null);
  const [worktrees, setWorktrees] = useState<WorktreeEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reloads are driven by events that can outlive the consumer, so a ref (not a
  // per-effect cancelled flag) is what stops a late response setting state.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const reload = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!enabled || !rootDir) return;
      if (!opts?.silent) setLoading(true);
      try {
        const [bl, wl] = await Promise.all([
          gitBranches(rootDir),
          gitWorktreeList(rootDir).catch(() => [] as WorktreeEntry[]),
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
    [rootDir, enabled],
  );

  useEffect(() => { void reload(); }, [reload]);

  // A fetch from anywhere — this surface, the other one, the Git tab, the
  // autofetch poller — republishes the repo's refs, which is exactly when a new
  // branch becomes available. Silent: whatever is on screen swaps in place.
  useEffect(() => {
    if (!enabled || !rootDir) return;
    let unlisten: (() => void) | null = null;
    let dropped = false;
    import("@tauri-apps/api/event").then(({ listen }) =>
      listen<string>("git:fetched", (e) => {
        if (e.payload === rootDir) void reload({ silent: true });
      }).then((fn) => {
        if (dropped) fn();
        else unlisten = fn;
      }),
    );
    return () => { dropped = true; unlisten?.(); };
  }, [rootDir, reload, enabled]);

  return { branches, worktrees, loading, error, reload, setError };
}
