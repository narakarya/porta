import { useState, useEffect, useRef } from "react";
import { exportData, importData, listBackups, restoreBackup, saveFile, revealInFinder, exportFullBackup, importFullBackup, getPortaEnv } from "../../lib/commands";
import { yieldToFrame } from "../../lib/ui";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export default function BackupSection() {
  const [exportStatus, setExportStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [exportError, setExportError] = useState<string>("");
  const [exportedPath, setExportedPath] = useState<string | null>(null);

  const [backups, setBackups] = useState<string[]>([]);
  const [backupsLoading, setBackupsLoading] = useState(true);
  const [restoreStatus, setRestoreStatus] = useState<Record<string, "idle" | "loading" | "success" | "error">>({});

  const [importStatus, setImportStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [importError, setImportError] = useState<string>("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Full DB backup/restore
  const [portaEnv, setPortaEnv] = useState<string>("prod");
  const [fullExportStatus, setFullExportStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [fullExportPath, setFullExportPath] = useState<string | null>(null);
  const [fullImportStatus, setFullImportStatus] = useState<"idle" | "loading" | "success" | "error">("idle");

  useEffect(() => {
    getPortaEnv().then(setPortaEnv).catch(() => {});
    listBackups()
      .then(setBackups)
      .catch(() => setBackups([]))
      .finally(() => setBackupsLoading(false));
  }, []);

  async function handleExport() {
    setExportError("");
    setExportedPath(null);
    const date = new Date().toISOString().slice(0, 10);
    const env = portaEnv === "dev" ? "-dev" : "";
    let savePath: string | null = null;
    if (isTauri) {
      const { save: saveDialog } = await import("@tauri-apps/plugin-dialog");
      savePath = await saveDialog({
        defaultPath: `porta${env}-backup-${date}.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
    } else {
      savePath = `porta${env}-backup-${date}.json`;
    }
    if (!savePath) return;
    setExportStatus("loading");
    await yieldToFrame();
    try {
      const json = await exportData();
      await saveFile(savePath, json);
      setExportedPath(savePath);
      setExportStatus("success");
    } catch (err: unknown) {
      setExportStatus("error");
      setExportError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleRestore(filename: string) {
    if (!window.confirm(`Restore from ${filename}? This will replace your current database. You'll need to reload the app.`)) return;
    setRestoreStatus((prev) => ({ ...prev, [filename]: "loading" }));
    await yieldToFrame();
    try {
      await restoreBackup(filename);
      setRestoreStatus((prev) => ({ ...prev, [filename]: "success" }));
    } catch {
      setRestoreStatus((prev) => ({ ...prev, [filename]: "error" }));
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportStatus("loading");
    setImportError("");
    const reader = new FileReader();
    reader.onload = () => {
      if (!window.confirm("This will replace ALL existing data. Continue?")) {
        setImportStatus("idle");
        return;
      }
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

  async function handleFullExport() {
    setFullExportPath(null);
    const date = new Date().toISOString().slice(0, 10);
    const env = portaEnv === "dev" ? "-dev" : "";
    let savePath: string | null = null;
    if (isTauri) {
      const { save: saveDialog } = await import("@tauri-apps/plugin-dialog");
      savePath = await saveDialog({
        defaultPath: `porta${env}-backup-${date}.db`,
        filters: [{ name: "Porta Database", extensions: ["db"] }],
      });
    }
    if (!savePath) return;
    setFullExportStatus("loading");
    await yieldToFrame();
    try {
      await exportFullBackup(savePath);
      setFullExportPath(savePath);
      setFullExportStatus("success");
    } catch {
      setFullExportStatus("error");
    }
  }

  async function handleFullImportDialog() {
    let selected: string | null = null;
    if (isTauri) {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      selected = await openDialog({
        multiple: false,
        filters: [{ name: "Porta Database", extensions: ["db"] }],
      }) as string | null;
    }
    if (typeof selected !== "string" || !selected) return;
    if (!window.confirm(`Import "${selected.split("/").pop()}" and replace all current data? A backup will be created first. You'll need to restart the app.`)) return;
    setFullImportStatus("loading");
    await yieldToFrame();
    try {
      await importFullBackup(selected);
      setFullImportStatus("success");
    } catch {
      setFullImportStatus("error");
    }
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

      {/* Full DB backup card — primary */}
      <div className="flex flex-col gap-4 p-5 rounded-xl bg-white/[0.03] border border-white/[0.07]">
        <div className="flex items-start gap-4">
          <div className="w-9 h-9 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center shrink-0">
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" className="text-emerald-400">
              <ellipse cx="10" cy="5" rx="7" ry="2.5" stroke="currentColor" strokeWidth="1.5"/>
              <path d="M3 5v5c0 1.38 3.13 2.5 7 2.5s7-1.12 7-2.5V5" stroke="currentColor" strokeWidth="1.5"/>
              <path d="M3 10v5c0 1.38 3.13 2.5 7 2.5s7-1.12 7-2.5v-5" stroke="currentColor" strokeWidth="1.5"/>
            </svg>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <p className="text-[13px] font-medium text-zinc-200">Full Backup</p>
              <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                portaEnv === "dev" ? "bg-amber-500/15 text-amber-400" : "bg-emerald-500/15 text-emerald-400"
              }`}>{portaEnv}</span>
            </div>
            <p className="text-[12px] text-zinc-500 mt-0.5 leading-relaxed">
              Export or import the complete Porta database — all workspaces, apps, services, settings, and profiles. Use this to migrate to a new machine.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <button
            onClick={handleFullExport}
            disabled={fullExportStatus === "loading"}
            className="px-4 py-2 text-[13px] font-medium bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white rounded-lg transition-colors flex items-center gap-1.5"
          >
            {fullExportStatus === "loading" && (
              <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.3" />
                <path d="M14 8a6 6 0 00-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            )}
            {fullExportStatus === "loading" ? "Exporting..." : "Export Database"}
          </button>
          <button
            onClick={handleFullImportDialog}
            disabled={fullImportStatus === "loading"}
            className="px-4 py-2 text-[13px] font-medium bg-white/[0.06] hover:bg-white/[0.10] disabled:opacity-50 text-zinc-300 rounded-lg transition-colors flex items-center gap-1.5"
          >
            {fullImportStatus === "loading" && (
              <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.3" />
                <path d="M14 8a6 6 0 00-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            )}
            {fullImportStatus === "loading" ? "Importing..." : "Import Database"}
          </button>
          {fullExportStatus === "success" && fullExportPath && (
            <div className="flex items-center gap-2">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="text-emerald-400 shrink-0">
                <path d="M2 6l2.5 2.5 5.5-5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              <span className="text-[12px] text-emerald-400 font-mono truncate max-w-[180px]" title={fullExportPath}>
                {fullExportPath.split("/").pop()}
              </span>
              <button
                onClick={() => revealInFinder(fullExportPath)}
                className="text-[11px] text-zinc-500 hover:text-zinc-200 underline underline-offset-2 transition-colors shrink-0"
              >
                Show in Finder
              </button>
            </div>
          )}
          {fullExportStatus === "error" && (
            <span className="text-[12px] text-red-400">Export failed</span>
          )}
          {fullImportStatus === "success" && (
            <span className="text-[12px] text-emerald-400">Imported! Restart the app to apply.</span>
          )}
          {fullImportStatus === "error" && (
            <span className="text-[12px] text-red-400">Import failed</span>
          )}
        </div>
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
            className="self-start px-4 py-2 text-[13px] font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg transition-colors flex items-center gap-1.5"
          >
            {exportStatus === "loading" && (
              <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.3" />
                <path d="M14 8a6 6 0 00-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            )}
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
                      className="px-2.5 py-1 text-[12px] font-medium bg-white/[0.06] hover:bg-white/[0.10] disabled:opacity-50 disabled:cursor-not-allowed text-zinc-300 rounded-md transition-colors flex items-center gap-1.5"
                    >
                      {status === "loading" && (
                        <svg className="w-3 h-3 animate-spin" viewBox="0 0 16 16" fill="none">
                          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.3" />
                          <path d="M14 8a6 6 0 00-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                        </svg>
                      )}
                      {status === "loading" ? "Restoring..." : "Restore"}
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
            className="self-start px-4 py-2 text-[13px] font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg transition-colors flex items-center gap-1.5"
          >
            {importStatus === "loading" && (
              <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.3" />
                <path d="M14 8a6 6 0 00-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            )}
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
