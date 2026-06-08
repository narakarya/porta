import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { usePortaStore } from "../../store";
import { isTauri } from "../../lib/commands";
import type { Workspace } from "../../types";
import WorkspaceContextMenu from "../workspace/WorkspaceContextMenu";
import type { Service } from "../../types";
import Tooltip from "../shared/Tooltip";
import { checkForUpdate, dismissUpdater } from "../../lib/updater";

// Sidebar modals — kept out of the initial bundle since they only show on
// click. Without lazy() they'd be parsed up-front for every app launch.
const AddWorkspaceModal = lazy(() => import("../workspace/AddWorkspaceModal"));
const WorkspaceSettingsModal = lazy(() => import("../workspace/WorkspaceSettingsModal"));
const AddServiceModal = lazy(() => import("../service/AddServiceModal"));
const ServiceSettingsModal = lazy(() => import("../service/ServiceSettingsModal"));

interface ContextMenuState {
  ws: Workspace;
  x: number;
  y: number;
}

interface SidebarProps {
  onOpenSettings: () => void;
}

export default function Sidebar({ onOpenSettings }: SidebarProps) {
  const { workspaces, apps, services, selectedWorkspaceId, imageUpdateCache, selectWorkspace, reorderWorkspaces, reorderServices } = usePortaStore(
    useShallow((s) => ({
      workspaces: s.workspaces,
      apps: s.apps,
      services: s.services,
      selectedWorkspaceId: s.selectedWorkspaceId,
      imageUpdateCache: s.imageUpdateCache,
      selectWorkspace: s.selectWorkspace,
      reorderWorkspaces: s.reorderWorkspaces,
      reorderServices: s.reorderServices,
    }))
  );
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

  // One pass over apps instead of N×M nested scans in JSX.
  const activeByWs = useMemo(() => {
    const counts = new Map<string | null, number>();
    for (const a of apps) {
      if (a.status === "running" || a.status === "starting") {
        const k = a.workspace_id;
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    }
    return counts;
  }, [apps]);
  const activeCount = (wsId: string | null) => activeByWs.get(wsId) ?? 0;

  const updatesByWs = useMemo(() => {
    const counts = new Map<string | null, number>();
    for (const a of apps) {
      if (a.kind !== "docker" && a.kind !== "compose") continue;
      const info = imageUpdateCache[a.id];
      if (!info) continue;
      const hasUpdate = info.some(
        (i) => i.status === "ok" && (i.has_digest_update || !!i.suggested_tag)
      );
      if (hasUpdate) counts.set(a.workspace_id, (counts.get(a.workspace_id) ?? 0) + 1);
    }
    return counts;
  }, [apps, imageUpdateCache]);
  const updateCount = (wsId: string | null) => updatesByWs.get(wsId) ?? 0;
  const hasStandaloneApps = useMemo(() => apps.some((a) => a.workspace_id === null), [apps]);
  const showOtherSection = hasStandaloneApps || selectedWorkspaceId === null;



  function handleRightClick(e: React.MouseEvent, ws: Workspace) {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ ws, x: e.clientX, y: e.clientY });
  }

  return (
    <aside className="w-[200px] bg-[#1a1a1c] border-r border-white/[0.06] flex flex-col pb-3 shrink-0">
      <div className="h-11 flex items-center gap-2 px-4 shrink-0">
        <img src="/porta-logo.svg" alt="" width={18} height={18} className="rounded-[4px]" />
        <span className="text-[11px] font-semibold text-zinc-400 uppercase tracking-widest">Porta</span>
      </div>
      <div className="flex-1 flex flex-col gap-0.5 px-2 overflow-y-auto overflow-x-hidden no-drag">
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
            className="flex flex-col gap-0.5"
          >
            {workspaces.map((w, i) => {
              const count = activeCount(w.id);
              const updCount = updateCount(w.id);
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
                    {updCount > 0 && (
                      <Tooltip label={`${updCount} image update${updCount > 1 ? "s" : ""} available`} side="right">
                        <span className="text-[11px] text-amber-400 font-medium tabular-nums">{updCount}↑</span>
                      </Tooltip>
                    )}
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

        {showOtherSection && (
          <>
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
              const updCount = updateCount(null);
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
                  {updCount > 0 && (
                    <Tooltip label={`${updCount} image update${updCount > 1 ? "s" : ""} available`} side="right">
                      <span className="text-[11px] text-amber-400 font-medium tabular-nums">{updCount}↑</span>
                    </Tooltip>
                  )}
                  {count > 0 && (
                    <span className="text-[11px] text-emerald-400 font-medium tabular-nums">{count}</span>
                  )}
                </button>
              );
            })()}
          </>
        )}

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
            className="flex flex-col gap-0.5"
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
        <SidebarStatusRow />
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

      <Suspense fallback={null}>
        {showAddWs && <AddWorkspaceModal onClose={() => setShowAddWs(false)} />}
        {showAddService && <AddServiceModal onClose={() => setShowAddService(false)} />}
        {settingsWs && <WorkspaceSettingsModal workspace={settingsWs} onClose={() => setSettingsWs(null)} />}
        {editingService && <ServiceSettingsModal service={editingService} onClose={() => setEditingService(null)} />}
      </Suspense>
    </aside>
  );
}

/**
 * Compact status/version row. The dot carries system state via tooltip; the
 * text stays focused on the app version.
 */
function SidebarStatusRow() {
  const { setupStatus, updaterPhase, updaterInfo, updaterError } = usePortaStore(
    useShallow((s) => ({
      setupStatus: s.setupStatus,
      updaterPhase: s.updaterPhase,
      updaterInfo: s.updaterInfo,
      updaterError: s.updaterError,
    })),
  );
  const [open, setOpen] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (rowRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const updateDot =
    updaterPhase === "available" || updaterPhase === "ready" ? "bg-amber-400 pulse-dot" :
    updaterPhase === "checking" || updaterPhase === "downloading" || updaterPhase === "installing" || updaterPhase === "restarting" ? "bg-blue-400 pulse-dot" :
    updaterPhase === "error" ? "bg-red-400 pulse-dot" :
    null;

  const updateSummary =
    updaterPhase === "available" && updaterInfo ? `Update ${updaterInfo.version} available` :
    updaterPhase === "ready" && updaterInfo ? `Update ${updaterInfo.version} ready` :
    updaterPhase === "checking" ? "Checking for updates" :
    updaterPhase === "downloading" && updaterInfo ? `Downloading ${updaterInfo.version}` :
    updaterPhase === "installing" ? "Installing update" :
    updaterPhase === "restarting" ? "Restarting" :
    updaterPhase === "error" ? "Update check failed" :
    "No update pending";

  function popoverAction(label: string, onClick: () => void, tone: "primary" | "neutral" = "neutral") {
    return (
      <button
        onClick={(e) => {
          e.stopPropagation();
          onClick();
        }}
        className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${
          tone === "primary"
            ? "text-blue-300 bg-blue-500/10 hover:bg-blue-500/20"
            : "text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.06]"
        }`}
      >
        {label}
      </button>
    );
  }

  function UpdatePopover({ systemTooltip }: { systemTooltip: string }) {
    return (
      <div
        className="absolute left-0 bottom-full mb-1.5 w-[220px] rounded-lg border border-white/[0.10] bg-[#1c1c1e] shadow-2xl overflow-hidden z-50"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-3 py-2 border-b border-white/[0.06]">
          <div className="flex items-center gap-2">
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${updateDot ?? "bg-emerald-400"}`} />
            <p className="text-[12px] font-medium text-zinc-200 truncate">{updateSummary}</p>
          </div>
          <p className="mt-1 text-[10px] text-zinc-600 font-mono">Porta {__BUILD_TAG__}</p>
        </div>
        <div className="px-3 py-2 space-y-2">
          {(updaterPhase === "available" || updaterPhase === "ready") && updaterInfo && (
            <p className="text-[11px] text-zinc-500">
              <span className="font-mono text-amber-300">{updaterInfo.version}</span>{" "}
              {updaterPhase === "ready" ? "installed — see the update prompt to restart." : "available — see the update prompt to install."}
            </p>
          )}
          {(updaterPhase === "checking" || updaterPhase === "downloading" || updaterPhase === "installing" || updaterPhase === "restarting") && (
            <p className="text-[11px] text-zinc-500">Update task is running in the background.</p>
          )}
          {updaterPhase === "error" && (
            <>
              <p className="text-[11px] text-red-300/80 break-words">{updaterError || "Unknown update error"}</p>
              <div className="flex items-center gap-2">
                {popoverAction("Retry", () => { void checkForUpdate({ silent: false }); }, "primary")}
                {popoverAction("Dismiss", dismissUpdater)}
              </div>
            </>
          )}
          {updaterPhase === "idle" && (
            <>
              <p className="text-[11px] text-zinc-500">Porta checks on launch, periodically, and when the window regains focus.</p>
              <div className="flex items-center gap-2">
                {popoverAction("Check now", () => { void checkForUpdate({ silent: false }); }, "primary")}
              </div>
            </>
          )}
          <div className="pt-2 border-t border-white/[0.06]">
            <p className="text-[10px] text-zinc-600 whitespace-pre-line">{systemTooltip}</p>
          </div>
        </div>
      </div>
    );
  }

  if (!setupStatus) {
    const dotClass = updateDot ?? "bg-zinc-600";
    const tooltip = `System status unavailable\n${updateSummary}\nPorta ${__BUILD_TAG__}`;
    return (
      <div ref={rowRef} className="relative">
        {open && <UpdatePopover systemTooltip="System status unavailable" />}
        <div
          role="button"
          tabIndex={0}
          onClick={() => setOpen((v) => !v)}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setOpen((v) => !v); }}
          title={tooltip}
          className="flex items-center gap-2 w-full px-2 py-1.5 rounded-[6px] text-[9px] text-zinc-700 hover:text-zinc-500 hover:bg-white/[0.05] transition-all duration-100 font-mono select-text"
        >
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotClass}`} />
          <span className="truncate">v{__BUILD_TAG__}</span>
        </div>
      </div>
    );
  }

  // Order matters: missing > installed-but-stopped > all-green. The first
  // condition that matches wins, so a critical issue surfaces first.
  const issues: string[] = [];
  if (!setupStatus.caddy_installed)     issues.push("Caddy not installed");
  else if (!setupStatus.caddy_running)  issues.push("Caddy stopped");
  if (!setupStatus.dnsmasq_installed)   issues.push("dnsmasq not installed");
  if (!setupStatus.mkcert_installed)    issues.push("mkcert not installed");
  if (!setupStatus.certs_generated)     issues.push("TLS certs not generated");

  const tone: "ok" | "warn" | "bad" =
    !setupStatus.caddy_installed || !setupStatus.dnsmasq_installed || !setupStatus.mkcert_installed
      ? "bad"
      : issues.length > 0
        ? "warn"
        : "ok";

  const setupDotClass =
    tone === "ok"   ? "bg-emerald-400" :
    tone === "warn" ? "bg-amber-400 pulse-dot" :
                      "bg-red-400 pulse-dot";
  const dotClass = updateDot ?? setupDotClass;

  const label = `v${__BUILD_TAG__}`;
  const systemTooltip =
    tone === "ok" ? `All systems go\nPorta ${__BUILD_TAG__}` : `${issues.join("\n")}\nPorta ${__BUILD_TAG__}`;
  const tooltip = `${updateSummary}\n${systemTooltip}`;

  const dot = <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotClass}`} />;

  return (
    <div ref={rowRef} className="relative">
      {open && <UpdatePopover systemTooltip={systemTooltip} />}
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 w-full px-2 py-1.5 rounded-[6px] text-[9px] text-zinc-700 hover:text-zinc-500 hover:bg-white/[0.05] transition-all duration-100 font-mono"
        title={tooltip}
      >
        {dot}
        <span className="truncate">{label}</span>
      </button>
    </div>
  );
}
