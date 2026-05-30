import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { usePortaStore } from "../../store";
import {
  detectAppTags,
  getExtensionsForApp,
  rescanExtensions,
  updateExtension,
} from "../../lib/commands";
import type { ExtensionInfo } from "../../types/extension";
import { ExtensionIcon } from "./ExtensionIcon";

const ExtensionModal = lazy(() => import("../app/ExtensionModal"));

type SidebarToast = { message: string; kind: "success" | "error" } | null;

const SEARCH_THRESHOLD = 6;

export default function ExtensionSidebar() {
  const { sidebar, apps, open, close, openSettingsSection, bumpExtensionList } = usePortaStore(
    useShallow((s) => ({
      sidebar: s.extensionSidebar,
      apps: s.apps,
      open: s.openExtensionSidebar,
      close: s.closeExtensionSidebar,
      openSettingsSection: s.openSettingsSection,
      bumpExtensionList: s.bumpExtensionList,
    }))
  );

  const [activeExt, setActiveExt] = useState<ExtensionInfo | null>(null);
  const [reloading, setReloading] = useState(false);
  const [toast, setToast] = useState<SidebarToast>(null);
  const toastTimer = useRef<number | null>(null);

  const showToast = useCallback(
    (message: string, kind: "success" | "error" = "success") => {
      setToast({ message, kind });
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
      toastTimer.current = window.setTimeout(() => setToast(null), 2800);
    },
    []
  );

  useEffect(
    () => () => {
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
    },
    []
  );
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  // null while idle; { index, total } during a sequential update-all run so
  // we can show progress text in the header (instead of a tiny spinning icon).
  const [updatingAll, setUpdatingAll] = useState<{ index: number; total: number } | null>(null);
  const [query, setQuery] = useState("");

  // Close modal when sidebar switches to a different app
  useEffect(() => { setActiveExt(null); }, [sidebar?.appId]);

  // Esc closes modal first, then sidebar
  useEffect(() => {
    if (!sidebar) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (activeExt) setActiveExt(null);
      else close();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [sidebar, activeExt, close]);

  if (!sidebar) return null;
  const currentSidebar = sidebar;

  const app = apps.find((a) => a.id === sidebar.appId);
  if (!app) return null;
  const currentApp = app;

  const q = query.trim().toLowerCase();
  const visible = q
    ? sidebar.extensions.filter((e) =>
        `${e.name} ${e.description ?? ""} ${e.id}`.toLowerCase().includes(q)
      )
    : sidebar.extensions;

  async function refetchList(): Promise<ExtensionInfo[]> {
    const tags = currentApp.root_dir
      ? await detectAppTags(currentApp.root_dir).catch(() => [] as string[])
      : [];
    const exts = await getExtensionsForApp(currentApp.kind, tags);
    open(currentApp.id, exts);
    setActiveExt((current) =>
      current ? exts.find((ext) => ext.id === current.id) ?? null : null
    );
    return exts;
  }

  async function reloadExtensions() {
    if (reloading) return;
    setReloading(true);
    try {
      await rescanExtensions();
      const exts = await refetchList();
      showToast(
        exts.length === 0
          ? "No extensions match this app"
          : `${exts.length} extension${exts.length === 1 ? "" : "s"} loaded`
      );
    } catch {
      showToast("Reload failed", "error");
    } finally {
      setReloading(false);
    }
  }

  async function updateOne(ext: ExtensionInfo) {
    if (updatingId) return;
    setUpdatingId(ext.id);
    const prev = ext.version;
    try {
      const updated = await updateExtension(ext.id);
      await refetchList();
      bumpExtensionList();   // notify Settings → Extensions to re-fetch
      showToast(
        updated.version !== prev
          ? `${ext.name} v${prev}→v${updated.version}`
          : `${ext.name} already up to date`
      );
    } catch {
      showToast(`Update failed: ${ext.name}`, "error");
    } finally {
      setUpdatingId(null);
    }
  }

  async function updateAll() {
    if (updatingAll) return;
    const targets = currentSidebar.extensions.filter((e) => e.source);
    if (targets.length === 0) {
      showToast("Nothing to update");
      return;
    }
    const bumped: string[] = [];
    const failed: string[] = [];
    for (let i = 0; i < targets.length; i++) {
      const ext = targets[i];
      setUpdatingAll({ index: i + 1, total: targets.length });
      try {
        const updated = await updateExtension(ext.id);
        if (updated.version !== ext.version) {
          bumped.push(`${ext.name} v${ext.version}→v${updated.version}`);
        }
      } catch {
        failed.push(ext.name);
      }
    }
    await refetchList();
    bumpExtensionList();   // notify Settings → Extensions to re-fetch
    setUpdatingAll(null);
    if (failed.length) showToast(`Failed: ${failed.join(", ")}`, "error");
    else if (bumped.length) showToast(`Updated: ${bumped.join(", ")}`);
    else showToast("Everything up to date");
  }

  return (
    <>
      <div className="fixed top-11 right-0 bottom-0 w-[260px] flex flex-col bg-[#111113] border-l border-white/[0.06] z-40 shadow-[-8px_0_24px_rgba(0,0,0,0.35)]">
        {/* Header */}
        <div className="flex items-center gap-2 px-3 h-10 border-b border-white/[0.06] shrink-0">
          <ExtensionIcon extension={{ id: "extensions", name: "Extensions" }} size="sm" />
          <div className="flex flex-col flex-1 min-w-0">
            <span className="text-[12px] font-semibold text-zinc-200 leading-tight">Extensions</span>
            <span className="text-[10px] text-zinc-600 truncate leading-tight">{app.name}</span>
          </div>
          {sidebar.extensions.some((e) => e.source) && (
            updatingAll ? (
              // Active progress text — clearer than a tiny spinning icon.
              <span
                className="shrink-0 text-[10px] font-medium text-violet-300/90 tabular-nums px-1.5 py-0.5 rounded bg-violet-500/10"
                title={`Updating extension ${updatingAll.index} of ${updatingAll.total}`}
              >
                {updatingAll.index}/{updatingAll.total}
              </span>
            ) : (
              <button
                onClick={updateAll}
                className="p-1 text-zinc-600 hover:text-zinc-300 hover:bg-white/[0.06] rounded transition-colors shrink-0"
                title="Update all extensions"
              >
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                  <path
                    d="M8 2v7M5 6.5l3 3 3-3"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M3 11.5v1a1 1 0 001 1h8a1 1 0 001-1v-1"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            )
          )}
          <button
            onClick={reloadExtensions}
            disabled={reloading}
            className="p-1 text-zinc-600 hover:text-zinc-300 hover:bg-white/[0.06] rounded transition-colors shrink-0 disabled:opacity-40"
            title="Reload extensions"
          >
            <svg className={reloading ? "animate-spin" : ""} width="13" height="13" viewBox="0 0 16 16" fill="none">
              <path d="M13 8a5 5 0 1 1-1.7-3.7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M13 2v4h-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
          <button
            onClick={() => openSettingsSection("extensions")}
            className="p-1 text-zinc-600 hover:text-zinc-300 hover:bg-white/[0.06] rounded transition-colors shrink-0"
            title="Manage extensions"
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <rect x="2.5" y="3" width="11" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
              <path d="M5 6h6M5 8h6M5 10h3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
          </button>
          <button
            onClick={close}
            className="p-1 text-zinc-600 hover:text-zinc-300 hover:bg-white/[0.06] rounded transition-colors shrink-0"
            title="Close (Esc)"
          >
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
              <path d="M2 2l8 8M10 2L2 10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
            </svg>
          </button>
        </div>

        {sidebar.extensions.length > SEARCH_THRESHOLD && (
          <div className="px-2 pt-2 shrink-0">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search extensions"
              className="w-full px-2.5 py-1.5 text-[11px] bg-white/[0.04] border border-white/[0.06] rounded-md text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-violet-500/30"
            />
          </div>
        )}

        {/* Extension list */}
        <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-1">
          {sidebar.extensions.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full px-3 text-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-white/[0.04] flex items-center justify-center text-zinc-600">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M5.5 1.5h3v1.5c0 .8.7 1.5 1.5 1.5s1.5-.7 1.5-1.5V1.5H12a1 1 0 011 1V4h-1.5C10.7 4 10 4.7 10 5.5s.7 1.5 1.5 1.5H13v1.5a1 1 0 01-1 1h-1.5v-1.5C10.5 7.2 9.8 6.5 9 6.5s-1.5.7-1.5 1.5v1.5H6a1 1 0 01-1-1V7H3.5C2.7 7 2 6.3 2 5.5S2.7 4 3.5 4H5V2.5a1 1 0 011-1z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"/>
                </svg>
              </div>
              <p className="text-[11px] text-zinc-400 leading-snug">No extensions match this app</p>
              <p className="text-[10px] text-zinc-600 leading-snug">
                Install one from Settings → Extensions. Built-in: <code className="text-zinc-500 font-mono">git-manager</code>.
              </p>
            </div>
          )}
          {sidebar.extensions.length > 0 && visible.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full px-3 text-center">
              <p className="text-[11px] text-zinc-500 leading-snug">
                No extensions match "{query}"
              </p>
            </div>
          )}
          {visible.map((ext) => {
            const isUpdating = updatingId === ext.id;
            return (
              <div
                key={ext.id}
                role="button"
                tabIndex={0}
                onClick={() => setActiveExt(ext)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setActiveExt(ext);
                  }
                }}
                aria-busy={isUpdating}
                className={`relative w-full text-left p-3 rounded-lg border border-white/[0.05] hover:bg-white/[0.04] hover:border-violet-500/20 transition-colors group cursor-pointer overflow-hidden ${isUpdating ? "pb-4" : ""}`}
              >
                <div className="flex items-start gap-2.5">
                  <div className="mt-0.5">
                    <ExtensionIcon extension={ext} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline justify-between gap-1">
                      <span className="text-[12px] font-medium text-zinc-200 truncate">{ext.name}</span>
                      <div className="flex items-center gap-1 shrink-0">
                        {!isUpdating && (
                          <span className="text-[10px] text-zinc-600 tabular-nums">
                            v{ext.version}
                          </span>
                        )}
                        {ext.source && !isUpdating && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              updateOne(ext);
                            }}
                            className="p-0.5 text-zinc-600 hover:text-violet-300 hover:bg-white/[0.06] rounded transition-colors"
                            title="Update extension"
                          >
                            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                              <path
                                d="M13 8a5 5 0 1 1-1.7-3.7"
                                stroke="currentColor"
                                strokeWidth="1.6"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                              <path
                                d="M13 2v4h-4"
                                stroke="currentColor"
                                strokeWidth="1.6"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          </button>
                        )}
                      </div>
                    </div>
                    {isUpdating ? (
                      <div className="mt-1 flex items-center gap-1.5 text-[10px] font-medium text-violet-300/90">
                        <span className="spinner !w-2.5 !h-2.5 !border" aria-hidden="true" />
                        <span className="truncate">Updating extension</span>
                      </div>
                    ) : ext.description && (
                      <p className="text-[11px] text-zinc-500 mt-0.5 line-clamp-2 leading-snug">{ext.description}</p>
                    )}
                  </div>
                </div>
                {/* Sweeping progress bar pinned to the card bottom while
                    an update is in flight — replaces the awkward 12px
                    icon spin. */}
                {isUpdating && (
                  <div className="loading-sweep absolute bottom-0 left-[-1px] right-[-1px]" />
                )}
              </div>
            );
          })}
        </div>

        {toast && (
          <div
            className={`mx-2 mb-2 px-3 py-2 rounded-lg text-[11px] font-medium shrink-0 ${
              toast.kind === "success"
                ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/20"
                : "bg-red-500/15 text-red-300 border border-red-500/20"
            }`}
          >
            {toast.message}
          </div>
        )}
      </div>

      {activeExt && (
        <Suspense fallback={null}>
          <ExtensionModal
            app={app}
            extension={activeExt}
            onClose={() => setActiveExt(null)}
          />
        </Suspense>
      )}
    </>
  );
}
