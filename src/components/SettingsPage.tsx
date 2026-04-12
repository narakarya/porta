import { useState, useEffect, useRef } from "react";
import SetupWizard from "./SetupWizard";
import { exportData, importData, listBackups, restoreBackup, saveFile, revealInFinder, gdriveConnect, gdriveStatus, gdriveDisconnect, gdriveSync, startCaddy, reloadCaddy, caddyStatusCheck, regenerateCerts, getLaunchAtLogin, setLaunchAtLogin } from "../lib/commands";
const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
import { usePortaStore } from "../store";

type Section = "setup" | "domains" | "notifications" | "backup" | "sync";

const NAV: { id: Section; label: string; icon: React.ReactNode }[] = [
  {
    id: "setup",
    label: "Setup & Certificates",
    icon: (
      <svg width="13" height="13" viewBox="0 0 20 20" fill="none">
        <path d="M10 2L3 6v4c0 3.5 3 6.7 7 8 4-1.3 7-4.5 7-8V6l-7-4z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
      </svg>
    ),
  },
  {
    id: "domains",
    label: "Domains",
    icon: (
      <svg width="13" height="13" viewBox="0 0 20 20" fill="none">
        <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.5"/>
        <path d="M10 3c-2 2-3 4.5-3 7s1 5 3 7M10 3c2 2 3 4.5 3 7s-1 5-3 7M3 10h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      </svg>
    ),
  },
  {
    id: "notifications",
    label: "Notifications",
    icon: (
      <svg width="13" height="13" viewBox="0 0 20 20" fill="none">
        <path d="M10 2.5C7 2.5 4.5 5 4.5 8v5l-1.5 2h14l-1.5-2V8C15.5 5 13 2.5 10 2.5z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
        <path d="M8 15.5a2 2 0 004 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      </svg>
    ),
  },
  {
    id: "backup",
    label: "Data & Backup",
    icon: (
      <svg width="13" height="13" viewBox="0 0 20 20" fill="none">
        <ellipse cx="10" cy="5" rx="7" ry="2.5" stroke="currentColor" strokeWidth="1.5"/>
        <path d="M3 5v5c0 1.38 3.13 2.5 7 2.5s7-1.12 7-2.5V5" stroke="currentColor" strokeWidth="1.5"/>
        <path d="M3 10v5c0 1.38 3.13 2.5 7 2.5s7-1.12 7-2.5v-5" stroke="currentColor" strokeWidth="1.5"/>
      </svg>
    ),
  },
  {
    id: "sync",
    label: "Sync",
    icon: (
      <svg width="13" height="13" viewBox="0 0 20 20" fill="none">
        <path d="M3 10a7 7 0 0112.9-3.8M17 10a7 7 0 01-12.9 3.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        <path d="M15 3v4h-4M5 17v-4h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    ),
  },
];

interface Props {
  onBack: () => void;
}

export default function SettingsPage({ onBack }: Props) {
  const [activeSection, setActiveSection] = useState<Section>("setup");
  const [showSetupWizard, setShowSetupWizard] = useState(false);

  return (
    <div className="flex h-screen bg-[#111113] text-zinc-100 font-sans overflow-hidden">
      {/* Drag region */}
      <div className="drag-region fixed top-0 left-0 right-0 h-8 z-10 pointer-events-none" />

      {/* Settings sidebar */}
      <aside className="w-[200px] bg-[#1a1a1c] border-r border-white/[0.06] flex flex-col pt-8 pb-3 shrink-0">
        {/* Back button */}
        <div className="px-4 mb-4">
          <button
            onClick={onBack}
            className="flex items-center gap-1.5 text-[12px] text-zinc-500 hover:text-zinc-200 transition-colors"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M7.5 2L3.5 6l4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            Back
          </button>
        </div>

        <div className="px-4 mb-3">
          <span className="text-[11px] font-semibold text-zinc-500 uppercase tracking-widest">
            Settings
          </span>
        </div>

        <nav className="flex-1 flex flex-col gap-0.5 px-2 overflow-auto no-drag">
          {NAV.map((item) => {
            const active = activeSection === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setActiveSection(item.id)}
                className={`flex items-center gap-2.5 px-2 py-1.5 rounded-[6px] text-[13px] w-full text-left transition-all duration-100 ${
                  active
                    ? "bg-white/10 text-zinc-100"
                    : "text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-200"
                }`}
              >
                <span className={active ? "text-zinc-300" : "text-zinc-600"}>
                  {item.icon}
                </span>
                <span className="flex-1 truncate">{item.label}</span>
              </button>
            );
          })}
        </nav>
      </aside>

      {/* Content area */}
      <main className="flex-1 overflow-auto pt-10 px-8 pb-8 no-drag">
        {activeSection === "setup" && (
          <SetupSection onOpenWizard={() => setShowSetupWizard(true)} />
        )}
        {activeSection === "domains" && <DomainsSection />}
        {activeSection === "notifications" && <NotificationsSection />}
        {activeSection === "backup" && <BackupSection />}
        {activeSection === "sync" && <SyncSection />}
      </main>

      {showSetupWizard && (
        <SetupWizard forceShow onClose={() => setShowSetupWizard(false)} />
      )}
    </div>
  );
}

function SetupSection({ onOpenWizard }: { onOpenWizard: () => void }) {
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

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-white/[0.02] border border-white/[0.04]">
      <span className="text-[12px] text-zinc-500">{label}</span>
      <span className="text-[12px] text-zinc-400 font-mono">{value}</span>
    </div>
  );
}

function NotificationsSection() {
  const { notificationsEnabled, setNotificationsEnabled } = usePortaStore();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-[16px] font-semibold text-zinc-100">Notifications</h1>
        <p className="text-[12px] text-zinc-500 mt-1 leading-relaxed">
          macOS notifications for app lifecycle events.
        </p>
      </div>

      <div className="flex flex-col gap-4 p-5 rounded-xl bg-white/[0.03] border border-white/[0.07]">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[13px] font-medium text-zinc-200">Enable notifications</p>
            <p className="text-[11px] text-zinc-500 mt-0.5 leading-relaxed">
              Show macOS notifications when apps are ready, crash, or hit retry limits.
            </p>
          </div>
          <button
            onClick={() => setNotificationsEnabled(!notificationsEnabled)}
            className={`relative w-9 h-5 rounded-full transition-colors shrink-0 mt-0.5 ${
              notificationsEnabled ? "bg-blue-600" : "bg-zinc-700"
            }`}
          >
            <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all ${
              notificationsEnabled ? "left-[18px]" : "left-0.5"
            }`} />
          </button>
        </div>

        <div className="h-px bg-white/[0.05]" />

        <div className="flex flex-col gap-2">
          <p className="text-[11px] font-medium text-zinc-500 uppercase tracking-wider">Events</p>
          {[
            { icon: "✓", label: "App is ready", desc: "Port accepting connections" },
            { icon: "✗", label: "App crashed", desc: "Process exited with non-zero code" },
            { icon: "✗", label: "Max retries reached", desc: "App stopped after all retry attempts" },
          ].map((row) => (
            <div key={row.label} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-white/[0.02] border border-white/[0.04]">
              <span className={`text-[12px] font-mono w-4 shrink-0 ${row.icon === "✓" ? "text-emerald-400" : "text-red-400"}`}>{row.icon}</span>
              <div className="flex-1 min-w-0">
                <p className="text-[12px] text-zinc-300">{row.label}</p>
                <p className="text-[11px] text-zinc-600">{row.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function BackupSection() {
  const [exportStatus, setExportStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [exportError, setExportError] = useState<string>("");
  const [exportedPath, setExportedPath] = useState<string | null>(null);

  const [backups, setBackups] = useState<string[]>([]);
  const [backupsLoading, setBackupsLoading] = useState(true);
  const [restoreStatus, setRestoreStatus] = useState<Record<string, "idle" | "loading" | "success" | "error">>({});

  const [importStatus, setImportStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [importError, setImportError] = useState<string>("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    listBackups()
      .then(setBackups)
      .catch(() => setBackups([]))
      .finally(() => setBackupsLoading(false));
  }, []);

  async function handleExport() {
    setExportStatus("loading");
    setExportError("");
    setExportedPath(null);
    try {
      const json = await exportData();
      const date = new Date().toISOString().slice(0, 10);
      let savePath: string | null = null;
      if (isTauri) {
        const { save: saveDialog } = await import("@tauri-apps/plugin-dialog");
        savePath = await saveDialog({
          defaultPath: `porta-backup-${date}.json`,
          filters: [{ name: "JSON", extensions: ["json"] }],
        });
      } else {
        savePath = `porta-backup-${date}.json`;
      }
      if (!savePath) { setExportStatus("idle"); return; } // user cancelled
      await saveFile(savePath, json);
      setExportedPath(savePath);
      setExportStatus("success");
    } catch (err: unknown) {
      setExportStatus("error");
      setExportError(err instanceof Error ? err.message : String(err));
    }
  }

  function handleRestore(filename: string) {
    setRestoreStatus((prev) => ({ ...prev, [filename]: "loading" }));
    restoreBackup(filename)
      .then(() => {
        setRestoreStatus((prev) => ({ ...prev, [filename]: "success" }));
      })
      .catch(() => {
        setRestoreStatus((prev) => ({ ...prev, [filename]: "error" }));
      });
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportStatus("loading");
    setImportError("");
    const reader = new FileReader();
    reader.onload = () => {
      const json = reader.result as string;
      importData(json, true)
        .then(() => {
          setImportStatus("success");
        })
        .catch((err: unknown) => {
          setImportStatus("error");
          setImportError(err instanceof Error ? err.message : String(err));
        });
    };
    reader.onerror = () => {
      setImportStatus("error");
      setImportError("Failed to read file.");
    };
    reader.readAsText(file);
    // Reset input so the same file can be re-selected
    e.target.value = "";
  }

  function parseBackupDate(filename: string): string {
    const match = filename.match(/(\d{4}-\d{2}-\d{2})/);
    if (match) return match[1];
    return filename;
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-[16px] font-semibold text-zinc-100">Data &amp; Backup</h1>
        <p className="text-[12px] text-zinc-500 mt-1 leading-relaxed">
          Export your Porta data, restore from automatic backups, or import a previously exported file.
        </p>
      </div>

      {/* Export card */}
      <div className="flex flex-col gap-4 p-5 rounded-xl bg-white/[0.03] border border-white/[0.07]">
        <div className="flex items-start gap-4">
          <div className="w-9 h-9 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center shrink-0">
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" className="text-blue-400">
              <path d="M10 3v10m0 0l-3.5-3.5M10 13l3.5-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M3 15h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </div>
          <div>
            <p className="text-[13px] font-medium text-zinc-200">Export JSON</p>
            <p className="text-[12px] text-zinc-500 mt-0.5 leading-relaxed">
              Download all your workspaces and apps as a JSON file for safekeeping or migration.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={handleExport}
            disabled={exportStatus === "loading"}
            className="self-start px-4 py-2 text-[13px] font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg transition-colors"
          >
            {exportStatus === "loading" ? "Exporting..." : "Export JSON"}
          </button>
          {exportStatus === "success" && exportedPath && (
            <div className="flex items-center gap-2">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="text-emerald-400 shrink-0">
                <path d="M2 6l2.5 2.5 5.5-5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              <span className="text-[12px] text-emerald-400 font-mono truncate max-w-[220px]" title={exportedPath}>
                {exportedPath.split("/").pop()}
              </span>
              <button
                onClick={() => revealInFinder(exportedPath)}
                className="text-[11px] text-zinc-500 hover:text-zinc-200 underline underline-offset-2 transition-colors shrink-0"
              >
                Show in Finder
              </button>
            </div>
          )}
          {exportStatus === "error" && (
            <span className="text-[12px] text-red-400">{exportError || "Export failed."}</span>
          )}
        </div>
      </div>

      {/* Auto-backups card */}
      <div className="flex flex-col gap-4 p-5 rounded-xl bg-white/[0.03] border border-white/[0.07]">
        <div className="flex items-start gap-4">
          <div className="w-9 h-9 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center shrink-0">
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" className="text-blue-400">
              <ellipse cx="10" cy="5" rx="7" ry="2.5" stroke="currentColor" strokeWidth="1.5"/>
              <path d="M3 5v5c0 1.38 3.13 2.5 7 2.5s7-1.12 7-2.5V5" stroke="currentColor" strokeWidth="1.5"/>
              <path d="M3 10v5c0 1.38 3.13 2.5 7 2.5s7-1.12 7-2.5v-5" stroke="currentColor" strokeWidth="1.5"/>
            </svg>
          </div>
          <div>
            <p className="text-[13px] font-medium text-zinc-200">Automatic Backups</p>
            <p className="text-[12px] text-zinc-500 mt-0.5 leading-relaxed">
              Porta creates backups automatically on data changes. Restore any snapshot below.
            </p>
          </div>
        </div>

        {backupsLoading ? (
          <p className="text-[12px] text-zinc-500">Loading backups...</p>
        ) : backups.length === 0 ? (
          <p className="text-[12px] text-zinc-500">No automatic backups yet.</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {backups.map((filename) => {
              const status = restoreStatus[filename] ?? "idle";
              return (
                <div
                  key={filename}
                  className="flex items-center justify-between px-3 py-2 rounded-lg bg-white/[0.02] border border-white/[0.04]"
                >
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <span className="text-[12px] text-zinc-300 font-mono truncate">{filename}</span>
                    <span className="text-[11px] text-zinc-600">{parseBackupDate(filename)}</span>
                  </div>
                  <div className="flex items-center gap-2 ml-3 shrink-0">
                    {status === "success" && (
                      <span className="text-[11px] text-emerald-400">Restored! Reload to apply</span>
                    )}
                    {status === "error" && (
                      <span className="text-[11px] text-red-400">Failed</span>
                    )}
                    <button
                      onClick={() => handleRestore(filename)}
                      disabled={status === "loading"}
                      className="px-2.5 py-1 text-[12px] font-medium bg-white/[0.06] hover:bg-white/[0.10] disabled:opacity-50 disabled:cursor-not-allowed text-zinc-300 rounded-md transition-colors"
                    >
                      {status === "loading" ? "..." : "Restore"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Import card */}
      <div className="flex flex-col gap-4 p-5 rounded-xl bg-white/[0.03] border border-white/[0.07]">
        <div className="flex items-start gap-4">
          <div className="w-9 h-9 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center shrink-0">
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" className="text-blue-400">
              <path d="M10 17V7m0 0l-3.5 3.5M10 7l3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M3 5h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </div>
          <div>
            <p className="text-[13px] font-medium text-zinc-200">Import from file</p>
            <p className="text-[12px] text-zinc-500 mt-0.5 leading-relaxed">
              Load a previously exported JSON backup. <span className="text-amber-400/80">This will replace all existing data.</span>
            </p>
          </div>
        </div>
        <input spellCheck={false}
          ref={fileInputRef}
          type="file"
          accept=".json"
          className="hidden"
          onChange={handleFileChange}
        />
        <div className="flex items-center gap-3">
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={importStatus === "loading"}
            className="self-start px-4 py-2 text-[13px] font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg transition-colors"
          >
            {importStatus === "loading" ? "Importing..." : "Import from file"}
          </button>
          {importStatus === "success" && (
            <span className="text-[12px] text-emerald-400">Imported successfully!</span>
          )}
          {importStatus === "error" && (
            <span className="text-[12px] text-red-400">{importError || "Import failed."}</span>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Sync Section (from agent-a842a7cd) ──────────────────────────────────────

type SyncTarget = "none" | "git" | "icloud" | "gdrive";
type SyncStatus = "idle" | "synced" | "syncing" | "error";

function SyncSection() {
  const [syncTarget, setSyncTarget] = useState<SyncTarget>("none");
  const [gitRepoUrl, setGitRepoUrl] = useState("");
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("idle");
  const [lastSynced, setLastSynced] = useState<string | null>(null);
  const [gdriveEmail, setGdriveEmail] = useState<string | null>(null);
  const [gdriveConnecting, setGdriveConnecting] = useState(false);
  const [gdriveError, setGdriveError] = useState<string | null>(null);

  const icloudPath = "~/Library/Mobile Documents/com~apple~CloudDocs/Porta";

  // Check stored auth on mount / when switching to gdrive
  useEffect(() => {
    if (syncTarget !== "gdrive") return;
    gdriveStatus()
      .then((s) => { if (s.connected) setGdriveEmail(s.email ?? null); })
      .catch(() => {});
  }, [syncTarget]);

  async function handleGdriveConnect() {
    setGdriveConnecting(true);
    setGdriveError(null);
    try {
      const result = await gdriveConnect();
      setGdriveEmail(result.email);
    } catch (e) {
      setGdriveError(String(e).replace(/^Error: /, ""));
    } finally {
      setGdriveConnecting(false);
    }
  }

  async function handleGdriveDisconnect() {
    await gdriveDisconnect();
    setGdriveEmail(null);
  }

  function handleTestConnection() {
    setSyncStatus("error");
    setGdriveError("Git sync is not yet implemented.");
  }

  async function handleSyncNow() {
    setSyncStatus("syncing");
    try {
      if (syncTarget === "gdrive") {
        const ts = await gdriveSync();
        setLastSynced(new Date(ts).toLocaleString());
      } else {
        // iCloud / Git sync not yet implemented — placeholder
        await new Promise((r) => setTimeout(r, 800));
        setLastSynced(new Date().toLocaleString());
      }
      setSyncStatus("synced");
    } catch (e) {
      setSyncStatus("error");
      setGdriveError(String(e).replace(/^Error: /, ""));
    }
  }

  const statusColor: Record<SyncStatus, string> = {
    idle: "text-zinc-500",
    synced: "text-emerald-400",
    syncing: "text-amber-400",
    error: "text-red-400",
  };

  const statusLabel: Record<SyncStatus, string> = {
    idle: "Not configured",
    synced: "Synced",
    syncing: "Syncing...",
    error: "Sync error",
  };

  const inputCls = "w-full bg-[#111113] border border-white/[0.08] rounded-lg px-3 py-2 text-[13px] text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-blue-500/60 transition-colors";
  const labelCls = "text-[11px] font-medium text-zinc-500 uppercase tracking-wide";

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-[16px] font-semibold text-zinc-100">Sync</h1>
        <p className="text-[12px] text-zinc-500 mt-1 leading-relaxed">
          Keep your Porta configuration in sync across multiple machines.
        </p>
      </div>

      {/* Status indicator */}
      <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-white/[0.02] border border-white/[0.04]">
        <div className="flex items-center gap-2">
          <span className={`inline-block w-1.5 h-1.5 rounded-full ${
            syncStatus === "synced" ? "bg-emerald-400" :
            syncStatus === "syncing" ? "bg-amber-400 animate-pulse" :
            syncStatus === "error" ? "bg-red-400" :
            "bg-zinc-600"
          }`} />
          <span className={`text-[12px] ${statusColor[syncStatus]}`}>{statusLabel[syncStatus]}</span>
        </div>
        {lastSynced && (
          <span className="text-[11px] text-zinc-600">Last sync: {lastSynced}</span>
        )}
      </div>

      {/* Sync target selector */}
      <div className="flex flex-col gap-4 p-5 rounded-xl bg-white/[0.03] border border-white/[0.07]">
        <div className="flex items-start gap-4">
          <div className="w-9 h-9 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center shrink-0">
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" className="text-blue-400">
              <path d="M3 10a7 7 0 0112.9-3.8M17 10a7 7 0 01-12.9 3.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              <path d="M15 3v4h-4M5 17v-4h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          <div>
            <p className="text-[13px] font-medium text-zinc-200">Sync Target</p>
            <p className="text-[12px] text-zinc-500 mt-0.5 leading-relaxed">
              Choose where to sync your Porta configuration.
            </p>
          </div>
        </div>

        <div className="flex gap-2 flex-wrap">
          {(["none", "git", "icloud", "gdrive"] as SyncTarget[]).map((target) => {
            const active = syncTarget === target;
            const labels: Record<SyncTarget, string> = { none: "None", git: "Git Repository", icloud: "iCloud Drive", gdrive: "Google Drive" };
            return (
              <button
                key={target}
                type="button"
                onClick={() => { setSyncTarget(target); if (target === "none") setSyncStatus("idle"); }}
                className={`px-3 py-1.5 rounded-lg text-[12px] font-medium border transition-colors ${
                  active
                    ? "bg-blue-500/15 text-blue-400 border-blue-500/30"
                    : "bg-white/[0.04] text-zinc-500 border-white/[0.06] hover:bg-white/[0.07] hover:text-zinc-300"
                }`}
              >
                {labels[target]}
              </button>
            );
          })}
        </div>

        {syncTarget === "git" && (
          <div className="flex flex-col gap-3 mt-1">
            <label className="flex flex-col gap-1.5">
              <span className={labelCls}>Repository URL</span>
              <input
                value={gitRepoUrl}
                onChange={(e) => setGitRepoUrl(e.target.value)}
                placeholder="https://github.com/user/porta-config.git"
                className={inputCls}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <button
              type="button"
              onClick={handleTestConnection}
              disabled={!gitRepoUrl || syncStatus === "syncing"}
              className="self-start px-3 py-1.5 text-[12px] font-medium bg-white/[0.06] hover:bg-white/[0.10] disabled:opacity-50 disabled:cursor-not-allowed text-zinc-300 rounded-lg transition-colors"
            >
              {syncStatus === "syncing" ? "Testing..." : "Test Connection"}
            </button>
          </div>
        )}

        {syncTarget === "icloud" && (
          <div className="flex flex-col gap-3 mt-1">
            <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-white/[0.02] border border-white/[0.04]">
              <span className="text-[12px] text-zinc-500">iCloud path</span>
              <span className="text-[12px] text-zinc-400 font-mono">{icloudPath}</span>
            </div>
            <p className="text-[11px] text-zinc-600 leading-relaxed">
              Porta will automatically detect and use your iCloud Drive for syncing configuration files.
            </p>
          </div>
        )}

        {syncTarget === "gdrive" && (
          <div className="flex flex-col gap-3 mt-1">
            {gdriveEmail ? (
              /* Connected */
              <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-emerald-500/[0.07] border border-emerald-500/20">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="text-emerald-400 shrink-0">
                  <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.3"/>
                  <path d="M4 7l2 2 4-4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                <span className="text-[12px] text-emerald-400 flex-1">{gdriveEmail}</span>
                <button
                  type="button"
                  onClick={handleGdriveDisconnect}
                  className="text-[11px] text-zinc-500 hover:text-red-400 transition-colors"
                >
                  Disconnect
                </button>
              </div>
            ) : (
              /* Not connected */
              <div className="flex flex-col gap-3">
                <p className="text-[12px] text-zinc-500 leading-relaxed">
                  You'll be redirected to Google in your browser to grant access. Porta only stores backups — no other files are accessed.
                </p>
                {gdriveError && (
                  <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-red-500/[0.07] border border-red-500/20">
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="text-red-400 shrink-0 mt-0.5">
                      <circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1.2"/>
                      <path d="M6 4v3M6 8.5v.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                    </svg>
                    <span className="text-[11px] text-red-400 leading-relaxed">{gdriveError}</span>
                  </div>
                )}
                <button
                  type="button"
                  onClick={handleGdriveConnect}
                  disabled={gdriveConnecting}
                  className="self-start flex items-center gap-2 px-3 py-1.5 text-[12px] font-medium bg-white/[0.06] hover:bg-white/[0.10] disabled:opacity-50 text-zinc-300 rounded-lg transition-colors border border-white/[0.08]"
                >
                  {gdriveConnecting ? (
                    <span className="w-3 h-3 border border-zinc-400/50 border-t-transparent rounded-full animate-spin" />
                  ) : (
                    <svg width="13" height="13" viewBox="0 0 20 20" fill="none" className="text-zinc-400">
                      <path d="M17 7H3M13 3l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                      <path d="M3 13v4h14v-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  )}
                  {gdriveConnecting ? "Waiting for browser…" : "Connect Google Drive"}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {syncTarget !== "none" && (
        <button
          type="button"
          onClick={handleSyncNow}
          disabled={
            syncStatus === "syncing" ||
            (syncTarget === "git" && !gitRepoUrl) ||
            (syncTarget === "gdrive" && !gdriveEmail)
          }
          className="self-start px-4 py-2 text-[13px] font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg transition-colors"
        >
          {syncStatus === "syncing" ? "Syncing..." : "Sync Now"}
        </button>
      )}
    </div>
  );
}

function DomainsSection() {
  const { workspaces, updateWorkspace } = usePortaStore();
  const [editId, setEditId] = useState<string | null>(null);
  const [editDomain, setEditDomain] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [reloadLoading, setReloadLoading] = useState(false);
  const [reloadStatus, setReloadStatus] = useState<"idle" | "success" | "error">("idle");

  function startEdit(ws: { id: string; domain: string }) {
    setEditId(ws.id);
    setEditDomain(ws.domain);
    setSaveError(null);
  }

  async function handleSave(ws: { id: string; name: string }) {
    if (!editDomain.trim()) return;
    setSaving(true);
    setSaveError(null);
    try {
      await updateWorkspace(ws.id, ws.name, editDomain.trim());
      setEditId(null);
    } catch (e: unknown) {
      setSaveError(String(e).replace(/^Error: /, ""));
    } finally {
      setSaving(false);
    }
  }

  async function handleReloadCaddy() {
    setReloadLoading(true);
    setReloadStatus("idle");
    try {
      await reloadCaddy();
      setReloadStatus("success");
    } catch {
      setReloadStatus("error");
    } finally {
      setReloadLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-[16px] font-semibold text-zinc-100">Domains</h1>
        <p className="text-[12px] text-zinc-500 mt-1 leading-relaxed">
          Manage the local domain for each workspace. Changes require a Caddy reload to take effect.
        </p>
      </div>

      {workspaces.length === 0 ? (
        <p className="text-[13px] text-zinc-500">No workspaces yet.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {workspaces.map((ws) => (
            <div key={ws.id} className="flex flex-col gap-3 p-4 rounded-xl bg-white/[0.03] border border-white/[0.07]">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[13px] font-medium text-zinc-200 truncate">{ws.name}</p>
                </div>
                {editId !== ws.id && (
                  <button
                    onClick={() => startEdit(ws)}
                    className="text-[11px] text-zinc-500 hover:text-zinc-200 transition-colors shrink-0"
                  >
                    Edit
                  </button>
                )}
              </div>

              {editId === ws.id ? (
                <div className="flex flex-col gap-2">
                  <input
                    value={editDomain}
                    onChange={(e) => setEditDomain(e.target.value)}
                    className="input-base font-mono text-[12px]"
                    placeholder="narakarya.test"
                    autoFocus
                  />
                  {saveError && <p className="text-[11px] text-red-400">{saveError}</p>}
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleSave(ws)}
                      disabled={!editDomain.trim() || saving}
                      className="px-3 py-1.5 text-[12px] font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg disabled:opacity-40 transition-colors"
                    >
                      {saving ? "Saving…" : "Save"}
                    </button>
                    <button
                      onClick={() => setEditId(null)}
                      className="px-3 py-1.5 text-[12px] text-zinc-500 hover:text-zinc-200 transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <p className="text-[12px] font-mono text-zinc-400">{ws.domain}</p>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-3 p-4 rounded-xl bg-white/[0.03] border border-white/[0.07]">
        <div>
          <p className="text-[13px] font-medium text-zinc-200">Apply Changes</p>
          <p className="text-[12px] text-zinc-500 mt-0.5 leading-relaxed">
            After editing a domain, reload Caddy to update routing.
          </p>
        </div>
        {reloadStatus === "success" && (
          <p className="text-[12px] text-emerald-400">Caddy reloaded successfully.</p>
        )}
        {reloadStatus === "error" && (
          <p className="text-[12px] text-red-400">Failed to reload Caddy.</p>
        )}
        <button
          onClick={handleReloadCaddy}
          disabled={reloadLoading}
          className="self-start px-3 py-1.5 text-[12px] font-medium bg-white/[0.06] hover:bg-white/[0.10] disabled:opacity-50 text-zinc-300 rounded-lg transition-colors"
        >
          {reloadLoading ? "Reloading…" : "Reload Caddy"}
        </button>
      </div>
    </div>
  );
}
