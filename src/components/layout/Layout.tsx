import type { ReactNode } from "react";
import { usePortaStore } from "../../store";
import Sidebar from "./Sidebar";

interface Props {
  children: ReactNode;
  onOpenSettings: () => void;
}

export default function Layout({ children, onOpenSettings }: Props) {
  const { apps } = usePortaStore();
  const running = apps.filter((a) => a.status === "running").length;
  const total = apps.length;

  return (
    <div className="flex h-screen bg-[#111113] text-zinc-100 font-sans overflow-hidden">
      {/* Title bar — compact, drag-only over sidebar */}
      <div className="drag-region fixed top-0 left-[200px] right-0 h-9 z-10 flex items-center justify-between bg-[#111113]/70 backdrop-blur-md border-b border-white/[0.03]">
        {/* Left: search trigger */}
        <button
          onClick={() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }))}
          className="no-drag flex items-center gap-1.5 ml-3 px-2.5 py-1 rounded-md text-zinc-600 hover:text-zinc-400 hover:bg-white/[0.05] transition-colors"
        >
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
            <circle cx="5" cy="5" r="3.5" stroke="currentColor" strokeWidth="1.2"/>
            <path d="M8 8l2.5 2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
          </svg>
          <span className="text-[10px]">⌘K</span>
        </button>

        {/* Center: status */}
        <div className="absolute left-1/2 -translate-x-1/2 flex items-center gap-1.5">
          <span className={`w-1.5 h-1.5 rounded-full ${running > 0 ? "bg-emerald-400" : "bg-zinc-700"}`} />
          <span className="text-[10px] text-zinc-600 tabular-nums">
            {running}/{total}
          </span>
        </div>

        {/* Right: settings */}
        <button
          onClick={onOpenSettings}
          className="no-drag p-1.5 rounded-md text-zinc-700 hover:text-zinc-400 hover:bg-white/[0.05] transition-colors mr-2"
          title="Settings"
        >
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
            <circle cx="7" cy="7" r="2.2" stroke="currentColor" strokeWidth="1.2"/>
            <path d="M7 1.5v1.2M7 11.3v1.2M1.5 7h1.2M11.3 7h1.2M3.1 3.1l.85.85M10.05 10.05l.85.85M10.9 3.1l-.85.85M3.95 10.05l-.85.85" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
          </svg>
        </button>
      </div>

      {/* Sidebar drag region (traffic lights area) */}
      <div className="drag-region fixed top-0 left-0 w-[200px] h-9 z-10" />

      <Sidebar onOpenSettings={onOpenSettings} />
      <main className="flex-1 overflow-y-auto overflow-x-hidden pt-9 px-6 pb-6 no-drag">
        {children}
      </main>
    </div>
  );
}
