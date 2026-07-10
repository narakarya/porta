import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePortaStore } from "../../store";
import { gitFetch, gitPull, gitPush, gitStatus, type GitStatus } from "../../lib/commands";
import { useFloatingPosition, useMeasuredSize } from "../shared/useFloatingPosition";
import type { App } from "../../types";

interface Props {
  app: App;
  onOpenTerminal?: (app: App) => void;
}

type Busy = "fetch" | "pull" | "push" | null;

export default function GitBadge({ app, onOpenTerminal }: Props) {
  // The Rust poller keeps this fresh every 15s. We seed it once on mount so a
  // newly-added app doesn't sit blank until the first tick.
  const fromStore = usePortaStore((s) => s.appGit[app.id]);
  const [seed, setSeed] = useState<GitStatus | null>(null);
  const status = fromStore ?? seed;

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (fromStore || !app.root_dir) return;
    let cancelled = false;
    gitStatus(app.root_dir).then((s) => { if (!cancelled) setSeed(s); }).catch(() => {});
    return () => { cancelled = true; };
  }, [app.root_dir, fromStore]);

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

  if (!status) return null;

  async function run(kind: Exclude<Busy, null>) {
    setBusy(kind);
    setError(null);
    try {
      if (kind === "fetch") await gitFetch(app.root_dir);
      else if (kind === "pull") await gitPull(app.root_dir);
      else await gitPush(app.root_dir);
      // Refresh immediately rather than waiting up to 15s for the next poll.
      const fresh = await gitStatus(app.root_dir);
      if (fresh) setSeed(fresh);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
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
              Open terminal in {app.root_dir.split("/").pop()}
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
