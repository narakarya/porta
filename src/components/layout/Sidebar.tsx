import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { usePortaStore } from "../../store";
import { isTauri, openExternalUrl, openInTerminal } from "../../lib/commands";
import type { AppInstance } from "../../lib/commands";
import type { App, Workspace } from "../../types";
import WorkspaceContextMenu from "../workspace/WorkspaceContextMenu";
import AppContextMenu from "../app/AppContextMenu";
import Tooltip from "../shared/Tooltip";
import { Spinner } from "../ui";
import { SidebarFrame, SidebarHeader, SidebarBody, SidebarFooter, SidebarGroupHeader, SidebarAddButton } from "./SidebarShell";

// Sidebar modals — kept out of the initial bundle since they only show on
// click. Without lazy() they'd be parsed up-front for every app launch.
const AddWorkspaceModal = lazy(() => import("../workspace/AddWorkspaceModal"));
const WorkspaceSettingsModal = lazy(() => import("../workspace/WorkspaceSettingsModal"));
const AddAppModal = lazy(() => import("../app/AddAppModal"));
const AppSettingsModal = lazy(() => import("../app/AppSettingsModal"));
const ImportComposeModal = lazy(() => import("../workspace/ImportComposeModal"));

interface ContextMenuState {
  ws: Workspace;
  x: number;
  y: number;
}

// Mirrors AppContextMenu's (unexported) MenuItem shape so the app-row menu can
// carry leading icons + a separator.
type AppMenuItem = {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
};

export default function Sidebar() {
  const { workspaces, apps, instances, selectedWorkspaceId, selectedAppId, imageUpdateCache, setupStatus, selectWorkspace, selectApp, reorderWorkspaces, reorderApps, moveAppToWorkspace, startApp, stopApp, restartApp, deleteApp, runInstance, stopInstanceAction, killInstanceAction, removeInstanceAction, activeDomain, setActiveDomain } = usePortaStore(
    useShallow((s) => ({
      workspaces: s.workspaces,
      apps: s.apps,
      instances: s.instances,
      selectedWorkspaceId: s.selectedWorkspaceId,
      selectedAppId: s.selectedAppId,
      imageUpdateCache: s.imageUpdateCache,
      setupStatus: s.setupStatus,
      selectWorkspace: s.selectWorkspace,
      selectApp: s.selectApp,
      reorderWorkspaces: s.reorderWorkspaces,
      reorderApps: s.reorderApps,
      moveAppToWorkspace: s.moveAppToWorkspace,
      startApp: s.startApp,
      stopApp: s.stopApp,
      restartApp: s.restartApp,
      deleteApp: s.deleteApp,
      runInstance: s.runInstance,
      stopInstanceAction: s.stopInstanceAction,
      killInstanceAction: s.killInstanceAction,
      removeInstanceAction: s.removeInstanceAction,
      activeDomain: s.activeDomain,
      setActiveDomain: s.setActiveDomain,
    }))
  );
  const [showAddWs, setShowAddWs] = useState(false);
  const [showAddApp, setShowAddApp] = useState(false);
  const [showImportCompose, setShowImportCompose] = useState(false);
  const [filterQuery, setFilterQuery] = useState("");
  const [settingsWs, setSettingsWs] = useState<Workspace | null>(null);
  const [settingsApp, setSettingsApp] = useState<App | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [appMenu, setAppMenu] = useState<{ app: App; x: number; y: number } | null>(null);
  // Instance-row overflow / right-click menu — mirrors appMenu but carries both
  // the instance and its parent app (instance actions are keyed by app id too).
  const [instMenu, setInstMenu] = useState<{ inst: AppInstance; app: App; x: number; y: number } | null>(null);
  // App ids with a start/stop round-trip in flight — drives the row toggle's
  // inline spinner so a click gives feedback before the status event lands.
  const [busyApps, setBusyApps] = useState<Set<string>>(new Set());
  // Same idea for instance rows — instance ids with a start/stop in flight.
  const [busyInstances, setBusyInstances] = useState<Set<string>>(new Set());
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
  // Per-app collapse of its worktree-instance sub-tree (default expanded —
  // holds the app ids whose instances are collapsed). Mirrors the workspace
  // collapse convention above.
  const [collapsedInstances, setCollapsedInstances] = useState<Set<string>>(new Set());
  const toggleInstancesCollapse = (id: string) =>
    setCollapsedInstances((prev) => {
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

  // ── App-row drag-reorder ────────────────────────────────────────────────
  // Mirrors the workspace drag above but scoped to app rows, which are grouped
  // per workspace and can also be dragged BETWEEN groups (→ moveAppToWorkspace).
  // Indices here are insertion positions within a group's app list (0..len).
  const appDragSrcRef = useRef<{ appId: string; wsId: string | null; index: number } | null>(null);
  const appDragOverRef = useRef<{ wsId: string | null; index: number } | null>(null);
  const isAppDraggingRef = useRef(false);
  const [appDraggingId, setAppDraggingId] = useState<string | null>(null);
  const [appDragOver, setAppDragOverState] = useState<{ wsId: string | null; index: number } | null>(null);

  function setDragOver(val: typeof dragOverIndex) {
    dragOverRef.current = val;
    setDragOverIndex(val);
  }

  function setAppDragOver(val: { wsId: string | null; index: number } | null) {
    appDragOverRef.current = val;
    setAppDragOverState(val);
  }

  function handleAppMouseDown(appId: string, wsId: string | null, index: number) {
    appDragSrcRef.current = { appId, wsId, index };
    isAppDraggingRef.current = true;
    setAppDraggingId(appId);
  }

  // Derive the insertion index (0..rows.length) from the cursor Y over a group's
  // app container. e.currentTarget is that group's list, so no per-group ref is
  // needed. Suppresses the indicator for same-group no-op targets.
  function handleAppListMouseMove(e: React.MouseEvent, wsId: string | null) {
    const src = appDragSrcRef.current;
    if (!isAppDraggingRef.current || !src) return;
    const container = e.currentTarget as HTMLElement;
    const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-approw]"));
    let idx = rows.length;
    for (let k = 0; k < rows.length; k++) {
      const r = rows[k].getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) { idx = k; break; }
    }
    // Within the source group, dropping just before/after the dragged row is a
    // no-op — hide the indicator so it reads as "no change".
    if (src.wsId === wsId && (idx === src.index || idx === src.index + 1)) {
      setAppDragOver(null);
      return;
    }
    setAppDragOver({ wsId, index: idx });
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
      // ── Workspace drag ──
      if (isDraggingRef.current) {
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
      }
      // ── App-row drag ──
      if (isAppDraggingRef.current) {
        const asrc = appDragSrcRef.current;
        const adst = appDragOverRef.current;
        if (asrc && adst) {
          if (asrc.wsId === adst.wsId) {
            // Same group: convert insertion index → post-removal target index.
            let to = adst.index;
            if (to > asrc.index) to -= 1;
            if (to !== asrc.index) reorderApps(asrc.wsId, asrc.index, to);
          } else {
            // Dropped over another workspace group → move it there.
            void moveAppToWorkspace(asrc.appId, adst.wsId);
          }
        }
        appDragSrcRef.current = null;
        appDragOverRef.current = null;
        isAppDraggingRef.current = false;
        setAppDragOverState(null);
        setAppDraggingId(null);
      }
      document.body.style.cursor = "";
    }
    window.addEventListener("mouseup", onGlobalMouseUp);
    return () => window.removeEventListener("mouseup", onGlobalMouseUp);
  }, [reorderWorkspaces, reorderApps, moveAppToWorkspace]);

  // Keep cursor grabbing globally so it doesn't flicker as mouse moves between items
  useEffect(() => {
    const dragging = draggingItem || appDraggingId;
    document.body.style.cursor = dragging ? "grabbing" : "";
    return () => { document.body.style.cursor = ""; };
  }, [draggingItem, appDraggingId]);

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

  // Keep the actionable rows, not only the workspace totals: the aggregate
  // badge is useful for discovery, but each app row also needs to identify
  // which app (and, for Compose, how many images) actually has an update.
  const updatesByApp = useMemo(() => {
    const updates = new Map<string, NonNullable<typeof imageUpdateCache[string]>>();
    for (const a of apps) {
      if (a.kind !== "docker" && a.kind !== "compose") continue;
      const actionable = (imageUpdateCache[a.id] ?? []).filter(
        (i) => i.status === "ok" && (i.has_digest_update || !!i.suggested_tag)
      );
      if (actionable.length > 0) updates.set(a.id, actionable);
    }
    return updates;
  }, [apps, imageUpdateCache]);

  const updatesByWs = useMemo(() => {
    const counts = new Map<string | null, number>();
    for (const a of apps) {
      if (updatesByApp.has(a.id)) {
        counts.set(a.workspace_id, (counts.get(a.workspace_id) ?? 0) + 1);
      }
    }
    return counts;
  }, [apps, updatesByApp]);
  const updateCount = (wsId: string | null) => updatesByWs.get(wsId) ?? 0;
  const runningTotal = useMemo(() => apps.filter((a) => a.status === "running").length, [apps]);
  const updatesTotal = useMemo(() => [...updatesByWs.values()].reduce((sum, n) => sum + n, 0), [updatesByWs]);



  function handleRightClick(e: React.MouseEvent, ws: Workspace) {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ ws, x: e.clientX, y: e.clientY });
  }

  // Public URL for an app row — mirrors AppCard's host resolution so "Open in
  // browser" lands on the same address Caddy serves.
  function appUrl(a: App): string {
    const ws = workspaces.find((w) => w.id === a.workspace_id) ?? null;
    const domain = a.custom_domain || ws?.domain || "narakarya.test";
    const sub = a.subdomain ?? a.name;
    const host = sub === "*" ? `*.${domain}` : `${sub}.${domain}`;
    const scheme = setupStatus?.certs_generated ? "https" : "http";
    return `${scheme}://${host}`;
  }

  // Toggle a row's process, tracking the in-flight round-trip so the button
  // can show a spinner. Store actions flip status optimistically, but the IPC
  // still awaits — the spinner covers that gap and any slow compose down.
  async function toggleApp(a: App) {
    if (busyApps.has(a.id)) return;
    const running = a.status === "running" || a.status === "starting";
    setBusyApps((prev) => new Set(prev).add(a.id));
    try {
      if (running) await stopApp(a.id);
      else await startApp(a.id);
    } catch {
      // Store already reconciles status on failure; nothing to surface here.
    } finally {
      setBusyApps((prev) => {
        const next = new Set(prev);
        next.delete(a.id);
        return next;
      });
    }
  }

  // Context-menu items for an app row (overflow button + right-click). Wired to
  // the same store/lib actions the workbench uses — no new actions invented.
  // Icons match the app's inline line-icon style (mockup 03's iconed menu).
  function appMenuItems(a: App): (AppMenuItem | "separator")[] {
    const running = a.status === "running" || a.status === "starting";
    return [
      running
        ? { label: "Stop", icon: <StopMenuIcon />, onClick: () => { void toggleApp(a); } }
        : { label: "Start", icon: <PlayMenuIcon />, onClick: () => { void toggleApp(a); } },
      { label: "Restart", icon: <RefreshMenuIcon />, onClick: () => { void restartApp(a.id); } },
      { label: "Terminal", icon: <TerminalMenuIcon />, disabled: !isTauri || !a.root_dir, onClick: () => { if (isTauri && a.root_dir) void openInTerminal(a.root_dir); } },
      { label: "Open in browser", icon: <ExternalMenuIcon />, disabled: !isTauri, onClick: () => { if (isTauri) void openExternalUrl(appUrl(a)); } },
      { label: "Settings", icon: <GearMenuIcon />, onClick: () => setSettingsApp(a) },
      "separator",
      { label: "Remove", icon: <TrashMenuIcon />, danger: true, onClick: () => { void deleteApp(a.id); } },
    ];
  }

  // Toggle a worktree instance's process, tracking the in-flight round-trip so
  // the row button can show a spinner. Mirrors toggleApp for app rows.
  async function toggleInstance(inst: AppInstance, app: App) {
    if (busyInstances.has(inst.id)) return;
    const running = inst.status === "running" || inst.status === "starting";
    setBusyInstances((prev) => new Set(prev).add(inst.id));
    try {
      if (running) await stopInstanceAction(inst.id, app.id);
      else await runInstance(app.id, inst.worktree_path);
    } catch {
      // Store reconciles status on failure; nothing to surface here.
    } finally {
      setBusyInstances((prev) => {
        const next = new Set(prev);
        next.delete(inst.id);
        return next;
      });
    }
  }

  // Public URL for an instance row — its own subdomain when it has one, else the
  // raw localhost port. Mirrors the workbench's instance "Open" target.
  function instanceUrl(inst: AppInstance): string {
    return inst.subdomain ? `https://${inst.subdomain}.test` : `http://localhost:${inst.port}`;
  }

  // Context-menu items for an instance sub-row (overflow button + right-click).
  // Mirrors appMenuItems but maps to the instance store actions. Instance
  // actions are keyed by (instanceId, appId), so the parent app is threaded in.
  function instanceMenuItems(inst: AppInstance, app: App): (AppMenuItem | "separator")[] {
    const running = inst.status === "running" || inst.status === "starting";
    return [
      running
        ? { label: "Stop", icon: <StopMenuIcon />, onClick: () => { void toggleInstance(inst, app); } }
        : { label: "Start", icon: <PlayMenuIcon />, onClick: () => { void toggleInstance(inst, app); } },
      { label: "Restart", icon: <RefreshMenuIcon />, onClick: () => { void (async () => { await killInstanceAction(inst.id, app.id); await runInstance(app.id, inst.worktree_path); })(); } },
      { label: "Terminal", icon: <TerminalMenuIcon />, disabled: !isTauri, onClick: () => { if (isTauri) void openInTerminal(inst.worktree_path); } },
      { label: "Open in browser", icon: <ExternalMenuIcon />, disabled: !isTauri, onClick: () => { if (isTauri) void openExternalUrl(instanceUrl(inst)); } },
      "separator",
      { label: "Remove", icon: <TrashMenuIcon />, danger: true, onClick: () => { void removeInstanceAction(inst.id, app.id); } },
    ];
  }

  // App rows shown under a workspace header. Clicking one opens the app in the
  // workbench (content-forward main). Status/port are baked into the row.
  function renderApps(wsId: string | null) {
    const q = filterQuery.trim().toLowerCase();
    const list = (appsByWs.get(wsId) ?? []).filter((a) => !q || a.name.toLowerCase().includes(q));
    // Drag is only meaningful over the unfiltered group (indices must line up
    // with the full group order the store reorders). While an app is being
    // dragged, keep even empty groups mounted so they're valid drop targets.
    const dragEnabled = !q;
    const dragActive = appDraggingId !== null;
    if (list.length === 0 && !dragActive) return null;
    const overHere = dragActive && appDragOver?.wsId === wsId ? appDragOver.index : null;
    return (
      <div
        className={`flex flex-col gap-px mb-0.5 ${dragActive && list.length === 0 ? "min-h-[22px]" : "min-h-[2px]"}`}
        onMouseMove={(e) => handleAppListMouseMove(e, wsId)}
        onMouseLeave={() => { if (isAppDraggingRef.current) setAppDragOver(null); }}
      >
        {list.map((a, i) => {
          const on = selectedAppId === a.id;
          const running = a.status === "running" || a.status === "starting";
          const busy = busyApps.has(a.id);
          const menuOpen = appMenu?.app.id === a.id;
          const isAppGhost = appDraggingId === a.id;
          const pendingImageUpdates = updatesByApp.get(a.id) ?? [];
          const imageUpdateLabel = pendingImageUpdates.length > 0
            ? `${pendingImageUpdates.length} image update${pendingImageUpdates.length > 1 ? "s" : ""} available · ${pendingImageUpdates
                .map((info) => info.service_name ? `${info.service_name} (${info.image})` : info.image)
                .join(", ")}`
            : "";
          // Worktree instances discovered under this app (loaded globally at
          // workspace load). Drives the disclosure chevron + indented sub-rows.
          const appInstances = instances[a.id] ?? [];
          const hasInstances = appInstances.length > 0;
          const instancesExpanded = hasInstances && !collapsedInstances.has(a.id);
          const dot =
            a.status === "running" ? "bg-emerald-400 pulse-dot"
            : a.status === "starting" ? "bg-amber-400"
            : "bg-zinc-600";
          return (
            <div key={a.id} className="relative">
              {overHere === i && (
                <div className="absolute -top-px left-4 right-1 h-0.5 rounded-full bg-blue-400 z-20 pointer-events-none" />
              )}
              <div
                role="button"
                tabIndex={0}
                data-approw={a.id}
                onMouseDown={() => { if (dragEnabled) handleAppMouseDown(a.id, wsId, i); }}
                onClick={() => { selectApp(a.id); setActiveDomain("workspaces"); }}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectApp(a.id); setActiveDomain("workspaces"); } }}
                onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setAppMenu({ app: a, x: e.clientX, y: e.clientY }); }}
                title={`${a.name} · :${a.port}`}
                style={isAppGhost ? { opacity: 0.35 } : undefined}
                className={`group flex items-center gap-2 pl-5 pr-2 py-1.5 rounded-[6px] text-[13px] w-full text-left select-none transition-colors ${
                  dragEnabled ? "cursor-grab" : "cursor-pointer"
                } ${on ? "bg-accent-bg text-ink" : "text-ink hover:bg-white/[0.05]"}`}
              >
                {/* Fixed disclosure column, present on EVERY app row so the
                    status dot + name align whether or not the app has
                    instances. Holds the expand chevron only when there are
                    instances; otherwise an empty spacer of the same width. */}
                <span className="-ml-3.5 shrink-0 w-3.5 flex items-center justify-center">
                  {hasInstances && (
                    <button
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => { e.stopPropagation(); toggleInstancesCollapse(a.id); }}
                      title={instancesExpanded ? "Hide instances" : "Show instances"}
                      className="p-0.5 -m-0.5 text-ink-3 hover:text-ink-2 transition-colors"
                    >
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" className={`transition-transform duration-150 ${instancesExpanded ? "rotate-90" : ""}`}>
                        <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    </button>
                  )}
                </span>
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dot}`} />
                <span className="flex-1 truncate">{a.name}</span>
                {pendingImageUpdates.length > 0 && (
                  <Tooltip label={imageUpdateLabel} side="right" className="shrink-0 flex items-center">
                    <span
                      role="status"
                      aria-label={imageUpdateLabel}
                      className="text-[10px] text-amber-400 font-medium tabular-nums"
                    >
                      {pendingImageUpdates.length}↑
                    </span>
                  </Tooltip>
                )}
                {/* Instance count + port at rest; start/stop toggle + overflow reveal on hover. */}
                <span className={`flex items-center gap-1.5 group-hover:hidden ${menuOpen ? "hidden" : ""}`}>
                  {hasInstances && (
                    <span className="flex items-center gap-1 text-[9.5px] text-ink-3 tabular-nums" title={`${appInstances.length} instance${appInstances.length > 1 ? "s" : ""}`}>
                      <GitBranchIcon />
                      {appInstances.length}
                    </span>
                  )}
                  <span className="text-[10px] text-zinc-600 font-mono tabular-nums">:{a.port}</span>
                </span>
                <span className={`items-center gap-1 shrink-0 ${menuOpen ? "flex" : "hidden group-hover:flex"}`}>
                  <button
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); void toggleApp(a); }}
                    disabled={busy}
                    title={busy ? (running ? "Stopping…" : "Starting…") : running ? "Stop" : "Start"}
                    className={`p-0.5 rounded transition-colors disabled:pointer-events-none ${running ? "text-zinc-400 hover:text-zinc-100" : "text-emerald-400 hover:text-emerald-300"}`}
                  >
                    {busy ? (
                      <Spinner size={13} />
                    ) : running ? (
                      <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><rect x="4" y="4" width="8" height="8" rx="1.5" /></svg>
                    ) : (
                      <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M5 3.5v9l7-4.5-7-4.5Z" /></svg>
                    )}
                  </button>
                  <button
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); setAppMenu({ app: a, x: r.right, y: r.bottom + 4 }); }}
                    title="More"
                    className="p-0.5 rounded text-zinc-500 hover:text-zinc-200 transition-colors"
                  >
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><circle cx="3.5" cy="8" r="1.3" /><circle cx="8" cy="8" r="1.3" /><circle cx="12.5" cy="8" r="1.3" /></svg>
                  </button>
                </span>
              </div>
              {/* Worktree instances as an indented sub-tree. Clicking a sub-row
                  selects the PARENT app and opens its workbench (where the
                  Overview instances section lives) — no per-instance selection
                  state exists. */}
              {instancesExpanded && (
                // Indented sub-tree. The container's left border is the tree
                // connector — it lines up under the parent app's status dot so
                // the children visibly hang off the app. ml sits the connector
                // just left of the instance dots (one indent step deeper than
                // the app dot); instance rows stay muted with no accent bg.
                <div className="ml-[30px] border-l border-[rgba(255,255,255,0.07)] flex flex-col gap-px mt-px mb-0.5">
                  {appInstances.map((inst) => {
                    const instOn = inst.status === "running" || inst.status === "starting";
                    const instBusy = busyInstances.has(inst.id);
                    const instMenuOpen = instMenu?.inst.id === inst.id;
                    return (
                      <div
                        key={inst.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => { selectApp(a.id); setActiveDomain("workspaces"); }}
                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectApp(a.id); setActiveDomain("workspaces"); } }}
                        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setInstMenu({ inst, app: a, x: e.clientX, y: e.clientY }); }}
                        title={`${inst.branch} · :${inst.port}`}
                        className="group/inst flex items-center gap-2 pl-3 pr-2 py-1 rounded-control w-full text-left select-none cursor-pointer transition-colors hover:bg-white/[0.04]"
                      >
                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${instOn ? "bg-ok" : "bg-ink-3"}`} />
                        <span className="flex-1 truncate text-[12px] text-ink-2">{inst.branch}</span>
                        {/* :port at rest; start/stop toggle + overflow reveal on hover. */}
                        <span className={`text-[10px] text-ink-3 font-mono tabular-nums shrink-0 group-hover/inst:hidden ${instMenuOpen ? "hidden" : ""}`}>:{inst.port}</span>
                        <span className={`items-center gap-1 shrink-0 ${instMenuOpen ? "flex" : "hidden group-hover/inst:flex"}`}>
                          <button
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={(e) => { e.stopPropagation(); void toggleInstance(inst, a); }}
                            disabled={instBusy}
                            title={instBusy ? (instOn ? "Stopping…" : "Starting…") : instOn ? "Stop" : "Start"}
                            className={`p-0.5 rounded transition-colors disabled:pointer-events-none ${instOn ? "text-ink-2 hover:text-ink" : "text-ok hover:text-ok"}`}
                          >
                            {instBusy ? (
                              <Spinner size={12} />
                            ) : instOn ? (
                              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><rect x="4" y="4" width="8" height="8" rx="1.5" /></svg>
                            ) : (
                              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M5 3.5v9l7-4.5-7-4.5Z" /></svg>
                            )}
                          </button>
                          <button
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={(e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); setInstMenu({ inst, app: a, x: r.right, y: r.bottom + 4 }); }}
                            title="More"
                            className="p-0.5 rounded text-ink-3 hover:text-ink-2 transition-colors"
                          >
                            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><circle cx="3.5" cy="8" r="1.3" /><circle cx="8" cy="8" r="1.3" /><circle cx="12.5" cy="8" r="1.3" /></svg>
                          </button>
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        {/* Insertion line after the last row (drop at end / into empty group). */}
        {overHere === list.length && (
          <div className="relative h-0.5">
            <div className="absolute -top-px left-4 right-1 h-0.5 rounded-full bg-blue-400 z-20 pointer-events-none" />
          </div>
        )}
      </div>
    );
  }

  return (
    <SidebarFrame>
      <SidebarHeader>
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
      </SidebarHeader>
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
      <SidebarBody className="flex flex-col gap-0.5 px-2 pt-1">
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
              const collapsed = collapsedWs.has(w.id);
              const totalCount = (appsByWs.get(w.id) ?? []).length;
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
                  <SidebarGroupHeader
                    label={w.name}
                    collapsed={collapsed}
                    onToggle={() => toggleWsCollapse(w.id)}
                    count={totalCount}
                    onAdd={() => { selectWorkspace(w.id); setShowAddApp(true); }}
                    addTitle={`New app in ${w.name}`}
                    className={`w-full text-left select-none cursor-grab ${
                      isSelected ? "text-zinc-300" : "text-zinc-500 hover:text-zinc-300"
                    }`}
                    containerProps={{
                      role: "button",
                      tabIndex: 0,
                      "data-wsrow": i,
                      onMouseDown: () => handleMouseDown("ws", i),
                      onClick: () => { selectWorkspace(w.id); selectApp(null); setActiveDomain("workspaces"); },
                      onKeyDown: (e) => { if (e.key === "Enter") { selectWorkspace(w.id); selectApp(null); setActiveDomain("workspaces"); } },
                      onContextMenu: (e) => handleRightClick(e, w),
                      style: isGhost ? { opacity: 0.35 } : undefined,
                    }}
                    // Expanded: pending-update badge sits before the app count.
                    beforeCount={updCount > 0 ? (
                      <Tooltip label={`${updCount} image update${updCount > 1 ? "s" : ""} available`} side="right">
                        <span className="text-[11px] text-amber-400 font-medium tabular-nums">{updCount}↑</span>
                      </Tooltip>
                    ) : undefined}
                    // Collapsed: swap the whole right cluster for a running/idle
                    // rollup plus any pending image updates.
                    end={collapsed ? (
                      <span className="flex items-center gap-2 normal-case tracking-normal">
                        {count > 0 ? (
                          <span className="flex items-center gap-1 text-[10px] text-ink-2 tabular-nums">
                            <span className="w-[5px] h-[5px] rounded-full bg-emerald-400 shrink-0" />
                            {count}
                          </span>
                        ) : (
                          <span className="text-[10px] text-ink-3">idle</span>
                        )}
                        {updCount > 0 && (
                          <Tooltip label={`${updCount} image update${updCount > 1 ? "s" : ""} available`} side="right">
                            <span className="text-[10px] text-amber-400 font-medium tabular-nums">{updCount}↑</span>
                          </Tooltip>
                        )}
                      </span>
                    ) : undefined}
                  />
                  {showLineAfter && (
                    <div className="absolute -bottom-px left-1 right-1 h-0.5 rounded-full bg-blue-400 z-20 pointer-events-none" />
                  )}
                  {!collapsedWs.has(w.id) && renderApps(w.id)}
                </div>
              );
            })}
          </div>
        )}

      </SidebarBody>

      {/* App-list foot — Add App / Import compose (mockup: bottom of the list) */}
      <SidebarFooter className="flex flex-col gap-1">
        <SidebarAddButton label="Add App" onClick={() => setShowAddApp(true)} />
        <button
          onClick={() => setShowImportCompose(true)}
          title="Import from docker-compose.yml"
          className="flex items-center justify-center gap-1.5 w-full px-2 py-1.5 rounded-[6px] text-[12px] text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.05] transition-colors"
        >
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M6 1.5v6M3.5 5L6 7.5 8.5 5M2 9.5h8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
          Import compose
        </button>
      </SidebarFooter>

      <SidebarFooter>
        <SidebarStatusRow />
      </SidebarFooter>

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

      {appMenu && (
        <AppContextMenu
          x={appMenu.x}
          y={appMenu.y}
          onClose={() => setAppMenu(null)}
          items={appMenuItems(appMenu.app)}
        />
      )}

      {instMenu && (
        <AppContextMenu
          x={instMenu.x}
          y={instMenu.y}
          onClose={() => setInstMenu(null)}
          items={instanceMenuItems(instMenu.inst, instMenu.app)}
        />
      )}

      <Suspense fallback={null}>
        {showAddWs && <AddWorkspaceModal onClose={() => setShowAddWs(false)} />}
        {showAddApp && <AddAppModal workspaceId={selectedWorkspaceId} onClose={() => setShowAddApp(false)} />}
        {showImportCompose && <ImportComposeModal workspaceId={selectedWorkspaceId} onClose={() => setShowImportCompose(false)} />}
        {settingsWs && <WorkspaceSettingsModal workspace={settingsWs} onClose={() => setSettingsWs(null)} />}
        {settingsApp && (
          <AppSettingsModal
            app={settingsApp}
            workspace={workspaces.find((w) => w.id === settingsApp.workspace_id) ?? null}
            onClose={() => setSettingsApp(null)}
          />
        )}
      </Suspense>
    </SidebarFrame>
  );
}

// Git-branch glyph — shared by the app-row instance count badge and the
// indented instance sub-rows. Inherits color via currentColor.
function GitBranchIcon({ className }: { className?: string }) {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <circle cx="4.5" cy="3.5" r="1.6" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="4.5" cy="12.5" r="1.6" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="11.5" cy="4.5" r="1.6" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4.5 5.1v5.8M4.5 8.5c5 0 7-1 7-2.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

// ── App-row context-menu icons (11×11 line-icon set, tinted by the menu) ──────
function PlayMenuIcon() {
  return <svg width="11" height="11" viewBox="0 0 11 11" fill="currentColor"><path d="M3 2l6 3.5L3 9V2z" /></svg>;
}
function StopMenuIcon() {
  return <svg width="11" height="11" viewBox="0 0 11 11" fill="currentColor"><rect x="2.5" y="2.5" width="6" height="6" rx="1" /></svg>;
}
function RefreshMenuIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
      <path d="M8.8 3.4A3.6 3.6 0 1 0 9.3 6.7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M9.3 1.8v1.9H7.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function TerminalMenuIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
      <rect x="1" y="1.5" width="9" height="8" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <path d="M2.5 4.5l2 1.5-2 1.5M5.5 7.5h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function ExternalMenuIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
      <path d="M4.5 2.5H2.5a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1V6.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6.5 1.5h3v3M9.5 1.5l-4 4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function GearMenuIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
      <circle cx="5.5" cy="5.5" r="1.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M5.5 1v1M5.5 9v1M1 5.5h1M9 5.5h1M2.3 2.3l.7.7M8.2 8.2l.7.7M8.2 2.3l-.7.7M2.3 8.2l.7-.7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}
function TrashMenuIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
      <path d="M2 3h7M4 3V2h3v1M3 3l.5 6h4L8 3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Compact status/version row. The dot carries system (setup) health via
 * tooltip; the text stays focused on the app version. Self-update state is NOT
 * shown here — that lives in the single update popover (UpdateToast, anchored to
 * the rail avatar) plus the avatar's update dot, so there's exactly one update
 * surface instead of a redundant second popover.
 */
function SidebarStatusRow() {
  const setupStatus = usePortaStore((s) => s.setupStatus);

  if (!setupStatus) {
    return (
      <div
        title={`System status unavailable\nPorta ${__BUILD_TAG__}`}
        className="flex items-center gap-2 w-full px-2 py-1.5 rounded-[6px] text-[9px] text-zinc-700 font-mono select-text"
      >
        <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-zinc-600" />
        <span className="truncate">v{__BUILD_TAG__}</span>
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

  const dotClass =
    tone === "ok"   ? "bg-emerald-400" :
    tone === "warn" ? "bg-amber-400 pulse-dot" :
                      "bg-red-400 pulse-dot";

  // Only surface system status as text when there's a problem; a healthy stack
  // is conveyed by the green dot alone.
  const systemIssues = tone === "ok" ? null : issues.join("\n");
  const tooltip = `Porta ${__BUILD_TAG__}${systemIssues ? `\n${systemIssues}` : ""}`;

  return (
    <div
      title={tooltip}
      className="flex items-center gap-2 w-full px-2 py-1.5 rounded-[6px] text-[9px] text-zinc-700 font-mono select-text"
    >
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotClass}`} />
      <span className="truncate">v{__BUILD_TAG__}</span>
    </div>
  );
}
