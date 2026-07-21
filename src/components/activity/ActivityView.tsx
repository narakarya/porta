import { useMemo, useState, useEffect, useRef, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { usePortaStore } from "../../store";
import { StatusDot, Button, EmptyState, type Status } from "../ui";
import { systemMetrics, isTauri, type SystemMetrics } from "../../lib/commands";
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

// ── Host-metrics helpers ────────────────────────────────────────────────────
const GIB = 1024 ** 3;
const gib = (b: number) => b / GIB;
const pct = (part: number, total: number) => (total > 0 ? (part / total) * 100 : 0);

// Session-lived recent-events feed. Kinds map to a colored dot; buffer is
// bounded and intentionally resets on reload.
type EventKind = "ok" | "warn" | "bad" | "neutral";
type ActivityEvent = { ts: number; kind: EventKind; label: string };
const MAX_EVENTS = 50;
const MAX_SAMPLES = 60;

const dotClass: Record<EventKind, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  bad: "bg-bad",
  neutral: "bg-ink-3",
};

const hhmm = (ts: number) =>
  new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

// Inline CPU + memory-% sparkline over the rolling sample buffer. Guarded by the
// caller for a short buffer; here we assume >= 2 samples.
function Sparkline({ samples }: { samples: Array<{ cpu: number; mem: number }> }) {
  const W = 300;
  const H = 44;
  const n = samples.length;
  const line = (key: "cpu" | "mem") =>
    samples
      .map((s, i) => {
        const x = n === 1 ? 0 : (i / (n - 1)) * W;
        const v = Math.min(100, Math.max(0, s[key]));
        const y = H - (v / 100) * H;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  const lastX = W;
  const lastY = (key: "cpu" | "mem") => {
    const v = Math.min(100, Math.max(0, samples[n - 1][key]));
    return H - (v / 100) * H;
  };
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      height={H}
      className="block"
      role="img"
      aria-label="CPU and memory usage trend"
    >
      {/* Faint baseline grid */}
      {[0, H / 2, H].map((y) => (
        <line key={y} x1={0} y1={y} x2={W} y2={y} stroke="var(--border-subtle)" strokeWidth={1} />
      ))}
      <polyline points={line("cpu")} fill="none" stroke="#378add" strokeWidth={1.5} />
      <polyline points={line("mem")} fill="none" stroke="#1d9e75" strokeWidth={1.5} />
      {/* Emphasized last point */}
      <circle cx={lastX} cy={lastY("cpu")} r={2.5} fill="#378add" />
      <circle cx={lastX} cy={lastY("mem")} r={2.5} fill="#1d9e75" />
    </svg>
  );
}

// Activity domain — a live "what's running right now" overview sourced entirely
// from real store state (apps + services), host system metrics, a resource
// trend sparkline, and a session-lived recent-events feed.
export default function ActivityView() {
  const { apps, services, workspaces, selectApp, setActiveDomain, startApp, stopApp, notifyError } =
    usePortaStore(
      useShallow((s) => ({
        apps: s.apps,
        services: s.services,
        workspaces: s.workspaces,
        selectApp: s.selectApp,
        setActiveDomain: s.setActiveDomain,
        startApp: s.startApp,
        stopApp: s.stopApp,
        notifyError: s.notifyError,
      }))
    );

  // These were bare `onClick={() => startApp(id)}` calls: the store action
  // rejects on a failed spawn and nothing caught it, so the row just sat there.
  async function run(kind: "start" | "stop", name: string, fn: () => Promise<void>) {
    try {
      await fn();
    } catch (e) {
      notifyError(`Failed to ${kind} ${name}`, e);
    }
  }

  // ── Host metrics + rolling trend buffer ─────────────────────────────────
  const [metrics, setMetrics] = useState<SystemMetrics | null>(null);
  const [samples, setSamples] = useState<Array<{ cpu: number; mem: number }>>([]);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const m = await systemMetrics();
        if (!alive) return;
        setMetrics(m);
        // Only feed the trend once we have real host data (browser mode returns
        // all-zeros, which we neither render nor chart).
        if (m.mem_total_bytes > 0) {
          const sample = { cpu: m.cpu_pct, mem: pct(m.mem_used_bytes, m.mem_total_bytes) };
          setSamples((prev) => {
            const next = [...prev, sample];
            return next.length > MAX_SAMPLES ? next.slice(-MAX_SAMPLES) : next;
          });
        }
      } catch {
        /* transient poll failure — keep last snapshot */
      }
    };
    poll();
    const id = setInterval(poll, 2000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // ── Recent-events feed (session-lived FE ring buffer) ────────────────────
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  // Latest apps/services for name lookup at event time without re-subscribing
  // on every status flip (we key the effect on the id lists only).
  const appsRef = useRef(apps);
  appsRef.current = apps;
  const servicesRef = useRef(services);
  servicesRef.current = services;
  const appIds = apps.map((a) => a.id).join(",");
  const svcIds = services.map((s) => s.id).join(",");

  useEffect(() => {
    if (!isTauri) return;
    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    const push = (kind: EventKind, label: string) =>
      setEvents((prev) => [{ ts: Date.now(), kind, label }, ...prev].slice(0, MAX_EVENTS));
    const appName = (id: string) => appsRef.current.find((a) => a.id === id)?.name ?? "app";
    const svcName = (id: string) => servicesRef.current.find((s) => s.id === id)?.name ?? "service";

    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const track = (p: Promise<() => void>) =>
        p.then((fn) => (cancelled ? fn() : unlisteners.push(fn)));

      for (const a of appsRef.current) {
        track(
          listen<number>(`app:exit:${a.id}`, (e) =>
            push(
              e.payload === 0 ? "neutral" : "bad",
              e.payload === 0 ? `${appName(a.id)} stopped` : `${appName(a.id)} exited · code ${e.payload}`
            )
          )
        );
        track(listen(`app:ready:${a.id}`, () => push("ok", `${appName(a.id)} started`)));
        track(listen(`app:starting:${a.id}`, () => push("neutral", `${appName(a.id)} starting`)));
        track(
          listen<{ exit_code: number; attempt: number; max: number }>(`app:crashed:${a.id}`, (e) =>
            push("bad", `${appName(a.id)} crashed · exit ${e.payload.exit_code}`)
          )
        );
      }
      for (const s of servicesRef.current) {
        track(
          listen<{ status: string; container_id: string | null }>(`service:status:${s.id}`, (e) => {
            const st = e.payload.status;
            const kind: EventKind =
              st === "running" ? "ok" : st === "stopped" || st === "error" ? "bad" : "warn";
            push(kind, `${svcName(s.id)} ${st}`);
          })
        );
      }
    })();

    return () => {
      cancelled = true;
      unlisteners.forEach((fn) => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appIds, svcIds]);

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
      <div className="max-w-3xl mx-auto">
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

        {/* Host system metrics + resource trend — real host data only (hidden
            in browser mode where the wrapper returns all-zeros). */}
        {metrics && metrics.mem_total_bytes > 0 && (
          <div className="mb-6">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-3">
              <Metric
                label="CPU"
                value={Math.round(metrics.cpu_pct)}
                sub="%"
                tone={metrics.cpu_pct > 85 ? "warn" : "ink"}
              />
              <Metric
                label="Memory"
                value={gib(metrics.mem_used_bytes).toFixed(1)}
                sub={`/${Math.round(gib(metrics.mem_total_bytes))}G · ${Math.round(
                  pct(metrics.mem_used_bytes, metrics.mem_total_bytes)
                )}%`}
                tone={pct(metrics.mem_used_bytes, metrics.mem_total_bytes) > 90 ? "warn" : "ink"}
              />
              <Metric
                label="Disk free"
                value={Math.round(gib(metrics.disk_free_bytes))}
                sub={`G · ${Math.round(pct(metrics.disk_free_bytes, metrics.disk_total_bytes))}%`}
                tone={pct(metrics.disk_free_bytes, metrics.disk_total_bytes) < 10 ? "warn" : "ink"}
              />
            </div>
            {samples.length >= 2 && (
              <div className="bg-surface-1 border border-subtle rounded-lg px-3 py-2.5">
                <div className="flex items-center gap-4 mb-1.5">
                  <span className="text-[11px] text-ink-2 flex items-center gap-1.5">
                    <span className="inline-block w-2 h-0.5" style={{ background: "#378add" }} />
                    CPU
                  </span>
                  <span className="text-[11px] text-ink-2 flex items-center gap-1.5">
                    <span className="inline-block w-2 h-0.5" style={{ background: "#1d9e75" }} />
                    Memory
                  </span>
                </div>
                <Sparkline samples={samples} />
              </div>
            )}
          </div>
        )}

        {/* Recent events — session-lived feed of app/service transitions. */}
        <div className="mb-6">
          <div className="text-[11px] uppercase tracking-wide text-ink-3 mb-1.5 px-1">Recent events</div>
          {events.length === 0 ? (
            <div className="text-[12px] text-ink-3 px-1 py-1">No recent activity this session.</div>
          ) : (
            <div className="bg-surface-1 border border-subtle rounded-card overflow-hidden divide-y divide-subtle">
              {events.map((ev, i) => (
                <div key={`${ev.ts}-${i}`} className="flex items-center gap-2.5 px-3 py-1.5">
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotClass[ev.kind]}`} />
                  <span className="text-[12px] text-ink flex-1 truncate">{ev.label}</span>
                  <span className="text-[11px] text-ink-3 font-mono tabular-nums shrink-0">{hhmm(ev.ts)}</span>
                </div>
              ))}
            </div>
          )}
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
                        <Button size="sm" onClick={() => run("stop", a.name, () => stopApp(a.id))}>Stop</Button>
                      ) : (
                        <Button size="sm" variant="primary" onClick={() => run("start", a.name, () => startApp(a.id))}>Start</Button>
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
