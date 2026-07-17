import { type ReactNode } from "react";
import { usePortaStore } from "../../store";
import Sidebar from "./Sidebar";
import ExtensionSidebar from "../extension/ExtensionSidebar";

interface Props {
  children: ReactNode;
}

export default function Layout({ children }: Props) {
  const extSidebarOpen = usePortaStore((s) => s.extensionSidebar !== null);
  const activeDomain = usePortaStore((s) => s.activeDomain);
  const showSidebar = activeDomain === "workspaces";

  return (
    <div className="flex flex-1 min-w-0 bg-[#0d0d0f] text-zinc-100 font-sans overflow-hidden">
      {/* Slim top drag strip — spans the content area right of the rail (+ sidebar
          in workspaces). Provides window drag and traffic-light clearance only. */}
      <div className={`drag-region fixed top-0 ${showSidebar ? "left-[270px]" : "left-[54px]"} right-0 h-11 z-10 bg-[#0d0d0f]/70 backdrop-blur-md border-b border-white/[0.03]`} />

      {/* Sidebar-top drag region (only when the workspaces sidebar shows) */}
      {showSidebar && <div className="drag-region fixed top-0 left-[54px] w-[216px] h-11 z-10" />}

      {showSidebar && <Sidebar />}
      <main className={`flex-1 overflow-y-auto overflow-x-hidden pt-14 px-6 pb-6 no-drag transition-[padding-right] duration-200 ${extSidebarOpen ? "pr-[272px]" : ""}`}>
        {children}
      </main>
      <ExtensionSidebar />
    </div>
  );
}
