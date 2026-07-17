import { useEffect, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { usePortaStore } from "../../store";
import Sidebar from "./Sidebar";
import ExtensionSidebar from "../extension/ExtensionSidebar";
import ResourceDrawer from "./ResourceDrawer";

interface Props {
  children: ReactNode;
}

export default function Layout({ children }: Props) {
  // Derive counts via selector so Layout only re-renders when running/total count
  // flips, not on every apps array mutation (metrics tick etc).
  const { running, extSidebarOpen, drawerOpen, activeDomain } = usePortaStore(
    useShallow((s) => ({
      running: s.apps.filter((a) => a.status === "running").length,
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
      {/* Slim title/drag strip — spans the content area right of the rail (+ sidebar in workspaces).
          Search lives in the Command Palette (⌘K); this strip only provides window drag,
          traffic-light clearance, and a quiet resource status chip on the right. */}
      <div className={`drag-region fixed top-0 ${showSidebar ? "left-[270px]" : "left-[54px]"} right-0 h-11 z-10 flex items-center justify-end bg-[#0d0d0f]/70 backdrop-blur-md border-b border-white/[0.03]`}>
        {/* Resource status chip — subtle, opens the resource drawer (⌘⇧M) */}
        <button
          onClick={toggleDrawer}
          title="Resources (⌘⇧M)"
          className={`no-drag mr-3 flex items-center gap-2 pl-2 pr-2.5 py-1 rounded-control border transition-colors ${
            drawerOpen
              ? "text-ink bg-white/[0.08] border-white/[0.10]"
              : "text-ink-3 hover:text-ink-2 bg-white/[0.03] hover:bg-white/[0.06] border-subtle"
          }`}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${running > 0 ? "bg-ok" : "bg-zinc-700"}`} />
          <span className="text-[10px] tabular-nums leading-none">
            <span className="text-ink-2 font-medium">{running}</span>
            <span className="text-ink-3"> running</span>
          </span>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="shrink-0 opacity-80">
            <path d="M1.5 9.5l2.5-4 2.5 2.5 4-6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
      </div>

      {/* Sidebar-top drag region (only when the workspaces sidebar shows) */}
      {showSidebar && <div className="drag-region fixed top-0 left-[54px] w-[216px] h-11 z-10" />}

      {showSidebar && <Sidebar />}
      <main className={`flex-1 overflow-y-auto overflow-x-hidden pt-14 px-6 pb-6 no-drag transition-[padding-right] duration-200 ${extSidebarOpen ? "pr-[272px]" : ""}`}>
        {children}
      </main>
      <ResourceDrawer />
      <ExtensionSidebar />
    </div>
  );
}
