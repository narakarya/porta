import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { usePortaStore } from "./store";
import { startCaddy, listCloudflareTunnels, getCfApiToken, listTunnelDns } from "./lib/commands";
import { setCachedTunnels, setCachedDnsRoutes } from "./lib/tunnelCache";
import { autoCheckForUpdate, checkForUpdate } from "./lib/updater";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "./lib/commands";
import Layout from "./components/layout/Layout";
import GlobalRail from "./components/layout/GlobalRail";
import WorkspaceView from "./components/workspace/WorkspaceView";
import HostsView from "./components/ssh/HostsView";
import ActivityView from "./components/activity/ActivityView";
import ExtensionsView from "./components/extension/ExtensionsView";
import SetupWizard from "./components/setup/SetupWizard";
import SettingsPage from "./components/settings/SettingsPage";
import CommandPalette from "./components/layout/CommandPalette";
import UpdateToast from "./components/layout/UpdateToast";
import ErrorBoundary from "./components/layout/ErrorBoundary";
import HelpModal from "./components/layout/HelpModal";
import { ExtensionHostProvider } from "./components/extension/ExtensionHostManager";
import UiGallery from "./components/ui/UiGallery";

type Page = "main" | "settings";

export default function App() {
  const { load, checkSetup, loadSettings, refreshHealth, settingsSection } = usePortaStore(
    useShallow((s) => ({
      load: s.load,
      checkSetup: s.checkSetup,
      loadSettings: s.loadSettings,
      refreshHealth: s.refreshHealth,
      settingsSection: s.settingsSection,
    }))
  );
  const setupStatus = usePortaStore((s) => s.setupStatus);
  const activeDomain = usePortaStore((s) => s.activeDomain);
  const [page, setPage] = useState<Page>("main");
  // A sidebar/deep-link request to open a specific Settings section also opens
  // the Settings page. SettingsPage consumes the section and clears it.
  useEffect(() => {
    if (settingsSection) setPage("settings");
  }, [settingsSection]);
  const [caddyAutoStartFailed, setCaddyAutoStartFailed] = useState(false);
  const [caddyBannerDismissed, setCaddyBannerDismissed] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  // ⌘? opens the keyboard cheatsheet. macOS treats Shift+/ as `?`, so we
  // check `e.key === "?"` rather than parsing modifiers from the slash key.
  // Skipped when focus is in an input so typing `?` mid-message works.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key !== "?") return;
      const t = e.target as HTMLElement | null;
      if (t && (["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || t.isContentEditable)) return;
      e.preventDefault();
      setHelpOpen((v) => !v);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    checkSetup();
    load().then(() => refreshHealth());
    loadSettings();

    const healthInterval = setInterval(() => refreshHealth(), 30_000);

    // Check for app updates shortly after startup (silent if none / offline).
    const updateCheck = setTimeout(() => autoCheckForUpdate(), 5000);

    // Periodic background re-check so a window left open for days still learns
    // about new releases without a restart. Silent — the toast only appears if
    // there's an update. (autoCheckForUpdate throttles to ≥30m, so this and the
    // focus trigger below can't double-fire.)
    const updateInterval = setInterval(() => autoCheckForUpdate(), 30 * 60 * 1000);

    // Re-check when the user returns to Porta after working elsewhere — the
    // common "left it open since yesterday" case. Throttled inside the helper.
    const onFocus = () => autoCheckForUpdate();
    window.addEventListener("focus", onFocus);

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
      clearInterval(updateInterval);
      clearTimeout(prewarmDelay);
      clearTimeout(updateCheck);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  // Native app-menu actions (Porta → Check for Updates… / Settings…) arrive as
  // events emitted from Rust (src-tauri/src/menu.rs). The manual check runs
  // non-silently so "you're up to date" gives feedback instead of a dead click.
  useEffect(() => {
    if (!isTauri) return;
    const unlisten = [
      listen("menu://check-for-updates", () => { void checkForUpdate({ silent: false }); }),
      listen("menu://open-settings", () => setPage("settings")),
    ];
    return () => { unlisten.forEach((p) => void p.then((un) => un())); };
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

  // Dev-only: `#gallery` renders the UI primitive gallery in isolation.
  if (typeof window !== "undefined" && window.location.hash === "#gallery") {
    return <UiGallery />;
  }

  return (
    <ErrorBoundary>
      <ExtensionHostProvider>
      <div className="flex h-screen bg-[#111113] text-zinc-100 font-sans overflow-hidden">
        {/* Persistent domain rail — visible across main and settings */}
        <GlobalRail
          onOpenSettings={() => setPage("settings")}
          onSelectDomain={() => setPage("main")}
          settingsActive={page === "settings"}
        />

        <div className="flex-1 flex min-w-0 relative">
          <div className={page === "main" ? "flex-1 flex min-w-0" : "hidden"}>
            <SetupWizard />
            <CommandPalette onOpenSettings={() => setPage("settings")} onShowShortcuts={() => setHelpOpen(true)} />

            <Layout onOpenSettings={() => setPage("settings")}>
              {/* Domains kept warm (mounted, toggled with `hidden`) so switching
                  doesn't unmount SshTerminal (disposing xterm / dropping listeners)
                  or re-hydrate the workspace subscriptions. */}
              <div hidden={activeDomain !== "workspaces"}>
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
              </div>
              <div hidden={activeDomain !== "hosts"}>
                <HostsView />
              </div>
              <div hidden={activeDomain !== "activity"}>
                <ActivityView />
              </div>
              <div hidden={activeDomain !== "extensions"}>
                <ExtensionsView />
              </div>
            </Layout>
          </div>
          {settingsVisited && (
            <div className={page === "settings" ? "flex-1 min-w-0" : "hidden"}>
              <SettingsPage onBack={() => setPage("main")} />
            </div>
          )}
        </div>
      </div>
      {/* Global toast for the updater — always mounted regardless of page so
          a download started from Settings stays visible after the user
          switches back to Main. */}
      <UpdateToast />
      {helpOpen && <HelpModal onClose={() => setHelpOpen(false)} />}
      </ExtensionHostProvider>
    </ErrorBoundary>
  );
}
