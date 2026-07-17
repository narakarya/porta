// Activity domain — consolidates resources, disk, updates, events, containers.
// Phase 1 ships the shell placeholder; the dashboard is built in the Activity phase.
export default function ActivityView() {
  return (
    <div className="flex flex-col items-center justify-center h-[60vh] text-center gap-2">
      <div className="w-11 h-11 rounded-xl bg-white/[0.04] flex items-center justify-center text-zinc-500">
        <svg width="20" height="20" viewBox="0 0 16 16" fill="none">
          <path d="M1.5 8.5h3l2-5 3 9 2-4h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      <h2 className="text-[15px] font-medium text-zinc-200">Activity</h2>
      <p className="text-[12px] text-zinc-500 max-w-xs">
        Resources, disk, updates, events, and container observability will live here.
      </p>
    </div>
  );
}
