import { useEffect, type ReactNode } from "react";
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
  const extSidebarOpen = usePortaStore((s) => s.extensionSidebar !== null);
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
    <div className="flex h-screen bg-[#111113] text-zinc-100 font-sans overflow-hidden">
      <Sidebar onOpenSettings={onOpenSettings} />
      <main className={`flex-1 overflow-hidden no-drag transition-[padding-right] duration-200 ${extSidebarOpen ? "pr-[260px]" : ""}`}>
        {children}
      </main>
      <ResourceDrawer />
      <ExtensionSidebar />
    </div>
  );
}
