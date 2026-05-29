import { useShallow } from "zustand/react/shallow";
import { usePortaStore } from "../../store";

interface Props {
  selectedIds: string[];
  onClear: () => void;
}

/**
 * Floating action bar shown at the bottom of the workspace whenever apps
 * are multi-selected (Cmd/Ctrl+click on a card). Surfaces bulk
 * start/stop/restart so the user doesn't have to click each card. Auto-
 * hides when the selection is empty.
 *
 * "All" actions are tied to the running store actions (`startApp`,
 * `stopApp`, `restartApp`) executed concurrently — the store's optimistic
 * updates make this feel instant even if a docker compose down stretches
 * the actual IPC out to 10+ seconds.
 */
export default function SelectionBar({ selectedIds, onClear }: Props) {
  const { apps, startApp, stopApp, restartApp } = usePortaStore(
    useShallow((s) => ({
      apps: s.apps,
      startApp: s.startApp,
      stopApp: s.stopApp,
      restartApp: s.restartApp,
    })),
  );

  if (selectedIds.length === 0) return null;

  const selected = apps.filter((a) => selectedIds.includes(a.id));
  const canStart   = selected.some((a) => a.status === "stopped" && (a.start_command || (a.kind === "docker" && a.docker_image) || (a.kind === "compose" && a.compose_file)));
  const canStop    = selected.some((a) => a.status === "running" || a.status === "starting");
  const canRestart = selected.some((a) => a.status === "running" || a.status === "starting");

  const startable = selected.filter((a) => a.status === "stopped").map((a) => a.id);
  const stoppable = selected.filter((a) => a.status === "running" || a.status === "starting").map((a) => a.id);

  // Parallel fan-out — order doesn't matter for these (depends_on chains
  // are honoured by the start_app IPC, not by call sequence here).
  const startAll   = () => Promise.allSettled(startable.map((id) => startApp(id)));
  const stopAll    = () => Promise.allSettled(stoppable.map((id) => stopApp(id)));
  const restartAll = () => Promise.allSettled(stoppable.map((id) => restartApp(id)));

  return (
    <div
      className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 px-3 py-2 bg-[#1c1c1e] border border-white/[0.12] rounded-xl shadow-2xl"
      role="toolbar"
      aria-label="Bulk app actions"
    >
      <span className="text-[11px] font-medium text-zinc-200 px-2">
        {selectedIds.length} selected
      </span>
      <div className="h-4 w-px bg-white/[0.08]" />
      <button
        onClick={startAll}
        disabled={!canStart}
        className="px-2.5 py-1 text-[11px] font-medium text-blue-400 bg-blue-500/10 hover:bg-blue-500/20 rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        title="Start selected stopped apps"
      >
        Start ({startable.length})
      </button>
      <button
        onClick={restartAll}
        disabled={!canRestart}
        className="px-2.5 py-1 text-[11px] font-medium text-amber-400 bg-amber-500/10 hover:bg-amber-500/20 rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        title="Restart selected running apps"
      >
        Restart ({stoppable.length})
      </button>
      <button
        onClick={stopAll}
        disabled={!canStop}
        className="px-2.5 py-1 text-[11px] font-medium text-zinc-300 bg-white/[0.06] hover:bg-white/[0.10] rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        title="Stop selected running apps"
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
