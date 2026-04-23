import type { ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { usePortaStore } from "../../store";
import Sidebar from "./Sidebar";

interface Props {
  children: ReactNode;
  onOpenSettings: () => void;
}

export default function Layout({ children, onOpenSettings }: Props) {
  // Derive counts via selector so Layout only re-renders when running/total count
  // flips, not on every apps array mutation (metrics tick etc).
  const { running, total } = usePortaStore(
    useShallow((s) => ({
      running: s.apps.filter((a) => a.status === "running").length,
      total: s.apps.length,
    }))
  );

  return (
    <div className="flex h-screen bg-[#111113] text-zinc-100 font-sans overflow-hidden">
      {/* Title bar */}
      <div className="drag-region fixed top-0 left-[200px] right-0 h-11 z-10 flex items-center bg-[#111113]/70 backdrop-blur-md border-b border-white/[0.03]">
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

        {/* Running count — right */}
        <div className="no-drag flex items-center gap-1.5 mr-3">
          <span className={`w-1.5 h-1.5 rounded-full ${running > 0 ? "bg-emerald-400" : "bg-zinc-700"}`} />
          <span className="text-[10px] text-zinc-600 tabular-nums">{running}/{total}</span>
        </div>
      </div>

      {/* Sidebar drag region (traffic lights area) */}
      <div className="drag-region fixed top-0 left-0 w-[200px] h-11 z-10" />

      <Sidebar onOpenSettings={onOpenSettings} />
      <main className="flex-1 overflow-y-auto overflow-x-hidden pt-14 px-6 pb-6 no-drag">
        {children}
      </main>
    </div>
  );
}
