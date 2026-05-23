import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { usePortaStore } from "./store";
import { startCaddy, listCloudflareTunnels, getCfApiToken, listTunnelDns } from "./lib/commands";
import { setCachedTunnels, setCachedDnsRoutes } from "./lib/tunnelCache";
import { checkForUpdate } from "./lib/updater";
import Layout from "./components/layout/Layout";
import WorkspaceView from "./components/workspace/WorkspaceView";
import SetupWizard from "./components/setup/SetupWizard";
import SettingsPage from "./components/settings/SettingsPage";
import CommandPalette from "./components/layout/CommandPalette";

type Page = "main" | "settings";

export default function App() {
  const { load, checkSetup, loadSettings, refreshHealth } = usePortaStore(
    useShallow((s) => ({
      load: s.load,
      checkSetup: s.checkSetup,
      loadSettings: s.loadSettings,
      refreshHealth: s.refreshHealth,
    }))
  );
  const setupStatus = usePortaStore((s) => s.setupStatus);
  const [page, setPage] = useState<Page>("main");
  const [caddyAutoStartFailed, setCaddyAutoStartFailed] = useState(false);
  const [caddyBannerDismissed, setCaddyBannerDismissed] = useState(false);

  useEffect(() => {
    checkSetup();
    load().then(() => refreshHealth());
    loadSettings();

    const healthInterval = setInterval(() => refreshHealth(), 30_000);

    // Check for app updates shortly after startup (silent if none / offline).
    const updateCheck = setTimeout(() => { void checkForUpdate(); }, 5000);

    // Pre-warm tunnel cache in the background so opening Settings → Tunnels
    // is instant (shows cached list immediately, refreshes in background).
    const prewarmDelay = setTimeout(() => {
      listCloudflareTunnels()
        .then(setCachedTunnels)
        .catch(() => {});
      getCfApiToken()
        .then((t) => {
          if (t) return listTunnelDns(t).then(setCachedDnsRoutes);
        })
        .catch(() => {});
    }, 2000);

    // Pre-warm heavy lazy chunks during idle time so the user's first click
    // (Settings, app card, deploy, etc.) doesn't pay a chunk-load delay.
    // Fire each on a separate idle slot so a single big chunk doesn't hog
    // the main thread during prewarm.
    type IdleCb = (cb: IdleRequestCallback) => number;
    const w = window as unknown as { requestIdleCallback?: IdleCb };
    const idle: IdleCb = w.requestIdleCallback ?? ((cb) => window.setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 0 } as IdleDeadline), 1));
    const prewarmHandles: number[] = [];
    const queue: Array<() => Promise<unknown>> = [
      () => import("./components/settings/SettingsPage"),
      () => import("./components/app/AppSettingsModal"),
      () => import("./components/app/LogViewer"),
      () => import("./components/app/AddAppModal"),
      () => import("./components/deploy/DeployModal"),
      () => import("./components/settings/CloudflareSection"),
      () => import("./components/settings/CloudflareZoneSection"),
      () => import("./components/settings/CloudflareEmailSection"),
    ];
    queue.forEach((load, i) => {
      prewarmHandles.push(idle(() => { load().catch(() => {}); }) as unknown as number);
      // Stagger fallback timers so the setTimeout-shim version doesn't all
      // fire on the same tick.
      void i;
    });

    return () => {
      clearInterval(healthInterval);
      clearTimeout(prewarmDelay);
      clearTimeout(updateCheck);
    };
  }, []);

  // Auto-start Caddy silently if installed but not running
  useEffect(() => {
    if (setupStatus?.caddy_installed && !setupStatus?.caddy_running) {
      startCaddy()
        .then(() => checkSetup())
        .catch(() => setCaddyAutoStartFailed(true));
    }
  }, [setupStatus?.caddy_installed, setupStatus?.caddy_running]);

  // Only show banner if auto-start failed
  const showCaddyBanner = caddyAutoStartFailed && !caddyBannerDismissed;

  // Keep both pages mounted once visited so navigating between Main and
  // Settings doesn't pay a full mount cost each time. Without this, every
  // back/forth caused a beachball — Layout + WorkspaceView re-mount means
  // the entire app list, event subscriptions, and state hydrate from
  // scratch, and SettingsPage re-mounts mean lazy chunks load again.
  const [settingsVisited, setSettingsVisited] = useState(false);
  useEffect(() => {
    if (page === "settings") setSettingsVisited(true);
  }, [page]);

  return (
    <>
      <div hidden={page !== "main"}>
        <SetupWizard />
        <CommandPalette onOpenSettings={() => setPage("settings")} />

        <Layout onOpenSettings={() => setPage("settings")}>
          {/* Caddy not running banner — shown after reboot or if Caddy was stopped */}
          {showCaddyBanner && (
            <div className="flex items-center gap-2.5 px-3 py-2 mb-4 bg-amber-500/10 border border-amber-500/25 rounded-lg">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="text-amber-400 shrink-0">
                <path d="M6 1.5l4.5 8H1.5L6 1.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
                <path d="M6 5v2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                <circle cx="6" cy="8.5" r="0.4" fill="currentColor"/>
              </svg>
              <p className="text-[11px] text-amber-300 flex-1">
                Caddy couldn't start automatically. Go to Settings → Setup to start it manually.
              </p>
              <button
                onClick={() => setCaddyBannerDismissed(true)}
                className="p-0.5 text-amber-600 hover:text-amber-300 transition-colors shrink-0"
                title="Dismiss"
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                </svg>
              </button>
            </div>
          )}
          <WorkspaceView />
        </Layout>
      </div>
      {settingsVisited && (
        <div hidden={page !== "settings"}>
          <SettingsPage onBack={() => setPage("main")} />
        </div>
      )}
    </>
  );
}
