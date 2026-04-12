import { useState } from "react";
import { usePortaStore } from "../store";
import AppCard from "./AppCard";
import AddAppModal from "./AddAppModal";

export default function WorkspaceView() {
  const { workspaces, apps, selectedWorkspaceId } = usePortaStore();
  const [showAdd, setShowAdd] = useState(false);

  const workspace =
    workspaces.find((w) => w.id === selectedWorkspaceId) ?? null;
  const visibleApps = apps.filter(
    (a) => a.workspace_id === selectedWorkspaceId
  );

  if (!workspace && selectedWorkspaceId !== null) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500">
        Select a workspace
      </div>
    );
  }

  return (
    <div className="max-w-2xl">
      <div className="flex items-baseline justify-between mb-4">
        <div>
          <h1 className="text-xl font-semibold">
            {workspace?.name ?? "Standalone Apps"}
          </h1>
          {workspace && (
            <p className="text-sm text-gray-500">{workspace.domain}</p>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        {visibleApps.length === 0 && (
          <p className="text-sm text-gray-600 py-4">No apps yet.</p>
        )}
        {visibleApps.map((app) => (
          <AppCard key={app.id} app={app} workspace={workspace} />
        ))}
      </div>

      <button
        onClick={() => setShowAdd(true)}
        className="mt-4 px-4 py-2 text-sm border border-dashed border-gray-700 hover:border-gray-500 text-gray-500 hover:text-gray-300 rounded-lg transition-colors w-full"
      >
        + Add App
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
