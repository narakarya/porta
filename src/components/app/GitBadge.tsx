import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePortaStore } from "../../store";
import { gitFetch, gitPull, gitPush, gitStatus, gitWorktreeList, type WorktreeEntry, type AppInstance } from "../../lib/commands";
import { useFloatingPosition, useMeasuredSize } from "../shared/useFloatingPosition";
import type { App } from "../../types";

interface Props {
  app: App;
  onOpenTerminal?: (app: App) => void;
}

type Busy = "fetch" | "pull" | "push" | null;

// Stable empty reference. Returning `?? []` straight from a Zustand selector
// yields a new array every render, which `useSyncExternalStore` reads as a new
// snapshot each time → infinite re-render ("Maximum update depth exceeded").
const EMPTY_INSTANCES: AppInstance[] = [];

/** Inline spinner — the ops run off the main thread now, so this actually animates. */
function Spinner({ className = "" }: { className?: string }) {
  return (
    <svg
      width="10" height="10" viewBox="0 0 12 12" fill="none"
      className={`animate-spin ${className}`}
      role="status" aria-label="Loading"
    >
      <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.5" />
      <path d="M6 1.5a4.5 4.5 0 0 1 4.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export default function GitBadge({ app, onOpenTerminal }: Props) {
  // The store is the single source of truth. The Rust poller writes
  // `appGit[app.id]` every 15s; we seed it once on mount (via setAppGit) so a
  // newly-added app doesn't sit blank until the first tick, and run() refreshes
  // it through the same action after a fetch/pull/push.
  const status = usePortaStore((s) => s.appGit[app.id]);
  const setAppGit = usePortaStore((s) => s.setAppGit);
  const pollError = usePortaStore((s) => s.appGitError[app.id]);
  const setAppGitError = usePortaStore((s) => s.setAppGitError);
  const instances = usePortaStore((s) => s.instances[app.id] ?? EMPTY_INSTANCES);
  const runInstance = usePortaStore((s) => s.runInstance);
  const stopInstanceAction = usePortaStore((s) => s.stopInstanceAction);
  const refreshInstances = usePortaStore((s) => s.refreshInstances);

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [worktrees, setWorktrees] = useState<WorktreeEntry[]>([]);
  const [wtQuery, setWtQuery] = useState("");
  const [wtBusy, setWtBusy] = useState<string | null>(null);

  // Tracks "already probed, this dir isn't a repo". The store maps to
  // GitStatus (never null), so a non-repo can't be recorded there — this ref
  // is local UI bookkeeping that stops the seeding effect from re-firing
  // gitStatus on every render for a non-repo app.
  const probedNonRepo = useRef(false);
  // Unmount guard for run()'s async writes, mirroring the seeding effect's
  // cancelled flag.
  // Set in setup, not just cleared in cleanup: StrictMode runs setup → cleanup →
  // setup on mount, and a ref that is only ever set false would stay false for
  // the component's whole life, wedging every button on `busy`.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // A root_dir edit can turn a non-repo into a repo; forget the earlier verdict.
  useEffect(() => { probedNonRepo.current = false; }, [app.root_dir]);

  useEffect(() => {
    if (status || probedNonRepo.current || !app.root_dir) return;
    let cancelled = false;
    gitStatus(app.root_dir)
      .then((s) => {
        if (cancelled) return;
        if (s) setAppGit(app.id, s);
        else probedNonRepo.current = true;
      })
      .catch((e) => {
        if (!cancelled) setAppGitError(app.id, String(e));
      });
    return () => { cancelled = true; };
  }, [app.id, app.root_dir, status, setAppGit, setAppGitError]);

  // A failed op's error must not survive close/reopen — clear it on close.
  useEffect(() => {
    if (!open) setError(null);
  }, [open]);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelSize = useMeasuredSize(panelRef, open);
  const coords = useFloatingPosition({
    triggerRef,
    panelSize,
    active: open,
    side: "bottom",
    align: "start",
    gap: 4,
  });

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") setOpen(false); }
    function onClick(e: MouseEvent) {
      const t = e.target as Node;
      if (!triggerRef.current?.contains(t) && !panelRef.current?.contains(t)) setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  // Load existing worktrees + current instances whenever the popover opens.
  useEffect(() => {
    if (!open || !app.root_dir) return;
    gitWorktreeList(app.root_dir).then(setWorktrees).catch(() => setWorktrees([]));
    refreshInstances(app.id);
  }, [open, app.root_dir, app.id, refreshInstances]);

  // Keep instance state fresh on ready/exit events for this app's instances.
  useEffect(() => {
    if (!open) return;
    const unlisten: Array<() => void> = [];
    import("@tauri-apps/api/event").then(({ listen }) => {
      for (const inst of instances) {
        listen(`instance:ready:${inst.id}`, () => refreshInstances(app.id)).then((u) => unlisten.push(u));
        listen(`instance:exit:${inst.id}`, () => refreshInstances(app.id)).then((u) => unlisten.push(u));
      }
    });
    return () => unlisten.forEach((u) => u());
  }, [open, instances, app.id, refreshInstances]);

  // A repo we couldn't read still deserves a badge: a silent disappearance is
  // what this whole change exists to fix.
  if (!status && !pollError) return null;

  // An error outranks a status, even a status we already have. Once git stops
  // being readable, the last branch and ahead/behind counts we saw are a claim
  // we can no longer stand behind — showing them is worse than showing nothing.
  // The poller emits an empty string here to retract a resolved error.
  if (pollError) {
    return (
      <>
        <button
          ref={triggerRef}
          onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
          className="inline-flex items-center gap-1 text-[10px] font-mono leading-none text-amber-400/80 hover:bg-white/[0.05] rounded px-1 py-0.5 transition-colors"
          title="Porta couldn't read this repo"
        >
          <span>git ⚠</span>
        </button>
        {open && createPortal(
          <div
            ref={panelRef}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            className="fixed z-[60] w-[280px] rounded-md bg-[#1c1c1e] border border-white/10 shadow-xl p-2 text-[11px]"
            style={coords ? { top: coords.top, left: coords.left } : { top: -9999, left: -9999, visibility: "hidden" }}
          >
            <div className="text-zinc-400 mb-1.5">Porta couldn't read this repo</div>
            <pre className="text-[10px] font-mono text-amber-300 whitespace-pre-wrap break-words max-h-28 overflow-y-auto">
              {pollError}
            </pre>
            <div className="flex items-center gap-2 mt-1">
              <button
                onClick={() => navigator.clipboard.writeText(pollError)}
                className="text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                Copy error
              </button>
              {/* Every fix for this — `safe.directory`, repairing `.git/config` —
                  happens in a shell, so give the user one from here. */}
              {onOpenTerminal && (
                <button
                  onClick={() => { setOpen(false); onOpenTerminal(app); }}
                  className="text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors"
                >
                  Open terminal
                </button>
              )}
            </div>
          </div>,
          document.body,
        )}
      </>
    );
  }

  async function run(kind: Exclude<Busy, null>) {
    setBusy(kind);
    setError(null);
    try {
      if (kind === "fetch") await gitFetch(app.root_dir);
      else if (kind === "pull") await gitPull(app.root_dir);
      else await gitPush(app.root_dir);
      // Refresh immediately rather than waiting up to 15s for the next poll.
      // Writes through the store so the badge (which reads only the store) updates.
      const fresh = await gitStatus(app.root_dir);
      if (!mountedRef.current) return;
      if (fresh) setAppGit(app.id, fresh);
    } catch (e) {
      if (mountedRef.current) setError(String(e));
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }

  const { branch, ahead, behind, dirty, upstream, detached } = status;

  return (
    <>
      <button
        ref={triggerRef}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        className="inline-flex items-center gap-1 text-[10px] font-mono leading-none hover:bg-white/[0.05] rounded px-1 py-0.5 transition-colors"
        title={detached ? "Detached HEAD" : upstream ?? "No upstream"}
      >
        <span className="text-zinc-500 truncate max-w-[14ch]">{branch}</span>
        {ahead > 0 && <span className="text-blue-300">↑{ahead}</span>}
        {behind > 0 && <span className="text-amber-300">↓{behind}</span>}
        {/* Activity stays visible on the card even with the popover closed. */}
        {busy !== null && <Spinner className="text-zinc-400" />}
      </button>

      {open && createPortal(
        <div
          ref={panelRef}
          // createPortal moves this to <body>, but React synthetic events still
          // bubble along the React tree into AppCard's clickable region (which
          // opens the settings modal). Stop propagation here so no click inside
          // the popover reaches it. The window `mousedown` outside-click listener
          // uses real-DOM contains(), so it's unaffected.
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          className="fixed z-[60] w-[260px] rounded-md bg-[#1c1c1e] border border-white/10 shadow-xl p-2 text-[11px]"
          style={coords ? { top: coords.top, left: coords.left } : { top: -9999, left: -9999, visibility: "hidden" }}
        >
          <div className="font-mono text-zinc-400 truncate mb-1.5">
            {branch}
            {upstream && <span className="text-zinc-600"> → {upstream}</span>}
          </div>

          <div className="grid grid-cols-3 gap-1 mb-2 font-mono text-[10px]">
            <div className="text-zinc-600">↑ {ahead} to push</div>
            <div className="text-zinc-600">↓ {behind} to pull</div>
            <div className="text-zinc-600">● {dirty} dirty</div>
          </div>

          <div className="flex gap-1">
            <button
              onClick={() => run("fetch")}
              disabled={busy !== null}
              className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1 rounded bg-white/[0.05] hover:bg-white/[0.09] disabled:opacity-40 text-zinc-300 transition-colors"
            >
              {busy === "fetch" && <Spinner />}
              Fetch
            </button>
            <button
              onClick={() => run("pull")}
              disabled={busy !== null || behind === 0}
              className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1 rounded bg-white/[0.05] hover:bg-white/[0.09] disabled:opacity-40 text-zinc-300 transition-colors"
            >
              {busy === "pull" && <Spinner />}
              Pull
            </button>
            <button
              onClick={() => run("push")}
              disabled={busy !== null || ahead === 0}
              className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1 rounded bg-white/[0.05] hover:bg-white/[0.09] disabled:opacity-40 text-zinc-300 transition-colors"
            >
              {busy === "push" && <Spinner />}
              Push
            </button>
          </div>

          {/* Run from worktree — existing worktrees only; exclude the primary checkout. */}
          {(() => {
            const branchWts = worktrees.filter((w) => w.path !== app.root_dir && w.branch);
            const others = branchWts.filter(
              (w) =>
                wtQuery === "" ||
                (w.branch ?? "").toLowerCase().includes(wtQuery.toLowerCase()) ||
                w.path.toLowerCase().includes(wtQuery.toLowerCase()),
            );
            const runningByPath = new Map(instances.map((i) => [i.worktree_path, i]));
            return (
              <div className="mt-2 border-t border-white/10 pt-2">
                <div className="text-[10px] text-zinc-500 mb-1">Run from worktree</div>
                {branchWts.length > 3 && (
                  <input
                    value={wtQuery}
                    onChange={(e) => setWtQuery(e.target.value)}
                    placeholder="Search branch…"
                    className="w-full mb-1 px-1.5 py-1 rounded bg-white/[0.04] text-[11px] text-zinc-200 placeholder-zinc-600 outline-none"
                  />
                )}
                {others.length === 0 && (
                  <div className="text-[10px] text-zinc-600">No other worktrees.</div>
                )}
                {others.map((w) => {
                  const inst = runningByPath.get(w.path);
                  return (
                    <div key={w.path} className="flex items-center gap-1 py-0.5 text-[11px]">
                      <span className="font-mono text-zinc-300 truncate flex-1" title={w.path}>
                        {w.branch}
                      </span>
                      {inst ? (
                        <>
                          <span
                            className="text-emerald-400/80 text-[10px] font-mono truncate max-w-[10ch]"
                            title={`${inst.subdomain}.test → :${inst.port}`}
                          >
                            {inst.status === "running" ? `:${inst.port}` : inst.status}
                          </span>
                          <button
                            onClick={() => stopInstanceAction(inst.id, app.id)}
                            className="text-[10px] text-zinc-500 hover:text-red-300 px-1"
                          >
                            Stop
                          </button>
                        </>
                      ) : (
                        <button
                          disabled={wtBusy !== null}
                          onClick={async () => {
                            setWtBusy(w.path);
                            setError(null);
                            try {
                              await runInstance(app.id, w.path);
                            } catch (e) {
                              setError(String(e));
                            } finally {
                              setWtBusy(null);
                            }
                          }}
                          className="text-[10px] text-zinc-300 hover:bg-white/[0.09] rounded px-1.5 py-0.5 disabled:opacity-40"
                        >
                          {wtBusy === w.path ? "…" : "Run"}
                        </button>
                      )}
                    </div>
                  );
                })}
                <div className="text-[9px] text-zinc-600 mt-1 leading-tight">
                  Sets a distinct PORT per instance. Stateful apps (e.g. Phoenix) may still
                  share a dev DB unless configured to read PORT/env.
                </div>
              </div>
            );
          })()}

          {onOpenTerminal && (
            <button
              onClick={() => { setOpen(false); onOpenTerminal(app); }}
              className="w-full mt-1 px-2 py-1 rounded text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.05] transition-colors text-left"
            >
              Open terminal in {app.root_dir.replace(/\/+$/, "").split("/").pop() || app.root_dir}
            </button>
          )}

          {error && (
            <div className="mt-2 p-1.5 rounded bg-red-500/10 border border-red-500/20">
              <pre className="text-[10px] font-mono text-red-300 whitespace-pre-wrap break-words max-h-24 overflow-y-auto">
                {error}
              </pre>
              <button
                onClick={() => navigator.clipboard.writeText(error)}
                className="mt-1 text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                Copy error
              </button>
            </div>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
