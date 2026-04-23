import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { usePortaStore } from "../../store";
import { openInEditor } from "../../lib/commands";

interface CommandPaletteProps {
  onOpenSettings: () => void;
}

type CommandSection = "Recent" | "Apps" | "Workspaces" | "Actions";

interface Command {
  id: string;
  label: string;
  hint?: string;
  section: CommandSection;
  icon: string;
  run: () => void;
  /** Searchable tokens beyond the label */
  searchTokens?: string;
  /** Status dot color for apps (null = no dot) */
  statusColor?: string | null;
}

// ── Fuzzy matching ──────────────────────────────────────────────────────────

interface FuzzyResult {
  score: number;
  /** Indices in the haystack that matched */
  matchedIndices: number[];
}

/**
 * Simple fuzzy scorer. Consecutive matches score higher.
 * Returns null if not all needle characters are found in order.
 */
function fuzzyMatch(needle: string, haystack: string): FuzzyResult | null {
  const lowerNeedle = needle.toLowerCase();
  const lowerHay = haystack.toLowerCase();

  let score = 0;
  let consecutive = 0;
  let haystackIdx = 0;
  const matchedIndices: number[] = [];

  for (let ni = 0; ni < lowerNeedle.length; ni++) {
    const ch = lowerNeedle[ni];
    let found = false;
    while (haystackIdx < lowerHay.length) {
      if (lowerHay[haystackIdx] === ch) {
        matchedIndices.push(haystackIdx);
        consecutive++;
        // Consecutive bonus grows quadratically
        score += consecutive * consecutive;
        // Bonus for matching at word boundary
        if (haystackIdx === 0 || /\W/.test(haystack[haystackIdx - 1])) {
          score += 5;
        }
        haystackIdx++;
        found = true;
        break;
      }
      consecutive = 0;
      haystackIdx++;
    }
    if (!found) return null;
  }

  // Bonus for shorter haystack (tighter match)
  score += Math.max(0, 20 - haystack.length);

  return { score, matchedIndices };
}

/**
 * Score a command against a query. Checks label + searchTokens.
 * Returns the best score and matched indices (in label only for highlighting).
 */
function scoreCommand(
  cmd: Command,
  query: string,
): { score: number; labelIndices: number[] } | null {
  const labelResult = fuzzyMatch(query, cmd.label);
  const tokenResult = cmd.searchTokens
    ? fuzzyMatch(query, cmd.searchTokens)
    : null;

  if (!labelResult && !tokenResult) return null;

  const labelScore = labelResult?.score ?? 0;
  const tokenScore = tokenResult?.score ?? 0;

  return {
    score: Math.max(labelScore, tokenScore),
    labelIndices: labelResult?.matchedIndices ?? [],
  };
}

// ── Highlighted label ───────────────────────────────────────────────────────

function HighlightedLabel({
  text,
  indices,
}: {
  text: string;
  indices: number[];
}) {
  if (indices.length === 0) return <>{text}</>;

  const indexSet = new Set(indices);
  const parts: { text: string; highlighted: boolean }[] = [];
  let current = "";
  let isHighlighted = indexSet.has(0);

  for (let i = 0; i < text.length; i++) {
    const match = indexSet.has(i);
    if (match !== isHighlighted) {
      if (current) parts.push({ text: current, highlighted: isHighlighted });
      current = "";
      isHighlighted = match;
    }
    current += text[i];
  }
  if (current) parts.push({ text: current, highlighted: isHighlighted });

  return (
    <>
      {parts.map((p, i) =>
        p.highlighted ? (
          <span key={i} className="text-blue-400">
            {p.text}
          </span>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

// ── Recent items localStorage ───────────────────────────────────────────────

const RECENT_KEY = "porta:command-palette:recent";
const MAX_RECENT = 5;

function getRecentIds(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}

function pushRecentId(id: string) {
  const ids = getRecentIds().filter((x) => x !== id);
  ids.unshift(id);
  localStorage.setItem(RECENT_KEY, JSON.stringify(ids.slice(0, MAX_RECENT)));
}

// ── Status dot ──────────────────────────────────────────────────────────────

function StatusDot({ color }: { color: string }) {
  return (
    <span
      className="inline-block w-1.5 h-1.5 rounded-full flex-shrink-0"
      style={{ backgroundColor: color }}
    />
  );
}

// ── Main component ──────────────────────────────────────────────────────────

export default function CommandPalette({ onOpenSettings }: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const { apps, workspaces, startApp, stopApp, selectWorkspace } = usePortaStore(
    useShallow((s) => ({
      apps: s.apps,
      workspaces: s.workspaces,
      startApp: s.startApp,
      stopApp: s.stopApp,
      selectWorkspace: s.selectWorkspace,
    }))
  );

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
  }, []);

  // Wrap run to track recents
  const tracked = useCallback(
    (id: string, fn: () => void) => {
      return () => {
        pushRecentId(id);
        fn();
        close();
      };
    },
    [close],
  );

  // Build commands from store state
  const commands: Command[] = useMemo(() => {
    const cmds: Command[] = [];

    // App commands
    for (const app of apps) {
      const ws = workspaces.find((w) => w.id === app.workspace_id);
      const statusColor =
        app.status === "running"
          ? "#34d399"
          : app.status === "starting"
            ? "#fbbf24"
            : "#6b7280";

      const searchBase = [
        app.name,
        String(app.port),
        app.subdomain ?? "",
        ws?.name ?? "",
        ws?.domain ?? "",
      ].join(" ");

      if (app.status === "stopped") {
        cmds.push({
          id: `start-${app.id}`,
          label: `Start ${app.name}`,
          hint: `port ${app.port}`,
          section: "Apps",
          icon: "▶",
          statusColor,
          searchTokens: searchBase,
          run: tracked(`start-${app.id}`, () => startApp(app.id)),
        });
      } else {
        cmds.push({
          id: `stop-${app.id}`,
          label: `Stop ${app.name}`,
          hint:
            app.status === "starting" ? "starting..." : `port ${app.port}`,
          section: "Apps",
          icon: "■",
          statusColor,
          searchTokens: searchBase,
          run: tracked(`stop-${app.id}`, () => stopApp(app.id)),
        });
      }

      cmds.push({
        id: `editor-${app.id}`,
        label: `Open ${app.name} in Editor`,
        hint: app.root_dir.split("/").slice(-2).join("/"),
        section: "Apps",
        icon: "✎",
        statusColor,
        searchTokens: searchBase,
        run: tracked(`editor-${app.id}`, () => {
          openInEditor(app.root_dir).catch(() => {});
        }),
      });

      // Open URL (only if the app has a subdomain + workspace domain)
      if (app.subdomain && ws?.domain) {
        const url = `https://${app.subdomain}.${ws.domain}`;
        cmds.push({
          id: `url-${app.id}`,
          label: `Open ${app.name} URL`,
          hint: `${app.subdomain}.${ws.domain}`,
          section: "Apps",
          icon: "↗",
          statusColor,
          searchTokens: searchBase,
          run: tracked(`url-${app.id}`, () => {
            window.open(url, "_blank");
          }),
        });
      }
    }

    // Workspace commands
    for (const ws of workspaces) {
      cmds.push({
        id: `workspace-${ws.id}`,
        label: `Switch to ${ws.name}`,
        hint: ws.domain,
        section: "Workspaces",
        icon: "⊞",
        searchTokens: `${ws.name} ${ws.domain}`,
        run: tracked(`workspace-${ws.id}`, () => selectWorkspace(ws.id)),
      });
    }

    // Static actions
    cmds.push({
      id: "open-settings",
      label: "Open Settings",
      section: "Actions",
      icon: "⚙",
      run: tracked("open-settings", () => onOpenSettings()),
    });

    return cmds;
  }, [apps, workspaces, startApp, stopApp, selectWorkspace, onOpenSettings, tracked]);

  // Build filtered + scored results
  const { sections, flatItems } = useMemo(() => {
    const trimmed = query.trim();

    type ScoredCommand = Command & { _score: number; _labelIndices: number[] };

    let scored: ScoredCommand[];

    if (trimmed === "") {
      // No query: show recent section + all commands
      const recentIds = getRecentIds();
      const recentCmds: ScoredCommand[] = [];
      for (const rid of recentIds) {
        const cmd = commands.find((c) => c.id === rid);
        if (cmd)
          recentCmds.push({
            ...cmd,
            section: "Recent" as CommandSection,
            _score: 0,
            _labelIndices: [],
          });
      }

      scored = [
        ...recentCmds,
        ...commands.map(
          (c): ScoredCommand => ({ ...c, _score: 0, _labelIndices: [] }),
        ),
      ];
    } else {
      // Fuzzy filter + sort by score desc
      const results: ScoredCommand[] = [];
      for (const cmd of commands) {
        const res = scoreCommand(cmd, trimmed);
        if (res) {
          results.push({
            ...cmd,
            _score: res.score,
            _labelIndices: res.labelIndices,
          });
        }
      }
      results.sort((a, b) => b._score - a._score);
      scored = results;
    }

    // Group by section in order
    const sectionOrder: CommandSection[] = [
      "Recent",
      "Apps",
      "Workspaces",
      "Actions",
    ];
    const grouped: Array<{
      title: CommandSection;
      items: ScoredCommand[];
    }> = sectionOrder
      .map((title) => ({
        title,
        items: scored.filter((c) => c.section === title),
      }))
      .filter((g) => g.items.length > 0);

    const flat = grouped.flatMap((g) => g.items);

    return { sections: grouped, flatItems: flat };
  }, [query, commands]);

  // Reset active index when filtered results change
  useEffect(() => {
    setActiveIndex(0);
  }, [query, open]);

  // Scroll active item into view
  useEffect(() => {
    if (!listRef.current) return;
    const active =
      listRef.current.querySelector<HTMLElement>("[data-active='true']");
    active?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  // Global Cmd+K listener
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
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

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
            spellCheck={false}
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search commands..."
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
                        key={`${group.title}-${cmd.id}`}
                        data-active={isActive ? "true" : undefined}
                        className={`flex items-center gap-2.5 px-3 py-2 text-[13px] text-zinc-200 rounded-lg cursor-pointer mx-1 transition-colors ${
                          isActive
                            ? "bg-white/[0.08]"
                            : "hover:bg-white/[0.05]"
                        }`}
                        onMouseEnter={() => setActiveIndex(globalIdx)}
                        onClick={() => cmd.run()}
                      >
                        <span className="text-zinc-500 text-[11px] w-4 text-center flex-shrink-0">
                          {cmd.icon}
                        </span>
                        {cmd.statusColor && (
                          <StatusDot color={cmd.statusColor} />
                        )}
                        <span className="flex-1 truncate">
                          <HighlightedLabel
                            text={cmd.label}
                            indices={cmd._labelIndices}
                          />
                        </span>
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
          <span>
            <kbd className="font-mono">↑↓</kbd> navigate
          </span>
          <span>
            <kbd className="font-mono">↵</kbd> select
          </span>
          <span>
            <kbd className="font-mono">esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}
