import { lazy, memo, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/react/shallow";
import { usePortaStore } from "../../store";
import type { App, Workspace } from "../../types";
import AppContextMenu from "./AppContextMenu";
import HostsDropdown from "./HostsDropdown";
import { openInEditor, openInTerminal, killPortHolder, checkPortAvailable, getExtensionsForApp, detectAppTags, type PortCheckResult } from "../../lib/commands";
import type { ExtensionInfo } from "../../types/extension";
import { useFloatingPosition, useMeasuredSize } from "../shared/useFloatingPosition";

// LogViewer is only opened when the user expands logs — defer its parse cost.
// (AppSettingsModal lives at the workspace level and is lazy-loaded there.)
const LogViewer = lazy(() => import("./LogViewer"));
const FileEditorModal = lazy(() => import("./FileEditorModal"));
const TrafficInspectorModal = lazy(() => import("./TrafficInspectorModal"));
const PortConflictModal = lazy(() => import("./PortConflictModal"));
import Tooltip from "../shared/Tooltip";
import LogToast from "./LogToast";
import TunnelQuickMenu from "./TunnelQuickMenu";
import DockerUpdateBadge from "./DockerUpdateBadge";
import AppDiskBadge from "./AppDiskBadge";
import ContainerStatsBadge from "./ContainerStatsBadge";
import { yieldToFrame } from "../../lib/ui";

interface Props {
  app: App;
  workspace: Workspace | null;
  startOrder?: number;
  // Callbacks take `app` so parents can share one stable ref across all cards
  // (required for React.memo below to actually skip re-renders).
  onOpenSettings?: (app: App) => void;
  onOpenTerminal?: (app: App, startupCommand?: string) => void;
  onOpenDeploy?: (app: App) => void;
}

function formatUptime(startedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function resolvedHost(app: App, workspace: Workspace | null): string {
  const domain = app.custom_domain || workspace?.domain || "narakarya.test";
  const sub = app.subdomain ?? app.name;
  return sub === "*" ? `*.${domain}` : `${sub}.${domain}`;
}

function allHosts(app: App, workspace: Workspace | null): string[] {
  const domain = app.custom_domain || workspace?.domain || "narakarya.test";
  const primary = resolvedHost(app, workspace);
  const extras = (app.extra_subdomains ?? []).map((s) => `${s}.${domain}`);
  return [primary, ...extras];
}

function AppCard({ app, workspace, startOrder, onOpenSettings, onOpenTerminal, onOpenDeploy }: Props) {
  // Actions — stable refs, picked once via shallow compare.
  const { startApp, stopApp, restartApp, killApp, startTunnel, stopTunnel, clearAppLogs, dismissPortConflict, registerToast, unregisterToast, getToastIndex, openExtensionSidebar, closeExtensionSidebar, extensionSidebar } = usePortaStore(
    useShallow((s) => ({
      startApp: s.startApp,
      stopApp: s.stopApp,
      restartApp: s.restartApp,
      killApp: s.killApp,
      startTunnel: s.startTunnel,
      stopTunnel: s.stopTunnel,
      clearAppLogs: s.clearAppLogs,
      dismissPortConflict: s.dismissPortConflict,
      registerToast: s.registerToast,
      unregisterToast: s.unregisterToast,
      getToastIndex: s.getToastIndex,
      openExtensionSidebar: s.openExtensionSidebar,
      closeExtensionSidebar: s.closeExtensionSidebar,
      extensionSidebar: s.extensionSidebar,
    }))
  );
  // Per-app state slices — component only re-renders when ITS slice changes.
  const setupStatus = usePortaStore((s) => s.setupStatus);
  const metrics = usePortaStore((s) => s.appMetrics[app.id]);
  const startedAt = usePortaStore((s) => s.appStartedAt[app.id]);
  const health = usePortaStore((s) => s.healthStatuses[app.id]);
  const appLogs = usePortaStore((s) => s.appLogs[app.id]);
  const appExitCode = usePortaStore((s) => s.appExitCode[app.id]);
  const appRetryCount = usePortaStore((s) => s.appRetryCount[app.id]);
  const portConflicts = usePortaStore((s) => s.portConflicts[app.id]);
  const appRestarting = usePortaStore((s) => s.appRestarting[app.id]);
  const appTunnelErrors = usePortaStore((s) => s.appTunnelErrors[app.id]);

  // Host computations read app fields that rarely change — memoize so they
  // don't re-run on unrelated parent state updates.
  const host = useMemo(() => resolvedHost(app, workspace), [app.custom_domain, app.subdomain, app.name, workspace?.domain]);
  const hosts = useMemo(() => allHosts(app, workspace), [app.custom_domain, app.subdomain, app.name, app.extra_subdomains, workspace?.domain]);
  const scheme = setupStatus?.certs_generated ? "https" : "http";
  const isStatic = app.kind === "static";
  const isDocker = app.kind === "docker";
  const isCompose = app.kind === "compose";
  const isProxy = app.kind === "proxy";
  // Apps Caddy serves directly with no Porta-managed process — same UI shape:
  // no Start/Stop, no logs, no metrics, no force-kill.
  const isManaged = !isStatic && !isProxy;
  const isStarting = app.status === "starting";
  const isRunning = app.status === "running";
  const isActive = isRunning || isStarting; // process is alive
  const isWildcard = (app.subdomain ?? app.name) === "*";
  const extraCount = (app.extra_subdomains ?? []).length;
  const logs = appLogs ?? [];
  const exitCode = appExitCode ?? null;
  const crashed = exitCode !== null && exitCode !== 0;
  const hasLogs = logs.length > 0;
  const showLogIcon = isActive || hasLogs; // keep icon visible while running even after clear
  const retryCount = appRetryCount ?? 0;
  const hasPortConflict = portConflicts ?? false;
  const isRestarting = appRestarting ?? false;
  const tunnelError = appTunnelErrors ?? null;

  // Local state for instant spinner feedback before Zustand's appRestarting propagates
  const [pendingRestart, setPendingRestart] = useState(false);
  // Clear once the real restarting flag arrives, the app is back up, OR the
  // app stopped — without the stopped case, clicking Stop while the
  // optimistic spinner is still showing would leave the buttons stuck in
  // "yellow Restarting" mode even though the backend already stopped.
  useEffect(() => {
    if (isRestarting || isRunning || app.status === "stopped") setPendingRestart(false);
  }, [isRestarting, isRunning, app.status]);

  const [logViewerOpen, setLogViewerOpen] = useState(false);
  const [fileEditorOpen, setFileEditorOpen] = useState(false);
  const [fileEditorInitialPath, setFileEditorInitialPath] = useState<string | undefined>(undefined);
  const [trafficOpen, setTrafficOpen] = useState(false);
  const [appExtensions, setAppExtensions] = useState<ExtensionInfo[]>([]);
  const extSidebarActive = extensionSidebar?.appId === app.id;
  const [hostsMenuOpen, setHostsMenuOpen] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [killConfirm, setKillConfirm] = useState(false);
  const [portKillFeedback, setPortKillFeedback] = useState<{ ok: boolean; msg: string } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  function showPortFeedback(ok: boolean, msg: string) {
    setPortKillFeedback({ ok, msg });
    setTimeout(() => setPortKillFeedback(null), 3000);
  }

  // ── Port availability check for stopped apps (process apps only) ─────────
  const [portCheck, setPortCheck] = useState<PortCheckResult | null>(null);
  const [portCheckOpen, setPortCheckOpen] = useState(false);
  const [killingPort, setKillingPort] = useState(false);
  // Auto-fix flow: opens the suggest-and-apply modal. Only useful when the
  // app has a compose file we can rewrite — for plain process apps the
  // existing "Kill PID" path is still the right tool.
  const [conflictModalOpen, setConflictModalOpen] = useState(false);
  const portCheckRef = useRef<HTMLDivElement>(null);
  const portCheckPanelRef = useRef<HTMLDivElement>(null);
  const portCheckPanelSize = useMeasuredSize(portCheckPanelRef, portCheckOpen);
  const portCheckCoords = useFloatingPosition({
    triggerRef: portCheckRef,
    panelSize: portCheckPanelSize,
    active: portCheckOpen,
    side: "bottom",
    align: "start",
    gap: 6,
  });
  const hasComposeFile = isCompose && !!app.compose_file;
  useEffect(() => {
    // Proxy apps point at an existing service — having the port "in use" is
    // expected and not a warning. Skip the lsof poll entirely.
    if (isStatic || isProxy || isActive) { setPortCheck(null); return; }
    let cancelled = false;
    function check() {
      checkPortAvailable(app.port)
        .then((r) => { if (!cancelled) setPortCheck(r); })
        .catch(() => {});
    }
    // Delay initial check (1–3s) so mounting AppCards doesn't fire N parallel
    // lsof IPC calls during workspace switch. Subsequent checks every 30s are
    // plenty — this isn't latency-critical info.
    const startDelay = setTimeout(check, 1000 + Math.random() * 2000);
    const interval = setInterval(check, 30_000);
    return () => { cancelled = true; clearTimeout(startDelay); clearInterval(interval); };
  }, [app.port, isActive, isStatic, isProxy]);

  // Close port-check popover on outside click / Esc.
  useEffect(() => {
    if (!portCheckOpen) return;
    function onDown(e: MouseEvent) {
      const t = e.target as Node | null;
      if (!t) return;
      if (portCheckRef.current?.contains(t)) return;
      if (portCheckPanelRef.current?.contains(t)) return;
      setPortCheckOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setPortCheckOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [portCheckOpen]);

  // Load extensions that match this app on mount (and when app kind changes).
  useEffect(() => {
    async function load() {
      const tags = app.root_dir ? await detectAppTags(app.root_dir).catch(() => [] as string[]) : [];
      const exts = await getExtensionsForApp(app.kind, tags).catch(() => [] as ExtensionInfo[]);
      setAppExtensions(exts);
    }
    load();
  }, [app.id, app.kind, app.root_dir]);

  async function handleKillPortHolder() {
    setKillingPort(true);
    try {
      await killPortHolder(app.port);
      // Re-poll immediately so the warning clears without waiting 30s.
      const r = await checkPortAvailable(app.port).catch(() => null);
      if (r) setPortCheck(r);
      setPortCheckOpen(false);
      showPortFeedback(true, `Killed process on port ${app.port}`);
    } catch (e) {
      showPortFeedback(false, `Failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setKillingPort(false);
    }
  }

  const [logToastOpen, setLogToastOpen] = useState(false);
  function openToast() { setLogToastOpen(true); registerToast(app.id); }
  function closeToast() { setLogToastOpen(false); unregisterToast(app.id); }
  // Clean up stack slot if the card unmounts while toast is open
  useEffect(() => () => { unregisterToast(app.id); }, []);

  // Initialize to current active state so mounting already-running apps don't trigger auto-open
  const prevActive = useRef(isActive);

  // Show log toast the moment app process starts (stopped → starting)
  useEffect(() => {
    if (isActive && !prevActive.current) {
      openToast();
      setBannerDismissed(false);
    }
    if (!isActive) setKillConfirm(false); // dismiss confirm if process already stopped
    prevActive.current = isActive;
  }, [isActive]);

  // On crash: keep toast open (turns red) and show banner
  const prevCrashed = useRef(crashed);
  useEffect(() => {
    if (crashed && !prevCrashed.current) {
      setBannerDismissed(false);
      // Keep toast open so user sees it turn red; don't force-open LogViewer
    }
    prevCrashed.current = crashed;
  }, [crashed]);

  function handleContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }

  function copyUrl() {
    if (!isWildcard) navigator.clipboard.writeText(`${scheme}://${host}`);
  }

  async function handleStart() {
    try {
      await startApp(app.id);
    } catch (e) {
      const full = e instanceof Error ? e.message : String(e);
      // For compose apps, a port-already-in-use failure is auto-fixable —
      // surface the suggest-and-apply modal instead of an alert wall.
      if (hasComposeFile) {
        const probe = await checkPortAvailable(app.port).catch(() => null);
        if (probe && !probe.available) {
          setPortCheck(probe);
          setConflictModalOpen(true);
          return;
        }
      }
      const short = full.length > 400 ? `${full.slice(0, 400)}…\n\n(truncated — check logs for full output)` : full;
      window.alert(`Failed to start ${app.name}:\n\n${short}`);
    }
  }

  return (
    <div
      className={`flex flex-col rounded-lg border transition-all duration-150 ${
        crashed
          ? "bg-red-500/[0.04] border-red-500/20"
          : "bg-[#1c1c1e] border-white/[0.06] hover:border-white/[0.10]"
      }`}
      onContextMenu={handleContextMenu}
    >
      {/* ── Main row ── */}
      <div className="group flex items-center gap-3 px-3 py-2.5">
        <span className={`w-2 h-2 rounded-full shrink-0 transition-colors ${
          isRunning                                            ? "bg-emerald-400 pulse-dot" :
          isStarting                                           ? "bg-amber-400 pulse-dot"   :
          crashed                                              ? "bg-red-400"                :
          // Static & proxy apps have no managed process — they're "live"
          // whenever Caddy is up and serving them.
          (isStatic || isProxy) && setupStatus?.caddy_running   ? "bg-emerald-400"            :
                                                                 "bg-zinc-600"
        }`} />

        <div
          className={`flex-1 min-w-0 ${onOpenSettings ? "cursor-pointer" : ""}`}
          onClick={onOpenSettings ? () => onOpenSettings(app) : undefined}
          title={onOpenSettings ? "Open settings" : undefined}
        >
          <div className="flex items-center gap-1.5">
            <p className="text-[13px] font-medium text-zinc-100 leading-tight">{app.name}</p>
            {isStatic && (
              <span className="text-[9px] font-semibold tracking-wider text-blue-300 bg-blue-500/10 border border-blue-500/20 px-1.5 py-0.5 rounded leading-none uppercase opacity-0 group-hover:opacity-100 transition-opacity duration-150">
                static
              </span>
            )}
            {isDocker && (
              <span className="text-[9px] font-semibold tracking-wider text-sky-300 bg-sky-500/10 border border-sky-500/20 px-1.5 py-0.5 rounded leading-none uppercase opacity-0 group-hover:opacity-100 transition-opacity duration-150">
                docker
              </span>
            )}
            {isCompose && (
              <span className="text-[9px] font-semibold tracking-wider text-teal-300 bg-teal-500/10 border border-teal-500/20 px-1.5 py-0.5 rounded leading-none uppercase opacity-0 group-hover:opacity-100 transition-opacity duration-150">
                compose
              </span>
            )}
            {(isDocker || isCompose) && <DockerUpdateBadge app={app} />}
            {(isDocker || isCompose) && <AppDiskBadge app={app} />}
            {isProxy && (
              <span className="text-[9px] font-semibold tracking-wider text-violet-300 bg-violet-500/10 border border-violet-500/20 px-1.5 py-0.5 rounded leading-none uppercase opacity-0 group-hover:opacity-100 transition-opacity duration-150">
                proxy
              </span>
            )}
            {isManaged && isRunning && health && health !== "healthy" && (
              <Tooltip label={health === "unhealthy" ? "Unhealthy" : "Checking..."} side="top">
                {health === "unhealthy" ? (
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className="text-red-400">
                    <path d="M5 3v2.5M5 7h.01" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
                  </svg>
                ) : (
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className="text-zinc-500">
                    <path d="M3.5 3.5a2 2 0 013 1.5c0 1-1.5 1-1.5 2M5 8.5h.01" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                  </svg>
                )}
              </Tooltip>
            )}
            {isManaged && isRunning && health === "healthy" && (
              <Tooltip label="Healthy" side="top">
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className="text-emerald-400 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
                  <path d="M2.5 5.5l2 2 3.5-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </Tooltip>
            )}
            {startOrder !== undefined && (
              <span className="text-[9px] font-medium text-zinc-600 bg-white/[0.04] border border-white/[0.06] px-1 py-0.5 rounded leading-none">
                {startOrder}
              </span>
            )}
            {onOpenSettings && (
              <svg
                width="10" height="10" viewBox="0 0 10 10" fill="none"
                className="text-zinc-600 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
              >
                <path d="M3.5 2l3 3-3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            )}
            {retryCount > 0 && (
              <span className="text-[10px] font-medium text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded-full leading-none">
                ↻{retryCount}
              </span>
            )}
            {hasPortConflict && (
              <button
                onClick={() => dismissPortConflict(app.id)}
                className="text-[10px] font-medium text-amber-400 bg-amber-500/10 hover:bg-amber-500/20 px-1.5 py-0.5 rounded-full leading-none transition-colors"
                title={`Port ${app.port} is in use — click to dismiss`}
              >
                ⚠ :{app.port}
              </button>
            )}
          </div>
          <div className="flex items-center gap-1.5 mt-0.5">
            {isStatic ? (
              <p className="text-[11px] text-zinc-600 font-mono truncate" title={app.root_dir}>
                {app.root_dir.split("/").slice(-2).join("/")}
              </p>
            ) : isProxy ? (
              <p className="text-[11px] text-zinc-600 font-mono">→ :{app.port}</p>
            ) : (
              <p className="text-[11px] text-zinc-600">port {app.port}</p>
            )}
            {isManaged && metrics && isRunning && !(isDocker || isCompose) && (
              <Tooltip label={startedAt ? `Up ${formatUptime(startedAt, Date.now())}` : "Running"}>
                <span className="text-[10px] text-zinc-400 font-mono bg-white/[0.04] border border-white/[0.06] px-1.5 py-0.5 rounded leading-none opacity-0 group-hover:opacity-100 transition-opacity duration-150">
                  {metrics.cpu.toFixed(1)}% · {metrics.mem_mb}MB
                </span>
              </Tooltip>
            )}
            {(isDocker || isCompose) && isRunning && (
              <ContainerStatsBadge appId={app.id} active={isRunning} />
            )}
            {isManaged && portCheck && !portCheck.available && (() => {
              // `ps -o comm=` returns the full command path for binaries
              // launched by version managers (mise/asdf/nvm) — strip to the
              // basename so the popover header stays readable. Full path is
              // still available below for context.
              const fullPath = portCheck.process_name ?? "";
              const basename = fullPath.split("/").filter(Boolean).pop() || "unknown";
              return (
                <div className="relative" ref={portCheckRef}>
                  <button
                    onClick={(e) => { e.stopPropagation(); setPortCheckOpen((v) => !v); }}
                    className="text-amber-400 hover:text-amber-300 transition-colors p-0.5 -m-0.5 rounded"
                    title={`Port ${app.port} occupied — click for details`}
                    aria-label="Port conflict details"
                  >
                    <svg width="11" height="11" viewBox="0 0 11 11" fill="none" className="inline-block">
                      <path d="M5.5 1.5l4 7H1.5l4-7z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
                      <path d="M5.5 5v1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                      <circle cx="5.5" cy="8" r="0.5" fill="currentColor"/>
                    </svg>
                  </button>
                  {portCheckOpen && createPortal(
                    <div
                      ref={portCheckPanelRef}
                      className="fixed z-[60] w-[280px] bg-[#1c1c1e] border border-amber-500/30 rounded-lg shadow-xl p-3 text-[11px]"
                      style={portCheckCoords ? { top: portCheckCoords.top, left: portCheckCoords.left } : { top: -9999, left: -9999, visibility: "hidden" }}
                    >
                      <div className="flex items-center gap-1.5 mb-2">
                        <span className="text-amber-400">
                          <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                            <path d="M5.5 1.5l4 7H1.5l4-7z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
                            <path d="M5.5 5v1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                            <circle cx="5.5" cy="8" r="0.5" fill="currentColor"/>
                          </svg>
                        </span>
                        <p className="text-amber-300 font-medium">Port {app.port} in use</p>
                      </div>
                      <div className="flex flex-col gap-1.5 mb-2.5">
                        <div className="flex items-baseline gap-2">
                          <span className="text-zinc-500 text-[10px] w-12 shrink-0">Process</span>
                          <span className="font-mono text-zinc-200 truncate">{basename}</span>
                        </div>
                        <div className="flex items-baseline gap-2">
                          <span className="text-zinc-500 text-[10px] w-12 shrink-0">PID</span>
                          <span className="font-mono text-zinc-200">{portCheck.pid ?? "—"}</span>
                        </div>
                        {fullPath && fullPath !== basename && (
                          <div className="flex flex-col gap-0.5">
                            <span className="text-zinc-500 text-[10px]">Path</span>
                            <span className="font-mono text-[10px] text-zinc-400 break-all leading-snug">
                              {fullPath}
                            </span>
                          </div>
                        )}
                      </div>
                      <div className="flex flex-col gap-1.5">
                        {hasComposeFile && (
                          <button
                            onClick={() => { setPortCheckOpen(false); setConflictModalOpen(true); }}
                            className="px-2.5 py-1 text-[11px] font-medium bg-emerald-600/90 hover:bg-emerald-500 text-white rounded-md transition-colors"
                          >
                            Auto-fix (suggest free port)
                          </button>
                        )}
                        <div className="flex gap-2">
                          <button
                            onClick={handleKillPortHolder}
                            disabled={killingPort}
                            className="flex-1 px-2.5 py-1 text-[11px] font-medium bg-red-600/90 hover:bg-red-500 text-white rounded-md disabled:opacity-50 transition-colors"
                          >
                            {killingPort ? "Killing…" : `Kill PID ${portCheck.pid ?? ""}`}
                          </button>
                          <button
                            onClick={() => setPortCheckOpen(false)}
                            className="px-2.5 py-1 text-[11px] text-zinc-400 hover:text-zinc-200 transition-colors"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    </div>,
                    document.body,
                  )}
                </div>
              );
            })()}
            {extraCount > 0 && (
              <span className="text-[10px] font-medium text-zinc-500 bg-white/[0.05] border border-white/[0.08] px-1 py-0.5 rounded leading-none" title={(app.extra_subdomains ?? []).join(", ")}>
                +{extraCount}
              </span>
            )}
          </div>
        </div>

        {/* ── Icon actions: hidden at rest, fade in on card hover. Keeps the
             card calm when scanning a long list; reveals controls when the
             user is interacting with a specific row. */}
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">

        {/* Deploy button — only if app.deploy_config_path */}
        {app.deploy_config_path && (
          <Tooltip label="Deploy">
            <button
              onClick={(e) => { e.stopPropagation(); onOpenDeploy?.(app); }}
              className="p-1 text-zinc-600 hover:text-zinc-300 hover:bg-white/[0.06] rounded-md transition-colors"
            >
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                <path d="M6.5 1.5C6.5 1.5 9.5 2 10.5 5c.5 1.5.5 3 0 4L9 8.5l-1.5 3-1.5-3L4.5 9.5c-.5-1-.5-2.5 0-4C5.5 2 6.5 1.5 6.5 1.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
                <circle cx="6.5" cy="5.5" r="1" stroke="currentColor" strokeWidth="1.2"/>
              </svg>
            </button>
          </Tooltip>
        )}

        {/* Tunnel quick menu — works for process/docker/compose and static
            (static routes via Caddy). */}
        <TunnelQuickMenu
          app={app}
          isActive={isActive}
          tunnelError={tunnelError}
          onStartTunnel={() => startTunnel(app.id)}
          onStopTunnel={() => stopTunnel(app.id)}
        />

        {/* Terminal button — needs a folder to cd into */}
        {app.root_dir && (
        <Tooltip label="Open terminal">
          <button
            onClick={(e) => { e.stopPropagation(); onOpenTerminal?.(app); }}
            className="p-1 text-zinc-600 hover:text-zinc-300 hover:bg-white/[0.06] rounded-md transition-colors"
          >
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
              <rect x="1" y="2" width="11" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.2"/>
              <path d="M3 5.5l2 1.5-2 1.5M6.5 8.5H9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        </Tooltip>
        )}

        {/* Files editor — unified compose + .env editor in one modal */}
        {(app.root_dir || (isCompose && app.compose_file)) && (
        <Tooltip label="Edit files (compose / .env)">
          <button
            onClick={(e) => { e.stopPropagation(); setFileEditorInitialPath(undefined); setFileEditorOpen(true); }}
            className="p-1 text-zinc-600 hover:text-zinc-300 hover:bg-white/[0.06] rounded-md transition-colors"
          >
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
              <path d="M2 3h6.5L11 5.5V11a.5.5 0 01-.5.5h-8.5A.5.5 0 012 11V3z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
              <path d="M8.5 3v2.5H11" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
              <path d="M4 7.5h5M4 9h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
            </svg>
          </button>
        </Tooltip>
        )}

        {/* Claude shortcut — open terminal with `claude` auto-running */}
        {app.root_dir && (
        <Tooltip label="Open terminal with claude">
          <button
            onClick={(e) => { e.stopPropagation(); onOpenTerminal?.(app, "claude"); }}
            className="p-1 text-orange-400/70 hover:text-orange-300 hover:bg-orange-500/10 rounded-md transition-colors"
          >
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
              <path d="M3 3.5l2 3-2 3M7 9.5h3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        </Tooltip>
        )}

        {/* Extension actions */}
        {appExtensions.length > 0 && (
          <Tooltip label={extSidebarActive ? "Close extensions" : `${appExtensions.length} extension${appExtensions.length > 1 ? "s" : ""}`}>
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (extSidebarActive) closeExtensionSidebar();
                else openExtensionSidebar(app.id, appExtensions);
              }}
              className={`p-1 rounded-md transition-colors ${extSidebarActive ? "text-violet-400 bg-violet-500/10" : "text-zinc-600 hover:text-violet-300 hover:bg-violet-500/10"}`}
            >
              <ExtPuzzleIcon />
            </button>
          </Tooltip>
        )}

        {/* HTTP traffic inspector — non-wildcard host served by Caddy.
            Hidden for docker/compose: container logs already cover the
            request-time view, and Caddy<->container traffic is noisy. */}
        {!isWildcard && !isDocker && !isCompose && (
          <Tooltip label="HTTP traffic">
            <button
              onClick={() => setTrafficOpen(true)}
              className="p-1 text-zinc-600 hover:text-emerald-300 hover:bg-emerald-500/10 rounded-md transition-colors"
            >
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                <path d="M1.5 6.5h2l1.5-3 2 6 1.5-3h3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          </Tooltip>
        )}

        {/* Logs — managed apps. Process apps gate on showLogIcon (avoid
            noise when there's no output yet); docker/compose always show
            since container logs persist past app stop. Static/proxy have
            nothing to log. */}
        {isManaged && (showLogIcon || isDocker || isCompose) && (
          <Tooltip label={crashed ? "View crash logs" : "View logs"}>
            <button
              onClick={() => setLogViewerOpen(true)}
              className={`p-1 rounded-md transition-colors ${
                crashed
                  ? "text-red-400 hover:bg-red-500/10"
                  : "text-zinc-600 hover:text-zinc-200 hover:bg-white/[0.06]"
              }`}
            >
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                <rect x="2" y="1.5" width="9" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2"/>
                <path d="M4.5 4.5h4M4.5 6.5h4M4.5 8.5h2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
              </svg>
            </button>
          </Tooltip>
        )}

        {/* Open browser — when running (or for static/proxy, always served by Caddy) and not wildcard */}
        {(isRunning || isStatic || isProxy) && !isWildcard && (
          <div className="relative">
            {extraCount === 0 ? (
              // Single subdomain — plain link
              <Tooltip label={`Open ${scheme}://${host}`}>
                <a
                  href={`${scheme}://${host}`}
                  target="_blank"
                  rel="noreferrer"
                  className="p-1 text-zinc-600 hover:text-zinc-200 hover:bg-white/[0.06] rounded-md transition-colors flex items-center"
                >
                  <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                    <path d="M5.5 2.5H3a.5.5 0 00-.5.5v7a.5.5 0 00.5.5h7a.5.5 0 00.5-.5V8M7.5 2.5H10.5M10.5 2.5V5.5M10.5 2.5L6.5 6.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </a>
              </Tooltip>
            ) : (
              // Multiple subdomains — dropdown button (rendered via portal to escape ancestor clipping)
              <HostsDropdown
                hostsMenuOpen={hostsMenuOpen}
                setHostsMenuOpen={setHostsMenuOpen}
                hosts={hosts}
                scheme={scheme}
              />
            )}
          </div>
        )}

        </div>
        {/* end hover-revealed icon actions */}

        {/* Start / Stop / Restart — process apps only. Static and proxy apps
            are served by Caddy whenever Caddy is up, so there's nothing to
            start or stop. */}
        {isManaged && (
        <div className="flex items-center gap-1">
          {isActive || isRestarting || pendingRestart ? (
            <>
              <button
                onClick={async () => {
                  setPendingRestart(true);
                  await yieldToFrame();
                  openToast();
                  setBannerDismissed(false);
                  restartApp(app.id);
                }}
                disabled={isRestarting || isStarting || pendingRestart}
                className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors disabled:pointer-events-none
                  text-zinc-400 hover:text-amber-400 bg-white/[0.05] hover:bg-amber-500/10
                  disabled:text-amber-400/70 disabled:bg-amber-500/10"
                title="Restart"
              >
                {isRestarting || pendingRestart ? (
                  <>
                    <svg className="animate-spin" width="10" height="10" viewBox="0 0 10 10" fill="none">
                      <path d="M5 1.5A3.5 3.5 0 1 1 1.5 5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
                    </svg>
                    Restarting
                  </>
                ) : "Restart"}
              </button>
              <button
                onClick={() => stopApp(app.id)}
                className="px-2.5 py-1 text-[11px] font-medium text-zinc-300 bg-white/[0.07] hover:bg-white/[0.12] rounded-md transition-colors"
              >
                Stop
              </button>
            </>
          ) : (
            <>
              <button
                onClick={handleStart}
                disabled={!app.start_command && !(isDocker && app.docker_image) && !(isCompose && app.compose_file)}
                className={`px-2.5 py-1 text-[11px] font-medium rounded-md disabled:opacity-30 transition-colors ${
                  crashed
                    ? "text-amber-400 bg-amber-500/10 hover:bg-amber-500/20"
                    : "text-blue-400 bg-blue-500/10 hover:bg-blue-500/20"
                }`}
              >
                {crashed ? "Restart" : "Start"}
              </button>
              {/* Compose/docker apps that crashed mid-start often leave
                  orphan containers behind. Surface Stop only in that case
                  so the user has a one-click cleanup — pristine stopped
                  apps don't get a noisy Stop button next to Start. */}
              {(isDocker || isCompose) && crashed && (
                <button
                  onClick={() => stopApp(app.id)}
                  className="px-2.5 py-1 text-[11px] font-medium text-zinc-300 bg-white/[0.07] hover:bg-white/[0.12] rounded-md transition-colors"
                  title="Clean up any orphan containers from the failed start"
                >
                  Stop
                </button>
              )}
            </>
          )}
        </div>
        )}
      </div>

      {/* ── Port kill feedback ── */}
      {portKillFeedback && (
        <div className={`mx-3 mb-2 px-2.5 py-1.5 rounded-md flex items-center gap-2 ${
          portKillFeedback.ok
            ? "bg-emerald-500/10 border border-emerald-500/20"
            : "bg-red-500/10 border border-red-500/20"
        }`}>
          {portKillFeedback.ok ? (
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none" className="text-emerald-400 shrink-0">
              <path d="M2 5.5l2.5 2.5 4.5-4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          ) : (
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none" className="text-red-400 shrink-0">
              <path d="M2 2l7 7M9 2L2 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
            </svg>
          )}
          <p className={`text-[11px] flex-1 ${portKillFeedback.ok ? "text-emerald-400" : "text-red-400"}`}>
            {portKillFeedback.msg}
          </p>
        </div>
      )}

      {/* ── Kill confirm bar ── */}
      {killConfirm && (
        <div className="mx-3 mb-2 px-2.5 py-1.5 bg-orange-500/10 border border-orange-500/20 rounded-md flex items-center gap-2">
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none" className="text-orange-400 shrink-0">
            <path d="M5.5 1.5l4 7H1.5l4-7z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
            <path d="M5.5 5v1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
            <circle cx="5.5" cy="8" r="0.5" fill="currentColor"/>
          </svg>
          <p className="text-[11px] text-orange-300 flex-1">Force kill? Process won't get to clean up.</p>
          <button
            onClick={() => { killApp(app.id); setKillConfirm(false); }}
            className="text-[11px] font-medium text-orange-400 hover:text-orange-200 transition-colors"
          >
            Kill
          </button>
          <button
            onClick={() => setKillConfirm(false)}
            className="text-[11px] text-orange-400/50 hover:text-orange-300 transition-colors"
          >
            Cancel
          </button>
        </div>
      )}

      {/* ── Crash banner ── */}
      {crashed && !bannerDismissed && (
        <div className="mx-3 mb-2 px-2.5 py-1.5 bg-red-500/10 border border-red-500/20 rounded-md flex items-center gap-2">
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none" className="text-red-400 shrink-0">
            <path d="M5.5 1.5l4 7H1.5l4-7z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
            <path d="M5.5 5v1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
            <circle cx="5.5" cy="8" r="0.5" fill="currentColor"/>
          </svg>
          <p className="text-[11px] text-red-400 flex-1">Exited with code {exitCode} — see logs</p>
          <button
            onClick={() => setBannerDismissed(true)}
            className="text-[10px] text-red-400/50 hover:text-red-300 transition-colors"
          >
            dismiss
          </button>
        </div>
      )}

      {/* ── Log toast (auto-opens on start; stays open/turns red on crash) ── */}
      {logToastOpen && !logViewerOpen && (
        <LogToast
          appName={app.name}
          logs={logs}
          isRunning={isRunning}
          isStarting={isStarting}
          crashed={crashed}
          stackIndex={getToastIndex(app.id)}
          onExpand={() => { closeToast(); setLogViewerOpen(true); }}
          onClose={closeToast}
        />
      )}

      {/* ── Overlays ── */}
      {contextMenu && (
        <AppContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          items={[
            {
              label: "Copy URL",
              icon: <svg width="11" height="11" viewBox="0 0 11 11" fill="none"><rect x="1" y="3.5" width="6" height="7" rx="1" stroke="currentColor" strokeWidth="1.2"/><path d="M3.5 3.5V2a.5.5 0 01.5-.5h5a.5.5 0 01.5.5v5.5a.5.5 0 01-.5.5H7.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>,
              onClick: copyUrl,
              disabled: isWildcard,
            },
            ...(app.root_dir ? [{
              label: "Open in Editor",
              icon: <svg width="11" height="11" viewBox="0 0 11 11" fill="none"><rect x="1" y="1.5" width="9" height="8" rx="1" stroke="currentColor" strokeWidth="1.2"/><path d="M3.5 4l1.5 1.5L3.5 7M6 7h2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>,
              onClick: () => openInEditor(app.root_dir),
            }, {
              label: "Open in Terminal",
              icon: <svg width="11" height="11" viewBox="0 0 11 11" fill="none"><rect x="1" y="1.5" width="9" height="8" rx="1" stroke="currentColor" strokeWidth="1.2"/><path d="M2.5 4.5l2 1.5-2 1.5M5.5 7.5h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>,
              onClick: () => openInTerminal(app.root_dir),
            }] : []),
            ...(isManaged && isActive ? [{
              label: "Force Kill",
              icon: <svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M5.5 1v2M5.5 8v2M1 5.5h2M8 5.5h2M2.5 2.5l1.5 1.5M7 7l1.5 1.5M7 2.5L5.5 4M2.5 8.5L4 7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>,
              onClick: () => setKillConfirm(true),
              danger: true,
            }] : []),
            ...(isManaged && !isActive ? [{
              label: `Kill port holder (:${app.port})`,
              icon: <svg width="11" height="11" viewBox="0 0 11 11" fill="none"><circle cx="5.5" cy="5.5" r="4" stroke="currentColor" strokeWidth="1.2"/><path d="M3.5 5.5h4M5.5 3.5v4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>,
              onClick: () =>
                killPortHolder(app.port)
                  .then((pid) => showPortFeedback(true, `Killed pid ${pid} — port :${app.port} is free`))
                  .catch((e) => showPortFeedback(false, String(e).replace("Error: ", ""))),
              danger: true,
            }] : []),
            "separator",
            ...(onOpenSettings ? [{
              label: "App Settings",
              icon: <svg width="11" height="11" viewBox="0 0 11 11" fill="none"><circle cx="5.5" cy="5.5" r="1.5" stroke="currentColor" strokeWidth="1.2"/><path d="M5.5 1v1M5.5 9v1M1 5.5h1M9 5.5h1M2.3 2.3l.7.7M8.2 8.2l.7.7M8.2 2.3l-.7.7M2.3 8.2l.7-.7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>,
              onClick: () => onOpenSettings(app),
            }] : []),
          ]}
        />
      )}

      <Suspense fallback={null}>
        {logViewerOpen && (
          <LogViewer
            appId={app.id}
            appName={app.name}
            appKind={app.kind}
            logs={logs}
            isRunning={isRunning}
            isStarting={isStarting}
            crashed={crashed}
            exitCode={exitCode}
            onClose={() => setLogViewerOpen(false)}
            onClear={() => clearAppLogs(app.id)}
          />
        )}
        {fileEditorOpen && (
          <FileEditorModal
            appId={app.id}
            appName={app.name}
            composePath={app.compose_file ?? null}
            currentPort={app.port}
            initialPath={fileEditorInitialPath}
            onClose={() => setFileEditorOpen(false)}
          />
        )}
        {trafficOpen && (
          <TrafficInspectorModal
            appId={app.id}
            appName={app.name}
            isOpen={trafficOpen}
            onClose={() => setTrafficOpen(false)}
          />
        )}
        {conflictModalOpen && (
          <PortConflictModal
            appId={app.id}
            appName={app.name}
            port={app.port}
            hasComposeFile={hasComposeFile}
            onApplied={async () => {
              setConflictModalOpen(false);
              const r = await checkPortAvailable(app.port).catch(() => null);
              if (r) setPortCheck(r);
              showPortFeedback(true, `Port changed — starting ${app.name}…`);
              try {
                await startApp(app.id);
              } catch (e) {
                showPortFeedback(false, `Start failed: ${e instanceof Error ? e.message : String(e)}`);
              }
            }}
            onClose={() => setConflictModalOpen(false)}
          />
        )}
      </Suspense>
    </div>
  );
}

export default memo(AppCard);

// ── Extension helpers ──────────────────────────────────────────────────────

function ExtPuzzleIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
      <path d="M5.5 2h3v1.5c0 .8.7 1.5 1.5 1.5s1.5-.7 1.5-1.5V2H12a1 1 0 0 1 1 1v1.5h-1.5C10.7 4.5 10 5.2 10 6s.7 1.5 1.5 1.5H13V9a1 1 0 0 1-1 1h-1.5v-1.5C10.5 7.7 9.8 7 9 7s-1.5.7-1.5 1.5V10H6a1 1 0 0 1-1-1V7.5H3.5C2.7 7.5 2 6.8 2 6s.7-1.5 1.5-1.5H5V3a1 1 0 0 1 1-1z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"/>
    </svg>
  );
}

