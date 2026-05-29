import { lazy, Suspense, useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { usePortaStore } from "../../store";
import { detectAppTags, getExtensionsForApp, rescanExtensions } from "../../lib/commands";
import type { ExtensionInfo } from "../../types/extension";
import { ExtensionIcon } from "./ExtensionIcon";

const ExtensionModal = lazy(() => import("../app/ExtensionModal"));

export default function ExtensionSidebar() {
  const { sidebar, apps, open, close } = usePortaStore(
    useShallow((s) => ({
      sidebar: s.extensionSidebar,
      apps: s.apps,
      open: s.openExtensionSidebar,
      close: s.closeExtensionSidebar,
    }))
  );

  const [activeExt, setActiveExt] = useState<ExtensionInfo | null>(null);
  const [reloading, setReloading] = useState(false);

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

  async function reloadExtensions() {
    if (reloading) return;
    setReloading(true);
    try {
      await rescanExtensions();
      const tags = currentApp.root_dir ? await detectAppTags(currentApp.root_dir).catch(() => [] as string[]) : [];
      const exts = await getExtensionsForApp(currentApp.kind, tags).catch(() => [] as ExtensionInfo[]);
      open(currentApp.id, exts);
      setActiveExt((current) => current ? exts.find((ext) => ext.id === current.id) ?? null : null);
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
            <div className="flex items-center justify-center h-full">
              <span className="text-[11px] text-zinc-600">No extensions available</span>
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
