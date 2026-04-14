import { useMemo, useState } from "react";
import { usePortaStore } from "../../store";
import { exportPortaConfig, importPortaConfig, isTauri } from "../../lib/commands";
import type { App } from "../../types";
import AppCard from "../app/AppCard";
import AddAppModal from "../app/AddAppModal";
import ImportComposeModal from "./ImportComposeModal";
import ServiceCard from "../service/ServiceCard";
import CanvasView from "./CanvasView";
import AppDetailSheet from "../app/AppDetailSheet";
import AppSettingsModal from "../app/AppSettingsModal";
import DeployModal from "../deploy/DeployModal";
import TerminalModal from "../terminal/TerminalModal";

type ViewMode = "list" | "canvas";

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
  const { workspaces, apps, services, selectedWorkspaceId, startAllInWorkspace, stopAllInWorkspace, load } = usePortaStore();
  const [showAdd, setShowAdd] = useState(false);
  const [showImportCompose, setShowImportCompose] = useState(false);
  const [showShareMenu, setShowShareMenu] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [detailApp, setDetailApp] = useState<App | null>(null);
  const [settingsApp, setSettingsApp] = useState<App | null>(null);
  const [deployApp, setDeployApp] = useState<App | null>(null);
  const [activeTerminalAppId, setActiveTerminalAppId] = useState<string | null>(null);
  // Track which apps have ever opened a terminal so their modal stays mounted (preserves PTY sessions)
  const [openedTerminalIds, setOpenedTerminalIds] = useState<Set<string>>(new Set());

  function openTerminal(app: App) {
    setOpenedTerminalIds((prev) => new Set([...prev, app.id]));
    setActiveTerminalAppId(app.id);
  }

  const workspace = workspaces.find((w) => w.id === selectedWorkspaceId) ?? null;
  const visibleApps = apps.filter((a) => a.workspace_id === selectedWorkspaceId);
  const runningCount = visibleApps.filter((a) => a.status === "running").length;
  const activeCount = visibleApps.filter((a) => a.status === "running" || a.status === "starting").length;
  const stoppedWithCommand = visibleApps.filter((a) => a.status === "stopped" && a.start_command);
  const hasStoppedApps = stoppedWithCommand.length > 0;
  const hasActiveApps = activeCount > 0;
  const startOrder = useMemo(() => computeStartOrder(visibleApps), [visibleApps]);

  // Keep detailApp in sync with latest store data
  const liveDetailApp = detailApp
    ? (apps.find((a) => a.id === detailApp.id) ?? detailApp)
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

  async function handleExportConfig() {
    setShowShareMenu(false);
    if (!isTauri || !selectedWorkspaceId) return;
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const destPath = await save({
        defaultPath: ".porta.yml",
        filters: [{ name: "Porta Config", extensions: ["yml", "yaml"] }],
      });
      if (destPath) await exportPortaConfig(selectedWorkspaceId, destPath);
    } catch (e) {
      console.error("Export failed:", e);
    }
  }

  async function handleImportConfig() {
    setShowShareMenu(false);
    if (!isTauri) return;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        multiple: false,
        filters: [{ name: "Porta Config", extensions: ["yml", "yaml"] }],
      });
      if (selected) {
        await importPortaConfig(selected as string);
        await load();
      }
    } catch (e) {
      console.error("Import failed:", e);
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
    <div>
      {/* Header */}
      <div className="flex items-end justify-between mb-5">
        <div className="flex items-center gap-3">
          <div>
            <h1 className="text-[17px] font-semibold text-zinc-100 leading-tight">
              {workspace?.name ?? "Standalone"}
            </h1>
            {workspace && (
              <p className="text-[12px] text-zinc-500 mt-0.5">{workspace.domain}</p>
            )}
          </div>
          {workspace && (
            <div className="relative">
              <button
                onClick={() => setShowShareMenu((v) => !v)}
                className="px-2 py-1 text-[11px] font-medium text-zinc-400 bg-white/[0.04] hover:bg-white/[0.08] rounded-md border border-white/[0.06] transition-colors"
                title="Share workspace"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="inline -mt-px mr-1">
                  <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
                  <polyline points="16 6 12 2 8 6" />
                  <line x1="12" y1="2" x2="12" y2="15" />
                </svg>
                Share
              </button>
              {showShareMenu && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowShareMenu(false)} />
                  <div className="absolute left-0 top-full mt-1 z-50 w-48 rounded-lg border border-white/[0.08] bg-zinc-900 shadow-xl py-1">
                    <button onClick={handleExportConfig} className="w-full text-left px-3 py-1.5 text-[12px] text-zinc-300 hover:bg-white/[0.06] transition-colors">
                      Export .porta.yml
                    </button>
                    <button onClick={handleImportConfig} className="w-full text-left px-3 py-1.5 text-[12px] text-zinc-300 hover:bg-white/[0.06] transition-colors">
                      Import .porta.yml
                    </button>
                  </div>
                </>
              )}
            </div>
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
            {/* View mode toggle */}
            <div className="flex rounded-md border border-white/[0.08] overflow-hidden">
              {(["list", "canvas"] as ViewMode[]).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setViewMode(mode)}
                  className={`px-2.5 py-1 text-[11px] font-medium capitalize transition-colors ${
                    viewMode === mode
                      ? "bg-white/[0.10] text-zinc-200"
                      : "bg-white/[0.02] text-zinc-500 hover:text-zinc-300"
                  }`}
                >
                  {mode === "list" ? "List" : "Canvas"}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <>
        {/* App list / Canvas */}
          {viewMode === "list" ? (
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
                visibleApps.map((app) => (
                  <AppCard
                    key={app.id}
                    app={app}
                    workspace={workspace}
                    startOrder={startOrder[app.id]}
                    onOpenDetail={() => setDetailApp(app)}
                    onOpenTerminal={() => openTerminal(app)}
                    onOpenDeploy={app.deploy_config_path ? () => setDeployApp(app) : undefined}
                  />
                ))
              )}
            </div>
          ) : (
            <CanvasView apps={visibleApps} workspace={workspace} />
          )}

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

          {/* Services */}
          {visibleServices.length > 0 && (
            <div className="mt-8">
              <div className="flex items-end justify-between mb-3">
                <h2 className="text-[14px] font-semibold text-zinc-300">Services</h2>
                <span className="text-[11px] text-zinc-500 mb-0.5">
                  {visibleServices.filter((s) => s.status === "running").length}/{visibleServices.length} running
                </span>
              </div>
              <div className="flex flex-col gap-1.5">
                {visibleServices.map((svc) => (
                  <ServiceCard key={svc.id} service={svc} />
                ))}
              </div>
            </div>
          )}

          {showAdd && (
            <AddAppModal
              workspaceId={selectedWorkspaceId}
              onClose={() => setShowAdd(false)}
            />
          )}

          {showImportCompose && (
            <ImportComposeModal
              workspaceId={selectedWorkspaceId}
              onClose={() => setShowImportCompose(false)}
            />
          )}

          {/* App detail sheet */}
          {liveDetailApp && (
            <AppDetailSheet
              app={liveDetailApp}
              workspace={workspace}
              onClose={() => setDetailApp(null)}
              onOpenSettings={() => {
                setSettingsApp(liveDetailApp);
                setDetailApp(null);
              }}
              onOpenTerminal={() => {
                openTerminal(liveDetailApp);
                setDetailApp(null);
              }}
              onOpenDeploy={() => {
                setDeployApp(liveDetailApp);
                setDetailApp(null);
              }}
            />
          )}

          {settingsApp && (
            <AppSettingsModal
              app={settingsApp}
              workspace={workspace}
              onClose={() => setSettingsApp(null)}
            />
          )}

          {deployApp && (
            <DeployModal
              app={deployApp}
              workspace={workspaces.find((w) => w.id === deployApp.workspace_id) ?? null}
              onClose={() => setDeployApp(null)}
            />
          )}

          {/* One TerminalModal per app that has been opened — each isolated with its own PTY sessions */}
          {visibleApps.filter((app) => openedTerminalIds.has(app.id)).map((app) => (
            <TerminalModal
              key={app.id}
              initialApp={app}
              isOpen={activeTerminalAppId === app.id}
              onClose={() => setActiveTerminalAppId(null)}
            />
          ))}
      </>

    </div>
  );
}
