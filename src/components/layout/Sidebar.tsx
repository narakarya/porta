import { useEffect, useRef, useState } from "react";
import { usePortaStore } from "../../store";
import { isTauri } from "../../lib/commands";
import type { Workspace } from "../../types";
import AddWorkspaceModal from "../workspace/AddWorkspaceModal";
import WorkspaceSettingsModal from "../workspace/WorkspaceSettingsModal";
import WorkspaceContextMenu from "../workspace/WorkspaceContextMenu";
import AddServiceModal from "../service/AddServiceModal";
import ServiceSettingsModal from "../service/ServiceSettingsModal";
import type { Service } from "../../types";
import Tooltip from "../shared/Tooltip";

interface ContextMenuState {
  ws: Workspace;
  x: number;
  y: number;
}

interface SidebarProps {
  onOpenSettings: () => void;
}

export default function Sidebar({ onOpenSettings }: SidebarProps) {
  const { workspaces, apps, services, selectedWorkspaceId, selectWorkspace, reorderWorkspaces, reorderServices } = usePortaStore();
  const [showAddWs, setShowAddWs] = useState(false);
  const [showAddService, setShowAddService] = useState(false);
  const [settingsWs, setSettingsWs] = useState<Workspace | null>(null);
  const [editingService, setEditingService] = useState<Service | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [wsExpanded, setWsExpanded] = useState(true);
  const [otherExpanded, setOtherExpanded] = useState(true);
  const [servicesCollapsed, setServicesCollapsed] = useState(false);
  const [dragOverIndex, setDragOverIndex] = useState<{ type: "ws" | "svc"; index: number } | null>(null);
  const [draggingItem, setDraggingItem] = useState<{ type: "ws" | "svc"; index: number } | null>(null);
  // Refs so global mouseup can read latest values without stale closures
  const dragSrcRef = useRef<{ type: "ws" | "svc"; index: number } | null>(null);
  const dragOverRef = useRef<{ type: "ws" | "svc"; index: number } | null>(null);
  const isDraggingRef = useRef(false);
  // Container refs — used by mousemove to calculate hover index from Y position.
  // mousemove on the container is more reliable than mouseenter on individual items
  // in WKWebView (Tauri/macOS) during a mouse-button-held drag.
  const wsListRef = useRef<HTMLDivElement>(null);
  const svcListRef = useRef<HTMLDivElement>(null);

  function setDragOver(val: typeof dragOverIndex) {
    dragOverRef.current = val;
    setDragOverIndex(val);
  }

  function handleMouseDown(type: "ws" | "svc", index: number) {
    dragSrcRef.current = { type, index };
    isDraggingRef.current = true;
    setDraggingItem({ type, index });
  }

  function handleListMouseMove(
    e: React.MouseEvent,
    type: "ws" | "svc",
    ref: React.RefObject<HTMLDivElement | null>,
    count: number,
  ) {
    const src = dragSrcRef.current;
    if (!isDraggingRef.current || src?.type !== type || !ref.current || count === 0) return;
    const rect = ref.current.getBoundingClientRect();
    const relY = e.clientY - rect.top;
    // Derive index from proportional Y position within the container
    const idx = Math.min(count - 1, Math.max(0, Math.floor(relY / (rect.height / count))));
    setDragOver(idx !== src.index ? { type, index: idx } : null);
  }

  // Global mouseup: perform reorder using refs (avoids stale closure on state)
  useEffect(() => {
    function onGlobalMouseUp() {
      if (!isDraggingRef.current) return;
      const src = dragSrcRef.current;
      const dst = dragOverRef.current;
      if (src && dst && src.type === dst.type && src.index !== dst.index) {
        if (src.type === "ws") reorderWorkspaces(src.index, dst.index);
        else reorderServices(src.index, dst.index);
      }
      dragSrcRef.current = null;
      dragOverRef.current = null;
      isDraggingRef.current = false;
      setDragOverIndex(null);
      setDraggingItem(null);
      document.body.style.cursor = "";
    }
    window.addEventListener("mouseup", onGlobalMouseUp);
    return () => window.removeEventListener("mouseup", onGlobalMouseUp);
  }, [reorderWorkspaces, reorderServices]);

  // Keep cursor grabbing globally so it doesn't flicker as mouse moves between items
  useEffect(() => {
    document.body.style.cursor = draggingItem ? "grabbing" : "";
    return () => { document.body.style.cursor = ""; };
  }, [draggingItem]);

  const activeCount = (wsId: string | null) =>
    apps.filter(
      (a) => a.workspace_id === wsId && (a.status === "running" || a.status === "starting")
    ).length;



  function handleRightClick(e: React.MouseEvent, ws: Workspace) {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ ws, x: e.clientX, y: e.clientY });
  }

  return (
    <aside className="w-[200px] bg-[#1a1a1c] border-r border-white/[0.06] flex flex-col pt-9 pb-3 shrink-0">
      <div className="flex-1 flex flex-col gap-0.5 px-2 overflow-y-auto overflow-x-hidden no-drag mt-1">
        <div className="flex items-center gap-1 px-2 mb-1 mt-1">
          <button
            onClick={() => setWsExpanded(!wsExpanded)}
            className="flex items-center gap-1 group/hdr flex-1"
          >
            <svg
              width="8" height="8" viewBox="0 0 8 8" fill="none"
              className={`text-zinc-600 transition-transform duration-150 ${wsExpanded ? "rotate-90" : ""}`}
            >
              <path d="M2.5 1.5L5.5 4L2.5 6.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            <span className="text-[10px] font-medium text-zinc-600 uppercase tracking-widest group-hover/hdr:text-zinc-400 transition-colors">
              Workspaces
            </span>
          </button>
          <Tooltip label="New Workspace" side="left">
            <button
              onClick={() => setShowAddWs(true)}
              className="text-zinc-600 hover:text-zinc-300 transition-colors p-0.5 rounded"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path d="M5 2v6M2 5h6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
              </svg>
            </button>
          </Tooltip>
        </div>

        {wsExpanded && (
          <div
            ref={wsListRef}
            onMouseMove={(e) => handleListMouseMove(e, "ws", wsListRef, workspaces.length)}
            onMouseLeave={() => isDraggingRef.current && setDragOver(null)}
          >
            {workspaces.map((w, i) => {
              const count = activeCount(w.id);
              const isSelected = selectedWorkspaceId === w.id;
              const isGhost = draggingItem?.type === "ws" && draggingItem.index === i;
              const srcIdx = draggingItem?.type === "ws" ? draggingItem.index : null;
              const dstIdx = dragOverIndex?.type === "ws" ? dragOverIndex.index : null;
              // Show insertion line before item when dragging from below, after when from above
              const showLineBefore = dstIdx === i && srcIdx !== null && srcIdx > i;
              const showLineAfter  = dstIdx === i && srcIdx !== null && srcIdx < i;
              return (
                <div key={w.id} className="relative">
                  {showLineBefore && (
                    <div className="absolute -top-px left-1 right-1 h-0.5 rounded-full bg-blue-400 z-20 pointer-events-none" />
                  )}
                  <div
                    role="button"
                    tabIndex={0}
                    onMouseDown={() => handleMouseDown("ws", i)}
                    onClick={() => selectWorkspace(w.id)}
                    onKeyDown={(e) => { if (e.key === "Enter") selectWorkspace(w.id); }}
                    onContextMenu={(e) => handleRightClick(e, w)}
                    style={isGhost ? { opacity: 0.35 } : undefined}
                    className={`flex items-center gap-2.5 px-2 py-1.5 rounded-[6px] text-[13px] w-full text-left select-none cursor-grab ${
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
                  </div>
                  {showLineAfter && (
                    <div className="absolute -bottom-px left-1 right-1 h-0.5 rounded-full bg-blue-400 z-20 pointer-events-none" />
                  )}
                </div>
              );
            })}
          </div>
        )}

        <button
          onClick={() => setOtherExpanded(!otherExpanded)}
          className="flex items-center gap-1 px-2 mb-1 mt-3 group/hdr"
        >
          <svg
            width="8" height="8" viewBox="0 0 8 8" fill="none"
            className={`text-zinc-600 transition-transform duration-150 ${otherExpanded ? "rotate-90" : ""}`}
          >
            <path d="M2.5 1.5L5.5 4L2.5 6.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <span className="text-[10px] font-medium text-zinc-600 uppercase tracking-widest group-hover/hdr:text-zinc-400 transition-colors">
            Other
          </span>
        </button>
        {otherExpanded && (() => {
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

        {/* Services section */}
        <div className="flex items-center gap-1 px-2 mb-1 mt-3">
          <button
            onClick={() => setServicesCollapsed(!servicesCollapsed)}
            className="flex items-center gap-1 group/hdr flex-1"
          >
            <svg
              width="8" height="8" viewBox="0 0 8 8" fill="none"
              className={`text-zinc-600 transition-transform duration-150 ${servicesCollapsed ? "" : "rotate-90"}`}
            >
              <path d="M2.5 1.5L5.5 4L2.5 6.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            <span className="text-[10px] font-medium text-zinc-600 uppercase tracking-widest group-hover/hdr:text-zinc-400 transition-colors">
              Services
            </span>
            {(() => {
              const runCount = services.filter((s) => s.status === "running").length;
              return runCount > 0 ? (
                <span className="text-[10px] text-emerald-400 font-medium tabular-nums ml-1">
                  {runCount}
                </span>
              ) : null;
            })()}
          </button>
          <Tooltip label="New Service" side="left">
            <button
              onClick={() => setShowAddService(true)}
              className="text-zinc-600 hover:text-zinc-300 transition-colors p-0.5 rounded"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path d="M5 2v6M2 5h6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
              </svg>
            </button>
          </Tooltip>
        </div>
        {!servicesCollapsed && (
          <div
            ref={svcListRef}
            onMouseMove={(e) => handleListMouseMove(e, "svc", svcListRef, services.length)}
            onMouseLeave={() => isDraggingRef.current && setDragOver(null)}
          >
            {services.map((svc, i) => {
              const isRunning = svc.status === "running";
              const isPulling = svc.status === "pulling";
              const isStarting = svc.status === "starting";
              const dotColor = isRunning
                ? "bg-emerald-400 pulse-dot"
                : isPulling
                ? "bg-blue-400 animate-pulse"
                : isStarting
                ? "bg-amber-400 animate-pulse"
                : "bg-zinc-600";
              const isGhost = draggingItem?.type === "svc" && draggingItem.index === i;
              const srcIdx = draggingItem?.type === "svc" ? draggingItem.index : null;
              const dstIdx = dragOverIndex?.type === "svc" ? dragOverIndex.index : null;
              const showLineBefore = dstIdx === i && srcIdx !== null && srcIdx > i;
              const showLineAfter  = dstIdx === i && srcIdx !== null && srcIdx < i;
              return (
                <div key={svc.id} className="relative">
                  {showLineBefore && (
                    <div className="absolute -top-px left-1 right-1 h-0.5 rounded-full bg-blue-400 z-20 pointer-events-none" />
                  )}
                  <div
                    onMouseDown={() => handleMouseDown("svc", i)}
                    onClick={() => setEditingService(svc)}
                    style={isGhost ? { opacity: 0.35 } : undefined}
                    className="group/svc flex items-center gap-2.5 px-2 py-1.5 rounded-[6px] text-[13px] text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-200 cursor-grab"
                  >
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 transition-colors ${dotColor}`} />
                    <span className="flex-1 truncate">{svc.name}</span>
                    <span className="text-[10px] text-zinc-600 group-hover/svc:text-zinc-500 transition-colors">
                      :{svc.port}
                    </span>
                  </div>
                  {showLineAfter && (
                    <div className="absolute -bottom-px left-1 right-1 h-0.5 rounded-full bg-blue-400 z-20 pointer-events-none" />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="px-2 pt-2 border-t border-white/[0.06] no-drag flex flex-col gap-0.5">
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
            {
              label: "Export .porta.yml",
              onClick: async () => {
                if (!isTauri) return;
                const { save } = await import("@tauri-apps/plugin-dialog");
                const { exportPortaConfig } = await import("../../lib/commands");
                const dest = await save({ defaultPath: ".porta.yml", filters: [{ name: "YAML", extensions: ["yml", "yaml"] }] });
                if (dest) await exportPortaConfig(contextMenu.ws.id, dest);
              },
            },
            {
              label: "Import .porta.yml",
              onClick: async () => {
                if (!isTauri) return;
                const { open } = await import("@tauri-apps/plugin-dialog");
                const { importPortaConfig } = await import("../../lib/commands");
                const src = await open({ multiple: false, filters: [{ name: "YAML", extensions: ["yml", "yaml"] }] });
                if (src) { await importPortaConfig(src as string); usePortaStore.getState().load(); }
              },
            },
          ]}
        />
      )}

      {showAddWs && <AddWorkspaceModal onClose={() => setShowAddWs(false)} />}
      {showAddService && <AddServiceModal onClose={() => setShowAddService(false)} />}
      {settingsWs && <WorkspaceSettingsModal workspace={settingsWs} onClose={() => setSettingsWs(null)} />}
      {editingService && <ServiceSettingsModal service={editingService} onClose={() => setEditingService(null)} />}
    </aside>
  );
}
