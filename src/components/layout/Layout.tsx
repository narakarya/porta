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
      {showSidebar && <Sidebar />}
      <main className={`flex-1 overflow-y-auto overflow-x-hidden px-6 py-6 no-drag transition-[padding-right] duration-200 ${extSidebarOpen ? "pr-[272px]" : ""}`}>
        {children}
      </main>
      <ExtensionSidebar />
    </div>
  );
}
