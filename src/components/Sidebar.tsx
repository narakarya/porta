import { useState } from "react";
import { usePortaStore } from "../store";
import AddWorkspaceModal from "./AddWorkspaceModal";

export default function Sidebar() {
  const { workspaces, apps, selectedWorkspaceId, selectWorkspace } =
    usePortaStore();
  const [showAddWs, setShowAddWs] = useState(false);

  const standaloneApps = apps.filter((a) => a.workspace_id === null);
  const runningCount = (wsId: string | null) =>
    apps.filter((a) => a.workspace_id === wsId && a.status === "running").length;

  return (
    <aside className="w-[200px] bg-[#1a1a1c] border-r border-white/[0.06] flex flex-col pt-8 pb-3 shrink-0">
      {/* App name */}
      <div className="px-4 mb-4">
        <span className="text-[11px] font-semibold text-zinc-500 uppercase tracking-widest">
          Porta
        </span>
      </div>

      <div className="flex-1 flex flex-col gap-0.5 px-2 overflow-auto no-drag">
        <p className="text-[10px] font-medium text-zinc-600 uppercase tracking-widest px-2 mb-1 mt-1">
          Workspaces
        </p>

        {workspaces.map((w) => {
          const count = runningCount(w.id);
          const active = selectedWorkspaceId === w.id;
          return (
            <button
              key={w.id}
              onClick={() => selectWorkspace(w.id)}
              className={`flex items-center gap-2.5 px-2 py-1.5 rounded-[6px] text-[13px] w-full text-left transition-all duration-100 ${
                active
                  ? "bg-white/10 text-zinc-100"
                  : "text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-200"
              }`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 transition-colors ${
                  count > 0 ? "bg-emerald-400 pulse-dot" : "bg-zinc-600"
                }`}
              />
              <span className="flex-1 truncate">{w.name}</span>
              {count > 0 && (
                <span className="text-[11px] text-emerald-400 font-medium tabular-nums">
                  {count}
                </span>
              )}
            </button>
          );
        })}

        {standaloneApps.length > 0 && (
          <>
            <p className="text-[10px] font-medium text-zinc-600 uppercase tracking-widest px-2 mb-1 mt-3">
              Other
            </p>
            <button
              onClick={() => selectWorkspace(null)}
              className={`flex items-center gap-2.5 px-2 py-1.5 rounded-[6px] text-[13px] w-full text-left transition-all duration-100 ${
                selectedWorkspaceId === null
                  ? "bg-white/10 text-zinc-100"
                  : "text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-200"
              }`}
            >
              <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-zinc-600" />
              <span>Standalone</span>
            </button>
          </>
        )}
      </div>

      <div className="px-2 pt-2 border-t border-white/[0.06] no-drag">
        <button
          onClick={() => setShowAddWs(true)}
          className="flex items-center gap-2 w-full px-2 py-1.5 rounded-[6px] text-[13px] text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.05] transition-all duration-100"
        >
          <span className="text-base leading-none">+</span>
          <span>New Workspace</span>
        </button>
      </div>

      {showAddWs && <AddWorkspaceModal onClose={() => setShowAddWs(false)} />}
    </aside>
  );
}
