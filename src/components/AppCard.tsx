import { useEffect, useRef, useState } from "react";
import { usePortaStore } from "../store";
import type { App, Workspace } from "../types";
import LogViewer from "./LogViewer";
import AppContextMenu from "./AppContextMenu";
import AppSettingsModal from "./AppSettingsModal";
import { openInEditor, killPid, killPortHolder } from "../lib/commands";

// eslint-disable-next-line no-control-regex
const ANSI_RE = /[\x1b\x9b][\[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]/g;
function stripAnsi(s: string) { return s.replace(ANSI_RE, ""); }

interface Props {
  app: App;
  workspace: Workspace | null;
}

// ── Log Toast ─────────────────────────────────────────────────────────────────

// Detect "held by process XXXX" pattern in log lines (Mix lock, npm lock, etc.)
const LOCK_RE = /held by process (\d+)/i;

interface LogToastProps {
  appName: string;
  logs: string[];
  isStarting?: boolean;
  crashed?: boolean;
  onExpand: () => void;
  onClose: () => void;
}

function LogToast({ appName, logs, isStarting, crashed, onExpand, onClose }: LogToastProps) {
  const [killedPid, setKilledPid] = useState<number | null>(null);
  const preview = logs.slice(-4).map(stripAnsi);

  // Scan recent logs for a lock-holder PID
  const lockPid = (() => {
    for (let i = logs.length - 1; i >= Math.max(0, logs.length - 20); i--) {
      const m = stripAnsi(logs[i]).match(LOCK_RE);
      if (m) return parseInt(m[1], 10);
    }
    return null;
  })();

  const dotColor = crashed
    ? "bg-red-400"
    : isStarting
    ? "bg-amber-400 pulse-dot"
    : "bg-emerald-400 pulse-dot";

  async function handleKillLock() {
    if (!lockPid) return;
    try {
      await killPid(lockPid);
      setKilledPid(lockPid);
    } catch {}
  }

  return (
    <div className={`fixed bottom-4 right-4 z-50 w-[320px] bg-[#1c1c1e] border rounded-xl shadow-2xl overflow-hidden ${
      crashed ? "border-red-500/20" : "border-white/[0.10]"
    }`}>
      {/* Header */}
      <div className={`flex items-center gap-2 px-3 py-2 border-b ${crashed ? "border-red-500/10" : "border-white/[0.06]"}`}>
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotColor}`} />
        <span className="text-[12px] font-medium text-zinc-200 flex-1 truncate">{appName}</span>
        <button onClick={onExpand} className="text-[11px] text-blue-400 hover:text-blue-300 transition-colors shrink-0">
          View full logs
        </button>
        <button onClick={onClose} className="ml-1 text-zinc-600 hover:text-zinc-300 transition-colors shrink-0">
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
            <path d="M1.5 1.5l8 8M9.5 1.5l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
          </svg>
        </button>
      </div>

      {/* Log preview — selectable */}
      <div className="px-3 py-2 font-mono min-h-[48px] select-text">
        {preview.length === 0 ? (
          <p className="text-[11px] text-zinc-600 select-none">Starting…</p>
        ) : (
          preview.map((line, i) => (
            <p key={i} className={`text-[11px] leading-5 whitespace-pre-wrap break-all ${crashed ? "text-red-300/70" : "text-zinc-400"}`}>
              {line}
            </p>
          ))
        )}
      </div>

      {/* Lock-holder action */}
      {lockPid && (
        <div className="px-3 py-2 border-t border-white/[0.05] flex items-center gap-2">
          {killedPid === lockPid ? (
            <p className="text-[11px] text-emerald-400">Killed process {lockPid}</p>
          ) : (
            <>
              <p className="text-[11px] text-zinc-500 flex-1">Lock held by pid {lockPid}</p>
              <button
                onClick={handleKillLock}
                className="text-[11px] font-medium text-orange-400 hover:text-orange-200 bg-orange-500/10 hover:bg-orange-500/20 px-2 py-0.5 rounded transition-colors"
              >
                Kill {lockPid}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function resolvedHost(app: App, workspace: Workspace | null): string {
  const domain = workspace?.domain ?? "narakarya.test";
  const sub = app.subdomain ?? app.name;
  return sub === "*" ? `*.${domain}` : `${sub}.${domain}`;
}

export default function AppCard({ app, workspace }: Props) {
  const { startApp, stopApp, killApp, setupStatus, appLogs, appExitCode, clearAppLogs } =
    usePortaStore();

  const host = resolvedHost(app, workspace);
  const scheme = setupStatus?.certs_generated ? "https" : "http";
  const isStarting = app.status === "starting";
  const isRunning = app.status === "running";
  const isActive = isRunning || isStarting; // process is alive
  const isWildcard = (app.subdomain ?? app.name) === "*";
  const logs = appLogs[app.id] ?? [];
  const exitCode = appExitCode[app.id] ?? null;
  const crashed = exitCode !== null && exitCode !== 0;
  const hasLogs = logs.length > 0;

  const [logViewerOpen, setLogViewerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [killConfirm, setKillConfirm] = useState(false);
  const [portKillFeedback, setPortKillFeedback] = useState<{ ok: boolean; msg: string } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  function showPortFeedback(ok: boolean, msg: string) {
    setPortKillFeedback({ ok, msg });
    setTimeout(() => setPortKillFeedback(null), 3000);
  }

  const [logToastOpen, setLogToastOpen] = useState(false);
  // Initialize to current active state so mounting already-running apps don't trigger auto-open
  const prevActive = useRef(isActive);

  // Show log toast the moment app process starts (stopped → starting)
  useEffect(() => {
    if (isActive && !prevActive.current) {
      setLogToastOpen(true);
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

        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-medium text-zinc-100 leading-tight">{app.name}</p>
          <p className="text-[11px] text-zinc-500 truncate mt-0.5">
            {isWildcard
              ? <span className="italic text-zinc-600">wildcard · {workspace?.domain ?? "narakarya.test"}</span>
              : host}
            <span className="text-zinc-700 ml-1">:{app.port}</span>
          </p>
        </div>

        {/* Log icon — always visible when there are logs */}
        {hasLogs && (
          <button
            onClick={() => setLogViewerOpen(true)}
            className={`p-1 rounded-md transition-colors ${
              crashed
                ? "text-red-400 hover:bg-red-500/10"
                : "text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.06]"
            }`}
            title="View logs"
          >
            {/* Page / document icon */}
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
              <rect x="2" y="1.5" width="9" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2"/>
              <path d="M4.5 4.5h4M4.5 6.5h4M4.5 8.5h2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
            </svg>
          </button>
        )}

        {/* Open icon — only when fully running and not wildcard */}
        {isRunning && !isWildcard && (
          <a
            href={`${scheme}://${host}`}
            target="_blank"
            rel="noreferrer"
            className="p-1 text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.06] rounded-md transition-colors"
            title={`Open ${scheme}://${host}`}
          >
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
              <path d="M5.5 2.5H3a.5.5 0 00-.5.5v7a.5.5 0 00.5.5h7a.5.5 0 00.5-.5V8M7.5 2.5H10.5M10.5 2.5V5.5M10.5 2.5L6.5 6.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </a>
        )}

        {/* Start / Stop */}
        <div className={`flex items-center transition-opacity duration-150 ${
          isActive || crashed ? "opacity-100" : "opacity-0 group-hover:opacity-100"
        }`}>
          {isActive ? (
            <button
              onClick={() => stopApp(app.id)}
              className="px-2.5 py-1 text-[11px] font-medium text-zinc-300 bg-white/[0.07] hover:bg-white/[0.12] rounded-md transition-colors"
            >
              Stop
            </button>
          ) : (
            <button
              onClick={handleStart}
              disabled={!app.start_command}
              className="px-2.5 py-1 text-[11px] font-medium text-blue-400 bg-blue-500/10 hover:bg-blue-500/20 rounded-md disabled:opacity-30 transition-colors"
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
          isStarting={isStarting}
          crashed={crashed}
          onExpand={() => { setLogToastOpen(false); setLogViewerOpen(true); }}
          onClose={() => setLogToastOpen(false)}
        />
      )}

      {/* ── Overlays ── */}
      {contextMenu && (
        <AppContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          items={[
            ...(!isWildcard ? [{
              label: "Open in browser",
              icon: <svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M4.5 2H2a.5.5 0 00-.5.5v7A.5.5 0 002 10h7a.5.5 0 00.5-.5V7M6.5 1.5H9.5M9.5 1.5V4.5M9.5 1.5L5.5 5.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>,
              onClick: () => window.open(`${scheme}://${host}`, "_blank"),
            }] : []),
            {
              label: "Copy URL",
              icon: <svg width="11" height="11" viewBox="0 0 11 11" fill="none"><rect x="1" y="3.5" width="6" height="7" rx="1" stroke="currentColor" strokeWidth="1.2"/><path d="M3.5 3.5V2a.5.5 0 01.5-.5h5a.5.5 0 01.5.5v5.5a.5.5 0 01-.5.5H7.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>,
              onClick: copyUrl,
              disabled: isWildcard,
            },
            {
              label: "View Logs",
              icon: <svg width="11" height="11" viewBox="0 0 11 11" fill="none"><rect x="1.5" y="1" width="8" height="9" rx="1" stroke="currentColor" strokeWidth="1.2"/><path d="M3.5 4h4M3.5 6h4M3.5 8h2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>,
              onClick: () => setLogViewerOpen(true),
            },
            {
              label: "Open in Editor",
              icon: <svg width="11" height="11" viewBox="0 0 11 11" fill="none"><rect x="1" y="1.5" width="9" height="8" rx="1" stroke="currentColor" strokeWidth="1.2"/><path d="M3.5 4l1.5 1.5L3.5 7M6 7h2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>,
              onClick: () => openInEditor(app.root_dir),
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
