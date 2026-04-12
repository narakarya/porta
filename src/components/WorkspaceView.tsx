import { useState } from "react";
import { usePortaStore } from "../store";
import AppCard from "./AppCard";
import AddAppModal from "./AddAppModal";

export default function WorkspaceView() {
  const { workspaces, apps, selectedWorkspaceId } = usePortaStore();
  const [showAdd, setShowAdd] = useState(false);

  const workspace = workspaces.find((w) => w.id === selectedWorkspaceId) ?? null;
  const visibleApps = apps.filter((a) => a.workspace_id === selectedWorkspaceId);
  const runningCount = visibleApps.filter((a) => a.status === "running").length;

  if (!workspace && selectedWorkspaceId !== null) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-600 text-[13px]">
        Select a workspace
      </div>
    );
  }

  return (
    <div className="max-w-xl">
      {/* Header */}
      <div className="flex items-end justify-between mb-5">
        <div>
          <h1 className="text-[17px] font-semibold text-zinc-100 leading-tight">
            {workspace?.name ?? "Standalone"}
          </h1>
          {workspace && (
            <p className="text-[12px] text-zinc-500 mt-0.5">{workspace.domain}</p>
          )}
        </div>
        {visibleApps.length > 0 && (
          <span className="text-[11px] text-zinc-500 mb-0.5">
            {runningCount}/{visibleApps.length} running
          </span>
        )}
      </div>

      {/* App list */}
      <div className="flex flex-col gap-1.5">
        {visibleApps.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="w-10 h-10 rounded-xl bg-white/[0.04] flex items-center justify-center mb-3">
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none" className="text-zinc-600">
                <rect x="2" y="2" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
                <rect x="10" y="2" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
                <rect x="2" y="10" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
                <rect x="10" y="10" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
              </svg>
            </div>
            <p className="text-[13px] text-zinc-500">No apps yet</p>
            <p className="text-[12px] text-zinc-600 mt-1">Add your first app to get started</p>
          </div>
        ) : (
          visibleApps.map((app) => (
            <AppCard key={app.id} app={app} workspace={workspace} />
          ))
        )}
      </div>

      {/* Add button */}
      <button
        onClick={() => setShowAdd(true)}
        className="mt-3 flex items-center justify-center gap-2 w-full py-2 rounded-lg border border-dashed border-white/[0.08] hover:border-white/[0.15] text-[12px] text-zinc-600 hover:text-zinc-400 transition-all duration-150"
      >
        <span>+</span>
        <span>Add App</span>
      </button>

      {showAdd && (
        <AddAppModal
          workspaceId={selectedWorkspaceId}
          onClose={() => setShowAdd(false)}
        />
      )}
    </div>
  );
}
