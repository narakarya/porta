import { lazy, Suspense, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { App } from "../../types";
import { usePortaStore } from "../../store";
import { Button, Tabs, StatusDot, Badge, Card, type Status, type TabItem } from "../ui";
import TerminalTab from "../terminal/TerminalTab";
import GitTab from "./GitTab";

const LogViewer = lazy(() => import("../app/LogViewer"));

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
];

interface Props {
  app: App;
  onBack: () => void;
  onOpenSettings: (app: App) => void;
}

export default function AppWorkbench({ app, onBack, onOpenSettings }: Props) {
  const [tab, setTab] = useState("overview");
  const [logsSeen, setLogsSeen] = useState(false);
  const [termSeen, setTermSeen] = useState(false);

  const { startApp, stopApp, restartApp, clearAppLogs, logs } = usePortaStore(
    useShallow((s) => ({
      startApp: s.startApp,
      stopApp: s.stopApp,
      restartApp: s.restartApp,
      clearAppLogs: s.clearAppLogs,
      logs: s.appLogs[app.id] ?? EMPTY,
    }))
  );

  const running = app.status === "running";
  const st = toStatus(app.status);
  const url = app.tunnel_active && app.tunnel_url ? app.tunnel_url : `http://localhost:${app.port}`;

  function select(id: string) {
    setTab(id);
    if (id === "logs") setLogsSeen(true);
    if (id === "terminal") setTermSeen(true);
  }

  const row = "flex items-center justify-between py-2 border-b border-subtle text-[13px] last:border-0";
  const key = "text-ink-3";

  return (
    <div className="flex flex-col h-[calc(100vh-56px)] -mx-6 -mt-14 pt-14">
      <div className="flex items-center gap-2.5 px-5 py-3 border-b border-subtle">
        <button onClick={onBack} title="Back to apps" className="text-ink-3 hover:text-ink p-1 -ml-1 rounded transition-colors">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M10 3.5L5.5 8l4.5 4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        <span className="text-[15px] font-medium text-ink">{app.name}</span>
        <StatusDot status={st} />
        <Badge tone={running ? "ok" : st === "error" ? "bad" : "neutral"}>{app.status}</Badge>
        <span className="text-[11px] text-ink-3 font-mono">:{app.port}</span>
        <div className="ml-auto flex gap-2">
          {running ? (
            <>
              <Button onClick={() => stopApp(app.id)}>Stop</Button>
              <Button onClick={() => restartApp(app.id)}>Restart</Button>
            </>
          ) : (
            <Button variant="primary" onClick={() => startApp(app.id)}>Start</Button>
          )}
          <Button onClick={() => window.open(url, "_blank")}>Open</Button>
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
            <Button onClick={() => onOpenSettings(app)}>Open settings…</Button>
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
      </div>
    </div>
  );
}
