import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { App } from "../../types";
import { appDiskUsage, pruneAppOldImages, type AppDiskUsage } from "../../lib/commands";
import { formatBytes, yieldToFrame } from "../../lib/ui";
import Tooltip from "../shared/Tooltip";
import { useFloatingPosition, useMeasuredSize } from "../shared/useFloatingPosition";

interface Props {
  app: App;
}

type LoadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; usage: AppDiskUsage }
  | { kind: "error" };

type CleanState = "idle" | "running" | "success" | "error";

/**
 * Combined image+volume size badge for docker / compose apps. Tap to load (we
 * don't fetch on mount — `docker ps`/`docker images` per app would be N
 * processes on the workspace view), reveals breakdown + per-app cleanup.
 */
export default function AppDiskBadge({ app }: Props) {
  const [state, setState] = useState<LoadState>({ kind: "idle" });
  const [open, setOpen] = useState(false);
  const [cleanState, setCleanState] = useState<CleanState>("idle");
  const [freed, setFreed] = useState<number>(0);

  // Reset when the app's image config changes — past size is stale.
  useEffect(() => {
    setState({ kind: "idle" });
    setCleanState("idle");
    setFreed(0);
  }, [app.docker_image, app.compose_file, app.kind]);

  async function load() {
    setState({ kind: "loading" });
    try {
      const usage = await appDiskUsage(app.id);
      setState({ kind: "ready", usage });
    } catch {
      setState({ kind: "error" });
    }
  }

  function handleToggle() {
    setOpen((prev) => {
      const next = !prev;
      if (next && state.kind === "idle") load();
      return next;
    });
  }

  async function handleClean() {
    if (!window.confirm("Remove old images for this app that aren't currently in use? Active images stay put.")) return;
    setCleanState("running");
    await yieldToFrame();
    try {
      const result = await pruneAppOldImages(app.id);
      setCleanState("success");
      setFreed(result.freed_bytes);
      load();
    } catch {
      setCleanState("error");
    }
  }

  const total =
    state.kind === "ready"
      ? state.usage.image_bytes + state.usage.volume_bytes + state.usage.container_bytes
      : 0;

  const label =
    state.kind === "ready"
      ? formatBytes(total)
      : state.kind === "loading"
      ? "…"
      : state.kind === "error"
      ? "?"
      : "disk";

  const hasStale = state.kind === "ready" && state.usage.stale_image_count > 0;

  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelOpen = open && state.kind === "ready";
  const panelSize = useMeasuredSize(panelRef, panelOpen);
  const coords = useFloatingPosition({
    triggerRef,
    panelSize,
    active: panelOpen,
    side: "bottom",
    align: "end",
    gap: 4,
  });

  // Click-outside / Escape closes the portal panel.
  useEffect(() => {
    if (!panelOpen) return;
    function onPointer(e: PointerEvent) {
      const t = e.target as Node | null;
      if (!t) return;
      if (panelRef.current?.contains(t)) return;
      if (triggerRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [panelOpen]);

  return (
    <div
      className={`relative inline-flex ${
        hasStale ? "" : "opacity-0 group-hover:opacity-100 transition-opacity duration-150"
      }`}
    >
      <Tooltip
        label={
          state.kind === "ready"
            ? `${formatBytes(state.usage.image_bytes)} images · ${formatBytes(state.usage.volume_bytes)} volumes`
            : "Tap to load disk usage"
        }
        side="top"
      >
        <button
          ref={triggerRef}
          onClick={(e) => {
            e.stopPropagation();
            handleToggle();
          }}
          className={`text-[9px] font-semibold tracking-wider px-1.5 py-0.5 rounded leading-none uppercase border transition-colors ${
            hasStale
              ? "text-amber-300 bg-amber-500/10 border-amber-500/30 hover:bg-amber-500/15"
              : "text-zinc-400 bg-white/[0.04] border-white/[0.08] hover:bg-white/[0.08]"
          }`}
        >
          {label}
        </button>
      </Tooltip>

      {panelOpen && createPortal(
        <div
          ref={panelRef}
          className="fixed z-[60] w-[260px] p-3 rounded-lg bg-[#1a1a1c] border border-white/[0.08] shadow-xl"
          style={coords ? { top: coords.top, left: coords.left } : { top: -9999, left: -9999, visibility: "hidden" }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] uppercase tracking-wider text-zinc-500">Disk</span>
            <button
              onClick={() => setOpen(false)}
              className="text-zinc-600 hover:text-zinc-300 text-[14px] leading-none"
              aria-label="Close"
            >
              ×
            </button>
          </div>
          <div className="flex flex-col gap-1.5 text-[12px]">
            <Row label="Images" value={state.usage.image_bytes} />
            <Row label="Volumes" value={state.usage.volume_bytes} />
            <Row label="Containers" value={state.usage.container_bytes} />
          </div>
          {hasStale && (
            <div className="mt-3 pt-3 border-t border-white/[0.06]">
              <p className="text-[11px] text-amber-300 mb-2">
                {state.usage.stale_image_count} stale image{state.usage.stale_image_count === 1 ? "" : "s"} from past updates
              </p>
              <button
                onClick={handleClean}
                disabled={cleanState === "running"}
                className="w-full px-2.5 py-1.5 text-[12px] font-medium bg-amber-700/40 hover:bg-amber-700/60 disabled:opacity-50 text-amber-100 rounded-md transition-colors flex items-center justify-center gap-1.5 border border-amber-700/40"
              >
                {cleanState === "running" && (
                  <svg className="w-3 h-3 animate-spin" viewBox="0 0 16 16" fill="none">
                    <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.3" />
                    <path d="M14 8a6 6 0 00-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                )}
                {cleanState === "running" ? "Cleaning…" : "Clean up old images"}
              </button>
              {cleanState === "success" && (
                <p className="mt-1.5 text-[11px] text-emerald-400">
                  Freed {formatBytes(freed)}
                </p>
              )}
              {cleanState === "error" && (
                <p className="mt-1.5 text-[11px] text-red-400">Cleanup failed</p>
              )}
            </div>
          )}
          {!hasStale && state.kind === "ready" && (
            <p className="mt-2 text-[11px] text-zinc-600">No stale images.</p>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-zinc-500">{label}</span>
      <span className="text-zinc-200 font-mono">{formatBytes(value)}</span>
    </div>
  );
}
