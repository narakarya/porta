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
      {/* Title bar */}
      <div className="drag-region fixed top-0 left-0 right-0 h-10 z-10 flex items-center bg-[#111113]/80 backdrop-blur-md border-b border-white/[0.04]">
        {/* Traffic light spacer (macOS) */}
        <div className="w-[200px] shrink-0" />

        {/* Search trigger */}
        <button
          onClick={() => {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
          }}
          className="no-drag flex items-center gap-2 px-3 py-1 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] transition-colors ml-2 group"
        >
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" className="text-zinc-600 group-hover:text-zinc-400 transition-colors">
            <circle cx="5" cy="5" r="3.5" stroke="currentColor" strokeWidth="1.2"/>
            <path d="M8 8l2.5 2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
          </svg>
          <span className="text-[11px] text-zinc-600 group-hover:text-zinc-400 transition-colors">Search</span>
          <kbd className="text-[10px] text-zinc-700 bg-white/[0.04] border border-white/[0.06] rounded px-1 py-0.5 font-sans leading-none">⌘K</kbd>
        </button>

        {/* Center — status */}
        <div className="flex-1 flex items-center justify-center gap-2">
          <span className="text-[11px] font-medium text-zinc-500">Porta</span>
          <span className="text-zinc-700">·</span>
          <span className="flex items-center gap-1.5 text-[11px]">
            <span className={`w-1.5 h-1.5 rounded-full ${running > 0 ? "bg-emerald-400 pulse-dot" : "bg-zinc-600"}`} />
            <span className={running > 0 ? "text-emerald-400/80" : "text-zinc-600"}>
              {running}/{total} running
            </span>
          </span>
        </div>

        {/* Settings */}
        <button
          onClick={onOpenSettings}
          className="no-drag p-1.5 rounded-lg text-zinc-600 hover:text-zinc-300 hover:bg-white/[0.06] transition-colors mr-3"
          title="Settings"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <circle cx="7" cy="7" r="2.2" stroke="currentColor" strokeWidth="1.2"/>
            <path d="M7 1.5v1.2M7 11.3v1.2M1.5 7h1.2M11.3 7h1.2M3.1 3.1l.85.85M10.05 10.05l.85.85M10.9 3.1l-.85.85M3.95 10.05l-.85.85" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
          </svg>
        </button>
      </div>

      <Sidebar onOpenSettings={onOpenSettings} />
      <main className="flex-1 overflow-y-auto overflow-x-hidden pt-10 px-6 pb-6 no-drag">
        {children}
      </main>
    </div>
  );
}
