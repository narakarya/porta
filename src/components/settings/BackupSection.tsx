import { useState, useEffect } from "react";
import {
  listBackups,
  restoreBackup,
  revealInFinder,
  exportFullBackup,
  importFullBackup,
  getPortaEnv,
  getBackupSchedule,
  setBackupSchedule,
  runBackupNowViaSchedule,
  type BackupSchedule,
  type ScheduleFreq,
} from "../../lib/commands";
import { yieldToFrame } from "../../lib/ui";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function formatRelative(ts: number | null): string {
  if (!ts) return "never";
  const diff = Date.now() / 1000 - ts;
  if (diff < 0) {
    const ahead = -diff;
    if (ahead < 60) return "in <1m";
    if (ahead < 3600) return `in ${Math.round(ahead / 60)}m`;
    if (ahead < 86400) return `in ${Math.round(ahead / 3600)}h`;
    return `in ${Math.round(ahead / 86400)}d`;
  }
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return `${Math.round(diff / 86400)}d ago`;
}

function formatAbsolute(ts: number | null): string {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function BackupSection() {
  const [backups, setBackups] = useState<string[]>([]);
  const [backupsLoading, setBackupsLoading] = useState(true);
  const [restoreStatus, setRestoreStatus] = useState<Record<string, "idle" | "loading" | "success" | "error">>({});

  const [portaEnv, setPortaEnv] = useState<string>("prod");
  const [fullExportStatus, setFullExportStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [fullExportPath, setFullExportPath] = useState<string | null>(null);
  const [fullImportStatus, setFullImportStatus] = useState<"idle" | "loading" | "success" | "error">("idle");

  const [schedule, setSchedule] = useState<BackupSchedule | null>(null);
  const [scheduleSaveStatus, setScheduleSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [runNowStatus, setRunNowStatus] = useState<"idle" | "loading" | "success" | "error">("idle");

  useEffect(() => {
    getPortaEnv().then(setPortaEnv).catch(() => {});
    listBackups()
      .then(setBackups)
      .catch(() => setBackups([]))
      .finally(() => setBackupsLoading(false));
    getBackupSchedule()
      .then(setSchedule)
      .catch(() => {});
  }, []);

  function patchSchedule(p: Partial<BackupSchedule>) {
    setSchedule((prev) => (prev ? { ...prev, ...p } : prev));
    setScheduleSaveStatus("idle");
  }

  async function handleSaveSchedule() {
    if (!schedule) return;
    setScheduleSaveStatus("saving");
    try {
      await setBackupSchedule(schedule);
      const fresh = await getBackupSchedule();
      setSchedule(fresh);
      setScheduleSaveStatus("saved");
      setTimeout(() => setScheduleSaveStatus("idle"), 2500);
    } catch {
      setScheduleSaveStatus("error");
    }
  }

  async function handleRunNow() {
    setRunNowStatus("loading");
    try {
      await runBackupNowViaSchedule();
      const [list, fresh] = await Promise.all([listBackups(), getBackupSchedule()]);
      setBackups(list);
      setSchedule(fresh);
      setRunNowStatus("success");
      setTimeout(() => setRunNowStatus("idle"), 2500);
    } catch {
      setRunNowStatus("error");
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
        <h1 className="text-[16px] font-semibold text-zinc-100">Backup</h1>
        <p className="text-[12px] text-zinc-500 mt-1 leading-relaxed">
          Export the Porta database to migrate machines, or restore from an automatic snapshot.
        </p>
      </div>

      {/* Full DB backup */}
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

      {/* Schedule */}
      <div className="flex flex-col gap-4 p-5 rounded-xl bg-white/[0.03] border border-white/[0.07]">
        <div className="flex items-start gap-4">
          <div className="w-9 h-9 rounded-xl bg-violet-500/10 border border-violet-500/20 flex items-center justify-center shrink-0">
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" className="text-violet-400">
              <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.5" />
              <path d="M10 6v4l2.5 2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </div>
          <div className="flex-1">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-[13px] font-medium text-zinc-200">Schedule</p>
                <p className="text-[12px] text-zinc-500 mt-0.5 leading-relaxed">
                  Run automatic backups on a recurring schedule. Old snapshots are pruned by retention.
                </p>
              </div>
              {schedule && (
                <button
                  onClick={() => patchSchedule({ enabled: !schedule.enabled })}
                  className={`relative w-9 h-5 rounded-full transition-colors shrink-0 mt-0.5 ${
                    schedule.enabled ? "bg-blue-600" : "bg-zinc-700"
                  }`}
                  aria-label="Toggle schedule"
                >
                  <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all ${
                    schedule.enabled ? "left-[18px]" : "left-0.5"
                  }`} />
                </button>
              )}
            </div>
          </div>
        </div>

        {schedule && (
          <>
            <div className="h-px bg-white/[0.05]" />

            {/* Frequency */}
            <div className="flex flex-col gap-2">
              <p className="text-[11px] font-medium text-zinc-500 uppercase tracking-wider">Frequency</p>
              <div className="flex items-center gap-2">
                {(["hourly", "daily", "weekly"] as ScheduleFreq[]).map((freq) => (
                  <label
                    key={freq}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded-lg cursor-pointer text-[12px] border transition-colors ${
                      schedule.frequency === freq
                        ? "bg-blue-500/15 border-blue-500/40 text-blue-300"
                        : "bg-white/[0.02] border-white/[0.05] text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    <input
                      type="radio"
                      name="freq"
                      checked={schedule.frequency === freq}
                      onChange={() => patchSchedule({ frequency: freq })}
                      className="sr-only"
                    />
                    <span className="capitalize">{freq}</span>
                  </label>
                ))}
              </div>
            </div>

            {/* Time picker (Daily / Weekly) */}
            {schedule.frequency !== "hourly" && (
              <div className="flex flex-col gap-2">
                <p className="text-[11px] font-medium text-zinc-500 uppercase tracking-wider">Time</p>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    max={23}
                    value={schedule.hour}
                    onChange={(e) => patchSchedule({ hour: Math.max(0, Math.min(23, parseInt(e.target.value || "0", 10))) })}
                    className="w-16 px-2 py-1.5 text-[12px] bg-white/[0.04] border border-white/[0.08] rounded-md text-zinc-200 focus:outline-none focus:border-blue-500/50"
                  />
                  <span className="text-zinc-500">:</span>
                  <input
                    type="number"
                    min={0}
                    max={59}
                    value={schedule.minute}
                    onChange={(e) => patchSchedule({ minute: Math.max(0, Math.min(59, parseInt(e.target.value || "0", 10))) })}
                    className="w-16 px-2 py-1.5 text-[12px] bg-white/[0.04] border border-white/[0.08] rounded-md text-zinc-200 focus:outline-none focus:border-blue-500/50"
                  />
                  <span className="text-[11px] text-zinc-500 ml-1">24-hour, local time</span>
                </div>
              </div>
            )}

            {/* Hourly: minute only */}
            {schedule.frequency === "hourly" && (
              <div className="flex flex-col gap-2">
                <p className="text-[11px] font-medium text-zinc-500 uppercase tracking-wider">Minute of hour</p>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    max={59}
                    value={schedule.minute}
                    onChange={(e) => patchSchedule({ minute: Math.max(0, Math.min(59, parseInt(e.target.value || "0", 10))) })}
                    className="w-16 px-2 py-1.5 text-[12px] bg-white/[0.04] border border-white/[0.08] rounded-md text-zinc-200 focus:outline-none focus:border-blue-500/50"
                  />
                  <span className="text-[11px] text-zinc-500 ml-1">:MM each hour</span>
                </div>
              </div>
            )}

            {/* Day of week (Weekly) */}
            {schedule.frequency === "weekly" && (
              <div className="flex flex-col gap-2">
                <p className="text-[11px] font-medium text-zinc-500 uppercase tracking-wider">Day of week</p>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {DAY_LABELS.map((label, idx) => (
                    <button
                      key={label}
                      onClick={() => patchSchedule({ day_of_week: idx })}
                      className={`px-3 py-1.5 text-[12px] rounded-md border transition-colors ${
                        schedule.day_of_week === idx
                          ? "bg-blue-500/15 border-blue-500/40 text-blue-300"
                          : "bg-white/[0.02] border-white/[0.05] text-zinc-400 hover:text-zinc-200"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Retention */}
            <div className="flex flex-col gap-2">
              <p className="text-[11px] font-medium text-zinc-500 uppercase tracking-wider">Retention</p>
              <div className="flex items-center gap-2">
                <span className="text-[12px] text-zinc-400">Keep last</span>
                <input
                  type="number"
                  min={1}
                  max={500}
                  value={schedule.retain_count}
                  onChange={(e) => patchSchedule({ retain_count: Math.max(1, Math.min(500, parseInt(e.target.value || "1", 10))) })}
                  className="w-20 px-2 py-1.5 text-[12px] bg-white/[0.04] border border-white/[0.08] rounded-md text-zinc-200 focus:outline-none focus:border-blue-500/50"
                />
                <span className="text-[12px] text-zinc-400">backups</span>
              </div>
            </div>

            <div className="h-px bg-white/[0.05]" />

            {/* Actions + status */}
            <div className="flex items-center gap-3 flex-wrap">
              <button
                onClick={handleSaveSchedule}
                disabled={scheduleSaveStatus === "saving"}
                className="px-4 py-2 text-[13px] font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors"
              >
                {scheduleSaveStatus === "saving" ? "Saving..." : "Save schedule"}
              </button>
              <button
                onClick={handleRunNow}
                disabled={runNowStatus === "loading"}
                className="px-4 py-2 text-[13px] font-medium bg-white/[0.06] hover:bg-white/[0.10] disabled:opacity-50 text-zinc-300 rounded-lg transition-colors"
              >
                {runNowStatus === "loading" ? "Running..." : "Run backup now"}
              </button>
              {scheduleSaveStatus === "saved" && (
                <span className="text-[12px] text-emerald-400">Saved</span>
              )}
              {scheduleSaveStatus === "error" && (
                <span className="text-[12px] text-red-400">Save failed</span>
              )}
              {runNowStatus === "success" && (
                <span className="text-[12px] text-emerald-400">Backup created</span>
              )}
              {runNowStatus === "error" && (
                <span className="text-[12px] text-red-400">Backup failed</span>
              )}
            </div>

            <div className="flex flex-col gap-1 text-[11px] text-zinc-500 leading-relaxed">
              <p>
                <span className="text-zinc-400">Last run:</span> {formatRelative(schedule.last_run_at)}
                {schedule.last_run_at ? <span className="text-zinc-600 ml-1">({formatAbsolute(schedule.last_run_at)})</span> : null}
              </p>
              <p>
                <span className="text-zinc-400">Next run:</span>{" "}
                {schedule.enabled
                  ? `${formatRelative(schedule.next_run_at)} ${schedule.next_run_at ? `(${formatAbsolute(schedule.next_run_at)})` : ""}`
                  : "schedule disabled"}
              </p>
            </div>
          </>
        )}
      </div>

      {/* Auto-backups */}
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
              Porta keeps the last 10 snapshots, taken automatically on data changes. Restore any of them below.
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
    </div>
  );
}
