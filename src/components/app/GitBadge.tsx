import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePortaStore } from "../../store";
import { gitFetch, gitPull, gitPush, gitStatus } from "../../lib/commands";
import { useFloatingPosition, useMeasuredSize } from "../shared/useFloatingPosition";
import type { App } from "../../types";

interface Props {
  app: App;
  onOpenTerminal?: (app: App) => void;
}

type Busy = "fetch" | "pull" | "push" | null;

export default function GitBadge({ app, onOpenTerminal }: Props) {
  // The store is the single source of truth. The Rust poller writes
  // `appGit[app.id]` every 15s; we seed it once on mount (via setAppGit) so a
  // newly-added app doesn't sit blank until the first tick, and run() refreshes
  // it through the same action after a fetch/pull/push.
  const status = usePortaStore((s) => s.appGit[app.id]);
  const setAppGit = usePortaStore((s) => s.setAppGit);
  const pollError = usePortaStore((s) => s.appGitError[app.id]);
  const setAppGitError = usePortaStore((s) => s.setAppGitError);

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);

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
            <button
              onClick={() => navigator.clipboard.writeText(pollError)}
              className="mt-1 text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              Copy error
            </button>
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
              className="flex-1 px-2 py-1 rounded bg-white/[0.05] hover:bg-white/[0.09] disabled:opacity-40 text-zinc-300 transition-colors"
            >
              {busy === "fetch" ? "…" : "Fetch"}
            </button>
            <button
              onClick={() => run("pull")}
              disabled={busy !== null || behind === 0}
              className="flex-1 px-2 py-1 rounded bg-white/[0.05] hover:bg-white/[0.09] disabled:opacity-40 text-zinc-300 transition-colors"
            >
              {busy === "pull" ? "…" : "Pull"}
            </button>
            <button
              onClick={() => run("push")}
              disabled={busy !== null || ahead === 0}
              className="flex-1 px-2 py-1 rounded bg-white/[0.05] hover:bg-white/[0.09] disabled:opacity-40 text-zinc-300 transition-colors"
            >
              {busy === "push" ? "…" : "Push"}
            </button>
          </div>

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
