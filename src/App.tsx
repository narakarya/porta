import { useEffect, useState } from "react";
import { usePortaStore } from "./store";
import { startCaddy } from "./lib/commands";
import Layout from "./components/layout/Layout";
import WorkspaceView from "./components/workspace/WorkspaceView";
import SetupWizard from "./components/setup/SetupWizard";
import SettingsPage from "./components/settings/SettingsPage";
import CommandPalette from "./components/layout/CommandPalette";

type Page = "main" | "settings";

export default function App() {
  const { load, checkSetup, loadSettings, setupStatus, refreshHealth } = usePortaStore();
  const [page, setPage] = useState<Page>("main");
  const [caddyAutoStartFailed, setCaddyAutoStartFailed] = useState(false);
  const [caddyBannerDismissed, setCaddyBannerDismissed] = useState(false);

  useEffect(() => {
    checkSetup();
    load().then(() => refreshHealth());
    loadSettings();

    const healthInterval = setInterval(() => refreshHealth(), 30_000);
    return () => clearInterval(healthInterval);
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

  if (page === "settings") {
    return <SettingsPage onBack={() => setPage("main")} />;
  }

  return (
    <>
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
    </>
  );
}
