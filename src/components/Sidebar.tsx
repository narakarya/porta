import { useState } from "react";
import { usePortaStore } from "../store";
import type { Workspace } from "../types";
import AddWorkspaceModal from "./AddWorkspaceModal";
import WorkspaceSettingsModal from "./WorkspaceSettingsModal";
import WorkspaceContextMenu from "./WorkspaceContextMenu";

interface ContextMenuState {
  ws: Workspace;
  x: number;
  y: number;
}

interface SidebarProps {
  onOpenSettings: () => void;
}

export default function Sidebar({ onOpenSettings }: SidebarProps) {
  const { workspaces, apps, selectedWorkspaceId, selectWorkspace } = usePortaStore();
  const [showAddWs, setShowAddWs] = useState(false);
  const [settingsWs, setSettingsWs] = useState<Workspace | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  const activeCount = (wsId: string | null) =>
    apps.filter(
      (a) => a.workspace_id === wsId && (a.status === "running" || a.status === "starting")
    ).length;

  const standaloneApps = apps.filter((a) => a.workspace_id === null);

  function handleRightClick(e: React.MouseEvent, ws: Workspace) {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ ws, x: e.clientX, y: e.clientY });
  }

  return (
    <aside className="w-[200px] bg-[#1a1a1c] border-r border-white/[0.06] flex flex-col pt-8 pb-3 shrink-0">
      {/* App name */}
      <div className="px-4 mb-4">
        <span className="text-[11px] font-semibold text-zinc-500 uppercase tracking-widest">Porta</span>
      </div>

      <div className="flex-1 flex flex-col gap-0.5 px-2 overflow-auto no-drag">
        <p className="text-[10px] font-medium text-zinc-600 uppercase tracking-widest px-2 mb-1 mt-1">
          Workspaces
        </p>

        {workspaces.map((w) => {
          const count = activeCount(w.id);
          const isSelected = selectedWorkspaceId === w.id;
          return (
            <button
              key={w.id}
              onClick={() => selectWorkspace(w.id)}
              onContextMenu={(e) => handleRightClick(e, w)}
              className={`flex items-center gap-2.5 px-2 py-1.5 rounded-[6px] text-[13px] w-full text-left transition-all duration-100 ${
                isSelected
                  ? "bg-white/10 text-zinc-100"
                  : "text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-200"
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 transition-colors ${
                count > 0 ? "bg-emerald-400 pulse-dot" : "bg-zinc-600"
              }`} />
              <span className="flex-1 truncate">{w.name}</span>
              {count > 0 && (
                <span className="text-[11px] text-emerald-400 font-medium tabular-nums">{count}</span>
              )}
            </button>
          );
        })}

        {standaloneApps.length > 0 && (
          <>
            <p className="text-[10px] font-medium text-zinc-600 uppercase tracking-widest px-2 mb-1 mt-3">
              Other
            </p>
            {(() => {
              const count = activeCount(null);
              const isSelected = selectedWorkspaceId === null;
              return (
                <button
                  onClick={() => selectWorkspace(null)}
                  className={`flex items-center gap-2.5 px-2 py-1.5 rounded-[6px] text-[13px] w-full text-left transition-all duration-100 ${
                    isSelected
                      ? "bg-white/10 text-zinc-100"
                      : "text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-200"
                  }`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 transition-colors ${
                    count > 0 ? "bg-emerald-400 pulse-dot" : "bg-zinc-600"
                  }`} />
                  <span className="flex-1">Standalone</span>
                  {count > 0 && (
                    <span className="text-[11px] text-emerald-400 font-medium tabular-nums">{count}</span>
                  )}
                </button>
              );
            })()}
          </>
        )}
      </div>

      <div className="px-2 pt-2 border-t border-white/[0.06] no-drag flex flex-col gap-0.5">
        <button
          onClick={() => setShowAddWs(true)}
          className="flex items-center gap-2 w-full px-2 py-1.5 rounded-[6px] text-[13px] text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.05] transition-all duration-100"
        >
          <span className="text-base leading-none">+</span>
          <span>New Workspace</span>
        </button>
        <button
          onClick={onOpenSettings}
          className="flex items-center gap-2 w-full px-2 py-1.5 rounded-[6px] text-[13px] text-zinc-600 hover:text-zinc-400 hover:bg-white/[0.05] transition-all duration-100"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="shrink-0">
            <circle cx="6" cy="6" r="2" stroke="currentColor" strokeWidth="1.2"/>
            <path d="M6 1v1M6 10v1M1 6h1M10 6h1M2.3 2.3l.7.7M9 9l.7.7M9.7 2.3l-.7.7M3 9l-.7.7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
          </svg>
          <span>Settings</span>
        </button>
      </div>

      {contextMenu && (
        <WorkspaceContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          items={[
            {
              label: "Workspace Settings",
              onClick: () => setSettingsWs(contextMenu.ws),
            },
          ]}
        />
      )}

      {showAddWs && <AddWorkspaceModal onClose={() => setShowAddWs(false)} />}
      {settingsWs && <WorkspaceSettingsModal workspace={settingsWs} onClose={() => setSettingsWs(null)} />}
    </aside>
  );
}
