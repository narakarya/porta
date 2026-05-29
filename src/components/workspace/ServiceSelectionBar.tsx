import { useShallow } from "zustand/react/shallow";
import { usePortaStore } from "../../store";

interface Props {
  selectedIds: string[];
  onClear: () => void;
}

/**
 * Companion to SelectionBar.tsx — same UI pattern, scoped to services.
 *
 * Services don't have a "starting" status concept tied to dependencies,
 * but they do have a "pulling" phase during the first run. We treat
 * `pulling | starting | running` as the active set the bulk actions
 * operate on for Stop/Restart; only `stopped` services get Started.
 *
 * Sits slightly higher than the app SelectionBar (bottom-20 vs bottom-6)
 * so when both are visible at once they don't overlap.
 */
export default function ServiceSelectionBar({ selectedIds, onClear }: Props) {
  const { services, startService, stopService, restartService } = usePortaStore(
    useShallow((s) => ({
      services: s.services,
      startService: s.startService,
      stopService: s.stopService,
      restartService: s.restartService,
    })),
  );

  if (selectedIds.length === 0) return null;

  const selected = services.filter((s) => selectedIds.includes(s.id));
  const startable = selected.filter((s) => s.status === "stopped").map((s) => s.id);
  const stoppable = selected.filter((s) => s.status === "running" || s.status === "starting" || s.status === "pulling").map((s) => s.id);

  const startAll   = () => Promise.allSettled(startable.map((id) => startService(id)));
  const stopAll    = () => Promise.allSettled(stoppable.map((id) => stopService(id)));
  const restartAll = () => Promise.allSettled(stoppable.map((id) => restartService(id)));

  return (
    <div
      className="fixed bottom-20 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 px-3 py-2 bg-[#1c1c1e] border border-violet-500/30 rounded-xl shadow-2xl"
      role="toolbar"
      aria-label="Bulk service actions"
    >
      <span className="text-[11px] font-medium text-violet-300 px-2">
        {selectedIds.length} service{selectedIds.length === 1 ? "" : "s"}
      </span>
      <div className="h-4 w-px bg-white/[0.08]" />
      <button
        onClick={startAll}
        disabled={startable.length === 0}
        className="px-2.5 py-1 text-[11px] font-medium text-blue-400 bg-blue-500/10 hover:bg-blue-500/20 rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        Start ({startable.length})
      </button>
      <button
        onClick={restartAll}
        disabled={stoppable.length === 0}
        className="px-2.5 py-1 text-[11px] font-medium text-amber-400 bg-amber-500/10 hover:bg-amber-500/20 rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        Restart ({stoppable.length})
      </button>
      <button
        onClick={stopAll}
        disabled={stoppable.length === 0}
        className="px-2.5 py-1 text-[11px] font-medium text-zinc-300 bg-white/[0.06] hover:bg-white/[0.10] rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        Stop ({stoppable.length})
      </button>
      <div className="h-4 w-px bg-white/[0.08]" />
      <button
        onClick={onClear}
        className="px-2.5 py-1 text-[11px] font-medium text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.06] rounded-md transition-colors"
        title="Clear selection (Esc)"
      >
        Clear
      </button>
    </div>
  );
}
