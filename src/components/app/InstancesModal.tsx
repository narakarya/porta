import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { App, Workspace } from "../../types";
import type { AppInstance } from "../../lib/commands";
import { deriveInstanceApp } from "../../lib/instance-app";
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

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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
