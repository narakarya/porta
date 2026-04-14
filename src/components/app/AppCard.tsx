import { useEffect, useRef, useState } from "react";
import { usePortaStore } from "../../store";
import type { App, Workspace } from "../../types";
import LogViewer from "./LogViewer";
import AppContextMenu from "./AppContextMenu";
import AppSettingsModal from "./AppSettingsModal";
import { openInEditor, openInTerminal, killPortHolder } from "../../lib/commands";
import Tooltip from "../shared/Tooltip";
import LogToast from "./LogToast";
import TunnelQuickMenu from "./TunnelQuickMenu";

interface Props {
  app: App;
  workspace: Workspace | null;
  startOrder?: number;
  onOpenDetail?: () => void;
  onOpenTerminal?: () => void;
  onOpenDeploy?: () => void;
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

export default function AppCard({ app, workspace, startOrder, onOpenDetail, onOpenTerminal, onOpenDeploy }: Props) {
  const { startApp, stopApp, restartApp, killApp, setupStatus, appLogs, appExitCode, appRetryCount, portConflicts, appRestarting, appTunnelErrors, appMetrics, healthStatuses, startTunnel, stopTunnel, clearAppLogs, dismissPortConflict, registerToast, unregisterToast, getToastIndex } =
    usePortaStore();
  const metrics = appMetrics[app.id];
  const health = healthStatuses[app.id];

  const host = resolvedHost(app, workspace);
  const hosts = allHosts(app, workspace);
  const scheme = setupStatus?.certs_generated ? "https" : "http";
  const isStarting = app.status === "starting";
  const isRunning = app.status === "running";
  const isActive = isRunning || isStarting; // process is alive
  const isWildcard = (app.subdomain ?? app.name) === "*";
  const extraCount = (app.extra_subdomains ?? []).length;
  const logs = appLogs[app.id] ?? [];
  const exitCode = appExitCode[app.id] ?? null;
  const crashed = exitCode !== null && exitCode !== 0;
  const hasLogs = logs.length > 0;
  const showLogIcon = isActive || hasLogs; // keep icon visible while running even after clear
  const retryCount = appRetryCount[app.id] ?? 0;
  const hasPortConflict = portConflicts[app.id] ?? false;
  const isRestarting = appRestarting[app.id] ?? false;
  const tunnelError = appTunnelErrors[app.id] ?? null;

  // Ref set synchronously on click — guards visibility across any intermediate Zustand renders
  const restartClickedRef = useRef(false);
  useEffect(() => { if (isRunning) restartClickedRef.current = false; }, [isRunning]);

  const [logViewerOpen, setLogViewerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [hostsMenuOpen, setHostsMenuOpen] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [killConfirm, setKillConfirm] = useState(false);
  const [portKillFeedback, setPortKillFeedback] = useState<{ ok: boolean; msg: string } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  function showPortFeedback(ok: boolean, msg: string) {
    setPortKillFeedback({ ok, msg });
    setTimeout(() => setPortKillFeedback(null), 3000);
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
    await startApp(app.id);
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
          isRunning  ? "bg-emerald-400 pulse-dot" :
          isStarting ? "bg-amber-400 pulse-dot"   :
          crashed    ? "bg-red-400"                :
                       "bg-zinc-600"
        }`} />

        <div
          className={`flex-1 min-w-0 ${onOpenDetail ? "cursor-pointer" : ""}`}
          onClick={onOpenDetail}
        >
          <div className="flex items-center gap-1.5">
            <p className="text-[13px] font-medium text-zinc-100 leading-tight">{app.name}</p>
            {isRunning && health && (
              <Tooltip label={health === "healthy" ? "Healthy" : health === "unhealthy" ? "Unhealthy" : "Checking..."} side="top">
                {health === "healthy" ? (
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className="text-emerald-400">
                    <path d="M2.5 5.5l2 2 3.5-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                ) : health === "unhealthy" ? (
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
            {startOrder !== undefined && (
              <span className="text-[9px] font-medium text-zinc-600 bg-white/[0.04] border border-white/[0.06] px-1 py-0.5 rounded leading-none">
                {startOrder}
              </span>
            )}
            {onOpenDetail && (
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
            <p className="text-[11px] text-zinc-600">port {app.port}</p>
            {metrics && isRunning && (
              <span className="text-[10px] text-zinc-600 font-mono">
                {metrics.cpu.toFixed(1)}% · {metrics.mem_mb} MB
              </span>
            )}
            {extraCount > 0 && (
              <span className="text-[10px] font-medium text-zinc-500 bg-white/[0.05] border border-white/[0.08] px-1 py-0.5 rounded leading-none" title={(app.extra_subdomains ?? []).join(", ")}>
                +{extraCount}
              </span>
            )}
          </div>
        </div>

        {/* Deploy button — only if app.deploy_config_path */}
        {app.deploy_config_path && (
          <Tooltip label="Deploy">
            <button
              onClick={(e) => { e.stopPropagation(); onOpenDeploy?.(); }}
              className="p-1 text-zinc-600 hover:text-zinc-300 hover:bg-white/[0.06] rounded-md transition-colors"
            >
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                <path d="M6.5 1.5C6.5 1.5 9.5 2 10.5 5c.5 1.5.5 3 0 4L9 8.5l-1.5 3-1.5-3L4.5 9.5c-.5-1-.5-2.5 0-4C5.5 2 6.5 1.5 6.5 1.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
                <circle cx="6.5" cy="5.5" r="1" stroke="currentColor" strokeWidth="1.2"/>
              </svg>
            </button>
          </Tooltip>
        )}

        {/* Tunnel quick menu — only shown when app is active, tunnel is connected, or there's an error */}
        <TunnelQuickMenu
          app={app}
          isActive={isActive}
          tunnelError={tunnelError}
          onStartTunnel={() => startTunnel(app.id)}
          onStopTunnel={() => stopTunnel(app.id)}
        />

        {/* Terminal button — always shown */}
        <Tooltip label="Open terminal">
          <button
            onClick={(e) => { e.stopPropagation(); onOpenTerminal?.(); }}
            className="p-1 text-zinc-600 hover:text-zinc-300 hover:bg-white/[0.06] rounded-md transition-colors"
          >
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
              <rect x="1" y="2" width="11" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.2"/>
              <path d="M3 5.5l2 1.5-2 1.5M6.5 8.5H9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        </Tooltip>

        {/* Log icon — always visible when there are logs */}
        {showLogIcon && (
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

        {/* Open browser — only when fully running and not wildcard */}
        {isRunning && !isWildcard && (
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
              // Multiple subdomains — dropdown button
              <>
                <Tooltip label="Open in browser">
                  <button
                    onClick={(e) => { e.stopPropagation(); setHostsMenuOpen((v) => !v); }}
                    className="p-1 text-zinc-600 hover:text-zinc-200 hover:bg-white/[0.06] rounded-md transition-colors"
                  >
                    <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                      <path d="M5.5 2.5H3a.5.5 0 00-.5.5v7a.5.5 0 00.5.5h7a.5.5 0 00.5-.5V8M7.5 2.5H10.5M10.5 2.5V5.5M10.5 2.5L6.5 6.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </button>
                </Tooltip>
                {hostsMenuOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setHostsMenuOpen(false)} />
                    <div className="absolute right-0 top-full mt-1 z-50 min-w-[180px] bg-[#1c1c1e] border border-white/[0.10] rounded-lg shadow-xl overflow-hidden">
                      {hosts.map((h) => (
                        <a
                          key={h}
                          href={`${scheme}://${h}`}
                          target="_blank"
                          rel="noreferrer"
                          onClick={() => setHostsMenuOpen(false)}
                          className="flex items-center gap-2 px-3 py-2 text-[12px] font-mono text-zinc-300 hover:bg-white/[0.07] transition-colors"
                        >
                          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className="text-zinc-600 shrink-0">
                            <path d="M4 1.5H2a.5.5 0 00-.5.5v6a.5.5 0 00.5.5h6a.5.5 0 00.5-.5V6M5.5 1.5H8.5M8.5 1.5V4.5M8.5 1.5L5 5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                          {h}
                        </a>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        )}

        {/* Start / Stop / Restart */}
        <div className="flex items-center gap-1">
          {isActive || isRestarting || restartClickedRef.current ? (
            <>
              <button
                onClick={() => { restartClickedRef.current = true; openToast(); setBannerDismissed(false); restartApp(app.id); }}
                disabled={isRestarting || isStarting || restartClickedRef.current}
                className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors disabled:pointer-events-none
                  text-zinc-400 hover:text-amber-400 bg-white/[0.05] hover:bg-amber-500/10
                  disabled:text-amber-400/70 disabled:bg-amber-500/10"
                title="Restart"
              >
                {isRestarting || restartClickedRef.current ? (
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
                disabled={isRestarting}
                className="px-2.5 py-1 text-[11px] font-medium text-zinc-300 bg-white/[0.07] hover:bg-white/[0.12] rounded-md transition-colors disabled:opacity-40 disabled:pointer-events-none"
              >
                Stop
              </button>
            </>
          ) : (
            <button
              onClick={handleStart}
              disabled={!app.start_command}
              className={`px-2.5 py-1 text-[11px] font-medium rounded-md disabled:opacity-30 transition-colors ${
                crashed
                  ? "text-amber-400 bg-amber-500/10 hover:bg-amber-500/20"
                  : "text-blue-400 bg-blue-500/10 hover:bg-blue-500/20"
              }`}
            >
              {crashed ? "Restart" : "Start"}
            </button>
          )}
        </div>
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
            {
              label: "Open in Editor",
              icon: <svg width="11" height="11" viewBox="0 0 11 11" fill="none"><rect x="1" y="1.5" width="9" height="8" rx="1" stroke="currentColor" strokeWidth="1.2"/><path d="M3.5 4l1.5 1.5L3.5 7M6 7h2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>,
              onClick: () => openInEditor(app.root_dir),
            },
            {
              label: "Open in Terminal",
              icon: <svg width="11" height="11" viewBox="0 0 11 11" fill="none"><rect x="1" y="1.5" width="9" height="8" rx="1" stroke="currentColor" strokeWidth="1.2"/><path d="M2.5 4.5l2 1.5-2 1.5M5.5 7.5h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>,
              onClick: () => openInTerminal(app.root_dir),
            },
            ...(isActive ? [{
              label: "Force Kill",
              icon: <svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M5.5 1v2M5.5 8v2M1 5.5h2M8 5.5h2M2.5 2.5l1.5 1.5M7 7l1.5 1.5M7 2.5L5.5 4M2.5 8.5L4 7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>,
              onClick: () => setKillConfirm(true),
              danger: true,
            }] : []),
            ...(!isActive ? [{
              label: `Kill port holder (:${app.port})`,
              icon: <svg width="11" height="11" viewBox="0 0 11 11" fill="none"><circle cx="5.5" cy="5.5" r="4" stroke="currentColor" strokeWidth="1.2"/><path d="M3.5 5.5h4M5.5 3.5v4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>,
              onClick: () =>
                killPortHolder(app.port)
                  .then((pid) => showPortFeedback(true, `Killed pid ${pid} — port :${app.port} is free`))
                  .catch((e) => showPortFeedback(false, String(e).replace("Error: ", ""))),
              danger: true,
            }] : []),
            "separator",
            {
              label: "App Settings",
              icon: <svg width="11" height="11" viewBox="0 0 11 11" fill="none"><circle cx="5.5" cy="5.5" r="1.5" stroke="currentColor" strokeWidth="1.2"/><path d="M5.5 1v1M5.5 9v1M1 5.5h1M9 5.5h1M2.3 2.3l.7.7M8.2 8.2l.7.7M8.2 2.3l-.7.7M2.3 8.2l.7-.7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>,
              onClick: () => setSettingsOpen(true),
            },
          ]}
        />
      )}

      {logViewerOpen && (
        <LogViewer
          appId={app.id}
          appName={app.name}
          logs={logs}
          crashed={crashed}
          exitCode={exitCode}
          onClose={() => setLogViewerOpen(false)}
          onClear={() => clearAppLogs(app.id)}
        />
      )}

      {settingsOpen && (
        <AppSettingsModal
          app={app}
          workspace={workspace}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}
