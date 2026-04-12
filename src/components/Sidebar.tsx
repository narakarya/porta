import { useState } from "react";
import { usePortaStore } from "../store";
import AddWorkspaceModal from "./AddWorkspaceModal";

export default function Sidebar() {
  const { workspaces, apps, selectedWorkspaceId, selectWorkspace } =
    usePortaStore();
  const [showAddWs, setShowAddWs] = useState(false);

  const standaloneApps = apps.filter((a) => a.workspace_id === null);
  const runningCount = (wsId: string | null) =>
    apps.filter((a) => a.workspace_id === wsId && a.status === "running")
      .length;

  return (
    <aside className="w-56 bg-gray-900 border-r border-gray-800 flex flex-col p-3 gap-1">
      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider px-2 mb-1">
        Workspaces
      </p>

      {workspaces.map((w) => {
        const count = runningCount(w.id);
        const active = selectedWorkspaceId === w.id;
        return (
          <button
            key={w.id}
            onClick={() => selectWorkspace(w.id)}
            className={`flex items-center gap-2 px-2 py-1.5 rounded-md text-sm w-full text-left transition-colors ${
              active
                ? "bg-indigo-600 text-white"
                : "hover:bg-gray-800 text-gray-300"
            }`}
          >
            <span
              className={`w-2 h-2 rounded-full ${
                count > 0 ? "bg-green-400" : "bg-gray-600"
              }`}
            />
            <span className="flex-1 truncate">{w.name}</span>
            {count > 0 && (
              <span className="text-xs text-green-400">{count}</span>
            )}
          </button>
        );
      })}

      {standaloneApps.length > 0 && (
        <button
          onClick={() => selectWorkspace(null)}
          className={`flex items-center gap-2 px-2 py-1.5 rounded-md text-sm w-full text-left transition-colors ${
            selectedWorkspaceId === null
              ? "bg-indigo-600 text-white"
              : "hover:bg-gray-800 text-gray-300"
          }`}
        >
          <span className="w-2 h-2 rounded-full bg-gray-600" />
          <span>Standalone</span>
        </button>
      )}

      <div className="flex-1" />

      <div className="border-t border-gray-800 pt-2 flex flex-col gap-1">
        <button
          onClick={() => setShowAddWs(true)}
          className="px-2 py-1.5 text-sm text-gray-400 hover:text-gray-100 hover:bg-gray-800 rounded-md text-left"
        >
          + Workspace
        </button>
      </div>

      {showAddWs && <AddWorkspaceModal onClose={() => setShowAddWs(false)} />}
    </aside>
  );
}
