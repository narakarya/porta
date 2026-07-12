import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { usePortaStore } from "../../store";
import { gitBranches, gitFetch, gitPull, gitPush, gitStatus, gitSwitchBranch, gitWorktreeList, type BranchList, type WorktreeEntry, type AppInstance } from "../../lib/commands";
import { useFloatingPosition, useMeasuredSize } from "../shared/useFloatingPosition";
import type { App } from "../../types";

interface Props {
  app: App;
  onOpenTerminal?: (app: App) => void;
  /** Instance cards use a synthetic app whose id is an instance id, not a real
   * app id — the "Run from worktree" launcher's `runInstance(app.id, ...)`
   * calls would hit the backend with that instance id and fail with "app not
   * found". Set true on instance-context renders to hide the launcher. */
  hideWorktreeLauncher?: boolean;
}

type Busy = "fetch" | "pull" | "push" | null;

// Stable empty reference. Returning `?? []` straight from a Zustand selector
// yields a new array every render, which `useSyncExternalStore` reads as a new
// snapshot each time → infinite re-render ("Maximum update depth exceeded").
const EMPTY_INSTANCES: AppInstance[] = [];

// The ops run off the main thread now, so these actually animate. Each git op
// gets a directional icon whose loading animation mirrors its meaning: fetch
// spins (sync), pull pulls down, push pushes up.

/** Circular sync arrows — fetch. Spins while fetching. */
function SyncIcon({ spinning = false, className = "" }: { spinning?: boolean; className?: string }) {
  return (
    <svg
      width="10" height="10" viewBox="0 0 12 12" fill="none"
      className={`${spinning ? "animate-spin" : ""} ${className}`}
      role={spinning ? "status" : undefined} aria-label={spinning ? "Fetching" : undefined}
    >
      <path d="M2 6a4 4 0 0 1 6.9-2.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M9 1.2v2.4H6.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 6a4 4 0 0 1-6.9 2.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M3 10.8V8.4h2.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Down arrow — pull. Bounces downward while pulling. */
function ArrowDownIcon({ animate = false, className = "" }: { animate?: boolean; className?: string }) {
  return (
    <svg
      width="10" height="10" viewBox="0 0 12 12" fill="none"
      className={`${animate ? "animate-bounce-down" : ""} ${className}`}
      role={animate ? "status" : undefined} aria-label={animate ? "Pulling" : undefined}
    >
      <path d="M6 2v7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M3 6.5 6 9.5 9 6.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Up arrow — push. Bounces upward while pushing. */
function ArrowUpIcon({ animate = false, className = "" }: { animate?: boolean; className?: string }) {
  return (
    <svg
      width="10" height="10" viewBox="0 0 12 12" fill="none"
      className={`${animate ? "animate-bounce-up" : ""} ${className}`}
      role={animate ? "status" : undefined} aria-label={animate ? "Pushing" : undefined}
    >
      <path d="M6 10V3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M3 5.5 6 2.5 9 5.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Truncates with an ellipsis by default; on hover, if the text overflows, it
 * slides sideways (marquee) far enough to reveal the tail, then settles back.
 * The shift distance is measured on enter and fed to the keyframe via a CSS var,
 * so a branch that fits never animates.
 */
function MarqueeOnHover({ text, className = "" }: { text: string; className?: string }) {
  const outerRef = useRef<HTMLSpanElement>(null);
  const [shift, setShift] = useState(0);
  const animating = shift < 0;

  function onEnter() {
    const el = outerRef.current;
    if (!el) return;
    const overflow = el.scrollWidth - el.clientWidth;
    if (overflow > 1) setShift(-overflow);
  }

  return (
    <span
      ref={outerRef}
      onMouseEnter={onEnter}
      onMouseLeave={() => setShift(0)}
      className={`inline-block max-w-full overflow-hidden align-bottom ${animating ? "whitespace-nowrap" : "truncate"} ${className}`}
    >
      <span
        className={animating ? "inline-block animate-marquee-hover" : ""}
        style={animating ? ({ "--marquee-shift": `${shift}px` } as CSSProperties) : undefined}
      >
        {text}
      </span>
    </span>
  );
}

export default function GitBadge({ app, onOpenTerminal, hideWorktreeLauncher = false }: Props) {
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

  // Clicking the badge (git icon + branch name) opens the main popover: stats,
  // fetch/pull/push, and — on non-instance cards — a "Switch branch" row and
  // "Run from worktree". "Switch branch" opens a second popover (`switchOpen`)
  // that flies out to the right of the main one, so the git-ops stay put.
  const [mainOpen, setMainOpen] = useState(false);
  const [switchOpen, setSwitchOpen] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [worktrees, setWorktrees] = useState<WorktreeEntry[]>([]);
  const [wtQuery, setWtQuery] = useState("");
  const [wtBusy, setWtBusy] = useState<string | null>(null);
  const [showAllWorktrees, setShowAllWorktrees] = useState(false);
  const [branches, setBranches] = useState<BranchList | null>(null);
  const [branchQuery, setBranchQuery] = useState("");
  const [switching, setSwitching] = useState<string | null>(null);

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

  // A failed op's error must not survive close/reopen — clear it once the main
  // popover shuts (the switch flyout can't outlive it).
  useEffect(() => {
    if (!mainOpen) { setError(null); setSwitchOpen(false); }
  }, [mainOpen]);

  // Badge chip → main popover (anchored below the badge).
  const mainTriggerRef = useRef<HTMLButtonElement>(null);
  const mainPanelRef = useRef<HTMLDivElement>(null);
  const mainSize = useMeasuredSize(mainPanelRef, mainOpen);
  const mainCoords = useFloatingPosition({
    triggerRef: mainTriggerRef,
    panelSize: mainSize,
    active: mainOpen,
    side: "bottom",
    align: "start",
    gap: 4,
  });

  // "Switch branch" row inside the main popover → flyout to its right.
  const switchTriggerRef = useRef<HTMLButtonElement>(null);
  const switchPanelRef = useRef<HTMLDivElement>(null);
  const switchSize = useMeasuredSize(switchPanelRef, switchOpen);
  const switchCoords = useFloatingPosition({
    triggerRef: switchTriggerRef,
    panelSize: switchSize,
    active: switchOpen,
    side: "right",
    align: "start",
    gap: 6,
  });

  useEffect(() => {
    if (!mainOpen) return;
    function onKey(e: KeyboardEvent) {
      // Esc peels one layer: close the flyout first, then the main popover.
      if (e.key !== "Escape") return;
      if (switchOpen) setSwitchOpen(false);
      else setMainOpen(false);
    }
    function onClick(e: MouseEvent) {
      const t = e.target as Node;
      const inMain = !!mainTriggerRef.current?.contains(t) || !!mainPanelRef.current?.contains(t);
      const inSwitch = !!switchPanelRef.current?.contains(t);
      if (!inMain && !inSwitch) { setMainOpen(false); setSwitchOpen(false); }
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, [mainOpen, switchOpen]);

  // Load worktrees + branches + current instances when the main popover opens —
  // both "Switch branch" and "Run from worktree" read them.
  useEffect(() => {
    if (!mainOpen || !app.root_dir) return;
    gitWorktreeList(app.root_dir).then(setWorktrees).catch(() => setWorktrees([]));
    gitBranches(app.root_dir).then(setBranches).catch(() => setBranches(null));
    refreshInstances(app.id);
  }, [mainOpen, app.root_dir, app.id, refreshInstances]);

  // Keep instance state fresh on ready/exit events for this app's instances.
  useEffect(() => {
    if (!mainOpen) return;
    const unlisten: Array<() => void> = [];
    import("@tauri-apps/api/event").then(({ listen }) => {
      for (const inst of instances) {
        listen(`instance:ready:${inst.id}`, () => refreshInstances(app.id)).then((u) => unlisten.push(u));
        listen(`instance:exit:${inst.id}`, () => refreshInstances(app.id)).then((u) => unlisten.push(u));
      }
    });
    return () => unlisten.forEach((u) => u());
  }, [mainOpen, instances, app.id, refreshInstances]);

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
          ref={mainTriggerRef}
          onClick={(e) => { e.stopPropagation(); setMainOpen((v) => !v); }}
          className="inline-flex items-center gap-1 text-[10px] font-mono leading-none text-amber-400/80 hover:bg-white/[0.05] rounded px-1 py-0.5 transition-colors"
          title="Porta couldn't read this repo"
        >
          <span>git ⚠</span>
        </button>
        {mainOpen && createPortal(
          <div
            ref={mainPanelRef}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            className="fixed z-[60] w-[280px] rounded-md bg-[#1c1c1e] border border-white/10 shadow-xl p-2 text-[11px]"
            style={mainCoords ? { top: mainCoords.top, left: mainCoords.left } : { top: -9999, left: -9999, visibility: "hidden" }}
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
                  onClick={() => { setMainOpen(false); onOpenTerminal(app); }}
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

  async function switchTo(name: string, create: boolean) {
    setSwitching(name);
    setError(null);
    try {
      await gitSwitchBranch(app.root_dir, name, create);
      const fresh = await gitStatus(app.root_dir);
      if (!mountedRef.current) return;
      if (fresh) setAppGit(app.id, fresh);
      await gitBranches(app.root_dir).then(setBranches).catch(() => {});
      setBranchQuery("");
    } catch (e) {
      if (mountedRef.current) setError(String(e));
    } finally {
      if (mountedRef.current) setSwitching(null);
    }
  }

  const { branch, ahead, behind, dirty, upstream, detached } = status;

  return (
    <>
      {/* Badge — git-branch icon + current branch name. Opens the main popover. */}
      <button
        ref={mainTriggerRef}
        onClick={(e) => { e.stopPropagation(); setMainOpen((v) => !v); }}
        className="inline-flex items-center gap-1 text-[10px] font-mono leading-none text-zinc-500 hover:bg-white/[0.05] rounded px-1 py-0.5 transition-colors"
        title={detached ? "Detached HEAD" : upstream ?? "No upstream"}
      >
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" className="shrink-0 text-zinc-500">
          <circle cx="4.5" cy="3.5" r="1.75" stroke="currentColor" strokeWidth="1.3" />
          <circle cx="4.5" cy="12.5" r="1.75" stroke="currentColor" strokeWidth="1.3" />
          <circle cx="11.5" cy="4.5" r="1.75" stroke="currentColor" strokeWidth="1.3" />
          <path d="M4.5 5.25v5.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          <path d="M11.5 6.25c0 2.6-1.9 3.5-4.2 3.9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
        <span className="truncate max-w-[14ch]">{branch}</span>
        {ahead > 0 && <span className="text-blue-300">↑{ahead}</span>}
        {behind > 0 && <span className="text-amber-300">↓{behind}</span>}
        {busy === "fetch" && <SyncIcon spinning className="text-zinc-400" />}
        {busy === "pull" && <ArrowDownIcon animate className="text-zinc-400" />}
        {busy === "push" && <ArrowUpIcon animate className="text-zinc-400" />}
      </button>

      {/* ── Main popover: stats + fetch/pull/push, plus (non-instance cards) the
           branch-switch trigger and worktree launcher ── */}
      {mainOpen && createPortal(
        <div
          ref={mainPanelRef}
          // createPortal moves this to <body>, but React synthetic events still
          // bubble along the React tree into AppCard's clickable region (which
          // opens the settings modal). Stop propagation here so no click inside
          // the popover reaches it. The window `mousedown` outside-click listener
          // uses real-DOM contains(), so it's unaffected.
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          className="fixed z-[60] w-[260px] rounded-md bg-[#1c1c1e] border border-white/10 shadow-xl p-2 text-[11px]"
          style={mainCoords ? { top: mainCoords.top, left: mainCoords.left } : { top: -9999, left: -9999, visibility: "hidden" }}
        >
          <div className="mb-1.5">
            <MarqueeOnHover text={branch} className="font-mono text-zinc-400 w-full" />
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
              <SyncIcon spinning={busy === "fetch"} />
              Fetch
            </button>
            <button
              onClick={() => run("pull")}
              disabled={busy !== null || behind === 0}
              className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1 rounded bg-white/[0.05] hover:bg-white/[0.09] disabled:opacity-40 text-zinc-300 transition-colors"
            >
              <ArrowDownIcon animate={busy === "pull"} />
              Pull
            </button>
            <button
              onClick={() => run("push")}
              disabled={busy !== null || ahead === 0}
              className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1 rounded bg-white/[0.05] hover:bg-white/[0.09] disabled:opacity-40 text-zinc-300 transition-colors"
            >
              <ArrowUpIcon animate={busy === "push"} />
              Push
            </button>
          </div>

          {/* Switch branch — opens the branch-list flyout to the right, so the
              git-ops above stay put. Hidden on instance cards (branch-pinned,
              synthetic app id). */}
          {!hideWorktreeLauncher && (
            <button
              ref={switchTriggerRef}
              onClick={() => { setError(null); setSwitchOpen((v) => !v); }}
              className={`mt-2 w-full flex items-center justify-between gap-1 px-2 py-1 rounded text-[11px] transition-colors ${switchOpen ? "bg-white/[0.09] text-zinc-100" : "bg-white/[0.05] hover:bg-white/[0.09] text-zinc-300"}`}
            >
              <span>Switch branch</span>
              <svg width="8" height="8" viewBox="0 0 8 8" fill="none" className="shrink-0 text-zinc-500">
                <path d="M3 1.5l2.5 2.5L3 6.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}

          {/* Run from worktree — existing worktrees only; exclude the primary
              checkout. Hidden on instance cards (app.id there is an instance id,
              so runInstance/stopInstanceAction would target the wrong thing). */}
          {!hideWorktreeLauncher && (() => {
            const branchWts = worktrees.filter((w) => w.path !== app.root_dir && w.branch);
            const others = branchWts.filter(
              (w) =>
                wtQuery === "" ||
                (w.branch ?? "").toLowerCase().includes(wtQuery.toLowerCase()) ||
                w.path.toLowerCase().includes(wtQuery.toLowerCase()),
            );
            const runningByPath = new Map(instances.map((i) => [i.worktree_path, i]));
            // Keep the list short by default; searching or "Show more" reveals the
            // rest. Running instances always show so an active one is never hidden.
            const LAUNCHER_CAP = 5;
            const isSearching = wtQuery.trim() !== "";
            const capped =
              showAllWorktrees || isSearching ? others : others.slice(0, LAUNCHER_CAP);
            const running = others.filter((w) => runningByPath.has(w.path));
            const visible = capped.concat(
              running.filter((w) => !capped.some((c) => c.path === w.path)),
            );
            const hiddenCount = others.length - visible.length;
            return (
              <div className="mt-2 border-t border-white/10 pt-2">
                <div className="text-[10px] text-zinc-500 mb-1">Run from worktree</div>
                {branchWts.length > LAUNCHER_CAP && (
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
                {visible.map((w) => {
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
                            title={inst.status === "running" ? "Stop & remove instance" : "Remove instance"}
                          >
                            {inst.status === "running" ? "Stop" : "Remove"}
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
                {!isSearching && (hiddenCount > 0 || showAllWorktrees) && others.length > LAUNCHER_CAP && (
                  <button
                    onClick={() => setShowAllWorktrees((v) => !v)}
                    className="mt-1 text-[10px] text-zinc-400 hover:text-zinc-200"
                  >
                    {hiddenCount > 0 ? `Show ${hiddenCount} more…` : "Show less"}
                  </button>
                )}
              </div>
            );
          })()}

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

      {/* ── Branch-list flyout — opens to the right of the main popover. Click a
           branch name to switch (or "Create <name>"); there is no Switch button. ── */}
      {switchOpen && createPortal(
        <div
          ref={switchPanelRef}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          className="fixed z-[61] w-[240px] rounded-md bg-[#1c1c1e] border border-white/10 shadow-xl p-2 text-[11px]"
          style={switchCoords ? { top: switchCoords.top, left: switchCoords.left } : { top: -9999, left: -9999, visibility: "hidden" }}
        >
          {branches && (() => {
            // Branches held by another worktree can't be switched to in the
            // primary checkout — git refuses. We already have `worktrees`.
            const heldByWorktree = new Set(
              worktrees
                .filter((w) => w.path !== app.root_dir && w.branch)
                .map((w) => w.branch as string),
            );
            // Merge local + remote-only, remote names stripped to short form so
            // `git switch <short>` triggers DWIM tracking-branch creation. Only
            // offer a remote short name when it's unambiguous: absent locally and
            // present in exactly one remote. When two remotes share it
            // (origin/foo + upstream/foo), a bare `git switch foo` is ambiguous,
            // so we skip it rather than surface a row that can only error — and
            // list keys stay unique.
            type Row = { name: string; kind: "local" | "remote" };
            const localSet = new Set(branches.local);
            const remoteShortCounts = new Map<string, number>();
            for (const r of branches.remote) {
              const short = r.replace(/^[^/]+\//, ""); // origin/foo → foo
              remoteShortCounts.set(short, (remoteShortCounts.get(short) ?? 0) + 1);
            }
            const rows: Row[] = branches.local.map((name) => ({ name, kind: "local" as const }));
            for (const [short, count] of remoteShortCounts) {
              if (count === 1 && !localSet.has(short)) rows.push({ name: short, kind: "remote" });
            }
            const q = branchQuery.trim();
            const filtered = rows.filter(
              (r) => q === "" || r.name.toLowerCase().includes(q.toLowerCase()),
            );
            const LAUNCHER_CAP = 5;
            const isSearching = q !== "";
            const capped = isSearching ? filtered : filtered.slice(0, LAUNCHER_CAP);
            const hiddenCount = filtered.length - capped.length;
            // Offer create only when the query matches no branch name exactly
            // (branch names are case-sensitive).
            const exactMatch = rows.some((r) => r.name === q);
            const showCreate = q !== "" && !exactMatch;
            return (
              <div>
                <div className="text-[10px] text-zinc-500 mb-1">Switch branch</div>
                <input
                  value={branchQuery}
                  onChange={(e) => setBranchQuery(e.target.value)}
                  placeholder="Search or create branch…"
                  className="w-full mb-1 px-1.5 py-1 rounded bg-white/[0.04] text-[11px] text-zinc-200 placeholder-zinc-600 outline-none"
                />
                {capped.length === 0 && !showCreate && (
                  <div className="text-[10px] text-zinc-600">No matching branch.</div>
                )}
                {capped.map((r) => {
                  const isCurrent = branches.current === r.name;
                  const held = heldByWorktree.has(r.name);
                  const disabled = isCurrent || held || switching !== null;
                  // The whole row is the switch action — click the name, no button.
                  return (
                    <button
                      key={`${r.kind}:${r.name}`}
                      disabled={disabled}
                      onClick={() => switchTo(r.name, false)}
                      title={held ? "Checked out in a worktree" : r.name}
                      className="w-full flex items-center gap-1 py-0.5 px-1 rounded text-[11px] text-left hover:bg-white/[0.07] disabled:cursor-default disabled:hover:bg-transparent"
                    >
                      <span className="font-mono text-zinc-300 truncate flex-1">
                        {isCurrent && <span className="text-emerald-400/80">● </span>}
                        {r.name}
                        {r.kind === "remote" && <span className="text-zinc-600"> ↗</span>}
                      </span>
                      {isCurrent ? (
                        <span className="text-[10px] text-zinc-600">current</span>
                      ) : held ? (
                        <span className="text-[10px] text-zinc-600">in worktree</span>
                      ) : switching === r.name ? (
                        <span className="text-[10px] text-zinc-500">…</span>
                      ) : null}
                    </button>
                  );
                })}
                {!isSearching && hiddenCount > 0 && (
                  <div className="mt-1 text-[10px] text-zinc-600">
                    {hiddenCount} more — type to search
                  </div>
                )}
                {showCreate && (
                  <button
                    disabled={switching !== null}
                    onClick={() => switchTo(q, true)}
                    className="mt-1 w-full text-left text-[10px] text-emerald-300/90 hover:bg-white/[0.06] rounded px-1.5 py-1 disabled:opacity-40"
                  >
                    {switching === q ? "Creating…" : <>Create <span className="font-mono">{q}</span></>}
                  </button>
                )}
              </div>
            );
          })()}

        </div>,
        document.body,
      )}
    </>
  );
}
