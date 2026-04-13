import { useState, useEffect } from "react";
import { startCaddy, reloadCaddy, caddyStatusCheck, regenerateCerts, getLaunchAtLogin, setLaunchAtLogin } from "../../lib/commands";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-white/[0.02] border border-white/[0.04]">
      <span className="text-[12px] text-zinc-500">{label}</span>
      <span className="text-[12px] text-zinc-400 font-mono">{value}</span>
    </div>
  );
}

interface SetupSectionProps {
  onOpenWizard: () => void;
}

export default function SetupSection({ onOpenWizard }: SetupSectionProps) {
  const [caddyRunning, setCaddyRunning] = useState<boolean | null>(null);
  const [caddyLoading, setCaddyLoading] = useState(false);
  const [caddyError, setCaddyError] = useState<string | null>(null);
  const [certsLoading, setCertsLoading] = useState(false);
  const [certsStatus, setCertsStatus] = useState<"idle" | "success" | "error">("idle");
  const [certsError, setCertsError] = useState<string | null>(null);
  const [launchAtLogin, setLaunchAtLoginState] = useState(false);

  useEffect(() => {
    caddyStatusCheck().then(setCaddyRunning).catch(() => setCaddyRunning(false));
    if (isTauri) getLaunchAtLogin().then(setLaunchAtLoginState).catch(() => {});
  }, []);

  async function handleToggleLaunchAtLogin() {
    const next = !launchAtLogin;
    try {
      await setLaunchAtLogin(next);
      setLaunchAtLoginState(next);
    } catch { /* ignore */ }
  }

  async function handleStartCaddy() {
    setCaddyLoading(true);
    setCaddyError(null);
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

  async function handleReloadCaddy() {
    setCaddyLoading(true);
    setCaddyError(null);
    try {
      await reloadCaddy();
    } catch (e: unknown) {
      setCaddyError(String(e).replace(/^Error: /, ""));
    } finally {
      setCaddyLoading(false);
    }
  }

  async function handleRegenCerts() {
    setCertsLoading(true);
    setCertsStatus("idle");
    setCertsError(null);
    try {
      await regenerateCerts();
      setCertsStatus("success");
    } catch (e: unknown) {
      setCertsStatus("error");
      setCertsError(String(e).replace(/^Error: /, ""));
    } finally {
      setCertsLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-[16px] font-semibold text-zinc-100">Setup &amp; Certificates</h1>
        <p className="text-[12px] text-zinc-500 mt-1 leading-relaxed">
          Manage local infrastructure — Caddy reverse proxy, dnsmasq DNS resolver, and mkcert SSL certificates.
        </p>
      </div>

      {/* Caddy status card */}
      <div className="flex flex-col gap-4 p-5 rounded-xl bg-white/[0.03] border border-white/[0.07]">
        <div className="flex items-start gap-4">
          <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
            caddyRunning ? "bg-emerald-500/10 border border-emerald-500/20" : "bg-amber-500/10 border border-amber-500/20"
          }`}>
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" className={caddyRunning ? "text-emerald-400" : "text-amber-400"}>
              <rect x="3" y="7" width="14" height="9" rx="2" stroke="currentColor" strokeWidth="1.5"/>
              <path d="M7 7V5a3 3 0 016 0v2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              <circle cx="10" cy="11.5" r="1" fill="currentColor"/>
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-[13px] font-medium text-zinc-200">Caddy HTTPS Proxy</p>
              <span className={`flex items-center gap-1 text-[11px] ${
                caddyRunning === null ? "text-zinc-600" : caddyRunning ? "text-emerald-400" : "text-amber-400"
              }`}>
                <span className={`w-1.5 h-1.5 rounded-full ${
                  caddyRunning === null ? "bg-zinc-600 animate-pulse" : caddyRunning ? "bg-emerald-400" : "bg-amber-400"
                }`} />
                {caddyRunning === null ? "Checking…" : caddyRunning ? "Running" : "Stopped"}
              </span>
            </div>
            <p className="text-[12px] text-zinc-500 mt-0.5 leading-relaxed">
              Routes HTTPS traffic to your local apps. macOS will ask for your password when starting on port 443.
            </p>
          </div>
        </div>

        {caddyError && (
          <p className="text-[12px] text-red-400 -mt-1">{caddyError}</p>
        )}

        <div className="flex items-center gap-2">
          {caddyRunning === false && (
            <button
              onClick={handleStartCaddy}
              disabled={caddyLoading}
              className="px-3 py-1.5 text-[12px] font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg transition-colors"
            >
              {caddyLoading ? "Starting…" : "Start Caddy"}
            </button>
          )}
          {caddyRunning && (
            <button
              onClick={handleReloadCaddy}
              disabled={caddyLoading}
              className="px-3 py-1.5 text-[12px] font-medium bg-white/[0.06] hover:bg-white/[0.10] disabled:opacity-50 text-zinc-300 rounded-lg transition-colors"
            >
              {caddyLoading ? "Reloading…" : "Reload Config"}
            </button>
          )}
          <button
            onClick={() => {
              setCaddyRunning(null);
              caddyStatusCheck().then(setCaddyRunning).catch(() => setCaddyRunning(false));
            }}
            className="px-3 py-1.5 text-[12px] text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Setup wizard card */}
      <div className="flex flex-col gap-4 p-5 rounded-xl bg-white/[0.03] border border-white/[0.07]">
        <div className="flex items-start gap-4">
          <div className="w-9 h-9 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center shrink-0">
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" className="text-blue-400">
              <path d="M10 2L3 6v4c0 3.5 3 6.7 7 8 4-1.3 7-4.5 7-8V6l-7-4z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
            </svg>
          </div>
          <div>
            <p className="text-[13px] font-medium text-zinc-200">Re-run Setup Wizard</p>
            <p className="text-[12px] text-zinc-500 mt-0.5 leading-relaxed">
              Installs or repairs Caddy, dnsmasq, and mkcert. Regenerates SSL wildcard certificates for all your workspace domains.
            </p>
          </div>
        </div>
        <button
          onClick={onOpenWizard}
          className="self-start px-4 py-2 text-[13px] font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors"
        >
          Open Setup Wizard
        </button>
      </div>

      {/* SSL certificate card */}
      <div className="flex flex-col gap-4 p-5 rounded-xl bg-white/[0.03] border border-white/[0.07]">
        <div className="flex items-start gap-4">
          <div className="w-9 h-9 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center shrink-0">
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" className="text-emerald-400">
              <path d="M7 10l2 2 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M10 2L3 6v4c0 3.5 3 6.7 7 8 4-1.3 7-4.5 7-8V6l-7-4z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
            </svg>
          </div>
          <div>
            <p className="text-[13px] font-medium text-zinc-200">SSL Certificates</p>
            <p className="text-[12px] text-zinc-500 mt-0.5 leading-relaxed">
              Regenerate wildcard SSL certs for all workspace domains. Use this to fix browser HTTPS warnings or after adding a new workspace domain.
            </p>
          </div>
        </div>
        {certsError && (
          <p className="text-[12px] text-red-400 -mt-1">{certsError}</p>
        )}
        <div className="flex items-center gap-3">
          <button
            onClick={handleRegenCerts}
            disabled={certsLoading}
            className="self-start px-4 py-2 text-[13px] font-medium bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg transition-colors"
          >
            {certsLoading ? "Regenerating…" : "Regenerate SSL Certs"}
          </button>
          {certsStatus === "success" && (
            <span className="flex items-center gap-1.5 text-[12px] text-emerald-400">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M2 6l2.5 2.5 5.5-5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              Certs regenerated — restart browser if needed
            </span>
          )}
        </div>
      </div>

      {/* Launch at Login */}
      {isTauri && (
        <div className="flex items-center justify-between p-5 rounded-xl bg-white/[0.03] border border-white/[0.07]">
          <div className="flex items-start gap-4">
            <div className="w-9 h-9 rounded-xl bg-zinc-500/10 border border-zinc-500/20 flex items-center justify-center shrink-0">
              <svg width="16" height="16" viewBox="0 0 20 20" fill="none" className="text-zinc-400">
                <rect x="3" y="4" width="14" height="12" rx="2" stroke="currentColor" strokeWidth="1.5"/>
                <path d="M7 4V3a1 1 0 011-1h4a1 1 0 011 1v1" stroke="currentColor" strokeWidth="1.5"/>
                <path d="M10 9v4M10 9l-2 2M10 9l2 2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
            <div>
              <p className="text-[13px] font-medium text-zinc-200">Launch at Login</p>
              <p className="text-[12px] text-zinc-500 mt-0.5 leading-relaxed">
                Automatically start Porta when you log in to macOS.
              </p>
            </div>
          </div>
          <button
            onClick={handleToggleLaunchAtLogin}
            className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${launchAtLogin ? "bg-blue-600" : "bg-zinc-700"}`}
          >
            <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all ${launchAtLogin ? "left-[18px]" : "left-0.5"}`} />
          </button>
        </div>
      )}

      {/* Info rows */}
      <div className="flex flex-col gap-2">
        <InfoRow label="Cert location" value="~/.porta/certs/test.pem" />
        <InfoRow label="Caddy admin" value="http://localhost:2019" />
        <InfoRow label="DNS resolver" value="/etc/resolver/test" />
      </div>
    </div>
  );
}
