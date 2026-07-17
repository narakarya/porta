import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import type { App } from "../../types";
import { usePortaStore } from "../../store";
import { isTauri } from "../../lib/commands";
import { Button, Tabs, StatusDot, Badge, Card, Popover, Skeleton, type Status, type TabItem } from "../ui";
import TerminalTab from "../terminal/TerminalTab";
import GitTab from "./GitTab";
import PublishTab from "./PublishTab";

const LogViewer = lazy(() => import("../app/LogViewer"));
const TrafficInspectorModal = lazy(() => import("../app/TrafficInspectorModal"));
const FileEditorModal = lazy(() => import("../app/FileEditorModal"));
const AppSettingsModal = lazy(() => import("../app/AppSettingsModal"));
const InstancesModal = lazy(() => import("../app/InstancesModal"));
type ConfigSection = import("../app/AppSettingsModal").Section;
type AppInstance = import("../../lib/commands").AppInstance;
const EMPTY_INSTANCES: AppInstance[] = [];

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
  { id: "git", label: "Git", icon: <svg {...I}><circle cx="4.5" cy="3.5" r="1.6" stroke="currentColor" strokeWidth="1.3"/><circle cx="4.5" cy="12.5" r="1.6" stroke="currentColor" strokeWidth="1.3"/><circle cx="11.5" cy="4.5" r="1.6" stroke="currentColor" strokeWidth="1.3"/><path d="M4.5 5.1v5.8M11.5 6.1c0 2.5-1.9 3.4-4.2 3.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg> },
  { id: "terminal", label: "Terminal", icon: <svg {...I}><rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.3"/><path d="M5 6.5L7 8l-2 1.5M8.5 9.5H11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg> },
  { id: "publish", label: "Publish", icon: <svg {...I}><circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.3"/><path d="M2 8h12M8 2c1.6 1.6 2.5 3.7 2.5 6S9.6 12.4 8 14c-1.6-1.6-2.5-3.7-2.5-6S6.4 3.6 8 2z" stroke="currentColor" strokeWidth="1.3"/></svg> },
  { id: "config", label: "Config", icon: <svg {...I}><path d="M3.5 4.5h9M3.5 8h9M3.5 11.5h9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/><circle cx="6" cy="4.5" r="1.5" fill="var(--surface-0)" stroke="currentColor" strokeWidth="1.3"/><circle cx="10.5" cy="8" r="1.5" fill="var(--surface-0)" stroke="currentColor" strokeWidth="1.3"/><circle cx="6" cy="11.5" r="1.5" fill="var(--surface-0)" stroke="currentColor" strokeWidth="1.3"/></svg> },
];

// Rolling window of live-metric samples kept per tile (~1 minute at the 2s
// poll cadence). Feeds the sparklines under each metric value.
const MAX_SAMPLES = 30;

/** A rolling sparkline that fills its width, normalised against its own peak. */
function Sparkline({ points, className = "" }: { points: number[]; className?: string }) {
  if (points.length < 2) return <div className="h-6" />;
  const w = 100;
  const h = 24;
  const peak = Math.max(...points, 1);
  const step = w / (points.length - 1);
  const d = points
    .map((p, i) => `${(i * step).toFixed(1)},${(h - (p / peak) * (h - 2) - 1).toFixed(1)}`)
    .join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none" className={className} aria-hidden>
      <polyline points={d} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** One metric tile (mockup 17): small label, large value, rolling sparkline. */
function MetricTile({ label, value, points, sparkClass }: {
  label: string;
  value: ReactNode;
  points: number[];
  sparkClass: string;
}) {
  return (
    <div className="rounded-lg border border-subtle bg-surface-1 px-3 py-2.5">
      <div className="text-[11px] text-ink-2">{label}</div>
      <div className="text-[18px] font-medium text-ink leading-tight">{value}</div>
      <div className="mt-1.5 h-6">
        <Sparkline points={points} className={sparkClass} />
      </div>
    </div>
  );
}

/**
 * Live per-app metrics panel — subscribes (component-local, isTauri-guarded)
 * to the backend `app:metrics:{id}` poller, which emits {cpu, mem_mb} every
 * ~2s for running process/docker apps. Keeps a rolling window per metric.
 */
function LiveMetrics({ appId, running }: { appId: string; running: boolean }) {
  const [sample, setSample] = useState<{ cpu: number; mem_mb: number } | null>(null);
  const [cpuHist, setCpuHist] = useState<number[]>([]);
  const [memHist, setMemHist] = useState<number[]>([]);

  useEffect(() => {
    // Drop stale history whenever we (re)subscribe or the app stops.
    setSample(null);
    setCpuHist([]);
    setMemHist([]);
    if (!isTauri || !running) return;

    let cancelled = false;
    let unlisten: (() => void) | undefined;
    import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<{ cpu: number; mem_mb: number }>(`app:metrics:${appId}`, (e) => {
          setSample(e.payload);
          setCpuHist((h) => [...h, e.payload.cpu].slice(-MAX_SAMPLES));
          setMemHist((h) => [...h, e.payload.mem_mb].slice(-MAX_SAMPLES));
        })
      )
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [appId, running]);

  if (!running) {
    return (
      <div className="rounded-lg border border-subtle bg-surface-1 px-4 py-6 text-center text-[12px] text-ink-3">
        No live metrics (app stopped)
      </div>
    );
  }

  // Running but the first sample hasn't landed yet — shimmer the tiles.
  if (!sample) {
    return (
      <div className="grid grid-cols-2 gap-2">
        {[0, 1].map((i) => (
          <div key={i} className="rounded-lg border border-subtle bg-surface-1 px-3 py-2.5 space-y-2">
            <Skeleton className="h-3 w-10" />
            <Skeleton className="h-5 w-16" />
            <Skeleton className="h-6 w-full" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-2">
      <MetricTile
        label="CPU"
        value={<>{sample.cpu}<span className="text-[11px] text-ink-3 ml-0.5">%</span></>}
        points={cpuHist}
        sparkClass="text-accent"
      />
      <MetricTile
        label="Memory"
        value={<>{sample.mem_mb}<span className="text-[11px] text-ink-3 ml-0.5">MB</span></>}
        points={memHist}
        sparkClass="text-ok"
      />
    </div>
  );
}

interface Props {
  app: App;
}

export default function AppWorkbench({ app }: Props) {
  const [tab, setTab] = useState("overview");
  const [logsSeen, setLogsSeen] = useState(false);
  const [termSeen, setTermSeen] = useState(false);
  // Config tab (mockup 20) — the app settings surface, rendered inline instead
  // of a full-screen modal. `configSection` deep-links the sub-nav (e.g. from
  // the Publish tab → Tunneling). Remounted per section so the initial deep
  // link takes effect.
  const [configSection, setConfigSection] = useState<ConfigSection | undefined>(undefined);
  const workspaces = usePortaStore((s) => s.workspaces);
  // Traffic + Files reuse their existing full-screen surfaces, opened as an
  // overlay from the Overview quick actions (they aren't inline tabs yet).
  const [overlay, setOverlay] = useState<null | "traffic" | "files">(null);
  // "Open in browser" split-button dropdown (mockup 05).
  const [openMenu, setOpenMenu] = useState(false);
  // In-flight lifecycle action — drives the Start/Stop/Restart Button spinners
  // while the start/stop/restart round-trip is pending.
  const [busy, setBusy] = useState<null | "start" | "stop" | "restart">(null);
  // Worktree instances (mockup 26) — the Overview "Instances" section lists the
  // primary checkout + each branch instance; the "＋ New from branch" affordance
  // opens this modal, which carries the run-on-branch picker.
  const [instancesOpen, setInstancesOpen] = useState(false);

  const {
    startApp, stopApp, restartApp, clearAppLogs, logs, health, branch,
    instances, refreshInstances, runInstance, stopInstanceAction, removeInstanceAction,
  } = usePortaStore(
    useShallow((s) => ({
      startApp: s.startApp,
      stopApp: s.stopApp,
      restartApp: s.restartApp,
      clearAppLogs: s.clearAppLogs,
      logs: s.appLogs[app.id] ?? EMPTY,
      health: s.healthStatuses[app.id],
      branch: s.appGit[app.id]?.branch,
      instances: s.instances[app.id] ?? EMPTY_INSTANCES,
      refreshInstances: s.refreshInstances,
      runInstance: s.runInstance,
      stopInstanceAction: s.stopInstanceAction,
      removeInstanceAction: s.removeInstanceAction,
    }))
  );
  useEffect(() => { void refreshInstances(app.id); }, [app.id, refreshInstances]);

  const running = app.status === "running";
  const st = toStatus(app.status);
  // Instances section (mockup 26): the primary checkout counts as running when
  // the app itself is up; branch instances count their own "running" status.
  const runningCount = (running ? 1 : 0) + instances.filter((i) => i.status === "running").length;
  // Host shown on the primary row — the app's .test subdomain if Caddy assigned
  // one, otherwise its raw localhost host.
  const primaryHost = app.subdomain ? `${app.subdomain}.test` : `localhost:${app.port}`;
  const url = app.tunnel_active && app.tunnel_url ? app.tunnel_url : `http://localhost:${app.port}`;
  // The default local address for this app — its .test subdomain if Caddy
  // assigned one, otherwise the raw localhost:port. Powers the split-button's
  // primary "Open" segment and the dropdown's Local row.
  const localHost = app.subdomain ? `${app.subdomain}.test` : `localhost:${app.port}`;
  const localUrl = app.subdomain ? `https://${app.subdomain}.test` : `http://localhost:${app.port}`;
  // Public host Caddy exposes this app under (if any) — shown as a link in the
  // header, matching the mockup's "mediapress.test" affordance.
  const domainHost =
    app.tunnel_active && app.tunnel_url ? app.tunnel_url.replace(/^https?:\/\//, "")
    : app.custom_domain || (app.subdomain ? `${app.subdomain}.test` : null);

  // Run a lifecycle action with a local in-flight flag so its Button shows a
  // spinner + disables until the round-trip settles.
  async function runLifecycle(kind: "start" | "stop" | "restart", fn: () => Promise<void>) {
    setBusy(kind);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  }

  function select(id: string) {
    setTab(id);
    if (id === "logs") setLogsSeen(true);
    if (id === "terminal") setTermSeen(true);
  }

  // Open the Config tab, optionally deep-linked to a sub-section. Used by the
  // header ⋯, the Settings quick-action, and the Publish tab's manage links.
  function openConfig(sec?: ConfigSection) {
    setConfigSection(sec);
    setTab("config");
  }

  const row = "flex items-center gap-4 py-2 border-b border-subtle text-[13px] last:border-0";
  const key = "text-ink-3 shrink-0 w-24";

  // Secondary Overview links — Traffic + Files open their existing full-screen
  // overlays. They aren't tabs, so they stay here (Logs/Terminal/Config are).
  const secondary: { id: "traffic" | "files"; label: string; icon: ReactNode }[] = [
    { id: "traffic", label: "Traffic",
      icon: <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.3"/><path d="M2 8h12M8 2c1.6 1.6 2.5 3.7 2.5 6S9.6 12.4 8 14c-1.6-1.6-2.5-3.7-2.5-6S6.4 3.6 8 2z" stroke="currentColor" strokeWidth="1.3"/></svg> },
    { id: "files", label: "Files",
      icon: <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3H6l1.5 1.5h5A1.5 1.5 0 0 1 14 6v5.5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5v-7Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/></svg> },
  ];

  return (
    <div className="flex flex-col h-[calc(100vh-56px)] -mx-6 -mt-14 pt-14">
      <div className="flex items-center gap-2.5 px-4 py-3 border-b border-subtle">
        <span className="w-[26px] h-[26px] rounded-[7px] bg-surface-2 text-accent flex items-center justify-center shrink-0">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><rect x="2.5" y="2.5" width="11" height="11" rx="2.4" stroke="currentColor" strokeWidth="1.3"/><path d="M5.5 8l1.6 1.6L10.5 6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </span>
        <span className="text-[16px] font-semibold text-ink">{app.name}</span>
        <Badge tone={running ? "ok" : st === "error" ? "bad" : "neutral"}>{app.status}</Badge>
        {running && health === "healthy" && (
          <Badge tone="ok"><svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" className="inline-block -mt-px mr-0.5"><path d="M8 14s-5.5-3.5-5.5-7.2A3 3 0 018 5.2 3 3 0 0113.5 6.8C13.5 10.5 8 14 8 14z"/></svg>healthy</Badge>
        )}
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
              {/* Lifecycle actions: Stop is the more prominent neutral (border-strong),
                  Restart the lighter subtle border — per mockup 05, neither is red. */}
              <Button variant="secondary" loading={busy === "stop"} icon={<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><rect x="2.5" y="2.5" width="7" height="7" rx="1.2"/></svg>} onClick={() => runLifecycle("stop", () => stopApp(app.id))}>Stop</Button>
              <Button variant="ghost" className="border border-subtle" loading={busy === "restart"} icon={<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6a4 4 0 0 1 6.9-2.8M9 1.2v2.4H6.6M10 6a4 4 0 0 1-6.9 2.8M3 10.8V8.4h2.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>} onClick={() => runLifecycle("restart", () => restartApp(app.id))}>Restart</Button>
            </>
          ) : (
            <Button variant="accent" loading={busy === "start"} icon={<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><path d="M3 2.2l6 3.8-6 3.8z"/></svg>} onClick={() => runLifecycle("start", () => startApp(app.id))}>Start</Button>
          )}
          {/* Thin divider separates lifecycle actions from the Open action (mockup 05). */}
          <span className="w-px h-5 self-center bg-[var(--border-subtle)] mx-0.5" aria-hidden />
          {/* Open split-button (mockup 05): the accent-tinted label opens the local
              URL directly; the chevron segment reveals the link-aware dropdown. */}
          <Popover
            open={openMenu}
            onClose={() => setOpenMenu(false)}
            align="right"
            width="w-[320px]"
            anchor={
              <span className="inline-flex items-stretch rounded-control overflow-hidden border border-[rgba(96,165,250,0.30)] self-center">
                <button
                  onClick={() => window.open(localUrl, "_blank")}
                  title={`Open ${localUrl}`}
                  className="text-[12px] font-medium text-accent-ink bg-accent-bg px-2.5 py-[5px] inline-flex items-center gap-1.5 hover:bg-[rgba(96,165,250,0.24)] transition-colors duration-fast"
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M6 3H4a1.5 1.5 0 0 0-1.5 1.5v7A1.5 1.5 0 0 0 4 13h7a1.5 1.5 0 0 0 1.5-1.5v-2M9 3h4v4M13 3L7 9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  Open
                </button>
                <button
                  onClick={() => setOpenMenu((v) => !v)}
                  title="Open in browser"
                  aria-label="Open in browser options"
                  aria-haspopup="menu"
                  aria-expanded={openMenu}
                  className="text-accent-ink bg-accent-bg px-[7px] border-l border-[rgba(96,165,250,0.30)] inline-flex items-center hover:bg-[rgba(96,165,250,0.24)] transition-colors duration-fast"
                >
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
                </button>
              </span>
            }
          >
            <div className="text-[10px] uppercase tracking-[0.04em] text-ink-3 px-2 py-1">Open in browser</div>

            {/* Local URL — always present; the app's default .test host or localhost. */}
            <div className="flex items-center gap-2.5 px-2 py-[7px] rounded-control bg-surface-1">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="text-ink-2 shrink-0"><path d="M2.5 7L8 2.5 13.5 7M4 6v6.5h8V6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
              <span className="min-w-0">
                <span className="block text-[13px] text-ink">
                  Local
                  <span className="text-[10px] text-ink-3 border border-subtle rounded-[4px] px-1 ml-1.5">default</span>
                </span>
                <span className="block text-[11px] text-ink-2 font-mono truncate">{localHost}</span>
              </span>
              <span className="ml-auto flex gap-2 text-ink-3 shrink-0">
                <button onClick={() => navigator.clipboard.writeText(localUrl)} title="Copy URL" aria-label="Copy local URL" className="hover:text-ink transition-colors">
                  <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3"/><path d="M3.5 10.5A1.5 1.5 0 0 1 2.5 9V4A1.5 1.5 0 0 1 4 2.5h5a1.5 1.5 0 0 1 1.5 1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
                </button>
                <button onClick={() => window.open(localUrl, "_blank")} title="Open URL" aria-label="Open local URL" className="hover:text-ink transition-colors">
                  <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M6 3H4a1.5 1.5 0 0 0-1.5 1.5v7A1.5 1.5 0 0 0 4 13h7a1.5 1.5 0 0 0 1.5-1.5v-2M9 3h4v4M13 3L7 9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
                </button>
              </span>
            </div>

            {/* Tunnel — only when a live Cloudflare tunnel URL exists. */}
            {app.tunnel_active && app.tunnel_url && (
              <div className="flex items-center gap-2.5 px-2 py-[7px] rounded-control">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="text-ok shrink-0"><circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.3"/><path d="M2 8h12M8 2c1.6 1.6 2.5 3.7 2.5 6S9.6 12.4 8 14c-1.6-1.6-2.5-3.7-2.5-6S6.4 3.6 8 2z" stroke="currentColor" strokeWidth="1.3"/></svg>
                <span className="min-w-0">
                  <span className="block text-[13px] text-ink">
                    Tunnel <span className="text-[10px] text-ok">● live</span>
                  </span>
                  <span className="block text-[11px] text-ink-2 font-mono truncate">{app.tunnel_url.replace(/^https?:\/\//, "")}</span>
                </span>
                <span className="ml-auto flex gap-2 text-ink-3 shrink-0">
                  <button onClick={() => navigator.clipboard.writeText(app.tunnel_url!)} title="Copy URL" aria-label="Copy tunnel URL" className="hover:text-ink transition-colors">
                    <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3"/><path d="M3.5 10.5A1.5 1.5 0 0 1 2.5 9V4A1.5 1.5 0 0 1 4 2.5h5a1.5 1.5 0 0 1 1.5 1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
                  </button>
                  <button onClick={() => window.open(app.tunnel_url!, "_blank")} title="Open URL" aria-label="Open tunnel URL" className="hover:text-ink transition-colors">
                    <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M6 3H4a1.5 1.5 0 0 0-1.5 1.5v7A1.5 1.5 0 0 0 4 13h7a1.5 1.5 0 0 0 1.5-1.5v-2M9 3h4v4M13 3L7 9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  </button>
                </span>
              </div>
            )}

            {/* Custom domain — only when the app has one configured. */}
            {app.custom_domain && (
              <div className="flex items-center gap-2.5 px-2 py-[7px] rounded-control">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="text-ink-2 shrink-0"><path d="M8 2l1.7 3.5 3.8.5-2.8 2.7.7 3.8L8 10.8 4.6 12.5l.7-3.8L2.5 6l3.8-.5L8 2z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/></svg>
                <span className="min-w-0">
                  <span className="block text-[13px] text-ink">Custom domain</span>
                  <span className="block text-[11px] text-ink-2 font-mono truncate">{app.custom_domain}</span>
                </span>
                <span className="ml-auto flex gap-2 text-ink-3 shrink-0">
                  <button onClick={() => navigator.clipboard.writeText(`https://${app.custom_domain}`)} title="Copy URL" aria-label="Copy custom domain URL" className="hover:text-ink transition-colors">
                    <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3"/><path d="M3.5 10.5A1.5 1.5 0 0 1 2.5 9V4A1.5 1.5 0 0 1 4 2.5h5a1.5 1.5 0 0 1 1.5 1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
                  </button>
                  <button onClick={() => window.open(`https://${app.custom_domain}`, "_blank")} title="Open URL" aria-label="Open custom domain URL" className="hover:text-ink transition-colors">
                    <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M6 3H4a1.5 1.5 0 0 0-1.5 1.5v7A1.5 1.5 0 0 0 4 13h7a1.5 1.5 0 0 0 1.5-1.5v-2M9 3h4v4M13 3L7 9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  </button>
                </span>
              </div>
            )}

            <div className="h-px bg-[var(--border-subtle)] mx-1.5 my-1" aria-hidden />
            <button
              onClick={() => { setOpenMenu(false); openConfig("domain"); }}
              className="w-full flex items-center gap-2 px-2 py-1.5 text-[12px] text-ink-2 rounded-control hover:bg-white/[0.03] hover:text-ink transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
              Manage domains &amp; tunnel
            </button>
          </Popover>
          <Button variant="ghost" onClick={() => openConfig()} title="App settings" aria-label="More">
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
              <div className="text-[10px] uppercase tracking-[0.09em] text-ink-3 mb-2 px-0.5">Live metrics</div>
              <LiveMetrics appId={app.id} running={running} />
              <div className="mt-2 flex gap-2">
                {secondary.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => setOverlay(s.id)}
                    className="group inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-control border border-subtle bg-surface-1 text-[12px] text-ink-3 hover:text-ink hover:border-strong hover:bg-white/[0.03] transition-colors duration-fast"
                  >
                    <span className="group-hover:text-accent transition-colors duration-fast">{s.icon}</span>
                    {s.label}
                  </button>
                ))}
              </div>
            </section>

            {/* Instances (mockup 26) — the primary checkout plus each git-worktree
                branch instance, each with its own port/URL. The "＋ New from branch"
                affordance opens the InstancesModal (run-on-branch picker) and stays
                visible even at zero instances so it's discoverable. */}
            <section>
              <div className="flex items-center gap-2 mb-2 px-0.5">
                <span className="text-accent inline-flex items-center" aria-hidden>
                  <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><circle cx="4" cy="4" r="1.6" stroke="currentColor" strokeWidth="1.3"/><circle cx="4" cy="12" r="1.6" stroke="currentColor" strokeWidth="1.3"/><circle cx="12" cy="8" r="1.6" stroke="currentColor" strokeWidth="1.3"/><path d="M4 5.6v4.8M5.6 4h1.2c1.5 0 2.4.9 2.4 2.4v.4M5.6 12h1.2c1.5 0 2.4-.9 2.4-2.4v-.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
                </span>
                <span className="text-[13px] font-medium text-ink">Instances</span>
                <span className="text-[11px] text-ink-3">· {runningCount} running</span>
                <button
                  onClick={() => setInstancesOpen(true)}
                  className="ml-auto text-[11px] text-accent-ink inline-flex items-center gap-1 hover:brightness-110 transition-[filter]"
                >
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
                  New from branch
                </button>
              </div>

              <div className="space-y-1.5">
                {/* Primary/main checkout row. */}
                <div className="flex items-center gap-2.5 border border-subtle rounded-[9px] px-3 py-2">
                  <span className={`w-[7px] h-[7px] rounded-full shrink-0 ${running ? "bg-ok" : "bg-ink-3"}`} aria-hidden />
                  <span className="text-[13px] text-ink">{branch || "main"}</span>
                  <span className="text-[11px] text-ink-3 font-mono truncate">
                    :{app.port} · {primaryHost}
                  </span>
                  <span className="ml-auto text-[11px] text-ink-2 shrink-0">primary</span>
                </div>

                {/* One row per worktree instance. */}
                {instances.map((inst) => {
                  const isRunning = inst.status === "running";
                  const instUrl = inst.tunnel_active && inst.tunnel_url
                    ? inst.tunnel_url
                    : `https://${inst.subdomain}.test`;
                  return (
                    <div key={inst.id} className="flex items-center gap-2.5 border border-subtle rounded-[9px] px-3 py-2">
                      <span className={`w-[7px] h-[7px] rounded-full shrink-0 ${isRunning ? "bg-ok" : "bg-ink-3"}`} aria-hidden />
                      <span className="text-[13px] text-ink inline-flex items-center gap-1.5 min-w-0">
                        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" className="text-ink-3 shrink-0"><circle cx="4.5" cy="3.5" r="1.6" stroke="currentColor" strokeWidth="1.3"/><circle cx="4.5" cy="12.5" r="1.6" stroke="currentColor" strokeWidth="1.3"/><circle cx="11.5" cy="4.5" r="1.6" stroke="currentColor" strokeWidth="1.3"/><path d="M4.5 5.1v5.8M11.5 6.1c0 2.5-1.9 3.4-4.2 3.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
                        <span className="truncate">{inst.branch}</span>
                      </span>
                      <span className="text-[11px] text-ink-3 font-mono truncate">
                        :{inst.port} · {isRunning ? `${inst.subdomain}.test` : "stopped"}
                      </span>
                      <span className="ml-auto flex items-center gap-1.5 text-ink-3 shrink-0">
                        {isRunning ? (
                          <>
                            <button onClick={() => window.open(instUrl, "_blank")} title="Open instance" aria-label="Open instance" className="hover:text-accent transition-colors">
                              <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M6 3H4a1.5 1.5 0 0 0-1.5 1.5v7A1.5 1.5 0 0 0 4 13h7a1.5 1.5 0 0 0 1.5-1.5v-2M9 3h4v4M13 3L7 9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
                            </button>
                            <button onClick={() => void stopInstanceAction(inst.id, app.id)} title="Stop instance" aria-label="Stop instance" className="hover:text-ink transition-colors">
                              <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor"><rect x="4" y="4" width="8" height="8" rx="1.3"/></svg>
                            </button>
                          </>
                        ) : (
                          <>
                            <button onClick={() => void runInstance(app.id, inst.worktree_path)} title="Run instance" aria-label="Run instance" className="hover:text-ok transition-colors">
                              <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor"><path d="M5 3.5l7 4.5-7 4.5z"/></svg>
                            </button>
                            <button onClick={() => void removeInstanceAction(inst.id, app.id)} title="Remove instance" aria-label="Remove instance" className="hover:text-bad transition-colors">
                              <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M3 4.5h10M6.5 4.5V3.2A.7.7 0 0 1 7.2 2.5h1.6a.7.7 0 0 1 .7.7v1.3M5 4.5l.5 8a1 1 0 0 0 1 .9h3a1 1 0 0 0 1-.9l.5-8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
                            </button>
                          </>
                        )}
                      </span>
                    </div>
                  );
                })}

                {instances.length === 0 && (
                  <div className="border border-subtle rounded-[9px] px-3 py-2.5 text-[12px] text-ink-3">
                    No branch instances — run one from a branch.
                  </div>
                )}
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
          <PublishTab app={app} onOpenConfig={openConfig} />
        </div>

        {/* Config (mockup 20) — app settings inline, not a full-screen modal.
            Mounted only while active (like the old modal); keyed by section so
            a deep-link re-seeds the sub-nav. */}
        {tab === "config" && (
          <div className="h-full">
            <Suspense fallback={null}>
              <AppSettingsModal
                embedded
                key={configSection ?? "general"}
                app={app}
                workspace={workspaces.find((w) => w.id === app.workspace_id) ?? null}
                initialSection={configSection}
                onClose={() => select("overview")}
              />
            </Suspense>
          </div>
        )}
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

      {instancesOpen && (
        <Suspense fallback={null}>
          <InstancesModal
            app={app}
            workspace={workspaces.find((w) => w.id === app.workspace_id) ?? null}
            instances={instances}
            onClose={() => setInstancesOpen(false)}
          />
        </Suspense>
      )}
    </div>
  );
}
