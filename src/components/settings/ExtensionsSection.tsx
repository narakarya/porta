import { useEffect, useState } from "react";
import {
  listExtensions,
  installExtensionFromFolder,
  installExtensionFromGithub,
  updateExtension,
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
  const [notice, setNotice] = useState<string | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [updatingAll, setUpdatingAll] = useState<{ index: number; total: number } | null>(null);
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

  const handleUpdate = async (id: string) => {
    const prevVersion = extensions.find((e) => e.id === id)?.version;
    setUpdatingId(id);
    setError(null);
    setNotice(null);
    try {
      const ext = await updateExtension(id);
      setExtensions((prev) =>
        prev.map((e) => (e.id === ext.id ? ext : e)).sort((a, b) => a.name.localeCompare(b.name)),
      );
      setNotice(
        prevVersion && prevVersion !== ext.version
          ? `${ext.name} updated v${prevVersion} → v${ext.version}`
          : `${ext.name} is up to date (v${ext.version})`,
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setUpdatingId(null);
    }
  };

  /**
   * Sequentially update every extension that has a remote source. Skips
   * local-folder installs (they have no `source` to re-fetch from). Each
   * step is independent — if one fails, we capture the error and keep
   * going so a single bad remote doesn't strand the rest.
   */
  const handleUpdateAll = async () => {
    const updatable = extensions.filter((e) => e.source);
    if (updatable.length === 0) return;
    setError(null);
    setNotice(null);
    const failed: string[] = [];
    const bumped: string[] = [];
    for (let i = 0; i < updatable.length; i++) {
      const ext = updatable[i];
      setUpdatingAll({ index: i + 1, total: updatable.length });
      try {
        const updated = await updateExtension(ext.id);
        if (updated.version !== ext.version) bumped.push(`${updated.name} → v${updated.version}`);
        setExtensions((prev) =>
          prev.map((e) => (e.id === updated.id ? updated : e)).sort((a, b) => a.name.localeCompare(b.name)),
        );
      } catch (e) {
        failed.push(`${ext.name}: ${String(e).replace(/^Error: /, "")}`);
      }
    }
    setUpdatingAll(null);
    if (failed.length > 0) setError(failed.join(" · "));
    if (bumped.length > 0) setNotice(`Updated: ${bumped.join(", ")}`);
    else if (failed.length === 0) setNotice("All extensions are up to date");
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

  // Only extensions installed from a remote source can be re-fetched —
  // local-folder installs have no URL to pull from.
  const updatableCount = extensions.filter((e) => e.source).length;

  return (
    <div className="flex flex-col gap-6 max-w-2xl">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-[15px] font-semibold text-zinc-100 mb-1">Extensions</h1>
          <p className="text-[12px] text-zinc-500">
            Install custom extensions to add functionality to Porta.
          </p>
        </div>
        {updatableCount > 0 && (
          <button
            onClick={handleUpdateAll}
            disabled={!!updatingAll || !!updatingId}
            className="shrink-0 px-3 py-1.5 rounded-lg text-[12px] font-medium bg-blue-500/10 hover:bg-blue-500/20 text-blue-400 border border-blue-500/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title={`Re-fetch every extension installed from a remote source (${updatableCount})`}
          >
            {updatingAll
              ? `Updating ${updatingAll.index}/${updatingAll.total}…`
              : `Update all (${updatableCount})`}
          </button>
        )}
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

      {notice && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="text-emerald-400 mt-0.5 shrink-0">
            <circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1.4"/>
            <path d="M4 6l1.5 1.5L8.5 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <p className="text-[11px] text-emerald-400">{notice}</p>
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
        <div className="flex flex-col items-center gap-2 py-10 text-center">
          <div className="w-12 h-12 rounded-2xl bg-white/[0.04] flex items-center justify-center text-zinc-600">
            <svg width="22" height="22" viewBox="0 0 32 32" fill="none">
              <path d="M13 5h6v3c0 1.7 1.3 3 3 3s3-1.3 3-3V5h4a2 2 0 012 2v5h-3c-1.7 0-3 1.3-3 3s1.3 3 3 3h3v5a2 2 0 01-2 2h-4v-3c0-1.7-1.3-3-3-3s-3 1.3-3 3v3h-5a2 2 0 01-2-2v-5h3c1.7 0 3-1.3 3-3s-1.3-3-3-3H8V7a2 2 0 012-2z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
            </svg>
          </div>
          <p className="text-[13px] text-zinc-300">No extensions installed</p>
          <p className="text-[11px] text-zinc-500 max-w-xs">
            Use the install actions above. Try{" "}
            <button
              onClick={() => setGithubUrl("narakarya/porta:extensions-bundled/git-manager")}
              className="font-mono text-zinc-400 hover:text-zinc-200 underline decoration-dotted underline-offset-2"
              title="Click to fill the GitHub URL above"
            >
              narakarya/porta:extensions-bundled/git-manager
            </button>{" "}
            for the bundled Git Manager.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {extensions.map((ext) => (
            <ExtensionCard
              key={ext.id}
              ext={ext}
              updating={updatingId === ext.id}
              onUpdate={() => handleUpdate(ext.id)}
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
  updating,
  onUpdate,
  onToggle,
  onUninstall,
}: {
  ext: ExtensionInfo;
  updating: boolean;
  onUpdate: () => void;
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
        {/* Update from source (GitHub installs only) */}
        {ext.source && (
          <button
            onClick={onUpdate}
            disabled={updating}
            className="p-1.5 rounded-md text-zinc-600 hover:text-violet-400 hover:bg-violet-500/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title={`Update from ${ext.source}`}
          >
            {updating ? (
              <svg className="animate-spin" width="11" height="11" viewBox="0 0 11 11" fill="none">
                <path d="M5.5 1A4.5 4.5 0 1 1 1 5.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
              </svg>
            ) : (
              <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                <path d="M9.5 5.5A4 4 0 1 1 5.5 1.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                <path d="M9.5 1.5v4h-4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            )}
          </button>
        )}

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
