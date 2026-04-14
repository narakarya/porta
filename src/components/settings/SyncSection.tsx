import { useState, useEffect } from "react";
import { gitSyncGetRepo, gitSyncSetRepo, gitSyncTest, gitSyncPush, gitSyncDisconnect } from "../../lib/commands";

type SyncStatus = "idle" | "connected" | "syncing" | "synced" | "error";

export default function SyncSection() {
  const [gitRepoUrl, setGitRepoUrl] = useState("");
  const [savedUrl, setSavedUrl] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("idle");
  const [lastSynced, setLastSynced] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testSuccess, setTestSuccess] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  // Load existing repo on mount
  useEffect(() => {
    gitSyncGetRepo().then((url) => {
      if (url) {
        setSavedUrl(url);
        setGitRepoUrl(url);
        setSyncStatus("connected");
      }
    }).catch(() => {});
  }, []);

  async function handleSaveRepo() {
    if (!gitRepoUrl.trim()) return;
    setSaving(true);
    setSyncError(null);
    setSaveSuccess(false);
    try {
      await gitSyncSetRepo(gitRepoUrl.trim());
      setSavedUrl(gitRepoUrl.trim());
      setSyncStatus("connected");
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (e) {
      setSyncError(String(e).replace(/^Error: /, ""));
      setSyncStatus("error");
    } finally {
      setSaving(false);
    }
  }

  async function handleTestConnection() {
    setTesting(true);
    setSyncError(null);
    setTestSuccess(false);
    try {
      await gitSyncTest();
      setTestSuccess(true);
      setTimeout(() => setTestSuccess(false), 3000);
    } catch (e) {
      setSyncError(String(e).replace(/^Error: /, ""));
      setSyncStatus("error");
    } finally {
      setTesting(false);
    }
  }

  async function handleSyncNow() {
    setSyncStatus("syncing");
    setSyncError(null);
    try {
      const ts = await gitSyncPush();
      if (ts.startsWith("No changes")) {
        setLastSynced(ts);
      } else {
        setLastSynced(new Date(ts).toLocaleString());
      }
      setSyncStatus("synced");
    } catch (e) {
      setSyncStatus("error");
      setSyncError(String(e).replace(/^Error: /, ""));
    }
  }

  async function handleDisconnect() {
    await gitSyncDisconnect();
    setSavedUrl(null);
    setSyncStatus("idle");
    setLastSynced(null);
    setSyncError(null);
  }

  const isConnected = savedUrl !== null;

  const statusColor: Record<SyncStatus, string> = {
    idle: "text-zinc-500",
    connected: "text-blue-400",
    synced: "text-emerald-400",
    syncing: "text-amber-400",
    error: "text-red-400",
  };

  const statusLabel: Record<SyncStatus, string> = {
    idle: "Not configured",
    connected: "Connected",
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
          Keep your Porta configuration in sync across multiple machines via a Git repository.
        </p>
      </div>

      {/* Status indicator */}
      <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-white/[0.02] border border-white/[0.04]">
        <div className="flex items-center gap-2">
          <span className={`inline-block w-1.5 h-1.5 rounded-full ${
            syncStatus === "synced" ? "bg-emerald-400" :
            syncStatus === "syncing" ? "bg-amber-400 animate-pulse" :
            syncStatus === "connected" ? "bg-blue-400" :
            syncStatus === "error" ? "bg-red-400" :
            "bg-zinc-600"
          }`} />
          <span className={`text-[12px] ${statusColor[syncStatus]}`}>{statusLabel[syncStatus]}</span>
        </div>
        {lastSynced && (
          <span className="text-[11px] text-zinc-600">Last sync: {lastSynced}</span>
        )}
      </div>

      {/* Git config */}
      <div className="flex flex-col gap-4 p-5 rounded-xl bg-white/[0.03] border border-white/[0.07]">
        <div className="flex items-start gap-4">
          <div className="w-9 h-9 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center shrink-0">
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" className="text-blue-400">
              <path d="M3 10a7 7 0 0112.9-3.8M17 10a7 7 0 01-12.9 3.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              <path d="M15 3v4h-4M5 17v-4h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          <div className="flex-1">
            <p className="text-[13px] font-medium text-zinc-200">Git Repository</p>
            <p className="text-[12px] text-zinc-500 mt-0.5 leading-relaxed">
              Porta will push and pull your configuration from a private Git repository.
            </p>
          </div>
          {isConnected && (
            <button
              type="button"
              onClick={handleDisconnect}
              className="text-[11px] text-zinc-600 hover:text-red-400 transition-colors shrink-0"
            >
              Disconnect
            </button>
          )}
        </div>

        {isConnected ? (
          /* Connected state */
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-500/[0.07] border border-emerald-500/20">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="text-emerald-400 shrink-0">
                <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.3"/>
                <path d="M4 7l2 2 4-4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              <span className="text-[12px] text-emerald-400 font-mono truncate flex-1">{savedUrl}</span>
            </div>
          </div>
        ) : (
          /* Not connected */
          <div className="flex flex-col gap-3">
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
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleSaveRepo}
                disabled={!gitRepoUrl.trim() || saving}
                className="px-3 py-1.5 text-[12px] font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors flex items-center gap-1.5"
              >
                {saving && <span className="w-3 h-3 border border-white/50 border-t-transparent rounded-full animate-spin" />}
                {saving ? "Connecting..." : "Connect"}
              </button>
              {saveSuccess && (
                <span className="flex items-center gap-1.5 text-[12px] text-emerald-400">
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l2.5 2.5 5.5-5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  Connected!
                </span>
              )}
              {isConnected && (
                <button
                  type="button"
                  onClick={handleTestConnection}
                  disabled={testing}
                  className="px-3 py-1.5 text-[12px] font-medium bg-white/[0.06] hover:bg-white/[0.10] disabled:opacity-50 text-zinc-300 rounded-lg transition-colors"
                >
                  {testing ? "Testing..." : "Test Connection"}
                </button>
              )}
            </div>
          </div>
        )}

        {syncError && (
          <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-red-500/[0.07] border border-red-500/20">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="text-red-400 shrink-0 mt-0.5">
              <circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1.2"/>
              <path d="M6 4v3M6 8.5v.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
            </svg>
            <span className="text-[11px] text-red-400 leading-relaxed">{syncError}</span>
          </div>
        )}
      </div>

      {/* Sync actions */}
      {isConnected && (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleSyncNow}
            disabled={syncStatus === "syncing"}
            className="px-4 py-2 text-[13px] font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors flex items-center gap-1.5"
          >
            {syncStatus === "syncing" && <span className="w-3 h-3 border border-white/50 border-t-transparent rounded-full animate-spin" />}
            {syncStatus === "syncing" ? "Syncing..." : "Sync Now"}
          </button>
          <button
            type="button"
            onClick={handleTestConnection}
            disabled={testing || syncStatus === "syncing"}
            className="px-3 py-2 text-[12px] font-medium bg-white/[0.06] hover:bg-white/[0.10] disabled:opacity-50 text-zinc-300 rounded-lg transition-colors flex items-center gap-1.5"
          >
            {testing && <span className="w-3 h-3 border border-white/50 border-t-transparent rounded-full animate-spin" />}
            {testing ? "Testing..." : "Test Connection"}
          </button>
          {testSuccess && (
            <span className="flex items-center gap-1.5 text-[12px] text-emerald-400 animate-in fade-in">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l2.5 2.5 5.5-5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
              Connection OK
            </span>
          )}
          {syncStatus === "synced" && lastSynced && !testSuccess && (
            <span className="flex items-center gap-1.5 text-[12px] text-emerald-400">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l2.5 2.5 5.5-5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
              {lastSynced}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
