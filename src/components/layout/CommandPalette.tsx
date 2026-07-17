import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { usePortaStore } from "../../store";
import { openInEditor } from "../../lib/commands";
import { useExtensionInvoke } from "../extension/ExtensionHostManager";

interface CommandPaletteProps {
  onOpenSettings: () => void;
  onShowShortcuts?: () => void;
}

type CommandSection =
  | "Recent"
  | "Apps"
  | "Extensions"
  | "Workspaces"
  | "Hosts"
  | "Services"
  | "Actions";

interface Command {
  id: string;
  label: string;
  hint?: string;
  section: CommandSection;
  icon: React.ReactNode;
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
  const indexSet = new Set(indices);
  // Two-tone label: verb (first word) reads in text-ink, the target name
  // (everything after the first space) dims to text-ink-2. Fuzzy-matched
  // characters still take precedence with the accent tint.
  const splitIdx = text.indexOf(" ");

  const styleKey = (i: number): "match" | "dim" | "base" => {
    if (indexSet.has(i)) return "match";
    if (splitIdx >= 0 && i > splitIdx) return "dim";
    return "base";
  };

  const parts: { text: string; kind: "match" | "dim" | "base" }[] = [];
  let current = "";
  let kind = styleKey(0);

  for (let i = 0; i < text.length; i++) {
    const k = styleKey(i);
    if (k !== kind) {
      if (current) parts.push({ text: current, kind });
      current = "";
      kind = k;
    }
    current += text[i];
  }
  if (current) parts.push({ text: current, kind });

  return (
    <>
      {parts.map((p, i) => (
        <span
          key={i}
          className={
            p.kind === "match"
              ? "text-accent-ink"
              : p.kind === "dim"
                ? "text-ink-2"
                : undefined
          }
        >
          {p.text}
        </span>
      ))}
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

// ── Icons ─────────────────────────────────────────────────────────────────
// Inline line-icons, one coherent stroke family (16px, stroke-width ~1.3,
// currentColor so they inherit the row's token-based text color). Matches the
// app's existing icon style (see GlobalRail / AppWorkbench / PublishTab).

const ICON = {
  search: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M10.4 10.4l3.1 3.1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  ),
  start: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M5.5 3.5l6 4.5-6 4.5v-9z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  ),
  stop: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <rect x="4" y="4" width="8" height="8" rx="1.4" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  ),
  editor: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M11 2.5l2.5 2.5M2.5 13.5l.7-2.8 8-8a1.2 1.2 0 0 1 1.6 0l.7.7a1.2 1.2 0 0 1 0 1.6l-8 8-2.8.7z" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  external: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M12 8.7v3.3a1.3 1.3 0 0 1-1.3 1.3H3.8A1.3 1.3 0 0 1 2.5 12V5.3A1.3 1.3 0 0 1 3.8 4h3.3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 2.5h3.5V6M13.5 2.5L7.5 8.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  extension: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M6 2.5a1.3 1.3 0 112.6 0V4h2.4a.6.6 0 01.6.6V7h1.4a1.3 1.3 0 110 2.6H11.6V13a.6.6 0 01-.6.6H8.6V12a1.3 1.3 0 10-2.6 0v1.6H3.4a.6.6 0 01-.6-.6V9.6H4a1.3 1.3 0 100-2.6H2.8V4.6A.6.6 0 013.4 4H6V2.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  ),
  workspace: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <rect x="2" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <rect x="9" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <rect x="2" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <rect x="9" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  ),
  server: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <rect x="2.5" y="2.5" width="11" height="4.5" rx="1.2" stroke="currentColor" strokeWidth="1.3" />
      <rect x="2.5" y="9" width="11" height="4.5" rx="1.2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4.7 4.75h.01M4.7 11.25h.01" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  ),
  database: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <ellipse cx="8" cy="3.8" rx="4.5" ry="1.8" stroke="currentColor" strokeWidth="1.3" />
      <path d="M3.5 3.8v8.4c0 1 2 1.8 4.5 1.8s4.5-.8 4.5-1.8V3.8" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M3.5 8c0 1 2 1.8 4.5 1.8s4.5-.8 4.5-1.8" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  ),
  settings: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="2.2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 1.5v1.7M8 12.8v1.7M14.5 8h-1.7M3.2 8H1.5M12.6 3.4l-1.2 1.2M4.6 11.4l-1.2 1.2M12.6 12.6l-1.2-1.2M4.6 4.6L3.4 3.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  ),
  shortcuts: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <rect x="2" y="4" width="12" height="8" rx="1.4" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4.5 6.5h.01M7 6.5h.01M9.5 6.5h.01M11.5 6.5h.01M5 9.5h6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  ),
} as const;

// ── Main component ──────────────────────────────────────────────────────────

export default function CommandPalette({ onOpenSettings, onShowShortcuts }: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const { apps, workspaces, services, sshHosts, startApp, stopApp, selectWorkspace, setActiveDomain, connectOrFocusSsh, loadSshHosts, appExtensions, openExtensionSidebar } = usePortaStore(
    useShallow((s) => ({
      apps: s.apps,
      workspaces: s.workspaces,
      services: s.services,
      sshHosts: s.sshHosts,
      startApp: s.startApp,
      stopApp: s.stopApp,
      selectWorkspace: s.selectWorkspace,
      setActiveDomain: s.setActiveDomain,
      connectOrFocusSsh: s.connectOrFocusSsh,
      loadSshHosts: s.loadSshHosts,
      appExtensions: s.appExtensions,
      openExtensionSidebar: s.openExtensionSidebar,
    }))
  );
  const { invokeAction } = useExtensionInvoke();

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
          icon: ICON.start,
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
          icon: ICON.stop,
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
        icon: ICON.editor,
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
          icon: ICON.external,
          statusColor,
          searchTokens: searchBase,
          run: tracked(`url-${app.id}`, () => {
            window.open(url, "_blank");
          }),
        });
      }
    }

    // Extension appAction commands — one per action of each enabled extension
    // matching an app. Runs headlessly; falls back to opening the panel if the
    // extension didn't register the command.
    for (const app of apps) {
      const exts = appExtensions[app.id] ?? [];
      for (const ext of exts) {
        if (!ext.enabled) continue;
        for (const action of ext.contributes_app_actions ?? []) {
          const id = `extaction-${app.id}-${ext.id}-${action.id}`;
          cmds.push({
            id,
            label: `${action.label} · ${app.name}`,
            hint: ext.name,
            section: "Extensions",
            icon: ICON.extension,
            searchTokens: `${action.label} ${action.id} ${ext.name} ${ext.id} ${app.name}`,
            run: tracked(id, () => {
              invokeAction(app, ext, action.id).catch((e) => {
                if (e instanceof Error && e.message === "__unregistered__") {
                  openExtensionSidebar(app.id, exts, ext.id);
                }
              });
            }),
          });
        }
      }
    }

    // Workspace commands
    for (const ws of workspaces) {
      cmds.push({
        id: `workspace-${ws.id}`,
        label: `Switch to ${ws.name}`,
        hint: ws.domain,
        section: "Workspaces",
        icon: ICON.workspace,
        searchTokens: `${ws.name} ${ws.domain}`,
        run: tracked(`workspace-${ws.id}`, () => { selectWorkspace(ws.id); setActiveDomain("workspaces"); }),
      });
    }

    // Go to — navigation to hosts and services domains.
    for (const host of sshHosts) {
      cmds.push({
        id: `goto-host-${host.id}`,
        label: `Go to ${host.label}`,
        hint: host.hostname,
        section: "Hosts",
        icon: ICON.server,
        searchTokens: `${host.label} ${host.hostname} ${host.username ?? ""} host ssh`,
        run: tracked(`goto-host-${host.id}`, () => {
          setActiveDomain("hosts");
          connectOrFocusSsh(host.id).catch(() => {});
        }),
      });
    }

    for (const svc of services) {
      cmds.push({
        id: `goto-service-${svc.id}`,
        label: `Go to ${svc.name}`,
        hint: svc.image,
        section: "Services",
        icon: ICON.database,
        searchTokens: `${svc.name} ${svc.image} service`,
        run: tracked(`goto-service-${svc.id}`, () => {
          setActiveDomain("services");
        }),
      });
    }

    // Static actions
    cmds.push({
      id: "open-settings",
      label: "Open Settings",
      section: "Actions",
      icon: ICON.settings,
      hint: "⌘,",
      run: tracked("open-settings", () => onOpenSettings()),
    });

    if (onShowShortcuts) {
      cmds.push({
        id: "show-shortcuts",
        label: "Show keyboard shortcuts",
        section: "Actions",
        icon: ICON.shortcuts,
        hint: "⌘?",
        searchTokens: "help cheatsheet keys",
        run: tracked("show-shortcuts", () => onShowShortcuts()),
      });
    }

    return cmds;
  }, [apps, workspaces, services, sshHosts, startApp, stopApp, selectWorkspace, setActiveDomain, connectOrFocusSsh, appExtensions, invokeAction, openExtensionSidebar, onOpenSettings, onShowShortcuts, tracked]);

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
      "Extensions",
      "Workspaces",
      "Hosts",
      "Services",
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

  // Auto-focus input when opened + refresh SSH hosts so the "Go to" group is
  // populated even if the hosts domain hasn't been visited yet.
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus());
      loadSshHosts().catch(() => {});
    }
  }, [open, loadSshHosts]);

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
      className="fixed inset-0 z-50 flex items-start justify-center pt-[32px] bg-[rgba(0,0,0,0.35)]"
      onClick={close}
    >
      <div
        className="w-full max-w-[400px] bg-surface-2 border-[0.5px] border-strong rounded-xl shadow-[0_16px_48px_-8px_rgba(0,0,0,0.7)] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Search input */}
        <div className="flex items-center gap-2.5 px-[15px] py-3 border-b-[0.5px] border-white/[0.08]">
          <span className="text-zinc-500 flex-shrink-0 flex items-center">{ICON.search}</span>
          <input
            spellCheck={false}
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search commands..."
            className="flex-1 bg-transparent text-[14px] text-[#e7e7ea] placeholder-zinc-600 outline-none"
          />
          {query ? (
            <button
              onClick={() => setQuery("")}
              className="text-[11px] text-zinc-600 hover:text-zinc-400 border-[0.5px] border-white/[0.08] rounded px-1.5 py-px flex-shrink-0"
            >
              clear
            </button>
          ) : (
            <span className="text-[10px] text-zinc-500 border-[0.5px] border-white/[0.08] rounded px-1.5 py-px flex-shrink-0 select-none">
              esc
            </span>
          )}
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-[320px] overflow-y-auto p-1.5">
          {flatItems.length === 0 ? (
            <div className="px-2 py-6 text-center text-[12px] text-zinc-600">
              No commands found
            </div>
          ) : (
            sections.map((group) => {
              const groupStartIndex = flatItems.indexOf(group.items[0]);
              return (
                <div key={group.title}>
                  <div className="text-[10px] text-zinc-500 uppercase tracking-[0.04em] px-[9px] pt-2 pb-[3px] select-none">
                    {group.title}
                  </div>
                  {group.items.map((cmd, i) => {
                    const globalIdx = groupStartIndex + i;
                    const isActive = globalIdx === activeIndex;
                    return (
                      <div
                        key={`${group.title}-${cmd.id}`}
                        data-active={isActive ? "true" : undefined}
                        className={`flex items-center gap-2.5 px-[9px] py-[7px] text-[13px] text-[#e7e7ea] rounded-[7px] cursor-pointer transition-colors ${
                          isActive
                            ? "bg-blue-400/[0.16]"
                            : "hover:bg-white/[0.05]"
                        }`}
                        onMouseEnter={() => setActiveIndex(globalIdx)}
                        onClick={() => cmd.run()}
                      >
                        <span
                          className={`flex items-center justify-center w-4 flex-shrink-0 ${
                            isActive ? "text-blue-300" : "text-ink-2"
                          }`}
                        >
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
                        {cmd.hint && !isActive && (
                          <span className="text-zinc-500 text-[11px] truncate max-w-[120px]">
                            {cmd.hint}
                          </span>
                        )}
                        {isActive && (
                          <span className="text-[11px] text-zinc-400 flex-shrink-0 leading-none">
                            ↵
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
      </div>
    </div>
  );
}
