import type { ReactNode } from "react";
import Sidebar from "./Sidebar";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen bg-[#111113] text-zinc-100 font-sans overflow-hidden">
      {/* Transparent drag region at the top for window dragging */}
      <div className="drag-region fixed top-0 left-0 right-0 h-8 z-10 pointer-events-none" />
      <Sidebar />
      <main className="flex-1 overflow-auto pt-8 px-6 pb-6 no-drag">
        {children}
      </main>
    </div>
  );
}
