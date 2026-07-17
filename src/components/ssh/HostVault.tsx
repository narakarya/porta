import { useEffect, useMemo, useRef, useState } from "react";
import { usePortaStore } from "../../store";
import type { SshHost } from "../../lib/commands";
import HostFormModal from "./HostFormModal";
import { OsIcon } from "./OsIcon";
import { SidebarHeader, SidebarBody, SidebarFooter, SidebarGroupHeader, SidebarAddButton } from "../layout/SidebarShell";

type MenuState = { host: SshHost; x: number; y: number };

export default function HostVault() {
  const hosts = usePortaStore((s) => s.sshHosts);
  const workspaces = usePortaStore((s) => s.workspaces);
  const sessions = usePortaStore((s) => s.sshSessions);
  const activeSessionId = usePortaStore((s) => s.activeSessionId);
  const connectOrFocusSsh = usePortaStore((s) => s.connectOrFocusSsh);
  const connectSsh = usePortaStore((s) => s.connectSsh);
  const deleteSshHost = usePortaStore((s) => s.deleteSshHost);

  const [query, setQuery] = useState("");
  const [wsFilter, setWsFilter] = useState(""); // "" = all
  const [filterOpen, setFilterOpen] = useState(false);
  const [editing, setEditing] = useState<SshHost | null>(null);
  const [adding, setAdding] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null); // right-click context menu
  const filterRef = useRef<HTMLDivElement | null>(null);

  const wsName = useMemo(() => new Map(workspaces.map((w) => [w.id, w.name])), [workspaces]);

  // Hosts with at least one live session, and how many.
  const liveCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of sessions) {
      if (s.status === "disconnected") continue;
      m.set(s.hostId, (m.get(s.hostId) ?? 0) + 1);
    }
    return m;
  }, [sessions]);

  // Total live sessions — feeds the header subtitle (mirrors the Workspaces
  // sidebar's "N running" line).
  const activeSessions = useMemo(
    () => sessions.filter((s) => s.status !== "disconnected").length,
    [sessions]
  );

  const list = useMemo(
    () =>
      hosts
        .filter(
          (h) =>
            `${h.label} ${h.hostname} ${h.username}`.toLowerCase().includes(query.toLowerCase()) &&
            (!wsFilter || h.workspace_ids.includes(wsFilter))
        )
        .sort((a, b) => a.label.localeCompare(b.label)),
    [hosts, query, wsFilter]
  );

  // Group the filtered hosts by their free-text `group` field — mirrors how the
  // Workspaces sidebar groups app rows under a workspace header. Ungrouped hosts
  // fall under a default "Hosts" bucket. Named groups sort A→Z; the default
  // bucket sorts last so explicit folders lead.
  const DEFAULT_GROUP = "Hosts";
  const groups = useMemo(() => {
    const m = new Map<string, SshHost[]>();
    for (const h of list) {
      const key = h.group?.trim() || DEFAULT_GROUP;
      const arr = m.get(key);
      if (arr) arr.push(h);
      else m.set(key, [h]);
    }
    return [...m.entries()].sort(([a], [b]) => {
      if (a === DEFAULT_GROUP) return 1;
      if (b === DEFAULT_GROUP) return -1;
      return a.localeCompare(b);
    });
  }, [list]);

  async function onDelete(h: SshHost) {
    let ok = false;
    try {
      const { confirm } = await import("@tauri-apps/plugin-dialog");
      ok = await confirm(`Delete "${h.label}"? This can't be undone.`, { title: "Delete host", kind: "warning" });
    } catch {
      ok = window.confirm(`Delete "${h.label}"?`);
    }
    if (ok) deleteSshHost(h.id);
  }

  // Open the row context menu, anchored at the cursor and clamped to viewport.
  function openMenu(e: React.MouseEvent, host: SshHost) {
    e.preventDefault();
    e.stopPropagation();
    const MENU_W = 184;
    const MENU_H = 172;
    const x = Math.max(8, Math.min(e.clientX, window.innerWidth - MENU_W - 8));
    const y = Math.max(8, Math.min(e.clientY, window.innerHeight - MENU_H - 8));
    setMenu({ host, x, y });
  }

  // Esc closes the context menu (outside-click handled by the backdrop below).
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu]);

  const activeFilterName = wsFilter ? wsName.get(wsFilter) : null;

  const activeHostId = useMemo(
    () => sessions.find((s) => s.id === activeSessionId)?.hostId ?? null,
    [sessions, activeSessionId]
  );

  return (
    <>
      {/* Title header — shared shell with the Workspaces sidebar (drag-region +
          title + subtitle + a "+" affordance), so both domains read the same. */}
      <SidebarHeader>
        <div className="flex-1 min-w-0">
          <div className="no-drag text-[15px] font-semibold text-ink leading-tight">Hosts</div>
          <div className="no-drag text-[11px] text-ink-3 mt-0.5">
            {hosts.length} host{hosts.length === 1 ? "" : "s"}{activeSessions > 0 ? ` · ${activeSessions} active` : ""}
          </div>
        </div>
        <button
          onClick={() => setAdding(true)}
          title="Add host"
          aria-label="Add host"
          className="no-drag text-ink-3 hover:text-ink transition-colors p-1 -mr-1 mt-0.5 rounded"
        >
          <svg width="12" height="12" viewBox="0 0 10 10" fill="none"><path d="M5 2v6M2 5h6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
        </button>
      </SidebarHeader>

      {/* Search + workspace filter — occupies the same slot the Workspaces
          sidebar reserves for its filter bar. */}
      <div className="px-2.5 pb-2 shrink-0 flex items-center gap-1.5">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search hosts…"
          className="flex-1 min-w-0 px-2 py-1 text-[12px] bg-surface-input border border-subtle rounded-control text-ink placeholder:text-ink-3 outline-none focus:border-[rgba(96,165,250,0.5)] transition-colors"
        />
        {workspaces.length > 0 && (
          <div className="relative shrink-0" ref={filterRef}>
            <button
              onClick={() => setFilterOpen((v) => !v)}
              title={activeFilterName ? `Filtered: ${activeFilterName}` : "Filter by workspace"}
              className={`relative flex items-center justify-center w-7 h-7 rounded-control border transition-colors ${
                wsFilter
                  ? "text-accent-ink bg-accent-bg border-[rgba(96,165,250,0.4)]"
                  : "text-ink-3 border-subtle hover:text-ink-2 hover:border-strong"
              }`}
            >
              <svg width="13" height="13" viewBox="0 0 12 12" fill="none">
                <path d="M1 2h10L7 6.5V10L5 9V6.5L1 2z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
              </svg>
              {wsFilter && <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-accent" />}
            </button>
            {filterOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setFilterOpen(false)} />
                <div className="absolute right-0 mt-1 w-44 max-h-64 overflow-y-auto z-50 p-1 bg-surface-2 border border-strong rounded-card shadow-xl">
                  <button
                    onClick={() => { setWsFilter(""); setFilterOpen(false); }}
                    className={`w-full text-left px-2 py-1 text-[12px] rounded-md ${!wsFilter ? "text-accent-ink bg-accent-bg" : "text-ink-2 hover:bg-white/[0.05]"}`}
                  >
                    All workspaces
                  </button>
                  {workspaces.map((w) => (
                    <button
                      key={w.id}
                      onClick={() => { setWsFilter(w.id); setFilterOpen(false); }}
                      className={`w-full text-left px-2 py-1 text-[12px] rounded-md truncate ${wsFilter === w.id ? "text-accent-ink bg-accent-bg" : "text-ink-2 hover:bg-white/[0.05]"}`}
                    >
                      {w.name}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Grouped list — group headers + rows mirror the Workspaces sidebar shell
          (uppercase group header with a muted count + "+" affordance; app-row
          rhythm for the host rows). */}
      <SidebarBody className="flex flex-col gap-0.5 px-2 pt-1">
        {groups.map(([groupName, groupHosts]) => (
          <div key={groupName}>
            {/* Group header — shared shell with the Workspaces sidebar. */}
            <SidebarGroupHeader
              label={groupName}
              count={groupHosts.length}
              onAdd={() => setAdding(true)}
              addTitle="Add host"
              addLabel="Add host"
            />

            {groupHosts.map((h) => {
              const live = liveCount.get(h.id) ?? 0;
              const selected = h.id === activeHostId;
              const menuHere = menu?.host.id === h.id;
              return (
                <div
                  key={h.id}
                  onContextMenu={(e) => openMenu(e, h)}
                  className={`group flex items-center gap-2 pl-1.5 pr-2 py-1.5 rounded-[6px] text-[13px] transition-colors ${
                    selected ? "bg-accent-bg text-ink" : menuHere ? "bg-white/[0.05]" : "text-ink hover:bg-white/[0.05]"
                  }`}
                >
                  <button
                    className="flex-1 min-w-0 text-left flex items-center gap-2.5"
                    onClick={() => connectOrFocusSsh(h.id)}
                    title={live ? `Focus session · ${h.username}@${h.hostname}:${h.port}` : `Connect ${h.username}@${h.hostname}:${h.port}`}
                  >
                    {/* Leading OS badge — fixed width, vertically centred against
                        the two-line identity block so every row aligns. */}
                    <span className="shrink-0 flex items-center justify-center w-5" title={h.detected_os ?? undefined}>
                      <OsIcon os={h.detected_os} size={18} />
                    </span>
                    {/* Two lines: label (full width) on top, user@host muted below —
                        so the label is never truncated by the address (Termius-style). */}
                    <span className="flex-1 min-w-0 flex flex-col leading-tight">
                      <span className="flex items-center gap-1.5">
                        {live > 0 && (
                          <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-ok" title={`${live} active session${live > 1 ? "s" : ""}`} />
                        )}
                        <span className="flex-1 truncate text-[13px] text-ink">{h.label}</span>
                        {live > 1 && <span className="shrink-0 text-[10px] text-ok tabular-nums">×{live}</span>}
                      </span>
                      <span className="truncate text-[11px] text-ink-3 mt-0.5">
                        {h.username}@{h.hostname}
                      </span>
                    </span>
                  </button>
                  {/* Trailing ⋯ — discoverability handle for the context menu. */}
                  <button
                    className="shrink-0 opacity-0 group-hover:opacity-100 flex items-center justify-center w-6 h-6 rounded-control text-ink-3 hover:text-ink hover:bg-white/[0.06] transition-colors"
                    onClick={(e) => openMenu(e, h)}
                    title="Host actions"
                    aria-label="Host actions"
                  >
                    <DotsIcon />
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </SidebarBody>

      {/* Add-host footer — bordered footer slot, shared shell with the
          Workspaces "Add App" button. */}
      <SidebarFooter>
        <SidebarAddButton label="Add host" onClick={() => setAdding(true)} />
      </SidebarFooter>

      {/* Right-click / ⋯ context menu — single instance, cursor-anchored. */}
      {menu && (
        <>
          <div
            className="fixed inset-0 z-[60]"
            onClick={() => setMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setMenu(null); }}
          />
          <div
            className="fixed z-[61] min-w-[184px] py-1 bg-surface-2 border border-strong rounded-card shadow-xl shadow-black/40"
            style={{ left: menu.x, top: menu.y }}
            role="menu"
          >
            <MenuItem
              icon={<TerminalIcon />}
              label="Connect"
              onClick={() => { connectOrFocusSsh(menu.host.id); setMenu(null); }}
            />
            <MenuItem
              icon={<PlusIcon />}
              label="New session"
              onClick={() => { connectSsh(menu.host.id); setMenu(null); }}
            />
            <MenuItem
              icon={<PencilIcon />}
              label="Edit host"
              onClick={() => { setEditing(menu.host); setMenu(null); }}
            />
            <div className="my-1 border-t border-subtle" />
            <MenuItem
              icon={<TrashIcon />}
              label="Delete host"
              danger
              onClick={() => { const h = menu.host; setMenu(null); onDelete(h); }}
            />
          </div>
        </>
      )}

      {adding && <HostFormModal onClose={() => setAdding(false)} />}
      {editing && <HostFormModal host={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-[12px] text-left transition-colors hover:bg-white/[0.05] ${
        danger ? "text-red-400" : "text-ink-2 hover:text-ink"
      }`}
    >
      <span className="shrink-0 flex items-center justify-center w-3.5">{icon}</span>
      {label}
    </button>
  );
}

// ── Line icons (14px, currentColor) ──────────────────────────────────────────
function TerminalIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 5.5 6.5 8 4 10.5" />
      <path d="M8.5 10.5H12" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
      <path d="M8 3.5v9M3.5 8h9" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11.5 2.8a1.1 1.1 0 0 1 1.6 1.6L5.5 12 3 13l1-2.5z" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.5 4.5h9" />
      <path d="M6.5 4.5V3h3v1.5" />
      <path d="M5 4.5l.6 8h4.8l.6-8" />
    </svg>
  );
}

function DotsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
      <circle cx="4" cy="8" r="1.15" />
      <circle cx="8" cy="8" r="1.15" />
      <circle cx="12" cy="8" r="1.15" />
    </svg>
  );
}
