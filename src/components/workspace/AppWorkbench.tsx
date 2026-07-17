import { lazy, Suspense, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { App } from "../../types";
import { usePortaStore } from "../../store";
import { Button, Tabs, StatusDot, Badge, Card, type Status, type TabItem } from "../ui";
import TerminalTab from "../terminal/TerminalTab";
import GitTab from "./GitTab";
import PublishTab from "./PublishTab";

const LogViewer = lazy(() => import("../app/LogViewer"));
const TrafficInspectorModal = lazy(() => import("../app/TrafficInspectorModal"));
const FileEditorModal = lazy(() => import("../app/FileEditorModal"));

// Stable empty ref so the store selector never returns a fresh array (which
// would make useShallow see a change every render → infinite update loop).
const EMPTY: string[] = [];

function toStatus(s: string): Status {
  if (s === "running") return "running";
  if (s === "crashed") return "error";
  if (s === "starting") return "connecting";
  return "stopped";
}

const TABS: TabItem[] = [
  { id: "overview", label: "Overview" },
  { id: "logs", label: "Logs" },
  { id: "terminal", label: "Terminal" },
  { id: "git", label: "Git" },
  { id: "publish", label: "Publish" },
];

interface Props {
  app: App;
  onOpenSettings: (app: App) => void;
}

export default function AppWorkbench({ app, onOpenSettings }: Props) {
  const [tab, setTab] = useState("overview");
  const [logsSeen, setLogsSeen] = useState(false);
  const [termSeen, setTermSeen] = useState(false);
  // Traffic + Files reuse their existing full-screen surfaces, opened as an
  // overlay from the Overview quick actions (they aren't inline tabs yet).
  const [overlay, setOverlay] = useState<null | "traffic" | "files">(null);

  const { startApp, stopApp, restartApp, clearAppLogs, logs, health, branch } = usePortaStore(
    useShallow((s) => ({
      startApp: s.startApp,
      stopApp: s.stopApp,
      restartApp: s.restartApp,
      clearAppLogs: s.clearAppLogs,
      logs: s.appLogs[app.id] ?? EMPTY,
      health: s.healthStatuses[app.id],
      branch: s.appGit[app.id]?.branch,
    }))
  );

  const running = app.status === "running";
  const st = toStatus(app.status);
  const url = app.tunnel_active && app.tunnel_url ? app.tunnel_url : `http://localhost:${app.port}`;
  // Public host Caddy exposes this app under (if any) — shown as a link in the
  // header, matching the mockup's "mediapress.test" affordance.
  const domainHost =
    app.tunnel_active && app.tunnel_url ? app.tunnel_url.replace(/^https?:\/\//, "")
    : app.custom_domain || (app.subdomain ? `${app.subdomain}.test` : null);

  function select(id: string) {
    setTab(id);
    if (id === "logs") setLogsSeen(true);
    if (id === "terminal") setTermSeen(true);
  }

  const row = "flex items-center justify-between py-2 border-b border-subtle text-[13px] last:border-0";
  const key = "text-ink-3";

  return (
    <div className="flex flex-col h-[calc(100vh-56px)] -mx-6 -mt-14 pt-14">
      <div className="flex items-center gap-2 px-5 py-3 border-b border-subtle">
        <StatusDot status={st} />
        <span className="text-[15px] font-medium text-ink">{app.name}</span>
        <Badge tone={running ? "ok" : st === "error" ? "bad" : "neutral"}>{app.status}</Badge>
        {running && health === "healthy" && <Badge tone="ok">healthy</Badge>}
        {running && health === "unhealthy" && <Badge tone="bad">unhealthy</Badge>}
        {domainHost && (
          <button
            onClick={() => window.open(`https://${domainHost}`, "_blank")}
            title={`Open https://${domainHost}`}
            className="text-[11px] text-ink-3 hover:text-accent-ink font-mono inline-flex items-center gap-1 transition-colors"
          >
            {domainHost}
            <svg width="9" height="9" viewBox="0 0 12 12" fill="none"><path d="M4.5 2.5h5v5M9.5 2.5L5 7M8 8v2.5H2.5V5H5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </button>
        )}
        <span className="text-[11px] text-ink-3 font-mono">port {app.port}</span>
        {branch && (
          <span className="text-[11px] text-ink-3 font-mono inline-flex items-center gap-1" title={`branch ${branch}`}>
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none"><circle cx="4.5" cy="3.5" r="1.6" stroke="currentColor" strokeWidth="1.3"/><circle cx="4.5" cy="12.5" r="1.6" stroke="currentColor" strokeWidth="1.3"/><circle cx="11.5" cy="4.5" r="1.6" stroke="currentColor" strokeWidth="1.3"/><path d="M4.5 5.1v5.8M11.5 6.1c0 2.5-1.9 3.4-4.2 3.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
            {branch}
          </span>
        )}
        <div className="ml-auto flex gap-2">
          {running ? (
            <>
              <Button onClick={() => stopApp(app.id)}>Stop</Button>
              <Button onClick={() => restartApp(app.id)}>Restart</Button>
            </>
          ) : (
            <Button variant="primary" onClick={() => startApp(app.id)}>Start</Button>
          )}
          <Button variant="primary" onClick={() => window.open(url, "_blank")}>Open</Button>
        </div>
      </div>

      <Tabs tabs={TABS} active={tab} onSelect={select} />

      <div className="flex-1 min-h-0">
        <div hidden={tab !== "overview"} className="h-full overflow-y-auto p-5">
          <Card className="max-w-xl">
            <div className={row}><span className={key}>Status</span><span className="text-ink flex items-center gap-1.5"><StatusDot status={st} />{app.status}</span></div>
            <div className={row}><span className={key}>Port</span><span className="text-ink font-mono">{app.port}</span></div>
            <div className={row}><span className={key}>Kind</span><span className="text-ink">{app.kind || "process"}</span></div>
            <div className={row}><span className={key}>Root</span><span className="text-ink font-mono truncate max-w-[16rem]">{app.root_dir}</span></div>
            <div className={row}><span className={key}>URL</span><span className="text-accent-ink font-mono">{url}</span></div>
          </Card>
          <div className="mt-4">
            <div className="text-[11px] uppercase tracking-wide text-ink-3 mb-1.5">Quick actions</div>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => setOverlay("traffic")}>Traffic</Button>
              <Button onClick={() => setOverlay("files")}>Files</Button>
              <Button onClick={() => select("logs")}>Logs</Button>
              <Button onClick={() => select("terminal")}>Terminal</Button>
              <Button onClick={() => onOpenSettings(app)}>Settings…</Button>
            </div>
          </div>
        </div>

        {logsSeen && (
          <div hidden={tab !== "logs"} className="h-full">
            <Suspense fallback={null}>
              <LogViewer
                appId={app.id}
                appName={app.name}
                appKind={app.kind}
                logs={logs}
                isRunning={running}
                onClose={() => setTab("overview")}
                onClear={() => clearAppLogs(app.id)}
              />
            </Suspense>
          </div>
        )}

        {termSeen && (
          <div hidden={tab !== "terminal"} className="h-full p-2">
            <TerminalTab appId={app.id} rootDir={app.root_dir} visible={tab === "terminal"} />
          </div>
        )}

        <div hidden={tab !== "git"} className="h-full">
          <GitTab app={app} />
        </div>

        <div hidden={tab !== "publish"} className="h-full">
          <PublishTab app={app} />
        </div>
      </div>

      {overlay === "traffic" && (
        <Suspense fallback={null}>
          <TrafficInspectorModal appId={app.id} appName={app.name} isOpen onClose={() => setOverlay(null)} />
        </Suspense>
      )}
      {overlay === "files" && (
        <Suspense fallback={null}>
          <FileEditorModal
            appId={app.id}
            appName={app.name}
            composePath={app.compose_file ?? null}
            currentPort={app.port}
            onClose={() => setOverlay(null)}
          />
        </Suspense>
      )}
    </div>
  );
}
