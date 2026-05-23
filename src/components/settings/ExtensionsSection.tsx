import { useEffect, useState } from "react";
import {
  listExtensions,
  installExtensionFromFolder,
  installExtensionFromGithub,
  setExtensionEnabled,
  uninstallExtension,
} from "../../lib/commands";
import type { ExtensionInfo } from "../../lib/commands";

export default function ExtensionsSection() {
  const [extensions, setExtensions] = useState<ExtensionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [githubUrl, setGithubUrl] = useState("");
  const [githubInstalling, setGithubInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmUninstall, setConfirmUninstall] = useState<string | null>(null);

  const reload = async () => {
    setLoading(true);
    try {
      setExtensions(await listExtensions());
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { reload(); }, []);

  const handleInstallFromFolder = async () => {
    setError(null);
    let selected: string | null = null;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const result = await open({ directory: true, title: "Select extension folder" });
      selected = typeof result === "string" ? result : null;
    } catch {
      return;
    }
    if (!selected) return;
    setInstalling(true);
    try {
      const ext = await installExtensionFromFolder(selected);
      setExtensions((prev) => {
        const filtered = prev.filter((e) => e.id !== ext.id);
        return [...filtered, ext].sort((a, b) => a.name.localeCompare(b.name));
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setInstalling(false);
    }
  };

  const handleInstallFromGithub = async () => {
    const url = githubUrl.trim();
    if (!url) return;
    setGithubInstalling(true);
    setError(null);
    try {
      const ext = await installExtensionFromGithub(url);
      setExtensions((prev) => {
        const filtered = prev.filter((e) => e.id !== ext.id);
        return [...filtered, ext].sort((a, b) => a.name.localeCompare(b.name));
      });
      setGithubUrl("");
    } catch (e) {
      setError(String(e));
    } finally {
      setGithubInstalling(false);
    }
  };

  const handleToggle = async (id: string, enabled: boolean) => {
    try {
      await setExtensionEnabled(id, enabled);
      setExtensions((prev) => prev.map((e) => (e.id === id ? { ...e, enabled } : e)));
    } catch (e) {
      setError(String(e));
    }
  };

  const handleUninstall = async (id: string) => {
    try {
      await uninstallExtension(id);
      setExtensions((prev) => prev.filter((e) => e.id !== id));
    } catch (e) {
      setError(String(e));
    } finally {
      setConfirmUninstall(null);
    }
  };

  return (
    <div className="flex flex-col gap-6 max-w-2xl">
      {/* Header */}
      <div>
        <h1 className="text-[15px] font-semibold text-zinc-100 mb-1">Extensions</h1>
        <p className="text-[12px] text-zinc-500">
          Install custom extensions to add functionality to Porta.
        </p>
      </div>

      {/* Install actions */}
      <div className="flex flex-col gap-3">
        {/* From folder */}
        <div className="flex items-center gap-3">
          <button
            onClick={handleInstallFromFolder}
            disabled={installing || githubInstalling}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.07] hover:bg-white/[0.11] border border-white/[0.08] text-[12px] text-zinc-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
          >
            {installing ? (
              <svg className="animate-spin" width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M6 1A5 5 0 1 1 1 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
              </svg>
            )}
            {installing ? "Installing…" : "Install from folder…"}
          </button>
          <span className="text-[11px] text-zinc-600">
            Folder must contain a <code className="text-zinc-500">porta.json</code> manifest
          </span>
        </div>

        {/* From GitHub */}
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-0 rounded-lg border border-white/[0.08] bg-white/[0.04] overflow-hidden">
            <span className="px-2.5 text-[11px] text-zinc-600 select-none border-r border-white/[0.08] py-1.5">
              GitHub
            </span>
            <input
              type="text"
              value={githubUrl}
              onChange={(e) => setGithubUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleInstallFromGithub(); }}
              placeholder="owner/repo or https://github.com/owner/repo"
              className="bg-transparent text-[12px] text-zinc-200 placeholder-zinc-600 px-2.5 py-1.5 outline-none w-[320px]"
              disabled={githubInstalling || installing}
            />
          </div>
          <button
            onClick={handleInstallFromGithub}
            disabled={!githubUrl.trim() || githubInstalling || installing}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.07] hover:bg-white/[0.11] border border-white/[0.08] text-[12px] text-zinc-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {githubInstalling ? (
              <svg className="animate-spin" width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M6 1A5 5 0 1 1 1 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M3 6h6M7 4l2 2-2 2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            )}
            {githubInstalling ? "Fetching…" : "Install"}
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="text-red-400 mt-0.5 shrink-0">
            <circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1.4"/>
            <path d="M6 3.5v3M6 8.5v.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
          </svg>
          <p className="text-[11px] text-red-400 font-mono break-all">{error}</p>
        </div>
      )}

      {/* Extension list */}
      {loading ? (
        <div className="flex flex-col gap-2">
          {[0, 1].map((i) => (
            <div
              key={i}
              className="h-16 rounded-xl bg-white/[0.03] border border-white/[0.05] animate-pulse"
              style={{ animationDelay: `${i * 80}ms` }}
            />
          ))}
        </div>
      ) : extensions.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-12 text-zinc-600">
          <svg width="32" height="32" viewBox="0 0 32 32" fill="none" className="opacity-40">
            <path d="M13 5h6v3c0 1.7 1.3 3 3 3s3-1.3 3-3V5h4a2 2 0 012 2v5h-3c-1.7 0-3 1.3-3 3s1.3 3 3 3h3v5a2 2 0 01-2 2h-4v-3c0-1.7-1.3-3-3-3s-3 1.3-3 3v3h-5a2 2 0 01-2-2v-5h3c1.7 0 3-1.3 3-3s-1.3-3-3-3H8V7a2 2 0 012-2z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
          </svg>
          <p className="text-[12px]">No extensions installed</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {extensions.map((ext) => (
            <ExtensionCard
              key={ext.id}
              ext={ext}
              onToggle={handleToggle}
              onUninstall={() => setConfirmUninstall(ext.id)}
            />
          ))}
        </div>
      )}

      {/* Uninstall confirmation */}
      {confirmUninstall && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-[#1c1c1e] border border-white/[0.08] rounded-xl p-5 w-[320px] flex flex-col gap-4 shadow-2xl">
            <div className="flex flex-col gap-1">
              <p className="text-[13px] font-semibold text-zinc-100">Uninstall extension?</p>
              <p className="text-[12px] text-zinc-500">
                This will remove <span className="text-zinc-300">{confirmUninstall}</span> and delete its files from disk.
              </p>
            </div>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setConfirmUninstall(null)}
                className="px-3 py-1.5 rounded-lg text-[12px] text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.05] transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => handleUninstall(confirmUninstall)}
                className="px-3 py-1.5 rounded-lg text-[12px] bg-red-500/20 hover:bg-red-500/30 text-red-400 border border-red-500/20 transition-colors"
              >
                Uninstall
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ExtensionCard({
  ext,
  onToggle,
  onUninstall,
}: {
  ext: ExtensionInfo;
  onToggle: (id: string, enabled: boolean) => void;
  onUninstall: () => void;
}) {
  return (
    <div className={`flex items-center gap-3 px-4 py-3 rounded-xl border transition-colors ${
      ext.enabled
        ? "bg-white/[0.03] border-white/[0.06]"
        : "bg-transparent border-white/[0.04] opacity-60"
    }`}>
      {/* Puzzle piece icon */}
      <div className="w-8 h-8 rounded-lg bg-violet-500/10 border border-violet-500/20 flex items-center justify-center shrink-0">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="text-violet-400">
          <path d="M5.5 2h3v1.5c0 .8.7 1.5 1.5 1.5s1.5-.7 1.5-1.5V2H12a1 1 0 0 1 1 1v1.5h-1.5C10.7 4.5 10 5.2 10 6s.7 1.5 1.5 1.5H13V9a1 1 0 0 1-1 1h-1.5v-1.5C10.5 7.7 9.8 7 9 7s-1.5.7-1.5 1.5V10H6a1 1 0 0 1-1-1V7.5H3.5C2.7 7.5 2 6.8 2 6s.7-1.5 1.5-1.5H5V3a1 1 0 0 1 1-1z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"/>
        </svg>
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium text-zinc-100 truncate">{ext.name}</span>
          <span className="text-[10px] text-zinc-600 shrink-0">v{ext.version}</span>
        </div>
        {ext.description && (
          <p className="text-[11px] text-zinc-500 truncate mt-0.5">{ext.description}</p>
        )}
        <p className="text-[10px] text-zinc-700 font-mono mt-0.5">{ext.id}</p>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 shrink-0">
        {/* Enable/disable toggle */}
        <button
          onClick={() => onToggle(ext.id, !ext.enabled)}
          className={`relative w-8 h-4.5 rounded-full border transition-colors ${
            ext.enabled
              ? "bg-violet-500/30 border-violet-500/40"
              : "bg-white/[0.06] border-white/[0.1]"
          }`}
          title={ext.enabled ? "Disable" : "Enable"}
          style={{ minWidth: "32px", height: "18px" }}
        >
          <span
            className={`absolute top-[2px] w-3.5 h-3.5 rounded-full transition-all ${
              ext.enabled
                ? "left-[calc(100%-16px)] bg-violet-400"
                : "left-[2px] bg-zinc-500"
            }`}
            style={{ width: "14px", height: "14px" }}
          />
        </button>

        {/* Uninstall */}
        <button
          onClick={onUninstall}
          className="p-1.5 rounded-md text-zinc-600 hover:text-red-400 hover:bg-red-500/10 transition-colors"
          title="Uninstall"
        >
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
            <path d="M1 2.5h9M4 2.5V1.5a.5.5 0 01.5-.5h2a.5.5 0 01.5.5v1M8.5 2.5l-.5 7a.5.5 0 01-.5.5H3.5a.5.5 0 01-.5-.5l-.5-7" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
          </svg>
        </button>
      </div>
    </div>
  );
}
