import { useEffect, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { usePortaStore } from "../../store";
import Sidebar from "./Sidebar";
import ExtensionSidebar from "../extension/ExtensionSidebar";
import ResourceDrawer from "./ResourceDrawer";

interface Props {
  children: ReactNode;
  onOpenSettings: () => void;
}

export default function Layout({ children, onOpenSettings }: Props) {
  // Derive counts via selector so Layout only re-renders when running/total count
  // flips, not on every apps array mutation (metrics tick etc).
  const { running, total, extSidebarOpen, drawerOpen, activeDomain } = usePortaStore(
    useShallow((s) => ({
      running: s.apps.filter((a) => a.status === "running").length,
      total: s.apps.length,
      extSidebarOpen: s.extensionSidebar !== null,
      drawerOpen: s.resourceDrawerOpen,
      activeDomain: s.activeDomain,
    }))
  );
  const showSidebar = activeDomain === "workspaces";
  const toggleDrawer = usePortaStore((s) => s.toggleResourceDrawer);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey) return;
      if (e.key.toLowerCase() !== "m") return;
      e.preventDefault();
      toggleDrawer();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleDrawer]);

  return (
    <div className="flex flex-1 min-w-0 bg-[#0d0d0f] text-zinc-100 font-sans overflow-hidden">
      {/* Title bar — spans the content area to the right of the rail (+ sidebar in workspaces) */}
      <div className={`drag-region fixed top-0 ${showSidebar ? "left-[270px]" : "left-[54px]"} right-0 h-11 z-10 flex items-center bg-[#0d0d0f]/70 backdrop-blur-md border-b border-white/[0.03]`}>
        {/* Search trigger — wider */}
        <button
          onClick={() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }))}
          className="no-drag flex items-center gap-2 ml-3 px-3 py-1 rounded-md bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] transition-colors flex-1 max-w-xs"
        >
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none" className="text-zinc-600 shrink-0">
            <circle cx="5" cy="5" r="3.5" stroke="currentColor" strokeWidth="1.2"/>
            <path d="M8 8l2.5 2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
          </svg>
          <span className="text-[11px] text-zinc-600 flex-1 text-left">Search...</span>
          <kbd className="text-[10px] text-zinc-700 bg-white/[0.04] border border-white/[0.06] rounded px-1 py-0.5 font-sans leading-none shrink-0">⌘K</kbd>
        </button>

        <div className="flex-1" />

        {/* Running count + resource drawer toggle — right */}
        <div className="no-drag flex items-center gap-2 mr-3">
          <div className="flex items-center gap-1.5">
            <span className={`w-1.5 h-1.5 rounded-full ${running > 0 ? "bg-emerald-400" : "bg-zinc-700"}`} />
            <span className="text-[10px] text-zinc-600 tabular-nums">{running}/{total}</span>
          </div>
          <button
            onClick={toggleDrawer}
            title="Resources (⌘⇧M)"
            className={`p-1 rounded transition-colors ${drawerOpen ? "text-zinc-200 bg-white/[0.08]" : "text-zinc-600 hover:text-zinc-300"}`}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M1.5 9.5l2.5-4 2.5 2.5 4-6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        </div>
      </div>

      {/* Sidebar-top drag region (only when the workspaces sidebar shows) */}
      {showSidebar && <div className="drag-region fixed top-0 left-[54px] w-[216px] h-11 z-10" />}

      {showSidebar && <Sidebar onOpenSettings={onOpenSettings} />}
      <main className={`flex-1 overflow-y-auto overflow-x-hidden pt-14 px-6 pb-6 no-drag transition-[padding-right] duration-200 ${extSidebarOpen ? "pr-[272px]" : ""}`}>
        {children}
      </main>
      <ResourceDrawer />
      <ExtensionSidebar />
    </div>
  );
}
