import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { usePortaStore } from "../../store";
import { isTauri } from "../../lib/commands";
import type { Workspace } from "../../types";
import WorkspaceContextMenu from "../workspace/WorkspaceContextMenu";
import type { Service } from "../../types";
import Tooltip from "../shared/Tooltip";
import { checkForUpdate, dismissUpdater, startUpdateDownload } from "../../lib/updater";
import { Database, House, Lifebuoy, Pulse, SquaresFour } from "@phosphor-icons/react";

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
  const { workspaces, apps, services, selectedWorkspaceId, imageUpdateCache, appExtensions, selectWorkspace, reorderWorkspaces, reorderServices, toggleResourceDrawer, openSettingsSection, mainView, setMainView } = usePortaStore(
    useShallow((s) => ({
      workspaces: s.workspaces,
      apps: s.apps,
      services: s.services,
      selectedWorkspaceId: s.selectedWorkspaceId,
      imageUpdateCache: s.imageUpdateCache,
      appExtensions: s.appExtensions,
      selectWorkspace: s.selectWorkspace,
      reorderWorkspaces: s.reorderWorkspaces,
      reorderServices: s.reorderServices,
      toggleResourceDrawer: s.toggleResourceDrawer,
      openSettingsSection: s.openSettingsSection,
      mainView: s.mainView,
      setMainView: s.setMainView,
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
  const activeCount = (wsId: string | null) => {
    const actual = activeByWs.get(wsId) ?? 0;
    if (isTauri || actual > 0) return actual;
    const previewCounts: Record<string, number> = { "ws-2": 1, "ws-3": 1, "ws-5": 3 };
    return wsId ? previewCounts[wsId] ?? 0 : 0;
  };

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
  const extensionCount = useMemo(
    () => new Set(Object.values(appExtensions).flat().map((extension) => extension.id)).size,
    [appExtensions],
  );



  function handleRightClick(e: React.MouseEvent, ws: Workspace) {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ ws, x: e.clientX, y: e.clientY });
  }

  return (
    <aside className="w-[220px] border-r border-white/[0.07] flex flex-col pb-8 shrink-0" style={{ background: "radial-gradient(circle at 18% 0%, #202226 0%, #171719 34%, #141416 100%)" }}>
      <div className="h-[58px] flex items-center gap-2.5 px-4 shrink-0">
        <img src="/porta-logo.svg" alt="" width={24} height={24} className="rounded-[5px]" />
        <span className="text-[12px] font-semibold text-zinc-300 uppercase tracking-widest">Porta</span>
      </div>
      <div className="flex-1 flex flex-col gap-0.5 px-2 overflow-y-auto overflow-x-hidden no-drag">
        <div className="mb-4 space-y-0.5">
          <button
            onClick={() => setMainView("workspace")}
            className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-[13px] ${
              mainView === "workspace"
                ? "bg-white/[0.08] font-medium text-zinc-200"
                : "text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-200"
            }`}
          >
            <House size={13} />
            Workbench
          </button>
          <button onClick={toggleResourceDrawer} className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-[13px] text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-200">
            <Pulse size={13} />
            Activity
          </button>
          <button onClick={() => { openSettingsSection("extensions"); onOpenSettings(); }} className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-[13px] text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-200">
            <SquaresFour size={13} />
            <span className="flex-1 text-left">Extensions</span>
            {(extensionCount > 0 || !isTauri) && <span className="rounded-full bg-violet-500/25 px-1.5 py-0.5 text-[9px] font-semibold text-violet-300">{extensionCount || 3}</span>}
          </button>
        </div>
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
              const isSelected = mainView === "workspace" && selectedWorkspaceId === w.id;
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
                    onClick={() => { selectWorkspace(w.id); setMainView("workspace"); }}
                    onKeyDown={(e) => { if (e.key === "Enter") { selectWorkspace(w.id); setMainView("workspace"); } }}
                    onContextMenu={(e) => handleRightClick(e, w)}
                    style={isGhost ? { opacity: 0.35 } : undefined}
                    className={`flex items-center gap-2.5 px-2 py-2 rounded-[6px] text-[13px] w-full text-left select-none cursor-grab ${
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

        {showOtherSection && isTauri && (
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
              const isSelected = mainView === "workspace" && selectedWorkspaceId === null;
              return (
                <button
                  onClick={() => { selectWorkspace(null); setMainView("workspace"); }}
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

        {/* Hosts (SSH) */}
        <button
          onClick={() => setMainView("hosts")}
          className={`flex items-center gap-2.5 px-2 py-1.5 mt-3 rounded-[6px] text-[13px] w-full text-left transition-all duration-100 ${
            mainView === "hosts"
              ? "bg-white/10 text-zinc-100"
              : "text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-200"
          }`}
        >
          <svg width="13" height="13" viewBox="0 0 12 12" fill="none" className="shrink-0">
            <rect x="1" y="2" width="10" height="7" rx="1" stroke="currentColor" strokeWidth="1.1"/>
            <path d="M3 4.5l1.5 1L3 6.5M6 6.5h2.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <span className="flex-1">Hosts</span>
        </button>

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
                    className="group/svc flex items-center gap-2.5 px-2 py-2 rounded-[6px] text-[13px] text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-200 cursor-grab"
                  >
                    <Database size={14} className={isRunning ? "text-zinc-500" : "text-zinc-600"} />
                    <span className="flex-1 truncate">{svc.name}</span>
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
        <button className="flex items-center gap-2 w-full px-2 py-1.5 rounded-[6px] text-[12px] text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.05] transition-all duration-100">
          <Lifebuoy size={13} />
          <span>Help &amp; Feedback</span>
        </button>
        {!isTauri && <div className="h-[228px] shrink-0" />}
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
  const [open, setOpen] = useState(!isTauri);
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
    updaterPhase === "available" && updaterInfo ? `Porta ${updaterInfo.version} available` :
    updaterPhase === "ready" && updaterInfo ? `Update ${updaterInfo.version} ready` :
    updaterPhase === "checking" ? "Checking for updates" :
    updaterPhase === "uptodate" ? "You're on the latest version" :
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
        className={`px-2.5 py-1 rounded-md text-[12px] font-medium transition-colors ${
          tone === "primary"
            ? "text-blue-300 bg-blue-500/10 hover:bg-blue-500/20"
            : "text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.06]"
        }`}
      >
        {label}
      </button>
    );
  }

  function UpdatePopover({ systemIssues }: { systemIssues: string | null }) {
    const busy = updaterPhase === "checking" || updaterPhase === "downloading"
      || updaterPhase === "installing" || updaterPhase === "restarting";
    return (
      <div
        className="absolute left-2.5 bottom-full mb-5 w-[210px] rounded-xl border border-white/[0.12] bg-[#1b1d20] shadow-2xl overflow-hidden z-50"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-3 py-3 space-y-2.5">
          <div>
            <div className="flex items-center gap-2">
              {busy ? (
                <span className="spinner text-blue-400" style={{ width: 11, height: 11 }} />
              ) : (
                <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-emerald-400" />
              )}
              <p className="text-[13px] font-medium text-zinc-200 truncate">{updateSummary}</p>
            </div>
            <p className="mt-1 text-[11px] text-zinc-500">You're on <span className="font-mono">{updaterInfo?.currentVersion || __BUILD_TAG__}</span></p>
          </div>

          {(updaterPhase === "available" || updaterPhase === "ready") && updaterInfo && (
            <>
              <div className="border-t border-white/[0.07] pt-2">
                <p className="mb-1.5 text-[11px] font-semibold text-zinc-300">What's new</p>
                <ul className="space-y-1 text-[11px] leading-relaxed text-zinc-500">
                  {(updaterInfo.body || "Performance and reliability improvements").split("\n").filter(Boolean).slice(0, 3).map((line) => <li key={line}>• {line.replace(/^[-*•]\s*/, "")}</li>)}
                </ul>
              </div>
              <div className="flex items-center gap-2 pt-1">
                {updaterPhase === "available" && popoverAction("Download", () => { void startUpdateDownload(); }, "primary")}
                {updaterPhase === "ready" && <span className="text-[10px] text-emerald-300">Ready to restart</span>}
                {popoverAction("Later", () => setOpen(false))}
              </div>
            </>
          )}
          {busy && (
            <p className="text-[11px] text-zinc-500">Update task is running in the background.</p>
          )}
          {updaterPhase === "error" && (
            <>
              <p className="text-[11px] text-red-300/80 break-words">{updaterError || "Unknown update error"}</p>
              <div className="flex items-center gap-2">
                {popoverAction("Retry", () => { void checkForUpdate({ silent: false, source: "popover" }); }, "primary")}
                {popoverAction("Dismiss", dismissUpdater)}
              </div>
            </>
          )}
          {(updaterPhase === "idle" || updaterPhase === "uptodate") && (
            <div className="flex items-center gap-2">
              {popoverAction("Check now", () => { void checkForUpdate({ silent: false, source: "popover" }); }, "primary")}
            </div>
          )}

          {/* System health surfaces only when something's actually wrong — when
              all good, the green dot already says so. */}
          {systemIssues && (
            <div className="pt-2 border-t border-white/[0.06]">
              <p className="text-[10px] text-amber-300/80 whitespace-pre-line">{systemIssues}</p>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (!setupStatus) {
    const dotClass = updateDot ?? "bg-zinc-600";
    const tooltip = `System status unavailable\n${updateSummary}\nPorta ${__BUILD_TAG__}`;
    return (
      <div ref={rowRef} className="relative">
        {open && <UpdatePopover systemIssues="System status unavailable" />}
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

  const label = `v${updaterInfo?.currentVersion || __BUILD_TAG__}`;
  // Only surface system status as text when there's a problem; a healthy stack
  // is conveyed by the green dot alone.
  const systemIssues = tone === "ok" ? null : issues.join("\n");
  const tooltip = `${updateSummary} · Porta ${__BUILD_TAG__}${systemIssues ? `\n${systemIssues}` : ""}`;

  const dot = <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotClass}`} />;

  return (
    <div ref={rowRef} className="relative">
      {open && <UpdatePopover systemIssues={systemIssues} />}
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
