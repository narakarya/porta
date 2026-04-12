import { useEffect, useState } from "react";
import { usePortaStore } from "./store";
import { reloadCaddy, startCaddy } from "./lib/commands";
import Layout from "./components/Layout";
import WorkspaceView from "./components/WorkspaceView";
import SetupWizard from "./components/SetupWizard";
import SettingsPage from "./components/SettingsPage";
import CommandPalette from "./components/CommandPalette";

type Page = "main" | "settings";

export default function App() {
  const { load, checkSetup, setupStatus } = usePortaStore();
  const [page, setPage] = useState<Page>("main");
  const [caddyStarting, setCaddyStarting] = useState(false);
  const [caddyError, setCaddyError] = useState<string | null>(null);

  useEffect(() => {
    checkSetup();
    load();
    reloadCaddy().catch(() => {});
  }, []);

  // Show banner if Caddy is installed but stopped (e.g. after reboot).
  // We do NOT auto-start — that would trigger a silent admin password prompt.
  // The user clicks "Start Caddy" explicitly so they understand the macOS prompt.
  const showCaddyBanner = !!setupStatus?.caddy_installed && !setupStatus?.caddy_running;

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

      {/* Caddy not running banner — shown after reboot or if Caddy was stopped */}
      {showCaddyBanner && (
        <div className="fixed top-8 left-0 right-0 z-40 flex justify-center pointer-events-none">
          <div className="flex items-center gap-2.5 px-3 py-2 bg-amber-500/10 border border-amber-500/25 rounded-lg shadow-lg pointer-events-auto mx-4">
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
            {caddyStarting && (
              <span className="spinner text-amber-400 shrink-0" />
            )}
          </div>
        </div>
      )}

      <Layout onOpenSettings={() => setPage("settings")}>
        <WorkspaceView />
      </Layout>
    </>
  );
}
