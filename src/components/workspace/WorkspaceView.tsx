import { lazy, Suspense, useMemo, useRef, useEffect, useState, useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import { usePortaStore } from "../../store";
import type { App } from "../../types";
import { detectStartCommand } from "../../lib/commands";
import AppCard from "../app/AppCard";
import type { AddAppDefaultValues } from "../app/AddAppModal";
import ServiceCard from "../service/ServiceCard";
import SelectionBar from "./SelectionBar";
import ServiceSelectionBar from "./ServiceSelectionBar";

// Modals are lazy-loaded — they're large (AppSettingsModal alone is 2k+
// lines) and only mount when the user actually opens them. Eager imports
// were forcing all this code to parse on initial app load.
const AddAppModal = lazy(() => import("../app/AddAppModal"));
const AddServiceModal = lazy(() => import("../service/AddServiceModal"));
const ImportComposeModal = lazy(() => import("./ImportComposeModal"));
const AppSettingsModal = lazy(() => import("../app/AppSettingsModal"));
const TerminalModal = lazy(() => import("../terminal/TerminalModal"));

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Compute topological start order from depends_on chains. Returns a map of appId -> 1-based order number. */
function computeStartOrder(apps: { id: string; depends_on: string[] }[]): Record<string, number> {
  const order: Record<string, number> = {};
  const hasDeps = apps.some((a) => a.depends_on.length > 0);
  if (!hasDeps) return order;

  // Build in-degree map and adjacency
  const inDeg: Record<string, number> = {};
  const children: Record<string, string[]> = {};
  for (const a of apps) {
    inDeg[a.id] = inDeg[a.id] ?? 0;
    for (const dep of a.depends_on) {
      if (!children[dep]) children[dep] = [];
      children[dep].push(a.id);
      inDeg[a.id] = (inDeg[a.id] ?? 0) + 1;
    }
  }

  // Kahn's algorithm
  const queue = apps.filter((a) => (inDeg[a.id] ?? 0) === 0).map((a) => a.id);
  let level = 1;
  while (queue.length > 0) {
    const size = queue.length;
    for (let i = 0; i < size; i++) {
      const id = queue.shift()!;
      order[id] = level;
      for (const child of children[id] ?? []) {
        inDeg[child]--;
        if (inDeg[child] === 0) queue.push(child);
      }
    }
    level++;
  }

  return order;
}

export default function WorkspaceView() {
  const { workspaces, apps, services, selectedWorkspaceId, startAllInWorkspace, stopAllInWorkspace } = usePortaStore(
    useShallow((s) => ({
      workspaces: s.workspaces,
      apps: s.apps,
      services: s.services,
      selectedWorkspaceId: s.selectedWorkspaceId,
      startAllInWorkspace: s.startAllInWorkspace,
      stopAllInWorkspace: s.stopAllInWorkspace,
    }))
  );
  const [showAdd, setShowAdd] = useState(false);
  const [showAddService, setShowAddService] = useState(false);
  const [addAppDefaults, setAddAppDefaults] = useState<AddAppDefaultValues | undefined>(undefined);
  const [showImportCompose, setShowImportCompose] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const dragCounterRef = useRef(0);
  const [filterByWs, setFilterByWs] = useState<Record<string, string>>({});
  const filterText = filterByWs[selectedWorkspaceId ?? "__standalone"] ?? "";
  const setFilterText = (text: string) => setFilterByWs((prev) => ({ ...prev, [selectedWorkspaceId ?? "__standalone"]: text }));
  const filterRef = useRef<HTMLInputElement>(null);

  // Bulk selection state. Set instead of array so toggle is O(1) and we
  // can pass selected ids to SelectionBar by spreading. Cleared on
  // workspace switch so a stale selection from another ws doesn't haunt
  // the new view.
  const [selectedAppIds, setSelectedAppIds] = useState<Set<string>>(new Set());
  const [selectedServiceIds, setSelectedServiceIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    setSelectedAppIds(new Set());
    setSelectedServiceIds(new Set());
  }, [selectedWorkspaceId]);
  const toggleSelection = useCallback((id: string) => {
    setSelectedAppIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const toggleServiceSelection = useCallback((id: string) => {
    setSelectedServiceIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const clearSelection = useCallback(() => setSelectedAppIds(new Set()), []);
  const clearServiceSelection = useCallback(() => setSelectedServiceIds(new Set()), []);

  useEffect(() => {
    function isInEditableContext(target: EventTarget | null): boolean {
      const el = target as HTMLElement | null;
      if (!el) return false;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) return true;
      // CodeMirror, the YAML/env editors, and any rich-text input render as
      // contenteditable divs — without this check, "/" gets stolen for filter
      // focus mid-typing (e.g. typing `://` in an .env URL).
      if (el.isContentEditable) return true;
      if (el.closest && el.closest('[contenteditable="true"], .cm-content')) return true;
      return false;
    }
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "f") { e.preventDefault(); filterRef.current?.focus(); }
      if (e.key === "/" && !isInEditableContext(e.target)) { e.preventDefault(); filterRef.current?.focus(); }
      if (e.key === "Escape" && document.activeElement === filterRef.current) { filterRef.current?.blur(); setFilterText(""); }
      // Esc anywhere else clears bulk selection — non-destructive, mirrors
      // common multi-select UIs (Finder, Mail). Skipped when focus is in
      // the filter (handled above) or any input so typing remains
      // uninterrupted. Clears both app and service selections together.
      if (e.key === "Escape" && !isInEditableContext(e.target)) {
        setSelectedAppIds((prev) => (prev.size === 0 ? prev : new Set()));
        setSelectedServiceIds((prev) => (prev.size === 0 ? prev : new Set()));
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  const [settingsApp, setSettingsApp] = useState<App | null>(null);
  const [savedToast, setSavedToast] = useState(false);
  const [activeTerminalAppId, setActiveTerminalAppId] = useState<string | null>(null);
  // Track which apps have ever opened a terminal so their modal stays mounted (preserves PTY sessions)
  const [openedTerminalIds, setOpenedTerminalIds] = useState<Set<string>>(new Set());
  // One pending session request per app — bumping its id tells the modal to add a new tab
  const [pendingSessions, setPendingSessions] = useState<Record<string, { id: string; startupCommand: string | null }>>({});

  const openTerminal = useCallback((app: App, startupCommand?: string) => {
    setOpenedTerminalIds((prev) => new Set([...prev, app.id]));
    setActiveTerminalAppId(app.id);
    setPendingSessions((prev) => ({
      ...prev,
      [app.id]: {
        id: `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        startupCommand: startupCommand ?? null,
      },
    }));
  }, []);

  // Stable refs for AppCard callbacks so React.memo can skip re-renders
  // when a card's props haven't actually changed.
  const handleOpenSettings = useCallback((app: App) => setSettingsApp(app), []);

  // Handle a dropped folder path: detect start command and open AddAppModal pre-filled
  const handleFolderDrop = useCallback(async (folderPath: string) => {
    const parts = folderPath.split("/");
    const folderName = parts[parts.length - 1] ?? "";
    const defaults: AddAppDefaultValues = {
      name: folderName,
      root_dir: folderPath,
    };
    try {
      const result = await detectStartCommand(folderPath);
      if (result.command) {
        defaults.start_command = result.command;
        defaults.start_command_source = result.source;
      }
    } catch {
      // Detection failed — open modal without start command pre-filled
    }
    setAddAppDefaults(defaults);
    setShowAdd(true);
  }, []);

  // HTML5 drag-and-drop handlers (browser fallback)
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (dragCounterRef.current === 1) setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setIsDragging(false);
    // HTML5 drops — files may have a path property in some environments
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      const file = files[0];
      // In Electron/Tauri webview, files may have a `path` property
      const filePath = (file as File & { path?: string }).path;
      if (filePath) {
        handleFolderDrop(filePath);
      }
    }
  }, [handleFolderDrop]);

  // Tauri 2 native drag-drop listener — more reliable than HTML5 for folder paths
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
        unlisten = await getCurrentWebviewWindow().onDragDropEvent((event) => {
          if (event.payload.type === "over") {
            setIsDragging(true);
          } else if (event.payload.type === "drop") {
            setIsDragging(false);
            const paths = event.payload.paths;
            if (paths.length > 0) {
              handleFolderDrop(paths[0]);
            }
          } else if (event.payload.type === "leave") {
            setIsDragging(false);
          }
        });
      } catch {
        // Tauri drag-drop API not available — fall back to HTML5
      }
    })();
    return () => { unlisten?.(); };
  }, [handleFolderDrop]);

  const workspace = workspaces.find((w) => w.id === selectedWorkspaceId) ?? null;
  const allVisibleApps = useMemo(
    () => apps.filter((a) => a.workspace_id === selectedWorkspaceId),
    [apps, selectedWorkspaceId]
  );
  const filteredApps = useMemo(() => {
    const q = filterText.toLowerCase().trim();
    if (!q) return allVisibleApps;
    return allVisibleApps.filter((a) =>
      a.name.toLowerCase().includes(q) ||
      String(a.port).includes(q) ||
      (a.subdomain ?? "").toLowerCase().includes(q) ||
      a.status.includes(q)
    );
  }, [allVisibleApps, filterText]);
  const visibleApps = filteredApps;
  const runningCount = allVisibleApps.filter((a) => a.status === "running").length;
  const activeCount = allVisibleApps.filter((a) => a.status === "running" || a.status === "starting").length;
  const stoppedWithCommand = allVisibleApps.filter((a) => a.status === "stopped" && (a.start_command || (a.kind === "docker" && a.docker_image) || (a.kind === "compose" && a.compose_file)));
  const hasStoppedApps = stoppedWithCommand.length > 0;
  const hasActiveApps = activeCount > 0;
  const startOrder = useMemo(() => computeStartOrder(allVisibleApps), [allVisibleApps]);

  // Keep settingsApp in sync with latest store data so the modal sees fresh
  // values (tunnel URL arrives async, status flips, metrics update, etc.).
  const liveSettingsApp = settingsApp
    ? (apps.find((a) => a.id === settingsApp.id) ?? settingsApp)
    : null;

  // Show services scoped to this workspace, plus global services
  const visibleServices = services.filter(
    (s) => s.scope === "global" || s.scope === selectedWorkspaceId
  );

  function handleStartAll() {
    if (selectedWorkspaceId) {
      startAllInWorkspace(selectedWorkspaceId);
    }
  }

  function handleStopAll() {
    if (selectedWorkspaceId) {
      stopAllInWorkspace(selectedWorkspaceId);
    }
  }

  if (!workspace && selectedWorkspaceId !== null) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-600 text-[13px]">
        Select a workspace
      </div>
    );
  }

  return (
    <div
      className="relative"
      onDragOver={handleDragOver}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drag overlay */}
      {isDragging && (
        <div className="absolute inset-0 z-40 flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-blue-400/50 bg-blue-500/[0.08] backdrop-blur-[2px] pointer-events-none">
          <svg width="32" height="32" viewBox="0 0 32 32" fill="none" className="text-blue-400 mb-3">
            <path d="M4 12V8a2 2 0 012-2h6l2 3h12a2 2 0 012 2v15a2 2 0 01-2 2H6a2 2 0 01-2-2V12z" stroke="currentColor" strokeWidth="1.8" fill="none"/>
            <path d="M12 20l4-4 4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M16 16v8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
          </svg>
          <span className="text-[14px] font-medium text-blue-300">Drop folder to add app</span>
          <span className="text-[12px] text-blue-400/60 mt-1">We'll auto-detect the framework</span>
        </div>
      )}

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
          <div className="flex items-center gap-3 mb-0.5">
            <span className="flex items-center gap-1.5 text-[11px]">
              <span className={`w-1.5 h-1.5 rounded-full ${runningCount > 0 ? "bg-emerald-400 pulse-dot" : "bg-zinc-600"}`} />
              <span className={runningCount > 0 ? "text-emerald-400" : "text-zinc-500"}>
                {runningCount}/{visibleApps.length} running
              </span>
            </span>
            {visibleApps.length > 1 && (
              <div className="flex items-center gap-1.5">
                {hasStoppedApps && (
                  <button
                    onClick={handleStartAll}
                    className="px-2 py-0.5 text-[10px] font-medium text-blue-400 bg-blue-500/10 hover:bg-blue-500/20 rounded-md transition-colors"
                  >
                    Start All
                  </button>
                )}
                {hasActiveApps && (
                  <button
                    onClick={handleStopAll}
                    className="px-2 py-0.5 text-[10px] font-medium text-zinc-400 bg-white/[0.06] hover:bg-white/[0.10] rounded-md transition-colors"
                  >
                    Stop All
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Filter bar */}
      {allVisibleApps.length > 1 && (
        <div className="relative mb-3 max-w-xs">
          <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-600 pointer-events-none" width="12" height="12" viewBox="0 0 12 12" fill="none">
            <circle cx="5" cy="5" r="3.5" stroke="currentColor" strokeWidth="1.2"/>
            <path d="M8 8l2.5 2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
          </svg>
          <input
            ref={filterRef}
            spellCheck={false}
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            className="w-full pl-8 pr-7 py-1.5 text-[12px] text-zinc-200 bg-white/[0.03] border border-white/[0.07] rounded-lg placeholder:text-zinc-600 focus:outline-none focus:border-white/[0.15]"
            placeholder="Filter apps... (/ or ⌘F)"
          />
          {filterText && (
            <button
              onClick={() => setFilterText("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-600 hover:text-zinc-300"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
              </svg>
            </button>
          )}
        </div>
      )}

      {filterText && visibleApps.length === 0 && allVisibleApps.length > 0 && (
        <div className="flex items-center justify-center py-8 text-[13px] text-zinc-600">
          No apps match "{filterText}"
        </div>
      )}

      <>
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
                <p className="text-[12px] text-zinc-600 mt-1 mb-4">Add your first app to get started</p>
                <button
                  onClick={() => setShowAdd(true)}
                  className="px-4 py-1.5 text-[12px] font-medium text-blue-400 bg-blue-500/10 hover:bg-blue-500/20 rounded-lg transition-colors"
                >
                  + Add App
                </button>
              </div>
            ) : (
              visibleApps.map((app) => {
                const isSelected = selectedAppIds.has(app.id);
                return (
                  <div
                    key={app.id}
                    // Capture-phase listener so cmd/ctrl+click toggles
                    // selection *before* the AppCard's own click handlers
                    // (open Settings, etc.) see the event. AppCard stays
                    // unmodified — its existing internal stopPropagation
                    // on action buttons isn't affected because we only
                    // hijack the modifier-click path.
                    onClickCapture={(e) => {
                      if (e.metaKey || e.ctrlKey) {
                        e.preventDefault();
                        e.stopPropagation();
                        toggleSelection(app.id);
                      }
                    }}
                    className={`rounded-xl transition-shadow ${isSelected ? "ring-2 ring-blue-400/60 ring-offset-1 ring-offset-[#0a0a0c]" : ""}`}
                  >
                    <AppCard
                      app={app}
                      workspace={workspace}
                      startOrder={startOrder[app.id]}
                      onOpenSettings={handleOpenSettings}
                      onOpenTerminal={openTerminal}
                    />
                  </div>
                );
              })
            )}
          </div>

          {/* Add / Import buttons */}
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => setShowAdd(true)}
              className="flex-1 flex items-center justify-center gap-2 py-2 rounded-lg border border-dashed border-white/[0.08] hover:border-white/[0.15] text-[12px] text-zinc-600 hover:text-zinc-400 transition-all duration-150"
            >
              <span>+</span>
              <span>Add App</span>
            </button>
            <button
              onClick={() => setShowImportCompose(true)}
              className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-dashed border-white/[0.08] hover:border-white/[0.15] text-[12px] text-zinc-600 hover:text-zinc-400 transition-all duration-150"
              title="Import from docker-compose.yml"
            >
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" className="shrink-0">
                <path d="M6.5 1v8M3 5.5l3.5 3.5L10 5.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M2 10.5h9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
              </svg>
              <span>Import</span>
            </button>
          </div>

          {/* Services — always rendered so the "+ Add Service" affordance is
              discoverable even with zero services in this workspace. Hidden
              entirely only on the standalone view to keep that simple. */}
          {workspace && (
            <div className="mt-8">
              <div className="flex items-end justify-between mb-3">
                <div className="flex items-baseline gap-2.5">
                  <h2 className="text-[14px] font-semibold text-zinc-300">Services</h2>
                  {visibleServices.length > 0 && (
                    <span className="text-[11px] text-zinc-500">
                      {visibleServices.filter((s) => s.status === "running").length}/{visibleServices.length} running
                    </span>
                  )}
                </div>
                <button
                  onClick={() => setShowAddService(true)}
                  className="px-2 py-0.5 text-[10px] font-medium text-blue-400 bg-blue-500/10 hover:bg-blue-500/20 rounded-md transition-colors"
                >
                  + Service
                </button>
              </div>
              {visibleServices.length === 0 ? (
                <button
                  onClick={() => setShowAddService(true)}
                  className="w-full flex items-center justify-center gap-2 py-3 rounded-lg border border-dashed border-white/[0.08] hover:border-white/[0.15] text-[12px] text-zinc-600 hover:text-zinc-400 transition-all"
                >
                  Add a database, cache, or message broker
                </button>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {visibleServices.map((svc) => {
                    const isSelected = selectedServiceIds.has(svc.id);
                    return (
                      <div
                        key={svc.id}
                        onClickCapture={(e) => {
                          if (e.metaKey || e.ctrlKey) {
                            e.preventDefault();
                            e.stopPropagation();
                            toggleServiceSelection(svc.id);
                          }
                        }}
                        className={`rounded-xl transition-shadow ${isSelected ? "ring-2 ring-violet-400/60 ring-offset-1 ring-offset-[#0a0a0c]" : ""}`}
                      >
                        <ServiceCard service={svc} />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Modals are lazy-loaded; a single Suspense wraps the lot since
              fallback=null lets the existing scrim/content stay put while
              the chunk parses. */}
          <Suspense fallback={null}>
            {showAdd && (
              <AddAppModal
                workspaceId={selectedWorkspaceId}
                onClose={() => { setShowAdd(false); setAddAppDefaults(undefined); }}
                defaultValues={addAppDefaults}
              />
            )}

            {showImportCompose && (
              <ImportComposeModal
                workspaceId={selectedWorkspaceId}
                onClose={() => setShowImportCompose(false)}
              />
            )}

            {showAddService && (
              <AddServiceModal
                defaultScope={selectedWorkspaceId ?? "global"}
                onClose={() => setShowAddService(false)}
              />
            )}

            {liveSettingsApp && (
              <AppSettingsModal
                app={liveSettingsApp}
                workspace={workspace}
                onClose={() => setSettingsApp(null)}
                onSaved={() => {
                  // Keep the modal open after save — the user often tweaks
                  // multiple settings in one session, and auto-closing forces
                  // re-opening the modal for every adjustment.
                  setSavedToast(true);
                  window.setTimeout(() => setSavedToast(false), 2000);
                }}
              />
            )}

            {/* One TerminalModal per app that has been opened — each isolated with its own PTY sessions.
                Use the full `apps` list (not `visibleApps`) so switching workspace doesn't unmount
                a modal whose app now lives in a different workspace — that would kill the PTYs. */}
            {apps.filter((app) => openedTerminalIds.has(app.id)).map((app) => (
              <TerminalModal
                key={app.id}
                initialApp={app}
                isOpen={activeTerminalAppId === app.id}
                pendingSession={pendingSessions[app.id] ?? null}
                onClose={() => setActiveTerminalAppId(null)}
              />
            ))}
          </Suspense>

          {/* Save-success toast — appears centered-bottom after the settings
              modal closes via a successful save. Auto-dismisses after 2s. */}
          <div
            className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-[60] flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 border border-white/10 text-[11px] text-emerald-400 shadow-lg transition-all duration-200 pointer-events-none ${
              savedToast ? "opacity-100 translate-y-0" : "opacity-0 translate-y-1"
            }`}
          >
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
              <path d="M2 5.5l2.5 2.5 4.5-4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            Settings saved
          </div>
      </>

      <SelectionBar selectedIds={[...selectedAppIds]} onClear={clearSelection} />
      <ServiceSelectionBar selectedIds={[...selectedServiceIds]} onClear={clearServiceSelection} />
    </div>
  );
}
