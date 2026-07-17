import { lazy, Suspense, useState, type ReactNode } from "react";
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

const I = { width: 13, height: 13, viewBox: "0 0 16 16", fill: "none" } as const;
const TABS: TabItem[] = [
  { id: "overview", label: "Overview", icon: <svg {...I}><rect x="2" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3"/><rect x="9" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3"/><rect x="2" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3"/><rect x="9" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3"/></svg> },
  { id: "logs", label: "Logs", icon: <svg {...I}><path d="M3 3.5h10M3 6.5h10M3 9.5h7M3 12.5h5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg> },
  { id: "terminal", label: "Terminal", icon: <svg {...I}><rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.3"/><path d="M5 6.5L7 8l-2 1.5M8.5 9.5H11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg> },
  { id: "git", label: "Git", icon: <svg {...I}><circle cx="4.5" cy="3.5" r="1.6" stroke="currentColor" strokeWidth="1.3"/><circle cx="4.5" cy="12.5" r="1.6" stroke="currentColor" strokeWidth="1.3"/><circle cx="11.5" cy="4.5" r="1.6" stroke="currentColor" strokeWidth="1.3"/><path d="M4.5 5.1v5.8M11.5 6.1c0 2.5-1.9 3.4-4.2 3.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg> },
  { id: "publish", label: "Publish", icon: <svg {...I}><circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.3"/><path d="M2 8h12M8 2c1.6 1.6 2.5 3.7 2.5 6S9.6 12.4 8 14c-1.6-1.6-2.5-3.7-2.5-6S6.4 3.6 8 2z" stroke="currentColor" strokeWidth="1.3"/></svg> },
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

  const row = "flex items-center gap-4 py-2 border-b border-subtle text-[13px] last:border-0";
  const key = "text-ink-3 shrink-0 w-24";

  // Overview "Quick action" tiles — icon-first buttons that open the app's
  // ancillary surfaces. Wired to the same handlers as before; presentation only.
  const tiles: { id: string; label: string; icon: ReactNode; onClick: () => void }[] = [
    { id: "traffic", label: "Traffic", onClick: () => setOverlay("traffic"),
      icon: <svg width="17" height="17" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.3"/><path d="M2 8h12M8 2c1.6 1.6 2.5 3.7 2.5 6S9.6 12.4 8 14c-1.6-1.6-2.5-3.7-2.5-6S6.4 3.6 8 2z" stroke="currentColor" strokeWidth="1.3"/></svg> },
    { id: "files", label: "Files", onClick: () => setOverlay("files"),
      icon: <svg width="17" height="17" viewBox="0 0 16 16" fill="none"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3H6l1.5 1.5h5A1.5 1.5 0 0 1 14 6v5.5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5v-7Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/></svg> },
    { id: "logs", label: "Logs", onClick: () => select("logs"),
      icon: <svg width="17" height="17" viewBox="0 0 16 16" fill="none"><path d="M3 3.5h10M3 6.5h10M3 9.5h7M3 12.5h5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg> },
    { id: "terminal", label: "Terminal", onClick: () => select("terminal"),
      icon: <svg width="17" height="17" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.3"/><path d="M5 6.5L7 8l-2 1.5M8.5 9.5H11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg> },
    { id: "settings", label: "Settings", onClick: () => onOpenSettings(app),
      icon: <svg width="17" height="17" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="2.1" stroke="currentColor" strokeWidth="1.3"/><path d="M8 1.5v1.8M8 12.7v1.8M14.5 8h-1.8M3.3 8H1.5M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3M12.6 12.6l-1.3-1.3M4.7 4.7L3.4 3.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg> },
  ];

  return (
    <div className="flex flex-col h-[calc(100vh-56px)] -mx-6 -mt-14 pt-14">
      <div className="flex items-center gap-2.5 px-4 py-3 border-b border-subtle">
        <span className="w-[26px] h-[26px] rounded-[7px] bg-surface-2 text-accent flex items-center justify-center shrink-0">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><rect x="2.5" y="2.5" width="11" height="11" rx="2.4" stroke="currentColor" strokeWidth="1.3"/><path d="M5.5 8l1.6 1.6L10.5 6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </span>
        <span className="text-[16px] font-semibold text-ink">{app.name}</span>
        <StatusDot status={st} />
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
              <Button onClick={() => restartApp(app.id)}>Restart</Button>
              <Button variant="danger" onClick={() => stopApp(app.id)}>Stop</Button>
            </>
          ) : (
            <Button variant="primary" onClick={() => startApp(app.id)}>Start</Button>
          )}
          <Button variant="primary" onClick={() => window.open(url, "_blank")}>Open</Button>
          <Button variant="ghost" onClick={() => onOpenSettings(app)} title="App settings" aria-label="More">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><circle cx="3.5" cy="8" r="1.1" fill="currentColor"/><circle cx="8" cy="8" r="1.1" fill="currentColor"/><circle cx="12.5" cy="8" r="1.1" fill="currentColor"/></svg>
          </Button>
        </div>
      </div>

      <Tabs tabs={TABS} active={tab} onSelect={select} />

      <div className="flex-1 min-h-0">
        <div hidden={tab !== "overview"} className="h-full overflow-y-auto px-6 py-5">
          <div className="max-w-2xl space-y-6">
            <section>
              <div className="text-[10px] uppercase tracking-[0.09em] text-ink-3 mb-2 px-0.5">Details</div>
              <Card padded={false} className="overflow-hidden">
                <div className="px-4">
                  <div className={row}>
                    <span className={key}>Status</span>
                    <span className="text-ink flex items-center gap-1.5"><StatusDot status={st} />{app.status}</span>
                  </div>
                  <div className={row}>
                    <span className={key}>Port</span>
                    <span className="text-ink-2 font-mono">{app.port}</span>
                  </div>
                  <div className={row}>
                    <span className={key}>Kind</span>
                    <span className="text-ink-2">{app.kind || "process"}</span>
                  </div>
                  <div className={row}>
                    <span className={key}>Root</span>
                    <span className="text-ink-2 font-mono truncate max-w-[20rem]" title={app.root_dir}>{app.root_dir}</span>
                  </div>
                  <div className={row}>
                    <span className={key}>URL</span>
                    <button
                      onClick={() => window.open(url, "_blank")}
                      className="text-accent-ink font-mono truncate max-w-[20rem] hover:underline"
                      title={`Open ${url}`}
                    >
                      {url}
                    </button>
                  </div>
                </div>
              </Card>
            </section>

            <section>
              <div className="text-[10px] uppercase tracking-[0.09em] text-ink-3 mb-2 px-0.5">Quick actions</div>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
                {tiles.map((t) => (
                  <button
                    key={t.id}
                    onClick={t.onClick}
                    className="group flex flex-col items-center justify-center gap-2 py-4 px-2 rounded-card border border-subtle bg-surface-1 text-ink-3 hover:text-ink hover:border-strong hover:bg-white/[0.03] transition-colors duration-fast"
                  >
                    <span className="group-hover:text-accent transition-colors duration-fast">{t.icon}</span>
                    <span className="text-[11px] font-medium">{t.label}</span>
                  </button>
                ))}
              </div>
            </section>
          </div>
        </div>

        {logsSeen && (
          <div hidden={tab !== "logs"} className="h-full">
            <Suspense fallback={null}>
              <LogViewer
                embedded
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
