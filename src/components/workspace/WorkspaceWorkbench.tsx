import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  ArrowClockwise,
  ArrowSquareOut,
  Browser,
  CaretDown,
  Cube,
  DownloadSimple,
  DotsThree,
  FileCode,
  GitBranch,
  Globe,
  ListMagnifyingGlass,
  Package,
  Pulse,
  RocketLaunch,
  SlidersHorizontal,
  TerminalWindow,
  WifiHigh,
} from "@phosphor-icons/react";
import { usePortaStore } from "../../store";
import type { App } from "../../types";
import { detectAppTags, getExtensionsForApp, isTauri } from "../../lib/commands";
import AppCard from "../app/AppCard";
import type { AddAppDefaultValues } from "../app/AddAppModal";
import type { SessionRequest } from "../terminal/TerminalModal";
import WorkbenchLogPanel from "./WorkbenchLogPanel";
import WorkbenchGitPanel from "./WorkbenchGitPanel";
import WorkbenchExtensionPreview from "./WorkbenchExtensionPreview";

const TerminalModal = lazy(() => import("../terminal/TerminalModal"));
const AddAppModal = lazy(() => import("../app/AddAppModal"));
const AppSettingsModal = lazy(() => import("../app/AppSettingsModal"));
const FileEditorModal = lazy(() => import("../app/FileEditorModal"));
const TrafficInspectorModal = lazy(() => import("../app/TrafficInspectorModal"));
const ImportComposeModal = lazy(() => import("./ImportComposeModal"));

type Tool = "overview" | "logs" | "terminal" | "traffic" | "files" | "git" | "deploy" | "packages";

const CORE_TOOLS: Array<{ id: Tool; label: string; icon: typeof Pulse }> = [
  { id: "overview", label: "Overview", icon: Pulse },
  { id: "logs", label: "Logs", icon: ListMagnifyingGlass },
  { id: "terminal", label: "Terminal", icon: TerminalWindow },
  { id: "traffic", label: "Traffic", icon: Globe },
  { id: "files", label: "Files", icon: FileCode },
];

const EXTENSION_TOOLS: Array<{ id: Tool; label: string; icon: typeof Pulse; extensionId: string }> = [
  { id: "git", label: "Git", icon: GitBranch, extensionId: "git-manager" },
  { id: "deploy", label: "Deploy", icon: RocketLaunch, extensionId: "kamal" },
  { id: "packages", label: "Packages", icon: Package, extensionId: "phoenix-packages" },
];

function appHost(app: App, domain?: string) {
  const hostDomain = app.custom_domain || domain;
  if (!hostDomain) return null;
  return `${app.subdomain || app.name}.${hostDomain}`;
}

function AppNavItem({
  app,
  branch,
  selected,
  domain,
  onSelect,
  onLogs,
  onTerminal,
}: {
  app: App;
  branch?: string;
  selected: boolean;
  domain?: string;
  onSelect: () => void;
  onLogs: () => void;
  onTerminal: () => void;
}) {
  const isRunning = app.status === "running";
  const isStarting = app.status === "starting";
  const host = appHost(app, domain);

  return (
    <div
      className={`group rounded-lg border transition-colors ${
        selected
          ? "border-blue-500/55 bg-blue-500/[0.08]"
          : "border-transparent hover:border-white/[0.06] hover:bg-white/[0.035]"
      }`}
    >
      <button onClick={onSelect} className="w-full px-3 pt-2 pb-1.5 text-left">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 shrink-0 rounded-full ${isRunning ? "bg-emerald-400" : isStarting ? "bg-amber-400 animate-pulse" : "bg-zinc-600"}`} />
          <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-zinc-100">{app.name}</span>
          {selected && <CaretDown size={12} className="text-zinc-500" />}
        </div>
        <div className="mt-1 flex items-center gap-2 pl-4 text-[11px] text-zinc-500">
          <span className="font-mono">{app.status === "stopped" ? "stopped" : `port ${app.port || "—"}`}</span>
          {branch && (
            <span className="flex min-w-0 items-center gap-1 truncate font-mono">
              <GitBranch size={10} /> {branch}
            </span>
          )}
        </div>
      </button>
      {selected && (
        <div className="flex items-center gap-1 border-t border-white/[0.05] px-2.5 py-1">
          <span className="rounded-md p-1.5 text-emerald-400" title="Connected"><WifiHigh size={13} /></span>
          <button onClick={onLogs} className="rounded-md p-1.5 text-zinc-500 hover:bg-white/[0.07] hover:text-zinc-200" title="Open logs">
            <ListMagnifyingGlass size={13} />
          </button>
          <button onClick={onTerminal} className="rounded-md p-1.5 text-zinc-500 hover:bg-white/[0.07] hover:text-zinc-200" title="Open terminal">
            <TerminalWindow size={13} />
          </button>
          {host && (
            <a href={`https://${host}`} target="_blank" rel="noreferrer" className="rounded-md p-1.5 text-zinc-500 hover:bg-white/[0.07] hover:text-zinc-200" title="Open app">
              <ArrowSquareOut size={13} />
            </a>
          )}
          <span className="flex-1" />
          <button className="rounded-md p-1.5 text-zinc-500 hover:bg-white/[0.07] hover:text-zinc-200" title="More app actions"><DotsThree size={13} /></button>
        </div>
      )}
    </div>
  );
}

export default function WorkspaceWorkbench() {
  const {
    workspaces,
    apps,
    selectedWorkspaceId,
    appLogs,
    appMetrics,
    appGit,
    healthStatuses,
    appExtensions,
    startApp,
    stopApp,
    restartApp,
    clearAppLogs,
    setTerminalPlacement,
    setTerminalPanelHeight,
    openExtensionSidebar,
    cacheAppExtensions,
    openSettingsSection,
  } = usePortaStore(
    useShallow((s) => ({
      workspaces: s.workspaces,
      apps: s.apps,
      selectedWorkspaceId: s.selectedWorkspaceId,
      appLogs: s.appLogs,
      appMetrics: s.appMetrics,
      appGit: s.appGit,
      healthStatuses: s.healthStatuses,
      appExtensions: s.appExtensions,
      startApp: s.startApp,
      stopApp: s.stopApp,
      restartApp: s.restartApp,
      clearAppLogs: s.clearAppLogs,
      setTerminalPlacement: s.setTerminalPlacement,
      setTerminalPanelHeight: s.setTerminalPanelHeight,
      openExtensionSidebar: s.openExtensionSidebar,
      cacheAppExtensions: s.cacheAppExtensions,
      openSettingsSection: s.openSettingsSection,
    }))
  );

  const workspace = workspaces.find((item) => item.id === selectedWorkspaceId) ?? null;
  const visibleApps = useMemo(() => apps.filter((app) => app.workspace_id === selectedWorkspaceId), [apps, selectedWorkspaceId]);
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null);
  const [activeTool, setActiveTool] = useState<Tool>("logs");
  const [query, setQuery] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [addDefaults] = useState<AddAppDefaultValues | undefined>(undefined);
  const [settingsApp, setSettingsApp] = useState<App | null>(null);
  const [fileEditorApp, setFileEditorApp] = useState<App | null>(null);
  const [trafficApp, setTrafficApp] = useState<App | null>(null);
  const [activeTerminalAppId, setActiveTerminalAppId] = useState<string | null>(null);
  const [previewDockVisible, setPreviewDockVisible] = useState(!isTauri);
  const [openedTerminalIds, setOpenedTerminalIds] = useState<Set<string>>(new Set());
  const [pendingSessions, setPendingSessions] = useState<Record<string, SessionRequest>>({});

  useEffect(() => {
    const stillVisible = visibleApps.some((app) => app.id === selectedAppId);
    if (stillVisible) return;
    const next = visibleApps.find((app) => app.status === "running") ?? visibleApps[0] ?? null;
    setSelectedAppId(next?.id ?? null);
    setActiveTool("logs");
  }, [visibleApps, selectedAppId]);

  const selectedApp = visibleApps.find((app) => app.id === selectedAppId) ?? null;
  const filteredApps = visibleApps.filter((app) => {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return `${app.name} ${app.port} ${appGit[app.id]?.branch || ""} ${app.status}`.toLowerCase().includes(needle);
  });

  useEffect(() => {
    if (!selectedApp?.root_dir) return;
    let cancelled = false;
    void detectAppTags(selectedApp.root_dir)
      .catch(() => [] as string[])
      .then((tags) => getExtensionsForApp(selectedApp.kind, tags))
      .then((extensions) => {
        if (!cancelled) cacheAppExtensions(selectedApp.id, extensions);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [selectedApp?.id, selectedApp?.root_dir, selectedApp?.kind, cacheAppExtensions]);

  const openTerminal = useCallback((app: App, startupCommand?: string) => {
    setTerminalPlacement("panel");
    if (!isTauri) setTerminalPanelHeight(0.245);
    setOpenedTerminalIds((previous) => new Set([...previous, app.id]));
    setActiveTerminalAppId(app.id);
    if (!isTauri) setPreviewDockVisible(true);
    setPendingSessions((previous) => ({
      ...previous,
      [app.id]: { id: `workbench-${Date.now()}`, startupCommand: startupCommand ?? null },
    }));
  }, [setTerminalPlacement, setTerminalPanelHeight]);

  function chooseTool(tool: Tool) {
    if (!selectedApp) return;
    if (tool === "terminal") {
      openTerminal(selectedApp);
      return;
    }
    if (tool === "files") {
      setFileEditorApp(selectedApp);
      return;
    }
    if (tool === "traffic") {
      setTrafficApp(selectedApp);
      return;
    }
    if (tool === "git") {
      setActiveTool("git");
      return;
    }
    if (tool === "deploy" || tool === "packages") {
      if (!isTauri) {
        setActiveTool(tool);
        return;
      }
      const extensionId = EXTENSION_TOOLS.find((item) => item.id === tool)?.extensionId;
      const extensions = appExtensions[selectedApp.id] ?? [];
      const aliases = tool === "deploy" ? ["kamal", "deploy"] : tool === "packages" ? ["phoenix", "package", "hex"] : ["git"];
      const extension = extensions.find((item) =>
        item.id === extensionId || aliases.some((alias) => `${item.id} ${item.name}`.toLowerCase().includes(alias)),
      );
      if (extension) {
        openExtensionSidebar(selectedApp.id, extensions, extension.id);
        return;
      }
    }
    setActiveTool(tool);
  }

  const selectedHost = selectedApp ? appHost(selectedApp, workspace?.domain) : null;
  const selectedLogs = selectedApp ? appLogs[selectedApp.id] ?? [] : [];
  const selectedHealth = selectedApp ? (healthStatuses[selectedApp.id] ?? (selectedApp.status === "running" ? "healthy" : null)) : null;
  const selectedMetrics = selectedApp ? appMetrics[selectedApp.id] : null;
  const missingExtensionTool = EXTENSION_TOOLS.find((tool) => tool.id === activeTool);
  const selectedExtensions = selectedApp ? appExtensions[selectedApp.id] ?? [] : [];
  const gitExtensionAvailable = !isTauri || selectedExtensions.some((extension) =>
    extension.id === "git-manager" || `${extension.id} ${extension.name}`.toLowerCase().includes("git"),
  );
  const activeExtension = missingExtensionTool
    ? selectedExtensions.find((extension) => {
        const identity = `${extension.id} ${extension.name}`.toLowerCase();
        if (missingExtensionTool.id === "deploy") return extension.id === "kamal" || identity.includes("deploy") || identity.includes("kamal");
        if (missingExtensionTool.id === "packages") return extension.id === "phoenix-packages" || identity.includes("package") || identity.includes("phoenix");
        return extension.id === "git-manager" || identity.includes("git");
      }) ?? null
    : null;

  return (
    <div className="flex h-full min-h-0 bg-[#0d0d0f]">
      <aside
        className="flex w-[235px] shrink-0 flex-col border-r border-white/[0.06]"
        style={{
          background: "radial-gradient(circle at 20% 0%, #17191c 0%, #101012 40%, #0e0e10 100%)",
          ...(!isTauri ? { paddingBottom: "20.5vh" } : {}),
        }}
      >
        <div className="border-b border-white/[0.06] px-3 pb-3 pt-3">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-[16px] font-semibold text-zinc-100">{workspace?.name ?? "Standalone"}</h1>
              <p className="mt-0.5 truncate text-[11px] text-zinc-600">{workspace?.domain ?? "Apps without a workspace"}</p>
            </div>
            <button className="rounded-md p-1 text-zinc-600 hover:bg-white/[0.06] hover:text-zinc-300" title="Workspace options">
              <SlidersHorizontal size={14} />
            </button>
          </div>
          <div className="relative mt-3">
            <ListMagnifyingGlass size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-600" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter apps…"
              className="h-8 w-full rounded-lg border border-white/[0.07] bg-white/[0.035] pl-8 pr-3 text-[12px] text-zinc-200 outline-none placeholder:text-zinc-650 focus:border-blue-500/40"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-2.5">
          <div className="space-y-1">
            {filteredApps.map((app) => (
              <AppNavItem
                key={app.id}
                app={app}
                branch={appGit[app.id]?.branch || (app.status === "running" ? "main" : undefined)}
                selected={app.id === selectedAppId}
                domain={workspace?.domain}
                onSelect={() => { setSelectedAppId(app.id); setActiveTool("logs"); }}
                onLogs={() => { setSelectedAppId(app.id); setActiveTool("logs"); }}
                onTerminal={() => openTerminal(app)}
              />
            ))}
          </div>

        </div>

        <div className="border-t border-white/[0.06] p-2">
          <button onClick={() => setShowAdd(true)} className="flex h-8 w-full items-center justify-center gap-2 rounded-lg border border-dashed border-white/[0.08] text-[12px] text-zinc-500 hover:border-white/[0.15] hover:text-zinc-300">
            <Cube size={13} /> Add App
          </button>
          <button onClick={() => setShowImport(true)} className="mt-1 flex h-8 w-full items-center justify-center gap-2 rounded-lg border border-dashed border-white/[0.08] text-[12px] text-zinc-500 hover:border-white/[0.15] hover:text-zinc-300">
            <DownloadSimple size={13} /> Import
          </button>
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col bg-[#0d0d0f]">
        {selectedApp ? (
          <>
            <div className="flex h-[58px] shrink-0 items-center gap-3 border-b border-white/[0.06] px-5">
              <Cube size={18} className="text-zinc-200" weight="duotone" />
              <button className="flex items-center gap-1.5 text-[18px] font-semibold text-zinc-100" onClick={() => setActiveTool("overview")}> 
                {selectedApp.name} <CaretDown size={12} className="text-zinc-600" />
              </button>
              <span className="h-5 w-px bg-white/[0.07]" />
              {selectedHost && (
                <a href={`https://${selectedHost}`} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-[12px] text-zinc-400 hover:text-blue-300">
                  {selectedHost} <ArrowSquareOut size={11} />
                </a>
              )}
              <span className="text-[12px] font-mono text-zinc-500">port {selectedApp.port || "—"}</span>
              <span className="flex items-center gap-1 text-[12px] font-mono text-zinc-400"><GitBranch size={12} /> {appGit[selectedApp.id]?.branch || "main"}</span>
              <span className="flex-1" />
              <span className={`rounded-md px-2 py-1 text-[10px] font-medium ${selectedApp.status === "running" ? "bg-emerald-500/10 text-emerald-300" : "bg-white/[0.04] text-zinc-500"}`}>{selectedApp.status.charAt(0).toUpperCase() + selectedApp.status.slice(1)}</span>
              {selectedHealth === "healthy" && <span className="rounded-md bg-emerald-500/10 px-2 py-1 text-[10px] font-medium text-emerald-300">Healthy</span>}
              {selectedApp.status === "running" ? (
                <>
                  <button onClick={() => restartApp(selectedApp.id)} className="flex items-center gap-1.5 rounded-md border border-white/[0.08] px-2.5 py-1.5 text-[11px] text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-100"><ArrowClockwise size={12} /> Restart</button>
                  <button onClick={() => stopApp(selectedApp.id)} className="rounded-md border border-red-500/20 px-2.5 py-1.5 text-[11px] text-red-400 hover:bg-red-500/10">Stop</button>
                  <button className="rounded-md border border-white/[0.08] p-1.5 text-zinc-500 hover:bg-white/[0.05] hover:text-zinc-200" title="More app actions"><DotsThree size={14} /></button>
                </>
              ) : (
                <button onClick={() => startApp(selectedApp.id)} className="rounded-md bg-blue-500/15 px-3 py-1.5 text-[11px] font-medium text-blue-300 hover:bg-blue-500/25">Start</button>
              )}
            </div>

            <div className="flex h-[58px] shrink-0 items-end gap-1 border-b border-white/[0.06] px-3">
              {[...CORE_TOOLS, ...EXTENSION_TOOLS].map((tool) => {
                const Icon = tool.icon;
                const extension = "extensionId" in tool;
                const active = activeTool === tool.id;
                return (
                  <button
                    key={tool.id}
                    onClick={() => chooseTool(tool.id)}
                    className={`relative flex h-10 items-center gap-1.5 px-3 text-[13px] transition-colors ${active ? "text-zinc-100" : "text-zinc-400 hover:text-zinc-200"}`}
                  >
                    <Icon size={13} /> {tool.label}
                    {extension && <span className="h-1.5 w-1.5 rounded-full bg-violet-400" />}
                    {active && <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-blue-400" />}
                  </button>
                );
              })}
              <div className="relative">
                <button onClick={() => setShowMore((value) => !value)} className="relative flex h-10 items-center gap-1.5 px-3 text-[12px] text-zinc-500 transition-colors hover:text-zinc-200">
                  More <CaretDown size={11} />
                </button>
                {showMore && (
                  <div className="absolute left-0 top-full z-30 mt-1 w-44 rounded-lg border border-white/[0.1] bg-[#1b1d20] p-1 shadow-2xl">
                    <button onClick={() => { setShowMore(false); setActiveTool("overview"); }} className="w-full rounded-md px-2.5 py-2 text-left text-[11px] text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100">App overview</button>
                    <button onClick={() => { setShowMore(false); openTerminal(selectedApp); }} className="w-full rounded-md px-2.5 py-2 text-left text-[11px] text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100">New terminal session</button>
                    <button onClick={() => { setShowMore(false); setSettingsApp(selectedApp); }} className="w-full rounded-md px-2.5 py-2 text-left text-[11px] text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100">App settings</button>
                  </div>
                )}
              </div>
              <span className="flex-1" />
              {selectedMetrics && (
                <div className="mb-2 flex items-center gap-3 text-[10px] font-mono text-zinc-600">
                  <span>{selectedMetrics.cpu.toFixed(1)}% CPU</span>
                  <span>{selectedMetrics.mem_mb} MB</span>
                </div>
              )}
              <button onClick={() => setSettingsApp(selectedApp)} className="mb-2 rounded-md p-1.5 text-zinc-600 hover:bg-white/[0.06] hover:text-zinc-200" title="App settings"><SlidersHorizontal size={14} /></button>
            </div>

            <div className="min-h-0 flex-1 overflow-hidden">
              {activeTool === "logs" ? (
                <WorkbenchLogPanel logs={selectedLogs} onClear={() => clearAppLogs(selectedApp.id)} />
              ) : activeTool === "git" ? (
                <WorkbenchGitPanel
                  app={selectedApp}
                  extensionAvailable={gitExtensionAvailable}
                  onOpenTerminal={(command) => openTerminal(selectedApp, command)}
                  onOpenExtensions={() => openSettingsSection("extensions")}
                />
              ) : activeTool === "deploy" || activeTool === "packages" ? (
                <WorkbenchExtensionPreview
                  app={selectedApp}
                  tool={activeTool}
                  extension={activeExtension}
                  onOpenExtensions={() => openSettingsSection("extensions")}
                  onOpenTerminal={(command) => openTerminal(selectedApp, command)}
                />
              ) : (
                <div className="h-full overflow-y-auto p-5">
                  <div className="mx-auto max-w-5xl">
                    <AppCard app={selectedApp} workspace={workspace} onOpenSettings={setSettingsApp} onOpenTerminal={openTerminal} />
                    <div className="mt-4 grid grid-cols-3 gap-3">
                      <button onClick={() => setActiveTool("logs")} className="flex items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.025] p-4 text-left hover:bg-white/[0.045]">
                        <ListMagnifyingGlass size={19} className="text-blue-400" />
                        <span><span className="block text-[12px] font-medium text-zinc-200">Live logs</span><span className="mt-0.5 block text-[10px] text-zinc-600">Search, filter and follow output</span></span>
                      </button>
                      <button onClick={() => openTerminal(selectedApp)} className="flex items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.025] p-4 text-left hover:bg-white/[0.045]">
                        <TerminalWindow size={19} className="text-emerald-400" />
                        <span><span className="block text-[12px] font-medium text-zinc-200">Terminal</span><span className="mt-0.5 block text-[10px] text-zinc-600">Persistent PTY sessions</span></span>
                      </button>
                      <button onClick={() => chooseTool("git")} className="flex items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.025] p-4 text-left hover:bg-white/[0.045]">
                        <GitBranch size={19} className="text-violet-400" />
                        <span><span className="block text-[12px] font-medium text-zinc-200">Git Manager</span><span className="mt-0.5 block text-[10px] text-zinc-600">Status, history and sync</span></span>
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <Browser size={28} className="text-zinc-700" />
            <p className="mt-3 text-[13px] text-zinc-500">No app selected</p>
            <button onClick={() => setShowAdd(true)} className="mt-3 rounded-lg bg-blue-500/10 px-3 py-1.5 text-[11px] text-blue-300">Add an app</button>
          </div>
        )}
      </section>

      <Suspense fallback={null}>
        {showAdd && <AddAppModal workspaceId={selectedWorkspaceId} defaultValues={addDefaults} onClose={() => setShowAdd(false)} />}
        {showImport && <ImportComposeModal workspaceId={selectedWorkspaceId} onClose={() => setShowImport(false)} />}
        {settingsApp && workspace && <AppSettingsModal app={settingsApp} workspace={workspace} onClose={() => setSettingsApp(null)} onSaved={() => {}} />}
        {fileEditorApp && (
          <FileEditorModal
            appId={fileEditorApp.id}
            appName={fileEditorApp.name}
            composePath={fileEditorApp.compose_file ?? null}
            currentPort={fileEditorApp.port}
            onClose={() => setFileEditorApp(null)}
          />
        )}
        {trafficApp && (
          <TrafficInspectorModal
            appId={trafficApp.id}
            appName={trafficApp.name}
            isOpen
            onClose={() => setTrafficApp(null)}
          />
        )}
        {(isTauri
          ? apps.filter((app) => openedTerminalIds.has(app.id))
          : selectedApp && previewDockVisible ? [selectedApp] : []
        ).map((app) => (
          <TerminalModal
            key={app.id}
            initialApp={app}
            isOpen={isTauri ? activeTerminalAppId === app.id : previewDockVisible}
            pendingSession={pendingSessions[app.id] ?? null}
            onClose={() => {
              setActiveTerminalAppId(null);
              if (!isTauri) setPreviewDockVisible(false);
            }}
          />
        ))}
      </Suspense>

    </div>
  );
}
