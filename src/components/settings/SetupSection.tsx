import { useState, useEffect } from "react";
import { startCaddy, reloadCaddy, caddyStatusCheck, regenerateCerts, getLaunchAtLogin, setLaunchAtLogin } from "../../lib/commands";
import { yieldToFrame } from "../../lib/ui";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

interface SetupSectionProps {
  onOpenWizard: () => void;
}

export default function SetupSection({ onOpenWizard }: SetupSectionProps) {
  const [caddyRunning, setCaddyRunning] = useState<boolean | null>(null);
  const [caddyLoading, setCaddyLoading] = useState(false);
  const [caddyError, setCaddyError] = useState<string | null>(null);
  const [certsLoading, setCertsLoading] = useState(false);
  const [certsStatus, setCertsStatus] = useState<"idle" | "success" | "error">("idle");
  const [reloadingCaddy, setReloadingCaddy] = useState(false);
  const [launchAtLogin, setLaunchAtLoginState] = useState(false);

  useEffect(() => {
    caddyStatusCheck().then(setCaddyRunning).catch(() => setCaddyRunning(false));
    if (isTauri) getLaunchAtLogin().then(setLaunchAtLoginState).catch(() => {});
  }, []);

  const allGood = caddyRunning === true;

  async function handleStartCaddy() {
    setCaddyLoading(true);
    setCaddyError(null);
    await yieldToFrame();
    try {
      await startCaddy();
      await reloadCaddy().catch(() => {});
      setCaddyRunning(true);
    } catch (e: unknown) {
      setCaddyError(String(e).replace(/^Error: /, ""));
    } finally {
      setCaddyLoading(false);
    }
  }

  async function handleRegenCerts() {
    setCertsLoading(true);
    setCertsStatus("idle");
    await yieldToFrame();
    try {
      await regenerateCerts();
      setCertsStatus("success");
    } catch {
      setCertsStatus("error");
    } finally {
      setCertsLoading(false);
    }
  }

  async function handleReloadCaddy() {
    setReloadingCaddy(true);
    await yieldToFrame();
    try {
      await reloadCaddy();
    } catch { /* ignore */ } finally {
      setReloadingCaddy(false);
    }
  }

  async function handleToggleLaunchAtLogin() {
    const next = !launchAtLogin;
    try {
      await setLaunchAtLogin(next);
      setLaunchAtLoginState(next);
    } catch { /* ignore */ }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-[16px] font-semibold text-zinc-100">Setup</h1>
        <p className="text-[12px] text-zinc-500 mt-1">Local infrastructure status and controls.</p>
      </div>

      {/* Status overview card */}
      <div className="p-5 rounded-xl bg-white/[0.03] border border-white/[0.07]">
        <div className="flex items-center gap-3">
          <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
            allGood ? "bg-emerald-500/10 border border-emerald-500/20" : "bg-amber-500/10 border border-amber-500/20"
          }`}>
            {allGood ? (
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="text-emerald-400">
                <path d="M4 8.5l2.5 2.5L12 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="text-amber-400">
                <path d="M8 4v4M8 10.5h.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            )}
          </div>
          <div className="flex-1">
            <p className="text-[13px] font-medium text-zinc-200">
              {caddyRunning === null ? "Checking…" : allGood ? "Everything running" : "Caddy is not running"}
            </p>
            <p className="text-[11px] text-zinc-500 mt-0.5">
              {allGood ? "HTTPS proxy and DNS are active." : "HTTPS domains won't work until Caddy is started."}
            </p>
          </div>
          {!allGood && caddyRunning !== null && (
            <button
              onClick={handleStartCaddy}
              disabled={caddyLoading}
              className="px-3 py-1.5 text-[12px] font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors shrink-0 flex items-center gap-1.5"
            >
              {caddyLoading && (
                <svg className="w-3 h-3 animate-spin" viewBox="0 0 16 16" fill="none">
                  <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.3" />
                  <path d="M14 8a6 6 0 00-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              )}
              {caddyLoading ? "Starting…" : "Start Caddy"}
            </button>
          )}
        </div>
        {caddyError && (
          <p className="text-[11px] text-red-400 mt-2">{caddyError}</p>
        )}
      </div>

      {/* Launch at Login */}
      {isTauri && (
        <div className="flex items-center justify-between p-5 rounded-xl bg-white/[0.03] border border-white/[0.07]">
          <div>
            <p className="text-[13px] font-medium text-zinc-200">Launch at Login</p>
            <p className="text-[11px] text-zinc-500 mt-0.5">Start Porta automatically when you log in.</p>
          </div>
          <button
            onClick={handleToggleLaunchAtLogin}
            className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${launchAtLogin ? "bg-blue-600" : "bg-zinc-700"}`}
          >
            <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all ${launchAtLogin ? "left-[18px]" : "left-0.5"}`} />
          </button>
        </div>
      )}

      {/* Advanced — always shown since the content is small enough not to
          warrant a collapse. Was hidden behind a chevron toggle but the
          extra click added friction without any space saving. */}
      <div className="flex flex-col gap-4 p-5 rounded-xl bg-white/[0.03] border border-white/[0.07]">
        <div className="flex flex-wrap gap-2">
          <button
            onClick={onOpenWizard}
            className="px-3 py-1.5 text-[12px] font-medium bg-white/[0.06] hover:bg-white/[0.10] text-zinc-300 rounded-lg transition-colors"
          >
            Re-run Setup Wizard
          </button>
          <button
            onClick={handleRegenCerts}
            disabled={certsLoading}
            className="px-3 py-1.5 text-[12px] font-medium bg-white/[0.06] hover:bg-white/[0.10] disabled:opacity-50 text-zinc-300 rounded-lg transition-colors flex items-center gap-1.5"
          >
            {certsLoading && (
              <svg className="w-3 h-3 animate-spin" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.3" />
                <path d="M14 8a6 6 0 00-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            )}
            {certsLoading ? "Regenerating…" : "Regenerate SSL Certs"}
          </button>
          {allGood && (
            <button
              onClick={handleReloadCaddy}
              disabled={reloadingCaddy}
              className="px-3 py-1.5 text-[12px] text-zinc-500 hover:text-zinc-300 disabled:opacity-50 transition-colors flex items-center gap-1.5"
            >
              {reloadingCaddy && (
                <svg className="w-3 h-3 animate-spin" viewBox="0 0 16 16" fill="none">
                  <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.3" />
                  <path d="M14 8a6 6 0 00-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              )}
              {reloadingCaddy ? "Reloading…" : "Reload Caddy Config"}
            </button>
          )}
        </div>
        {certsStatus === "success" && (
          <p className="text-[11px] text-emerald-400">Certs regenerated — restart browser if needed</p>
        )}
        <div className="flex flex-col gap-1.5 text-[11px]">
          <div className="flex justify-between text-zinc-600"><span>Certs</span><span className="font-mono text-zinc-500">~/.porta/certs/test.pem</span></div>
          <div className="flex justify-between text-zinc-600"><span>Caddy API</span><span className="font-mono text-zinc-500">localhost:2019</span></div>
          <div className="flex justify-between text-zinc-600"><span>DNS resolver</span><span className="font-mono text-zinc-500">/etc/resolver/test</span></div>
        </div>
      </div>
    </div>
  );
}
