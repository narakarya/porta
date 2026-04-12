import { useState, useEffect, useRef } from "react";
import SetupWizard from "./SetupWizard";
import { exportData, importData, listBackups, restoreBackup } from "../lib/commands";

type Section = "setup" | "backup";

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
        {activeSection === "backup" && <BackupSection />}
      </main>

      {showSetupWizard && (
        <SetupWizard forceShow onClose={() => setShowSetupWizard(false)} />
      )}
    </div>
  );
}

function SetupSection({ onOpenWizard }: { onOpenWizard: () => void }) {
  return (
    <div className="max-w-[520px] flex flex-col gap-6">
      <div>
        <h1 className="text-[16px] font-semibold text-zinc-100">Setup &amp; Certificates</h1>
        <p className="text-[12px] text-zinc-500 mt-1 leading-relaxed">
          Manage local infrastructure — Caddy reverse proxy, dnsmasq DNS resolver, and mkcert SSL certificates.
        </p>
      </div>

      {/* Card */}
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

function BackupSection() {
  const [exportStatus, setExportStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [exportError, setExportError] = useState<string>("");

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

  function handleExport() {
    setExportStatus("loading");
    setExportError("");
    exportData()
      .then((json) => {
        const date = new Date().toISOString().slice(0, 10);
        const blob = new Blob([json], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `porta-backup-${date}.json`;
        a.click();
        URL.revokeObjectURL(url);
        setExportStatus("success");
        setTimeout(() => setExportStatus("idle"), 3000);
      })
      .catch((err: unknown) => {
        setExportStatus("error");
        setExportError(err instanceof Error ? err.message : String(err));
      });
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
    // Expect filenames like: backup-2026-04-12T10-30-00.json or similar patterns
    const match = filename.match(/(\d{4}-\d{2}-\d{2})/);
    if (match) return match[1];
    return filename;
  }

  return (
    <div className="max-w-[520px] flex flex-col gap-6">
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
            {exportStatus === "loading" ? "Exporting…" : "Export JSON"}
          </button>
          {exportStatus === "success" && (
            <span className="text-[12px] text-emerald-400">Downloaded!</span>
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
          <p className="text-[12px] text-zinc-500">Loading backups…</p>
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
                      {status === "loading" ? "…" : "Restore"}
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
        <input
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
            {importStatus === "loading" ? "Importing…" : "Import from file"}
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
