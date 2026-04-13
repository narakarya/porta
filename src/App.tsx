import { useEffect, useState } from "react";
import { usePortaStore } from "./store";
import { reloadCaddy, startCaddy } from "./lib/commands";
import Layout from "./components/layout/Layout";
import WorkspaceView from "./components/workspace/WorkspaceView";
import SetupWizard from "./components/setup/SetupWizard";
import SettingsPage from "./components/settings/SettingsPage";
import CommandPalette from "./components/layout/CommandPalette";

type Page = "main" | "settings";

export default function App() {
  const { load, checkSetup, loadSettings, setupStatus } = usePortaStore();
  const [page, setPage] = useState<Page>("main");
  const [caddyStarting, setCaddyStarting] = useState(false);
  const [caddyError, setCaddyError] = useState<string | null>(null);
  const [caddyBannerDismissed, setCaddyBannerDismissed] = useState(false);

  useEffect(() => {
    checkSetup();
    load();
    loadSettings();
    reloadCaddy().catch(() => {});
  }, []);

  // Show banner if Caddy is installed but stopped (e.g. after reboot).
  // We do NOT auto-start — that would trigger a silent admin password prompt.
  // The user clicks "Start Caddy" explicitly so they understand the macOS prompt.
  const showCaddyBanner = !!setupStatus?.caddy_installed && !setupStatus?.caddy_running && !caddyBannerDismissed;

  function handleStartCaddy() {
    setCaddyStarting(true);
    setCaddyError(null);
    startCaddy()
      .then(() => checkSetup())
      .then(() => reloadCaddy().catch(() => {}))
      .catch((e: unknown) => setCaddyError(String(e).replace(/^Error: /, "")))
      .finally(() => setCaddyStarting(false));
  }

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
              {caddyStarting
                ? "Starting Caddy HTTPS proxy…"
                : caddyError
                ? `Caddy failed to start — ${caddyError}`
                : "HTTPS proxy (Caddy) isn't running. macOS will ask for your password to start it on port 443."}
            </p>
            {!caddyStarting && (
              <button
                onClick={handleStartCaddy}
                className="text-[11px] font-medium text-amber-400 hover:text-amber-200 bg-amber-500/15 hover:bg-amber-500/25 px-2 py-0.5 rounded transition-colors shrink-0"
              >
                {caddyError ? "Retry" : "Start Caddy"}
              </button>
            )}
            {caddyStarting && <span className="spinner text-amber-400 shrink-0" />}
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
