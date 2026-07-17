import { useMemo, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { usePortaStore } from "../../store";
import { StatusDot, Button, EmptyState, type Status } from "../ui";
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

// Compact metric tile — big value, muted label, matching the Activity mockup's
// overview cards. `sub` renders as a de-emphasized suffix next to the value.
function Metric({
  label,
  value,
  sub,
  tone = "ink",
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "ink" | "warn";
}) {
  return (
    <div className="bg-surface-1 border border-subtle rounded-lg px-3 py-2.5">
      <div className="text-[11px] text-ink-2">{label}</div>
      <div className={`text-[18px] font-medium leading-tight mt-0.5 ${tone === "warn" ? "text-warn" : "text-ink"}`}>
        {value}
        {sub != null && <span className="text-[11px] text-ink-3 font-normal ml-0.5">{sub}</span>}
      </div>
    </div>
  );
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
  const transitioning =
    apps.filter((a) => a.status === "starting").length +
    services.filter((s) => s.status === "starting" || s.status === "pulling").length;

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
    "min-w-0 flex-1 flex items-center gap-2.5 px-3 py-2 text-left hover:bg-surface-2 transition-colors duration-fast";

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-6">
        <header className="mb-5">
          <div className="flex items-baseline gap-2.5">
            <h1 className="text-[17px] font-medium text-ink">Activity</h1>
            <span className="text-[11px] text-ink-3">system + runtime observability</span>
          </div>
        </header>

        {/* Live overview — real store counts in the mockup's metric-tile grid. */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-6">
          <Metric label="Apps up" value={runningApps} sub={`/${apps.length}`} />
          <Metric label="Services up" value={runningSvcs} sub={`/${services.length}`} />
          <Metric label="Workspaces" value={workspaces.length} />
          <Metric
            label="Starting"
            value={transitioning}
            tone={transitioning ? "warn" : "ink"}
          />
        </div>

        <div className="space-y-5">
          {groups.map((g) => (
            <section key={g.id ?? "standalone"}>
              <div className="text-[11px] uppercase tracking-wide text-ink-3 mb-1.5 px-1">{g.name}</div>
              <div className="bg-surface-1 border border-subtle rounded-card overflow-hidden divide-y divide-subtle">
                {g.apps.map((a) => (
                  <div key={a.id} className="flex items-center group">
                    <button className={rowBtn} onClick={() => openApp(a.id)} title="Open workbench">
                      <StatusDot status={appStatus(a.status)} />
                      <span className="text-[13px] text-ink flex-1 truncate">{a.name}</span>
                      <span className="text-[11px] text-ink-3 font-mono tabular-nums">:{a.port}</span>
                    </button>
                    <div className="pr-2 pl-1 shrink-0">
                      {a.status === "running" ? (
                        <Button size="sm" onClick={() => stopApp(a.id)}>Stop</Button>
                      ) : (
                        <Button size="sm" variant="primary" onClick={() => startApp(a.id)}>Start</Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}

          {services.length > 0 && (
            <section>
              <div className="text-[11px] uppercase tracking-wide text-ink-3 mb-1.5 px-1">Services</div>
              <div className="bg-surface-1 border border-subtle rounded-card overflow-hidden divide-y divide-subtle">
                {services.map((s) => (
                  <div key={s.id} className="flex items-center gap-2.5 px-3 py-2">
                    <StatusDot status={svcStatus(s.status)} />
                    <span className="text-[13px] text-ink flex-1 truncate">{s.name}</span>
                    <span className="text-[11px] text-ink-3 font-mono truncate max-w-[45%]">{s.image}:{s.tag}</span>
                    <span className="text-[11px] text-ink-3 font-mono tabular-nums shrink-0">:{s.port}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
