import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { usePortaStore } from "../../store";
import { isTauri } from "../../lib/commands";
import type { Workspace } from "../../types";
import WorkspaceContextMenu from "../workspace/WorkspaceContextMenu";
import Tooltip from "../shared/Tooltip";
import { checkForUpdate, dismissUpdater } from "../../lib/updater";

// Sidebar modals — kept out of the initial bundle since they only show on
// click. Without lazy() they'd be parsed up-front for every app launch.
const AddWorkspaceModal = lazy(() => import("../workspace/AddWorkspaceModal"));
const WorkspaceSettingsModal = lazy(() => import("../workspace/WorkspaceSettingsModal"));
const AddAppModal = lazy(() => import("../app/AddAppModal"));
const ImportComposeModal = lazy(() => import("../workspace/ImportComposeModal"));

interface ContextMenuState {
  ws: Workspace;
  x: number;
  y: number;
}

export default function Sidebar() {
  const { workspaces, apps, selectedWorkspaceId, selectedAppId, imageUpdateCache, selectWorkspace, selectApp, reorderWorkspaces, activeDomain, setActiveDomain } = usePortaStore(
    useShallow((s) => ({
      workspaces: s.workspaces,
      apps: s.apps,
      selectedWorkspaceId: s.selectedWorkspaceId,
      selectedAppId: s.selectedAppId,
      imageUpdateCache: s.imageUpdateCache,
      selectWorkspace: s.selectWorkspace,
      selectApp: s.selectApp,
      reorderWorkspaces: s.reorderWorkspaces,
      activeDomain: s.activeDomain,
      setActiveDomain: s.setActiveDomain,
    }))
  );
  const [showAddWs, setShowAddWs] = useState(false);
  const [showAddApp, setShowAddApp] = useState(false);
  const [showImportCompose, setShowImportCompose] = useState(false);
  const [filterQuery, setFilterQuery] = useState("");
  const [settingsWs, setSettingsWs] = useState<Workspace | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [wsExpanded] = useState(true);
  // Per-workspace collapse of the app sub-list (Shell C: apps live under each
  // workspace header in this column). Holds the ids that are collapsed.
  const [collapsedWs, setCollapsedWs] = useState<Set<string>>(new Set());
  const toggleWsCollapse = (id: string) =>
    setCollapsedWs((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
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
    let idx: number;
    if (type === "ws") {
      // Workspace rows now interleave with their app sub-lists, so the container
      // is no longer a uniform grid — derive the target from the header rows'
      // actual positions (tagged data-wsrow) instead of proportional height.
      const rows = Array.from(ref.current.querySelectorAll<HTMLElement>("[data-wsrow]"));
      idx = rows.findIndex((el) => e.clientY < el.getBoundingClientRect().bottom);
      if (idx === -1) idx = count - 1;
    } else {
      const rect = ref.current.getBoundingClientRect();
      const relY = e.clientY - rect.top;
      idx = Math.min(count - 1, Math.max(0, Math.floor(relY / (rect.height / count))));
    }
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
  }, [reorderWorkspaces]);

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

  // Apps grouped by workspace id, preserving store order — feeds the per-group
  // app rows rendered under each workspace header (Shell C app list column).
  const appsByWs = useMemo(() => {
    const m = new Map<string | null, typeof apps>();
    for (const a of apps) {
      const list = m.get(a.workspace_id) ?? [];
      list.push(a);
      m.set(a.workspace_id, list);
    }
    return m;
  }, [apps]);

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
  const runningTotal = useMemo(() => apps.filter((a) => a.status === "running").length, [apps]);
  const updatesTotal = useMemo(() => [...updatesByWs.values()].reduce((sum, n) => sum + n, 0), [updatesByWs]);



  function handleRightClick(e: React.MouseEvent, ws: Workspace) {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ ws, x: e.clientX, y: e.clientY });
  }

  // App rows shown under a workspace header. Clicking one opens the app in the
  // workbench (content-forward main). Status/port are baked into the row.
  function renderApps(wsId: string | null) {
    const q = filterQuery.trim().toLowerCase();
    const list = (appsByWs.get(wsId) ?? []).filter((a) => !q || a.name.toLowerCase().includes(q));
    if (list.length === 0) return null;
    return (
      <div className="flex flex-col gap-px mb-0.5">
        {list.map((a) => {
          const on = selectedAppId === a.id;
          const dot =
            a.status === "running" ? "bg-emerald-400 pulse-dot"
            : a.status === "starting" ? "bg-amber-400"
            : "bg-zinc-600";
          return (
            <button
              key={a.id}
              onClick={() => { selectApp(a.id); setActiveDomain("workspaces"); }}
              title={`${a.name} · :${a.port}`}
              className={`group flex items-center gap-2 pl-5 pr-2 py-1.5 rounded-[6px] text-[13px] w-full text-left transition-colors ${
                on ? "bg-accent-bg text-zinc-100" : "text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-200"
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dot}`} />
              <span className="flex-1 truncate">{a.name}</span>
              <span className="text-[10px] text-zinc-600 font-mono tabular-nums group-hover:text-zinc-500">:{a.port}</span>
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <aside className="w-[216px] bg-[#0d0d0f] border-r border-white/[0.07] flex flex-col pb-2 shrink-0">
      <div className="drag-region px-3.5 pt-3 pb-2 shrink-0 flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="no-drag text-[15px] font-semibold text-zinc-100 leading-tight">Workspaces</div>
          <div className="no-drag text-[11px] text-zinc-500 mt-0.5">
            {runningTotal} running{updatesTotal > 0 ? ` · ${updatesTotal} update${updatesTotal > 1 ? "s" : ""}` : ""}
          </div>
        </div>
        <Tooltip label="New Workspace" side="left">
          <button
            onClick={() => setShowAddWs(true)}
            className="no-drag text-zinc-600 hover:text-zinc-300 transition-colors p-1 -mr-1 mt-0.5 rounded"
          >
            <svg width="12" height="12" viewBox="0 0 10 10" fill="none">
              <path d="M5 2v6M2 5h6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
            </svg>
          </button>
        </Tooltip>
      </div>
      {/* Filter apps (mockup) — filters the app rows by name */}
      <div className="px-2.5 pb-2 shrink-0">
        <div className="flex items-center gap-1.5 border border-white/[0.08] rounded-[7px] px-2 py-1 focus-within:border-white/20 transition-colors">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="text-zinc-600 shrink-0"><circle cx="5" cy="5" r="3.3" stroke="currentColor" strokeWidth="1.2"/><path d="M7.6 7.6l2 2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
          <input
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            placeholder="Filter apps…"
            spellCheck={false}
            className="flex-1 min-w-0 bg-transparent text-[12px] text-zinc-300 placeholder-zinc-600 outline-none"
          />
          {filterQuery ? (
            <button onClick={() => setFilterQuery("")} className="text-zinc-600 hover:text-zinc-300 text-[13px] leading-none shrink-0">×</button>
          ) : (
            <span className="text-[10px] text-zinc-700 border border-white/[0.08] rounded px-1 shrink-0">⌘K</span>
          )}
        </div>
      </div>
      <div className="flex-1 flex flex-col gap-0.5 px-2 overflow-y-auto overflow-x-hidden no-drag pt-1">
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
              const isSelected = activeDomain === "workspaces" && selectedWorkspaceId === w.id;
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
                    data-wsrow={i}
                    onMouseDown={() => handleMouseDown("ws", i)}
                    onClick={() => { selectWorkspace(w.id); selectApp(null); setActiveDomain("workspaces"); }}
                    onKeyDown={(e) => { if (e.key === "Enter") { selectWorkspace(w.id); selectApp(null); setActiveDomain("workspaces"); } }}
                    onContextMenu={(e) => handleRightClick(e, w)}
                    style={isGhost ? { opacity: 0.35 } : undefined}
                    className={`group/wsh flex items-center gap-1 px-1.5 py-1 mt-1.5 rounded-[6px] text-[10.5px] font-medium uppercase tracking-[0.05em] w-full text-left select-none cursor-grab transition-colors ${
                      isSelected ? "text-zinc-300" : "text-zinc-500 hover:text-zinc-300"
                    }`}
                  >
                    <button
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => { e.stopPropagation(); toggleWsCollapse(w.id); }}
                      className="shrink-0 p-0.5 text-zinc-600 hover:text-zinc-300"
                      title={collapsedWs.has(w.id) ? "Expand" : "Collapse"}
                    >
                      <svg width="8" height="8" viewBox="0 0 8 8" fill="none" className={`transition-transform duration-150 ${collapsedWs.has(w.id) ? "" : "rotate-90"}`}>
                        <path d="M2.5 1.5L5.5 4L2.5 6.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    </button>
                    <span className="flex-1 truncate">{w.name}</span>
                    {updCount > 0 && (
                      <Tooltip label={`${updCount} image update${updCount > 1 ? "s" : ""} available`} side="right">
                        <span className="text-[11px] text-amber-400 font-medium tabular-nums">{updCount}↑</span>
                      </Tooltip>
                    )}
                    {count > 0 && (
                      <span className="text-[11px] text-emerald-400 font-semibold tabular-nums">{count}</span>
                    )}
                    <button
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => { e.stopPropagation(); selectWorkspace(w.id); setShowAddApp(true); }}
                      title={`New app in ${w.name}`}
                      className="shrink-0 -mr-0.5 p-0.5 rounded text-zinc-600 opacity-0 group-hover/wsh:opacity-100 hover:text-zinc-300 transition-opacity"
                    >
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M5 2v6M2 5h6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
                    </button>
                  </div>
                  {showLineAfter && (
                    <div className="absolute -bottom-px left-1 right-1 h-0.5 rounded-full bg-blue-400 z-20 pointer-events-none" />
                  )}
                  {!collapsedWs.has(w.id) && renderApps(w.id)}
                </div>
              );
            })}
          </div>
        )}

      </div>

      {/* App-list foot — Add App / Import compose (mockup: bottom of the list) */}
      <div className="px-2 pt-2 border-t border-white/[0.06] no-drag flex flex-col gap-1">
        <button
          onClick={() => setShowAddApp(true)}
          className="flex items-center justify-center gap-1.5 w-full px-2 py-1.5 rounded-[6px] text-[12px] text-zinc-300 border border-white/[0.08] hover:bg-white/[0.05] transition-colors"
        >
          <svg width="11" height="11" viewBox="0 0 10 10" fill="none"><path d="M5 2v6M2 5h6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
          Add App
        </button>
        <button
          onClick={() => setShowImportCompose(true)}
          title="Import from docker-compose.yml"
          className="flex items-center justify-center gap-1.5 w-full px-2 py-1.5 rounded-[6px] text-[12px] text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.05] transition-colors"
        >
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M6 1.5v6M3.5 5L6 7.5 8.5 5M2 9.5h8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
          Import compose
        </button>
      </div>

      <div className="px-2 pt-2 border-t border-white/[0.06] no-drag">
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
        {showAddApp && <AddAppModal workspaceId={selectedWorkspaceId} onClose={() => setShowAddApp(false)} />}
        {showImportCompose && <ImportComposeModal workspaceId={selectedWorkspaceId} onClose={() => setShowImportCompose(false)} />}
        {settingsWs && <WorkspaceSettingsModal workspace={settingsWs} onClose={() => setSettingsWs(null)} />}
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

  function UpdatePopover({ systemIssues }: { systemIssues: string | null }) {
    const busy = updaterPhase === "checking" || updaterPhase === "downloading"
      || updaterPhase === "installing" || updaterPhase === "restarting";
    return (
      <div
        className="absolute left-0 bottom-full mb-1.5 w-[220px] rounded-lg border border-white/[0.10] bg-[#1c1c1e] shadow-2xl overflow-hidden z-50"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-3 py-2.5 space-y-2">
          <div>
            <div className="flex items-center gap-2">
              {busy ? (
                <span className="spinner text-blue-400" style={{ width: 11, height: 11 }} />
              ) : (
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${updateDot ?? "bg-emerald-400"}`} />
              )}
              <p className="text-[12px] font-medium text-zinc-200 truncate">{updateSummary}</p>
            </div>
            <p className="mt-0.5 text-[10px] text-zinc-600 font-mono">Porta {__BUILD_TAG__}</p>
          </div>

          {(updaterPhase === "available" || updaterPhase === "ready") && updaterInfo && (
            <p className="text-[11px] text-zinc-500">
              <span className="font-mono text-amber-300">{updaterInfo.version}</span>{" "}
              {updaterPhase === "ready" ? "installed — see the update prompt to restart." : "available — see the update prompt to install."}
            </p>
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

  const label = `v${__BUILD_TAG__}`;
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
