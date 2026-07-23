import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import type { App } from "../../types";
import { usePortaStore } from "../../store";
import { MAX_PINNED_EXTENSIONS } from "../../store/slices/ui";
import { errorText } from "../../store/slices/notify";
import { isDockerRuntimeUnavailable } from "../../lib/docker-errors";
import { isTauri, openExternalUrl, revealInFinder, getExtensionsForApp, detectAppTags, startInstanceTunnel, stopInstanceTunnel, killPortHolder } from "../../lib/commands";
import { Button, Tabs, StatusDot, Badge, Card, Skeleton, type Status, type TabItem } from "../ui";
import TerminalWorkspace from "../terminal/TerminalWorkspace";
import GitTab from "./GitTab";
import AppAccessPopover, { type LocalDestination } from "./AppAccessPopover";
import GitBadge from "../app/GitBadge";
import LogToast from "../app/LogToast";
import DockerUpdateBadge from "../app/DockerUpdateBadge";
import ExtensionActionButtons from "../extension/ExtensionActionButtons";
import { ExtensionIcon } from "../extension/ExtensionIcon";
import RunOnBranchPicker from "./RunOnBranchPicker";
import AppContextMenu from "../app/AppContextMenu";
import type { ExtensionInfo } from "../../types/extension";

const LogViewer = lazy(() => import("../app/LogViewer"));
const TrafficInspectorModal = lazy(() => import("../app/TrafficInspectorModal"));
const FileEditorModal = lazy(() => import("../app/FileEditorModal"));
const AppSettingsModal = lazy(() => import("../app/AppSettingsModal"));
const AccessSettingsDrawer = lazy(() => import("../app/AccessSettingsDrawer"));
const ExtensionPanel = lazy(() => import("../app/ExtensionPanel"));
// SPIKE — lazy so the 215KB of vendored git-manager JS only loads if the tab is
// actually opened.
const GitManagerTab = lazy(() => import("./GitManagerTab"));
type ConfigSection = import("../app/AppSettingsModal").Section;
type AccessSettingsSection = import("../app/AccessSettingsDrawer").AccessSettingsSection;
type AppInstance = import("../../lib/commands").AppInstance;
const EMPTY_INSTANCES: AppInstance[] = [];

// Stable empty ref so the store selector never returns a fresh array (which
// would make useShallow see a change every render → infinite update loop).
const EMPTY: string[] = [];

// `App["status"]` only ever holds stopped/running/starting — a crash is carried
// out-of-band by `appExitCode` (non-zero), exactly like the grid card derives
// it. So the caller passes that flag in; mapping a "crashed" status string here
// would never fire.
function toStatus(s: string, crashed = false): Status {
  if (crashed) return "error";
  if (s === "running") return "running";
  if (s === "starting") return "connecting";
  return "stopped";
}

const I = { width: 13, height: 13, viewBox: "0 0 16 16", fill: "none" } as const;
const TABS: TabItem[] = [
  { id: "overview", label: "Overview", icon: <svg {...I}><rect x="2" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3"/><rect x="9" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3"/><rect x="2" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3"/><rect x="9" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3"/></svg> },
  { id: "logs", label: "Logs", icon: <svg {...I}><path d="M3 3.5h10M3 6.5h10M3 9.5h7M3 12.5h5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg> },
  { id: "git", label: "Git", icon: <svg {...I}><circle cx="4.5" cy="3.5" r="1.6" stroke="currentColor" strokeWidth="1.3"/><circle cx="4.5" cy="12.5" r="1.6" stroke="currentColor" strokeWidth="1.3"/><circle cx="11.5" cy="4.5" r="1.6" stroke="currentColor" strokeWidth="1.3"/><path d="M4.5 5.1v5.8M11.5 6.1c0 2.5-1.9 3.4-4.2 3.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg> },
  // SPIKE — the vendored git-manager UI, sitting next to the native tab so the
  // two can be judged side by side on the same repo. One of them goes away.
  { id: "git2", label: "Git 2", icon: <svg {...I}><circle cx="4.5" cy="3.5" r="1.6" stroke="currentColor" strokeWidth="1.3"/><circle cx="4.5" cy="12.5" r="1.6" stroke="currentColor" strokeWidth="1.3"/><circle cx="11.5" cy="4.5" r="1.6" stroke="currentColor" strokeWidth="1.3"/><path d="M4.5 5.1v5.8M11.5 6.1c0 2.5-1.9 3.4-4.2 3.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg> },
  { id: "terminal", label: "Terminal", icon: <svg {...I}><rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.3"/><path d="M5 6.5L7 8l-2 1.5M8.5 9.5H11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg> },
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

/**
 * Copy-to-clipboard affordance with a brief confirmation. The Overview's URL
 * and domain rows only opened their target — copying meant selecting the text
 * by hand, which the truncated/`user-select: none` chrome makes awkward.
 */
function CopyButton({ value, label, className = "" }: { value: string; label: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => setCopied(true)).catch(() => {});
      }}
      title={copied ? "Copied" : `Copy ${value}`}
      aria-label={`Copy ${label}`}
      className={`shrink-0 rounded p-0.5 transition-colors ${copied ? "text-ok" : "text-ink-3 hover:text-ink"} ${className}`}
    >
      {copied ? (
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M2 6.2l2.6 2.6L10 3.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
      ) : (
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none"><rect x="4" y="4" width="6.5" height="6.5" rx="1.3" stroke="currentColor" strokeWidth="1.1"/><path d="M8 3.4V2.8A1.3 1.3 0 0 0 6.7 1.5H2.8A1.3 1.3 0 0 0 1.5 2.8v3.9A1.3 1.3 0 0 0 2.8 8h.6" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/></svg>
      )}
    </button>
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
      {/* Fixed 2 decimals — the raw value jitters between 1 and 4 characters,
          which resized the tile on every 2s sample. */}
      <MetricTile
        label="CPU"
        value={<>{sample.cpu.toFixed(2)}<span className="text-[11px] text-ink-3 ml-0.5">%</span></>}
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
  // Instance mode: when set, this workbench renders a running worktree instance
  // (a synthetic app built via deriveInstanceApp). Lifecycle / tunnel / remove
  // route to the instance actions, the Config + Publish tabs and the Instances
  // section are hidden (an instance inherits parent config and can't nest), and
  // the header shows a breadcrumb back to the parent.
  instance?: AppInstance;
  parentApp?: App;
  onExitInstance?: () => void;
}

export default function AppWorkbench({ app, instance, parentApp, onExitInstance }: Props) {
  const isInstance = !!instance;
  const [tab, setTab] = useState("overview");
  const [logsSeen, setLogsSeen] = useState(false);
  const [termSeen, setTermSeen] = useState(false);
  const [git2Seen, setGit2Seen] = useState(false);
  // Config tab (mockup 20) — the app settings surface, rendered inline instead
  // of a full-screen modal. `configSection` deep-links the sub-nav (e.g. from
  // the Publish tab → Tunneling). Remounted per section so the initial deep
  // link takes effect.
  const [configSection, setConfigSection] = useState<ConfigSection | undefined>(undefined);
  const [accessSettingsSection, setAccessSettingsSection] = useState<AccessSettingsSection | null>(null);
  const workspaces = usePortaStore((s) => s.workspaces);
  // Traffic + Files reuse their existing full-screen surfaces, opened as an
  // overlay from the Overview quick actions (they aren't inline tabs yet).
  const [overlay, setOverlay] = useState<null | "traffic" | "files">(null);
  // In-flight lifecycle action — drives the Start/Stop/Restart Button spinners
  // while the start/stop/restart round-trip is pending.
  const [busy, setBusy] = useState<null | "start" | "stop" | "restart">(null);
  // start/restart IPC resolves after spawn, while readiness arrives later via
  // app:ready/instance:ready. Preserve which action is awaiting that event so
  // the button cannot look finished during the gap.
  const [waitingForReady, setWaitingForReady] = useState<null | "start" | "restart">(null);
  // Worktree instances (mockup 26) — the Overview "Instances" section lists the
  // primary checkout + each branch instance. "＋ New from branch" reveals the
  // inline RunOnBranchPicker; selecting an instance is stored globally so the
  // sidebar and workbench stay in sync.
  const [pickerOpen, setPickerOpen] = useState(false);
  // Instance-mode tunnel toggle (start/stop the worktree instance's tunnel).
  const [tunnelBusy, setTunnelBusy] = useState(false);
  // Header ⋯ menu, anchored to the button's own rect. Carries the destructive
  // actions the grid card has always had and the workbench was missing:
  // force-kill a process Stop can't reach, and free a port a dead run left held.
  const [headerMenu, setHeaderMenu] = useState<{ x: number; y: number } | null>(null);

  const {
    startApp, stopApp, restartApp, clearAppLogs, logs, exitCode, health, branch, restarting, setupStatus,
    instances, refreshInstances, runInstance, stopInstanceAction, removeInstanceAction,
    openExtensionSidebar, closeExtensionSidebar, cacheAppExtensions, extSidebarActive,
    pinnedExtensions, togglePinnedExtension, notifyError,
    clearTunnelLog, selectInstance, killApp, killInstanceAction, notify, workbenchTab, clearWorkbenchTab,
  } = usePortaStore(
    useShallow((s) => ({
      startApp: s.startApp,
      stopApp: s.stopApp,
      restartApp: s.restartApp,
      clearAppLogs: s.clearAppLogs,
      logs: s.appLogs[app.id] ?? EMPTY,
      exitCode: s.appExitCode[app.id] ?? null,
      health: s.healthStatuses[app.id],
      branch: s.appGit[app.id]?.branch,
      restarting: s.appRestarting[app.id] ?? false,
      setupStatus: s.setupStatus,
      instances: s.instances[app.id] ?? EMPTY_INSTANCES,
      refreshInstances: s.refreshInstances,
      runInstance: s.runInstance,
      stopInstanceAction: s.stopInstanceAction,
      removeInstanceAction: s.removeInstanceAction,
      openExtensionSidebar: s.openExtensionSidebar,
      closeExtensionSidebar: s.closeExtensionSidebar,
      cacheAppExtensions: s.cacheAppExtensions,
      pinnedExtensions: s.pinnedExtensions,
      togglePinnedExtension: s.togglePinnedExtension,
      notifyError: s.notifyError,
      extSidebarActive: s.extensionSidebar?.appId === app.id,
      clearTunnelLog: s.clearTunnelLog,
      selectInstance: s.selectInstance,
      killApp: s.killApp,
      killInstanceAction: s.killInstanceAction,
      notify: s.notify,
      workbenchTab: s.workbenchTab,
      clearWorkbenchTab: s.clearWorkbenchTab,
    }))
  );
  // Only the parent workbench tracks instances — an instance can't nest.
  useEffect(() => { if (!isInstance) void refreshInstances(app.id); }, [app.id, refreshInstances, isInstance]);

  // Extensions matching this app (mockup: the workbench is the app's home, so
  // the card's extension affordances must live here too — otherwise opening an
  // app hides the grid card and there's no way to reach its extensions).
  const [appExtensions, setAppExtensions] = useState<ExtensionInfo[]>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const tags = app.root_dir ? await detectAppTags(app.root_dir).catch(() => [] as string[]) : [];
      const exts = await getExtensionsForApp(app.kind, tags).catch(() => [] as ExtensionInfo[]);
      if (cancelled) return;
      setAppExtensions(exts);
      cacheAppExtensions(app.id, exts); // expose to the command palette
    })();
    return () => { cancelled = true; };
  }, [app.id, app.kind, app.root_dir, cacheAppExtensions]);

  const running = app.status === "running";
  // Apps Caddy serves directly (static/proxy) have no Porta-managed process,
  // so neither force-kill nor a port holder means anything for them.
  const isManaged = app.kind !== "static" && app.kind !== "proxy";
  // "starting" persists (optimistic) until the backend fires app:ready seconds
  // later; `restarting` is the store flag cleared on the same event. Both keep
  // the lifecycle button in its loading state through the real async phase —
  // otherwise the local `busy` flag clears the instant the IPC returns (before
  // the process is actually up) and the button flickers back to plain "Start".
  const isStarting = app.status === "starting";
  // Process is alive (running or booting) — drives the log toast's open/close
  // transitions, same signal the grid card uses.
  const isActive = running || isStarting;
  // A non-zero exit code is the only crash signal the backend emits; without
  // reading it the workbench showed a plain grey "stopped" for a failed start.
  const crashed = exitCode !== null && exitCode !== 0;
  const st = toStatus(app.status, crashed);
  // Every host Caddy serves this app under — the primary subdomain plus
  // any extra_subdomains, resolved against the app's custom domain or the
  // workspace domain (mirrors the card's allHosts in main).
  const routeOwner = isInstance && parentApp ? parentApp : app;
  const workspace = workspaces.find((w) => w.id === routeOwner.workspace_id) ?? null;
  const hostDomain = routeOwner.custom_domain || workspace?.domain || "narakarya.test";
  const primaryDomainHost = (() => {
    const sub = app.subdomain ?? app.name;
    return sub === "*" ? `*.${hostDomain}` : `${sub}.${hostDomain}`;
  })();
  // A worktree instance owns one generated host. Keep this guard at the
  // presentation boundary too, so a stale synthetic App can never show parent
  // aliases as domains belonging to the child.
  const scheme = setupStatus?.certs_generated ? "https" : "http";
  const localDestinations: LocalDestination[] = (() => {
    const rows: LocalDestination[] = [
      {
        host: primaryDomainHost,
        url: `${scheme}://${primaryDomainHost}`,
        kind: "default",
      },
    ];
    if (!isInstance) {
      rows.push(
        ...(app.extra_subdomains ?? [])
          .map((subdomain) => subdomain.trim())
          .filter(Boolean)
          .map((subdomain) => {
            const host = `${subdomain}.${hostDomain}`;
            return { host, url: `${scheme}://${host}`, kind: "alias" as const };
          }),
        ...(app.port_bindings ?? []).map((binding) => {
          const subdomain =
            binding.subdomain?.trim() ||
            binding.label.trim().toLowerCase().replace(/\s+/g, "-");
          const domain = binding.custom_domain?.trim() || hostDomain;
          const host = `${subdomain}.${domain}`;
          return { host, url: `${scheme}://${host}`, kind: "binding" as const };
        }),
      );
    }
    const seen = new Set<string>();
    return rows.filter(({ host }) => {
      if (seen.has(host)) return false;
      seen.add(host);
      return true;
    });
  })();
  const allHosts = localDestinations.map(({ host }) => host);
  // Instances section (mockup 26): the primary checkout counts as running when
  // the app itself is up; branch instances count their own "running" status.
  const runningCount = (running ? 1 : 0) + instances.filter((i) => i.status === "running").length;
  // Host shown on the primary row and opened by the main Open segment.
  const primaryHost = primaryDomainHost;
  const localUrl = localDestinations[0].url;
  const url = app.tunnel_active && app.tunnel_url ? app.tunnel_url : localUrl;
  // Public host Caddy exposes this app under — shown as a link in the header.
  const domainHost =
    app.tunnel_active && app.tunnel_url ? app.tunnel_url.replace(/^https?:\/\//, "")
    : primaryDomainHost;
  const domainUrl = app.tunnel_active && app.tunnel_url ? app.tunnel_url : localUrl;

  useEffect(() => {
    if (waitingForReady && app.status !== "starting") {
      setWaitingForReady(null);
    }
  }, [app.status, waitingForReady]);

  // ── Log toast (restored from the grid card) ──────────────────────────────
  // Opening an app hides the whole WorkspaceView subtree (App.tsx wraps it in
  // `hidden`), which took the card's LogToast — and therefore every start /
  // crash log preview — with it. The workbench owns its own copy so starting
  // from here surfaces the same output.
  const [logToastOpen, setLogToastOpen] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const prevActive = useRef(isActive);
  const prevCrashed = useRef(crashed);

  // The Logs tab already streams this output full-height; a toast on top of it
  // is pure noise, so suppress it while the user is looking at the logger.
  const inLogger = tab === "logs";

  useEffect(() => {
    if (isActive !== prevActive.current) {
      if (!inLogger) setLogToastOpen(true);
      if (isActive) setBannerDismissed(false);
    }
    prevActive.current = isActive;
  }, [isActive, inLogger]);

  useEffect(() => {
    if (crashed && !prevCrashed.current) {
      setBannerDismissed(false);
      if (!inLogger) setLogToastOpen(true);
    }
    prevCrashed.current = crashed;
  }, [crashed, inLogger]);

  // Switching to the logger supersedes the preview.
  useEffect(() => { if (inLogger) setLogToastOpen(false); }, [inLogger]);

  // Switching apps/instances reuses this component — don't carry the previous
  // app's toast or crash banner over.
  useEffect(() => {
    setLogToastOpen(false);
    setBannerDismissed(false);
  }, [app.id]);

  // Unpinning the extension whose tab is open (or switching to an app it
  // doesn't activate for) would leave `tab` pointing at a tab that no longer
  // exists — blank content with nothing selected in the strip.
  const pinnedTabIds = pinnedExtensions.map((id) => `ext:${id}`).join(",");
  useEffect(() => {
    if (!tab.startsWith("ext:")) return;
    const stillThere = appExtensions.some(
      (e) => `ext:${e.id}` === tab && pinnedExtensions.includes(e.id)
    );
    if (!stillThere) setTab("overview");
  }, [tab, appExtensions, pinnedTabIds, pinnedExtensions]);

  // Run a lifecycle action with a local in-flight flag so its Button shows a
  // spinner + disables until the round-trip settles.
  async function runLifecycle(kind: "start" | "stop" | "restart", fn: () => Promise<void>) {
    setBusy(kind);
    try {
      await fn();
      if (kind !== "stop") {
        const snapshot = usePortaStore.getState();
        const status = isInstance && instance
          ? snapshot.instances[instance.app_id]?.find((i) => i.id === instance.id)?.status
          : snapshot.apps.find((a) => a.id === app.id)?.status;
        if (status === "starting") setWaitingForReady(kind);
      }
    } catch (error) {
      // This used to rethrow into an unhandled rejection — no call site catches
      // it, so a failed start/stop/restart from the workbench was completely
      // silent. Docker-runtime-down is the one case the user can't act on from
      // here, and `app:start-failed` already reports it.
      setWaitingForReady(null);
      if (!isDockerRuntimeUnavailable(errorText(error))) {
        notifyError(`Failed to ${kind} ${isInstance ? instance!.branch : app.name}`, error);
      }
    } finally {
      setBusy(null);
    }
  }

  // Lifecycle wiring — in instance mode these route to the instance actions
  // (start = run the worktree, restart = stop then run) instead of the app ones,
  // so the shared header buttons drive the right backend for either surface.
  const startFn = isInstance
    ? () => runInstance(parentApp!.id, instance!.worktree_path)
    : () => startApp(app.id);
  const stopFn = isInstance
    ? () => stopInstanceAction(instance!.id, parentApp!.id)
    : () => stopApp(app.id);
  const restartFn = isInstance
    ? async () => {
        await stopInstanceAction(instance!.id, parentApp!.id);
        await runInstance(parentApp!.id, instance!.worktree_path);
      }
    : () => restartApp(app.id);
  // `stopApp` flips the store to "stopped" optimistically (compose down blocks
  // 5-30s), which used to unmount the very Stop button the user had just
  // clicked: the header fell back to the stopped branch, the spinner vanished
  // and the app looked idle while the IPC was still running — and a Start click
  // in that window silently queued behind the per-app lifecycle lock. Keep the
  // in-flight branch mounted until the round-trip actually settles.
  const stopping = busy === "stop";

  // SIGKILL, for a process Stop can't bring down (a hung compose teardown, a
  // shell that ignores SIGTERM). Confirmed first — it skips every clean-exit
  // path the app might still be running.
  const forceKillFn = isInstance
    ? () => killInstanceAction(instance!.id, parentApp!.id)
    : () => killApp(app.id);

  async function confirmForceKill() {
    const { confirm } = await import("@tauri-apps/plugin-dialog");
    const ok = await confirm(
      `Force kill ${isInstance ? instance!.branch : app.name}? The process is SIGKILLed, so it gets no chance to shut down cleanly.`,
      { title: "Force kill", kind: "warning", okLabel: "Force kill" },
    );
    if (!ok) return;
    try {
      await forceKillFn();
      notify({ kind: "success", message: `Force killed ${isInstance ? instance!.branch : app.name}` });
    } catch (e) {
      notifyError("Force kill failed", e);
    }
  }

  // A crashed run can leave its port bound by an orphan the app no longer
  // tracks, and Start then fails with "address already in use" forever.
  async function freePort() {
    try {
      const pid = await killPortHolder(app.port);
      notify({ kind: "success", message: `Killed pid ${pid} — port :${app.port} is free` });
    } catch (e) {
      notifyError(`Nothing killed on :${app.port}`, e);
    }
  }

  // Instance restart has no store `appRestarting` flag; the local `busy` covers it.
  const startLoading = !stopping && (busy === "start" || waitingForReady === "start" || (isStarting && !restarting && waitingForReady !== "restart"));
  const restartLoading = busy === "restart" || waitingForReady === "restart" || (!isInstance && restarting);

  async function toggleInstanceTunnel() {
    if (!instance) return;
    setTunnelBusy(true);
    try {
      if (app.tunnel_active) await stopInstanceTunnel(instance.id);
      else {
        clearTunnelLog(instance.id);
        await startInstanceTunnel(instance.id);
      }
    } finally {
      setTunnelBusy(false);
    }
  }

  function select(id: string) {
    setTab(id);
    if (id === "logs") setLogsSeen(true);
    if (id === "terminal") setTermSeen(true);
    if (id === "git2") setGit2Seen(true);
  }

  // Deep link from outside the workbench ("Open in Terminal" in the sidebar or
  // a card's context menu). Keyed on the *parent* app id so it still lands when
  // the request also selected one of this app's worktree instances.
  const ownerAppId = parentApp?.id ?? app.id;
  useEffect(() => {
    if (!workbenchTab || workbenchTab.appId !== ownerAppId) return;
    select(workbenchTab.tab);
    clearWorkbenchTab();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workbenchTab, ownerAppId, clearWorkbenchTab]);

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

  // Pinned extensions become tabs right after Config. Driven off the global pin
  // order and intersected with this app's matching extensions, so a pin only
  // materialises where the extension actually activates.
  const pinnedExts = pinnedExtensions
    .map((id) => appExtensions.find((e) => e.id === id))
    .filter((e): e is ExtensionInfo => !!e);

  // Instance mode hides Config because a branch instance inherits its parent.
  const visibleTabs: TabItem[] = [
    ...(isInstance ? TABS.filter((t) => t.id !== "config") : TABS),
    ...pinnedExts.map((e) => ({
      id: `ext:${e.id}`,
      label: e.name,
      icon: <ExtensionIcon extension={e} size="sm" />,
    })),
  ];

  return (
    <div className="flex flex-col h-screen -mx-6 -mt-6 -mb-6">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-subtle">
        <span className="w-[26px] h-[26px] rounded-[7px] bg-surface-2 text-accent flex items-center justify-center shrink-0">
          {isInstance ? (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="4.5" cy="3.5" r="1.6" stroke="currentColor" strokeWidth="1.3"/><circle cx="4.5" cy="12.5" r="1.6" stroke="currentColor" strokeWidth="1.3"/><circle cx="11.5" cy="4.5" r="1.6" stroke="currentColor" strokeWidth="1.3"/><path d="M4.5 5.1v5.8M11.5 6.1c0 2.5-1.9 3.4-4.2 3.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
          ) : (
            // Neutral app-window mark. Status is already communicated by the
            // badge below, so a checkmark here was redundant and misleading.
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
              <rect x="2.5" y="2.5" width="11" height="11" rx="2.4" stroke="currentColor" strokeWidth="1.3"/>
              <path d="M3 5.5h10M5 8.5h3.5M5 11h5.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
              <circle cx="4.6" cy="4.1" r=".55" fill="currentColor"/>
            </svg>
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            {isInstance && (
              // Compact breadcrumb: parent context stays available without
              // competing with the (often long) branch name.
              <button
                onClick={onExitInstance}
                title={`Back to ${parentApp?.name ?? "app"}`}
                className="inline-flex items-center gap-1 text-[11px] text-ink-3 hover:text-ink shrink-0 transition-colors"
              >
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M10 3.5L5.5 8l4.5 4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
                <span className="truncate max-w-[8rem]">{parentApp?.name}</span>
                <span aria-hidden>/</span>
              </button>
            )}
            <h1
              className="min-w-0 truncate text-[15px] font-semibold leading-5 text-ink"
              title={isInstance ? instance!.branch : app.name}
            >
              {isInstance ? instance!.branch : app.name}
            </h1>
          </div>
          <div className="mt-1 flex items-center gap-2 min-w-0 text-[11px] text-ink-3">
            <Badge tone={running ? "ok" : crashed ? "bad" : "neutral"}>
              {crashed ? `crashed (${exitCode})` : app.status}
            </Badge>
            {running && health === "healthy" && (
              <Badge tone="ok"><svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" className="inline-block -mt-px mr-0.5"><path d="M8 14s-5.5-3.5-5.5-7.2A3 3 0 018 5.2 3 3 0 0113.5 6.8C13.5 10.5 8 14 8 14z"/></svg>healthy</Badge>
            )}
            {running && health === "unhealthy" && <Badge tone="bad">unhealthy</Badge>}
            {domainHost && (
              <button
                onClick={() => openExternalUrl(domainUrl)}
                disabled={!running}
                title={running ? `Open ${domainUrl}` : "App is not running"}
                className="min-w-0 truncate text-ink-3 hover:text-accent-ink font-mono inline-flex items-center gap-1 transition-colors disabled:pointer-events-none disabled:opacity-60"
              >
                <span className="truncate">{domainHost}</span>
                <svg width="9" height="9" viewBox="0 0 12 12" fill="none" className="shrink-0"><path d="M4.5 2.5h5v5M9.5 2.5L5 7M8 8v2.5H2.5V5H5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </button>
            )}
            <span className="text-ink-3/60" aria-hidden>·</span>
            <span className="font-mono shrink-0">:{app.port}</span>
            {/* The instance title already is its branch. Keeping GitBadge here
                duplicated the same long label and made the header unreadable. */}
            {!isInstance && <GitBadge app={app} onOpenTerminal={() => select("terminal")} />}
          </div>
        </div>
        <div className="flex gap-2 shrink-0">
          {/* One button per lifecycle action, never swapped for a separate
              "Starting…" / "Restarting…" pill: the control the user just
              clicked stays in place and turns into its own spinner. Previously
              the loading branch rendered a different button set in a different
              order, so Restart jumped slots mid-click. Stop is appended (never
              prepended) while starting, so the Start button keeps its slot. */}
          {running || restartLoading || stopping ? (
            <>
              {/* Lifecycle actions: Stop is the more prominent neutral (border-strong),
                  Restart the lighter subtle border — per mockup 05, neither is red. */}
              <Button variant="secondary" loading={stopping} disabled={stopping} icon={<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><rect x="2.5" y="2.5" width="7" height="7" rx="1.2"/></svg>} onClick={() => runLifecycle("stop", stopFn)}>{stopping ? "Stopping" : "Stop"}</Button>
              <Button variant="ghost" className="border border-subtle" loading={restartLoading} disabled={restartLoading || stopping} icon={<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6a4 4 0 0 1 6.9-2.8M9 1.2v2.4H6.6M10 6a4 4 0 0 1-6.9 2.8M3 10.8V8.4h2.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>} onClick={() => runLifecycle("restart", restartFn)}>{restartLoading ? "Restarting" : "Restart"}</Button>
            </>
          ) : (
            <>
              <Button
                variant="accent"
                loading={startLoading}
                icon={<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><path d="M3 2.2l6 3.8-6 3.8z"/></svg>}
                onClick={() => runLifecycle("start", startFn)}
              >
                {startLoading ? "Starting" : crashed ? "Restart" : "Start"}
              </Button>
              {/* Abort a boot that's hanging — only meaningful while starting. */}
              {startLoading && (
                <Button
                  variant="secondary"
                  loading={stopping}
                  disabled={stopping}
                  icon={<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><rect x="2.5" y="2.5" width="7" height="7" rx="1.2"/></svg>}
                  onClick={() => runLifecycle("stop", stopFn)}
                >
                  Stop
                </Button>
              )}
            </>
          )}
          {/* Thin divider separates lifecycle actions from the Open action (mockup 05). */}
          <span className="w-px h-5 self-center bg-[var(--border-subtle)] mx-0.5" aria-hidden />
          <AppAccessPopover
            app={app}
            destinations={localDestinations}
            primaryUrl={localUrl}
            quickOnly={isInstance}
            offline={!running}
            externalBusy={tunnelBusy}
            onToggleExternalTunnel={isInstance ? toggleInstanceTunnel : undefined}
            onOpenAccessSettings={
              isInstance
                ? undefined
                : (section) => setAccessSettingsSection(section ?? "domain")
            }
          />
          {/* Extensions toggle (restored from the card): opens the global
              extension sidebar for this app. One match → focus it directly. */}
          {appExtensions.length > 0 && (
            <Button
              variant="ghost"
              className={extSidebarActive ? "text-accent" : ""}
              onClick={() => {
                if (extSidebarActive) closeExtensionSidebar();
                else if (appExtensions.length === 1) openExtensionSidebar(app.id, appExtensions, appExtensions[0].id);
                else openExtensionSidebar(app.id, appExtensions);
              }}
              title={extSidebarActive ? "Close extensions" : appExtensions.length === 1 ? `Open ${appExtensions[0].name}` : `${appExtensions.length} extensions`}
              aria-label={`${appExtensions.length} extension${appExtensions.length > 1 ? "s" : ""}`}
            >
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M6.2 2.5a1.2 1.2 0 0 1 2.4 0v.8h1.7c.4 0 .7.3.7.7v1.7h.8a1.2 1.2 0 0 1 0 2.4h-.8v2.4c0 .4-.3.7-.7.7H8.6v-.8a1.2 1.2 0 0 0-2.4 0v.8H4.5a.7.7 0 0 1-.7-.7V8.6h-.8a1.2 1.2 0 0 1 0-2.4h.8V4.5c0-.4.3-.7.7-.7h1.7v-.8z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/></svg>
              {appExtensions.length > 1 && <span className="text-[10px] font-medium ml-0.5">{appExtensions.length}</span>}
            </Button>
          )}
          {isInstance ? (
            <>
              {/* Remove this instance (deletes its worktree). */}
              <Button
                variant="ghost"
                onClick={() => { void removeInstanceAction(instance!.id, parentApp!.id); onExitInstance?.(); }}
                title="Remove instance"
                aria-label="Remove instance"
                className="hover:text-bad"
              >
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M3 4.5h10M6.5 4.5V3.2A.7.7 0 0 1 7.2 2.5h1.6a.7.7 0 0 1 .7.7v1.3M5 4.5l.5 8a1 1 0 0 0 1 .9h3a1 1 0 0 0 1-.9l.5-8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </Button>
            </>
          ) : (
            <Button
              variant="ghost"
              onClick={(e) => {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                setHeaderMenu((open) => (open ? null : { x: r.right, y: r.bottom + 4 }));
              }}
              title="More actions"
              aria-label="More"
            >
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><circle cx="3.5" cy="8" r="1.1" fill="currentColor"/><circle cx="8" cy="8" r="1.1" fill="currentColor"/><circle cx="12.5" cy="8" r="1.1" fill="currentColor"/></svg>
            </Button>
          )}
        </div>
      </div>

      {headerMenu && (
        <AppContextMenu
          x={headerMenu.x}
          y={headerMenu.y}
          onClose={() => setHeaderMenu(null)}
          items={[
            {
              label: "App settings",
              icon: <svg width="11" height="11" viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6" r="1.8" stroke="currentColor" strokeWidth="1.1"/><path d="M6 1v1.4M6 9.6V11M1 6h1.4M9.6 6H11M2.5 2.5l1 1M8.5 8.5l1 1M9.5 2.5l-1 1M3.5 8.5l-1 1" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/></svg>,
              onClick: () => openConfig(),
            },
            ...(app.root_dir
              ? [{
                  label: "Reveal in Finder",
                  icon: <svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M1.5 3.5A1 1 0 0 1 2.5 2.5h1.8L5.5 3.7h4A1 1 0 0 1 10.5 4.7v4.3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1V3.5z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"/></svg>,
                  onClick: () => { void revealInFinder(app.root_dir); },
                }]
              : []),
            ...(isManaged ? ["separator" as const] : []),
            ...(!isManaged
              ? []
              : isActive
              ? [{
                  label: "Force kill",
                  icon: <svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M5.5 1v2M5.5 8v2M1 5.5h2M8 5.5h2M2.5 2.5l1.5 1.5M7 7l1.5 1.5M7 2.5L5.5 4M2.5 8.5L4 7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>,
                  onClick: () => { void confirmForceKill(); },
                  danger: true,
                }]
              : [{
                  label: `Kill port holder (:${app.port})`,
                  icon: <svg width="11" height="11" viewBox="0 0 11 11" fill="none"><circle cx="5.5" cy="5.5" r="4" stroke="currentColor" strokeWidth="1.2"/><path d="M3.5 5.5h4M5.5 3.5v4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>,
                  onClick: () => { void freePort(); },
                  danger: true,
                }]),
          ]}
        />
      )}

      {/* ── Crash banner ── mirrors the grid card: a non-zero exit is the only
           signal the app died, and without it the workbench read as a plain
           "stopped". */}
      {crashed && !bannerDismissed && (
        <div className="mx-4 mt-2 px-2.5 py-1.5 bg-red-500/10 border border-red-500/20 rounded-md flex items-center gap-2">
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none" className="text-red-400 shrink-0">
            <path d="M5.5 1.5l4 7H1.5l4-7z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
            <path d="M5.5 5v1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
            <circle cx="5.5" cy="8" r="0.5" fill="currentColor"/>
          </svg>
          <p className="text-[11px] text-red-400 flex-1">Exited with code {exitCode}</p>
          {!inLogger && (
            <button onClick={() => select("logs")} className="text-[10px] text-red-300 hover:text-red-200 transition-colors">
              view logs
            </button>
          )}
          <button
            onClick={() => setBannerDismissed(true)}
            className="text-[10px] text-red-400/50 hover:text-red-300 transition-colors"
          >
            dismiss
          </button>
        </div>
      )}

      <Tabs tabs={visibleTabs} active={tab} onSelect={select} />

      <div className="flex-1 min-h-0">
        <div hidden={tab !== "overview"} className="h-full overflow-y-auto px-6 py-5">
          <div className="max-w-2xl space-y-6">
            <section>
              <div className="text-[10px] uppercase tracking-[0.09em] text-ink-3 mb-2 px-0.5">Details</div>
              <Card padded={false} className="overflow-hidden">
                <div className="px-4">
                  <div className={row}>
                    <span className={key}>Status</span>
                    <span className="text-ink flex items-center gap-1.5">
                      <StatusDot status={st} />
                      {crashed ? `crashed (exit ${exitCode})` : app.status}
                    </span>
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
                    {/* Reveal in Finder — the path was inert text, so the only
                        way to reach the folder was copying it by hand. */}
                    <button
                      onClick={() => revealInFinder(app.root_dir)}
                      title={`Show ${app.root_dir} in Finder`}
                      // Content is just the path, so without this the button
                      // announces as "/Users/…" and never says what it does.
                      aria-label={`Show ${app.root_dir} in Finder`}
                      className="group min-w-0 inline-flex items-center gap-1.5 text-ink-2 font-mono hover:text-accent-ink transition-colors"
                    >
                      <span className="truncate max-w-[20rem]">{app.root_dir}</span>
                      <svg width="11" height="11" viewBox="0 0 16 16" fill="none" className="shrink-0 text-ink-3 group-hover:text-accent-ink transition-colors">
                        <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3H6l1.5 1.5h5A1.5 1.5 0 0 1 14 6v5.5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5v-7Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
                      </svg>
                    </button>
                  </div>
                  <div className={row}>
                    <span className={key}>URL</span>
                    <span className="min-w-0 inline-flex items-center gap-1.5">
                      <button
                        onClick={() => openExternalUrl(url)}
                        disabled={!running}
                        className="text-accent-ink font-mono truncate max-w-[20rem] hover:underline disabled:pointer-events-none disabled:opacity-60"
                        title={running ? `Open ${url}` : "App is not running"}
                      >
                        {url}
                      </button>
                      <CopyButton value={url} label="URL" />
                    </span>
                  </div>
                  {/* Every Caddy host this app answers on — the primary
                      subdomain plus any extra_subdomains (restored from the card). */}
                  <div className={row}>
                    <span className={`${key} self-start pt-0.5`}>Domains</span>
                    <span className="flex flex-wrap gap-1.5 min-w-0">
                      {/* Chip = open + copy. Two sibling buttons rather than a
                          nested one (invalid HTML) sharing the chip border. */}
                      {allHosts.map((h) => (
                        <span
                          key={h}
                          className="group inline-flex items-center text-[11px] font-mono border border-subtle rounded-[5px] overflow-hidden hover:border-strong transition-colors"
                        >
                          <button
                            onClick={() => openExternalUrl(`${scheme}://${h}`)}
                            disabled={!running}
                            title={running ? `Open ${scheme}://${h}` : "App is not running"}
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 text-ink-2 hover:text-accent-ink transition-colors disabled:pointer-events-none disabled:opacity-60"
                          >
                            {h}
                            <svg width="9" height="9" viewBox="0 0 12 12" fill="none"><path d="M4.5 2.5h5v5M9.5 2.5L5 7M8 8v2.5H2.5V5H5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round"/></svg>
                          </button>
                          <CopyButton
                            value={`${scheme}://${h}`}
                            label={h}
                            className="mr-1 -ml-0.5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
                          />
                        </span>
                      ))}
                    </span>
                  </div>
                </div>
              </Card>
            </section>

            {/* Docker image + update affordance (mockup: image updates live on
                the grid card; once an app is opened the card is hidden, so the
                check/apply badge must live here too — otherwise there's no way
                to reach it from the workbench). Docker/compose apps only. */}
            {!isInstance && (app.kind === "docker" || app.kind === "compose") && (
              <section>
                <div className="text-[10px] uppercase tracking-[0.09em] text-ink-3 mb-2 px-0.5">Docker image</div>
                <div className="rounded-lg border border-subtle bg-surface-1 px-3 py-2.5">
                  <DockerUpdateBadge app={app} prominent />
                </div>
              </section>
            )}

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

            {/* Extensions (restored from the card): run any appAction contributed
                by a matching extension headlessly, or open the full panel. */}
            {appExtensions.length > 0 && (
              <section>
                <div className="flex items-center gap-2 mb-2 px-0.5">
                  <span className="text-[10px] uppercase tracking-[0.09em] text-ink-3">Extensions</span>
                  <button
                    onClick={() => appExtensions.length === 1 ? openExtensionSidebar(app.id, appExtensions, appExtensions[0].id) : openExtensionSidebar(app.id, appExtensions)}
                    className="ml-auto text-[11px] text-accent-ink inline-flex items-center gap-1 hover:brightness-110 transition-[filter]"
                  >
                    Open panel
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  </button>
                </div>
                {/* Pin picker — which extensions get their own workbench tab.
                    Global, so a pin follows the extension to every app it
                    activates for. Capped: past the cap the un-pinned rows go
                    inert rather than silently dropping a pin. */}
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {appExtensions.map((ext) => {
                    const isPinned = pinnedExtensions.includes(ext.id);
                    const capped = !isPinned && pinnedExtensions.length >= MAX_PINNED_EXTENSIONS;
                    return (
                      <button
                        key={ext.id}
                        onClick={() => togglePinnedExtension(ext.id)}
                        disabled={capped}
                        title={
                          isPinned
                            ? `Unpin ${ext.name} — removes its tab`
                            : capped
                              ? `Pin limit reached (${MAX_PINNED_EXTENSIONS}) — unpin one first`
                              : `Pin ${ext.name} as a tab`
                        }
                        aria-pressed={isPinned}
                        className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-control border text-[11px] transition-colors ${
                          isPinned
                            ? "border-[rgba(96,165,250,0.4)] bg-accent-bg text-accent-ink"
                            : capped
                              ? "border-subtle text-ink-3 opacity-40 cursor-not-allowed"
                              : "border-subtle text-ink-2 hover:text-ink hover:border-strong"
                        }`}
                      >
                        <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
                          <path d="M6.2 2h3.6l-.5 4 2.2 1.9v1.2H4.5V7.9L6.7 6l-.5-4Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" fill={isPinned ? "currentColor" : "none"} fillOpacity="0.25" />
                          <path d="M8 9.1V14" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                        </svg>
                        {ext.name}
                      </button>
                    );
                  })}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <ExtensionActionButtons
                    app={app}
                    extensions={appExtensions}
                    onOpenExtension={(ext) => openExtensionSidebar(app.id, appExtensions, ext.id)}
                  />
                </div>
              </section>
            )}

            {/* Instances (mockup 26) — the primary checkout plus each git-worktree
                branch instance. "＋ New from branch" reveals the inline picker;
                clicking an instance row opens it as its own workbench (full parent
                tab/action set). Parent workbench only — an instance can't nest. */}
            {!isInstance && (
            <section>
              <div className="flex items-center gap-2 mb-2 px-0.5">
                <span className="text-accent inline-flex items-center" aria-hidden>
                  <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><circle cx="4" cy="4" r="1.6" stroke="currentColor" strokeWidth="1.3"/><circle cx="4" cy="12" r="1.6" stroke="currentColor" strokeWidth="1.3"/><circle cx="12" cy="8" r="1.6" stroke="currentColor" strokeWidth="1.3"/><path d="M4 5.6v4.8M5.6 4h1.2c1.5 0 2.4.9 2.4 2.4v.4M5.6 12h1.2c1.5 0 2.4-.9 2.4-2.4v-.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
                </span>
                <span className="text-[13px] font-medium text-ink">Instances</span>
                <span className="text-[11px] text-ink-3">· {runningCount} running</span>
                <button
                  onClick={() => setPickerOpen((v) => !v)}
                  aria-expanded={pickerOpen}
                  className="ml-auto text-[11px] text-accent-ink inline-flex items-center gap-1 hover:brightness-110 transition-[filter]"
                >
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
                  New from branch
                </button>
              </div>

              {/* Inline run-on-branch picker (replaces the old modal). */}
              {pickerOpen && (
                <div className="mb-2">
                  <RunOnBranchPicker app={app} instances={instances} onClose={() => setPickerOpen(false)} />
                </div>
              )}

              <div className="space-y-1.5">
                {/* Primary/main checkout row — the app itself; not navigable. */}
                <div className="flex items-center gap-2.5 border border-subtle rounded-[9px] px-3 py-2">
                  <span className={`w-[7px] h-[7px] rounded-full shrink-0 ${running ? "bg-ok" : "bg-ink-3"}`} aria-hidden />
                  <span className="text-[13px] text-ink">{branch || "main"}</span>
                  <span className="text-[11px] text-ink-3 font-mono truncate">
                    :{app.port} · {primaryHost}
                  </span>
                  <span className="ml-auto text-[11px] text-ink-2 shrink-0">primary</span>
                </div>

                {/* One row per worktree instance — click to open its workbench. */}
                {instances.map((inst) => {
                  const isRunning = inst.status === "running";
                  const instUrl = inst.tunnel_active && inst.tunnel_url
                    ? inst.tunnel_url
                    : `${scheme}://${inst.subdomain}.${hostDomain}`;
                  return (
                    <div key={inst.id} className="group flex items-center gap-2.5 border border-subtle rounded-[9px] px-3 py-2 hover:border-strong hover:bg-white/[0.02] transition-colors">
                      <span className={`w-[7px] h-[7px] rounded-full shrink-0 ${isRunning ? "bg-ok" : "bg-ink-3"}`} aria-hidden />
                      <button
                        onClick={() => selectInstance(app.id, inst.id)}
                        title="Open instance workbench"
                        className="flex items-center gap-2.5 min-w-0 flex-1 text-left"
                      >
                        <span className="text-[13px] text-ink inline-flex items-center gap-1.5 min-w-0">
                          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" className="text-ink-3 shrink-0"><circle cx="4.5" cy="3.5" r="1.6" stroke="currentColor" strokeWidth="1.3"/><circle cx="4.5" cy="12.5" r="1.6" stroke="currentColor" strokeWidth="1.3"/><circle cx="11.5" cy="4.5" r="1.6" stroke="currentColor" strokeWidth="1.3"/><path d="M4.5 5.1v5.8M11.5 6.1c0 2.5-1.9 3.4-4.2 3.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
                          <span className="truncate">{inst.branch}</span>
                        </span>
                        <span className="text-[11px] text-ink-3 font-mono truncate">
                          :{inst.port} · {isRunning ? `${inst.subdomain}.${hostDomain}` : "stopped"}
                        </span>
                      </button>
                      <span className="ml-auto flex items-center gap-1.5 text-ink-3 shrink-0">
                        {isRunning ? (
                          <>
                            <button onClick={() => openExternalUrl(instUrl)} title="Open in browser" aria-label="Open in browser" className="hover:text-accent transition-colors">
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
                        {/* Open-workbench chevron — the row's primary navigation. */}
                        <span className="w-px h-4 bg-[var(--border-subtle)]" aria-hidden />
                        <button onClick={() => selectInstance(app.id, inst.id)} title="Open instance workbench" aria-label="Open instance workbench" className="text-ink-3 group-hover:text-ink transition-colors">
                          <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
                        </button>
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
            )}
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

        {/* Terminal — the shared multi-tab/split surface, not a bare single
            pane. The workbench hides the grid (and with it the TerminalModal),
            so this tab is the only terminal reachable once an app is open and
            must carry the same ⌘T / ⌘D / split affordances. */}
        {termSeen && (
          <div hidden={tab !== "terminal"} className="h-full">
            <TerminalWorkspace
              appId={app.id}
              appName={isInstance ? instance!.branch : app.name}
              rootDir={app.root_dir}
              active={tab === "terminal"}
              autoSeed
            />
          </div>
        )}

        <div hidden={tab !== "git"} className="h-full">
          <GitTab app={app} />
        </div>

        {/* SPIKE — kept mounted on purpose: surviving a tab switch with scroll,
            filters and a draft commit message intact is the whole point of
            running it in-process rather than in an iframe. */}
        {git2Seen && (
          <div hidden={tab !== "git2"} className="h-full">
            <Suspense fallback={null}>
              <GitManagerTab app={app} />
            </Suspense>
          </div>
        )}

        {/* Pinned extensions — the extension's own panel inline, same treatment
            as Config. Mounted only while active so an unopened extension never
            boots its iframe (and its bridge/PTYs) in the background. */}
        {pinnedExts.map((ext) =>
          tab === `ext:${ext.id}` ? (
            <div key={ext.id} className="h-full flex flex-col">
              <Suspense fallback={null}>
                <ExtensionPanel app={app} extension={ext} />
              </Suspense>
            </div>
          ) : null
        )}

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

      {/* ── Log toast — auto-opens on start/stop, turns red on crash. Silent
           while the Logs tab is active (the logger already shows this). ── */}
      {logToastOpen && !inLogger && (
        <LogToast
          appName={isInstance ? instance!.branch : app.name}
          logs={logs}
          isRunning={running}
          isStarting={isStarting}
          crashed={crashed}
          onExpand={() => { setLogToastOpen(false); select("logs"); }}
          onClose={() => setLogToastOpen(false)}
        />
      )}

      {accessSettingsSection && !isInstance && (
        <Suspense fallback={null}>
          <AccessSettingsDrawer
            app={app}
            workspace={workspaces.find((w) => w.id === app.workspace_id) ?? null}
            initialSection={accessSettingsSection}
            onClose={() => setAccessSettingsSection(null)}
          />
        </Suspense>
      )}

    </div>
  );
}
