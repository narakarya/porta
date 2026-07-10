import { useEffect } from "react";

interface Shortcut {
  keys: string[];
  desc: string;
}

interface Group {
  title: string;
  items: Shortcut[];
}

/**
 * Single source of truth for the keyboard cheatsheet. Each entry has to
 * correspond to a real handler somewhere else — when we add a new global
 * key, we add a line here too.
 */
const GROUPS: Group[] = [
  {
    title: "Global",
    items: [
      { keys: ["⌘", "K"], desc: "Open command palette" },
      { keys: ["⌘", "?"], desc: "Open this help" },
      { keys: ["⌘", ","], desc: "Open Settings" },
      { keys: ["⌘", "⇧", "M"], desc: "Toggle resource drawer" },
      { keys: ["⌘", "F"], desc: "Focus filter (in workspace view)" },
      { keys: ["/"],      desc: "Focus filter (without modifier)" },
      { keys: ["Esc"],    desc: "Close modal / clear filter" },
    ],
  },
  {
    title: "Workspace",
    items: [
      { keys: ["⌘", "Click"], desc: "Toggle selection on an app or service card" },
      { keys: ["Esc"],         desc: "Clear all selections (apps + services)" },
    ],
  },
  {
    title: "Git Manager extension",
    items: [
      { keys: ["1"], desc: "Status tab" },
      { keys: ["2"], desc: "Branches tab" },
      { keys: ["3"], desc: "Sync tab" },
      { keys: ["4"], desc: "History tab" },
      { keys: ["5"], desc: "Rebase tab" },
      { keys: ["6"], desc: "Stash tab" },
      { keys: ["R"], desc: "Refresh active tab" },
      { keys: ["⌘", "Enter"], desc: "Commit (inside the commit textarea)" },
    ],
  },
];

interface Props { onClose: () => void; }

export default function HelpModal({ onClose }: Props) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 bg-black/55 backdrop-blur-sm z-[80] flex items-center justify-center p-6"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-[#1a1a1c] border border-white/[0.10] rounded-2xl w-full max-w-2xl max-h-[80vh] overflow-hidden shadow-2xl flex flex-col">
        <div className="flex items-center gap-3 px-5 py-3 border-b border-white/[0.06]">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="text-blue-400">
            <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.3"/>
            <path d="M5.5 5.5a1.5 1.5 0 113 0c0 1-1.5 1-1.5 2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
            <circle cx="7" cy="10" r="0.6" fill="currentColor"/>
          </svg>
          <h1 className="text-[13px] font-semibold text-zinc-100 flex-1">Keyboard shortcuts</h1>
          <button
            onClick={onClose}
            className="p-1 text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.06] rounded-md transition-colors"
            title="Close (Esc)"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
            </svg>
          </button>
        </div>

        <div className="overflow-y-auto p-5 space-y-5">
          {GROUPS.map((g) => (
            <section key={g.title}>
              <h2 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-2">{g.title}</h2>
              <ul className="space-y-1.5">
                {g.items.map((s, i) => (
                  <li key={i} className="flex items-center gap-3 text-[12px]">
                    <span className="flex items-center gap-1.5 shrink-0">
                      {s.keys.map((k, j) => (
                        <kbd
                          key={j}
                          className="inline-block px-1.5 py-0.5 text-[10px] font-mono bg-white/[0.06] border border-white/[0.10] rounded text-zinc-300 min-w-[20px] text-center"
                        >
                          {k}
                        </kbd>
                      ))}
                    </span>
                    <span className="text-zinc-400 flex-1">{s.desc}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <div className="px-5 py-2.5 border-t border-white/[0.06] text-[10px] text-zinc-600">
          Missing a shortcut you want? File an issue at <span className="text-zinc-500 font-mono">narakarya/porta</span>.
        </div>
      </div>
    </div>
  );
}
