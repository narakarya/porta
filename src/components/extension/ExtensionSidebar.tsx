import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { usePortaStore } from "../../store";
import { detectAppTags, getExtensionsForApp, rescanExtensions } from "../../lib/commands";
import type { ExtensionInfo } from "../../types/extension";
import { ExtensionIcon } from "./ExtensionIcon";

const ExtensionModal = lazy(() => import("../app/ExtensionModal"));

type SidebarToast = { message: string; kind: "success" | "error" } | null;

export default function ExtensionSidebar() {
  const { sidebar, apps, open, close, openSettingsSection } = usePortaStore(
    useShallow((s) => ({
      sidebar: s.extensionSidebar,
      apps: s.apps,
      open: s.openExtensionSidebar,
      close: s.closeExtensionSidebar,
      openSettingsSection: s.openSettingsSection,
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

  const app = apps.find((a) => a.id === sidebar.appId);
  if (!app) return null;
  const currentApp = app;

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
              <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.4" />
              <path
                d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.3 3.3l1.4 1.4M11.3 11.3l1.4 1.4M12.7 3.3l-1.4 1.4M4.7 11.3l-1.4 1.4"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
              />
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
          {sidebar.extensions.map((ext) => (
            <button
              key={ext.id}
              onClick={() => setActiveExt(ext)}
              className="w-full text-left p-3 rounded-lg border border-white/[0.05] hover:bg-white/[0.04] hover:border-violet-500/20 transition-colors group"
            >
              <div className="flex items-start gap-2.5">
                <div className="mt-0.5">
                  <ExtensionIcon extension={ext} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline justify-between gap-1">
                    <span className="text-[12px] font-medium text-zinc-200 truncate">{ext.name}</span>
                    <span className="text-[10px] text-zinc-600 shrink-0">v{ext.version}</span>
                  </div>
                  {ext.description && (
                    <p className="text-[11px] text-zinc-500 mt-0.5 line-clamp-2 leading-snug">{ext.description}</p>
                  )}
                </div>
              </div>
            </button>
          ))}
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
