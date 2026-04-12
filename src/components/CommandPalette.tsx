import { useEffect, useRef, useState, useCallback } from "react";
import { usePortaStore } from "../store";
import { openInEditor } from "../lib/commands";

interface CommandPaletteProps {
  onOpenSettings: () => void;
}

interface Command {
  id: string;
  label: string;
  hint?: string;
  section: "Apps" | "Workspaces" | "Navigation";
  icon: string;
  run: () => void;
}

export default function CommandPalette({ onOpenSettings }: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const { apps, workspaces, startApp, stopApp, selectWorkspace } = usePortaStore();

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Build commands from store state
  const commands: Command[] = [
    // App commands
    ...apps.flatMap((app): Command[] => {
      const appCmds: Command[] = [];

      if (app.status === "stopped") {
        appCmds.push({
          id: `start-${app.id}`,
          label: `Start ${app.name}`,
          hint: `port ${app.port}`,
          section: "Apps",
          icon: "▶",
          run: () => { startApp(app.id); setOpen(false); },
        });
      } else {
        appCmds.push({
          id: `stop-${app.id}`,
          label: `Stop ${app.name}`,
          hint: app.status === "starting" ? "starting…" : `port ${app.port}`,
          section: "Apps",
          icon: "■",
          run: () => { stopApp(app.id); setOpen(false); },
        });
      }

      appCmds.push({
        id: `editor-${app.id}`,
        label: `Open ${app.name} in Editor`,
        hint: app.root_dir.split("/").slice(-2).join("/"),
        section: "Apps",
        icon: "✎",
        run: () => { openInEditor(app.root_dir).catch(() => {}); setOpen(false); },
      });

      return appCmds;
    }),

    // Workspace commands
    ...workspaces.map((ws): Command => ({
      id: `workspace-${ws.id}`,
      label: `Switch to ${ws.name}`,
      hint: ws.domain,
      section: "Workspaces",
      icon: "⊞",
      run: () => { selectWorkspace(ws.id); setOpen(false); },
    })),

    // Navigation commands
    {
      id: "open-settings",
      label: "Open Settings",
      section: "Navigation",
      icon: "⚙",
      run: () => { onOpenSettings(); setOpen(false); },
    },
  ];

  // Filter by query
  const filtered = query.trim() === ""
    ? commands
    : commands.filter((c) =>
        c.label.toLowerCase().includes(query.toLowerCase())
      );

  // Group by section
  const allSections: Array<{ title: Command["section"]; items: Command[] }> = [
    { title: "Apps" as const, items: filtered.filter((c) => c.section === "Apps") },
    { title: "Workspaces" as const, items: filtered.filter((c) => c.section === "Workspaces") },
    { title: "Navigation" as const, items: filtered.filter((c) => c.section === "Navigation") },
  ];
  const sections = allSections.filter((g) => g.items.length > 0);

  // Flat list for keyboard navigation
  const flatItems = sections.flatMap((g) => g.items);

  // Reset active index when filtered results change
  useEffect(() => {
    setActiveIndex(0);
  }, [query, open]);

  // Scroll active item into view
  useEffect(() => {
    if (!listRef.current) return;
    const active = listRef.current.querySelector<HTMLElement>("[data-active='true']");
    active?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  // Global ⌘K listener
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
        setQuery("");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Auto-focus input when opened
  useEffect(() => {
    if (open) {
      // Defer to let the DOM render first
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      close();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, flatItems.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      flatItems[activeIndex]?.run();
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh] bg-black/60 backdrop-blur-sm"
      onClick={close}
    >
      <div
        className="w-full max-w-[480px] bg-[#1c1c1e] border border-white/[0.10] rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Search input */}
        <div className="flex items-center px-3 border-b border-white/[0.08]">
          <span className="text-zinc-500 mr-2 text-sm">⌕</span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search commands…"
            className="flex-1 bg-transparent py-3 text-[13px] text-zinc-100 placeholder-zinc-600 outline-none"
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              className="text-zinc-600 hover:text-zinc-400 text-xs px-1"
            >
              ✕
            </button>
          )}
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-[300px] overflow-y-auto py-1">
          {flatItems.length === 0 ? (
            <div className="px-3 py-6 text-center text-[12px] text-zinc-600">
              No commands found
            </div>
          ) : (
            sections.map((group) => {
              // Track global offset for this group
              const groupStartIndex = flatItems.indexOf(group.items[0]);
              return (
                <div key={group.title}>
                  <div className="text-[10px] text-zinc-600 uppercase tracking-wider px-3 py-1 mt-1 select-none">
                    {group.title}
                  </div>
                  {group.items.map((cmd, i) => {
                    const globalIdx = groupStartIndex + i;
                    const isActive = globalIdx === activeIndex;
                    return (
                      <div
                        key={cmd.id}
                        data-active={isActive ? "true" : undefined}
                        className={`flex items-center gap-2.5 px-3 py-2 text-[13px] text-zinc-200 rounded-lg cursor-pointer mx-1 transition-colors ${
                          isActive ? "bg-white/[0.08]" : "hover:bg-white/[0.05]"
                        }`}
                        onMouseEnter={() => setActiveIndex(globalIdx)}
                        onClick={() => cmd.run()}
                      >
                        <span className="text-zinc-500 text-[11px] w-4 text-center flex-shrink-0">
                          {cmd.icon}
                        </span>
                        <span className="flex-1 truncate">{cmd.label}</span>
                        {cmd.hint && (
                          <span className="text-zinc-600 text-[11px] truncate max-w-[120px]">
                            {cmd.hint}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>

        {/* Footer hint */}
        <div className="flex items-center gap-3 px-3 py-2 border-t border-white/[0.06] text-[10px] text-zinc-700">
          <span><kbd className="font-mono">↑↓</kbd> navigate</span>
          <span><kbd className="font-mono">↵</kbd> select</span>
          <span><kbd className="font-mono">esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
