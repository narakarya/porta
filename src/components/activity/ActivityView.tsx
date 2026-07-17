import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { usePortaStore } from "../../store";
import { Card, StatusDot, Badge, Button, EmptyState, type Status } from "../ui";
import type { App, Service, Workspace } from "../../types";

function appStatus(s: App["status"]): Status {
  if (s === "running") return "running";
  if (s === "starting") return "connecting";
  return "stopped";
}

function svcStatus(s: Service["status"]): Status {
  if (s === "running") return "running";
  if (s === "pulling" || s === "starting") return "connecting";
  return "stopped";
}

// Activity domain — a live "what's running right now" overview sourced entirely
// from real store state (apps + services). Clicking an app opens its workbench.
// Resources/disk/updates/events land here in later Activity-phase increments.
export default function ActivityView() {
  const { apps, services, workspaces, selectApp, setActiveDomain, startApp, stopApp } =
    usePortaStore(
      useShallow((s) => ({
        apps: s.apps,
        services: s.services,
        workspaces: s.workspaces,
        selectApp: s.selectApp,
        setActiveDomain: s.setActiveDomain,
        startApp: s.startApp,
        stopApp: s.stopApp,
      }))
    );

  const runningApps = apps.filter((a) => a.status === "running").length;
  const runningSvcs = services.filter((s) => s.status === "running").length;

  // Group apps by workspace (null workspace → "Standalone").
  const groups = useMemo(() => {
    const byId = new Map<string | null, App[]>();
    for (const a of apps) {
      const key = a.workspace_id ?? null;
      const list = byId.get(key) ?? [];
      list.push(a);
      byId.set(key, list);
    }
    const wsName = (id: string | null) =>
      id === null ? "Standalone" : workspaces.find((w: Workspace) => w.id === id)?.name ?? "Workspace";
    return [...byId.entries()]
      .map(([id, list]) => ({ id, name: wsName(id), apps: list }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [apps, workspaces]);

  const openApp = (id: string) => {
    setActiveDomain("workspaces");
    selectApp(id);
  };

  if (apps.length === 0 && services.length === 0) {
    return (
      <EmptyState
        title="Nothing running yet"
        hint="Apps and services you add will show their live status here."
      />
    );
  }

  const rowBtn =
    "w-full flex items-center gap-2.5 px-3 py-2 rounded-control text-left hover:bg-surface-2 transition-colors";

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-6">
        <header className="mb-5 flex items-center gap-3">
          <h1 className="text-[17px] font-medium text-ink">Activity</h1>
          <div className="flex gap-1.5">
            <Badge tone={runningApps ? "ok" : "neutral"}>{runningApps} app{runningApps === 1 ? "" : "s"} up</Badge>
            <Badge tone={runningSvcs ? "ok" : "neutral"}>{runningSvcs} service{runningSvcs === 1 ? "" : "s"} up</Badge>
          </div>
        </header>

        <div className="space-y-4">
          {groups.map((g) => (
            <section key={g.id ?? "standalone"}>
              <div className="text-[11px] uppercase tracking-wide text-ink-3 mb-1.5 px-1">{g.name}</div>
              <Card padded={false} className="overflow-hidden">
                {g.apps.map((a) => (
                  <div key={a.id} className="flex items-center border-b border-subtle last:border-0">
                    <button className={rowBtn} onClick={() => openApp(a.id)} title="Open workbench">
                      <StatusDot status={appStatus(a.status)} />
                      <span className="text-[13px] text-ink flex-1 truncate">{a.name}</span>
                      <span className="text-[11px] text-ink-3 font-mono">:{a.port}</span>
                    </button>
                    <div className="pr-2 shrink-0">
                      {a.status === "running" ? (
                        <Button size="sm" onClick={() => stopApp(a.id)}>Stop</Button>
                      ) : (
                        <Button size="sm" variant="primary" onClick={() => startApp(a.id)}>Start</Button>
                      )}
                    </div>
                  </div>
                ))}
              </Card>
            </section>
          ))}

          {services.length > 0 && (
            <section>
              <div className="text-[11px] uppercase tracking-wide text-ink-3 mb-1.5 px-1">Services</div>
              <Card padded={false} className="overflow-hidden">
                {services.map((s) => (
                  <div key={s.id} className="flex items-center gap-2.5 px-3 py-2 border-b border-subtle last:border-0">
                    <StatusDot status={svcStatus(s.status)} />
                    <span className="text-[13px] text-ink flex-1 truncate">{s.name}</span>
                    <span className="text-[11px] text-ink-3 font-mono">{s.image}:{s.tag}</span>
                    <span className="text-[11px] text-ink-3 font-mono">:{s.port}</span>
                  </div>
                ))}
              </Card>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
