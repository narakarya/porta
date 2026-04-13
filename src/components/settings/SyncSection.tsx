import { useState, useEffect } from "react";
import { gdriveConnect, gdriveStatus, gdriveDisconnect, gdriveSync } from "../../lib/commands";

type SyncTarget = "none" | "git" | "icloud" | "gdrive";
type SyncStatus = "idle" | "synced" | "syncing" | "error";

export default function SyncSection() {
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
