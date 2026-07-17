import { useMemo, useRef, useState } from "react";
import { usePortaStore } from "../../store";
import type { SshHost } from "../../lib/commands";
import HostFormModal from "./HostFormModal";
import { osGlyph } from "./osIcon";

export default function HostVault() {
  const hosts = usePortaStore((s) => s.sshHosts);
  const workspaces = usePortaStore((s) => s.workspaces);
  const sessions = usePortaStore((s) => s.sshSessions);
  const connectOrFocusSsh = usePortaStore((s) => s.connectOrFocusSsh);
  const connectSsh = usePortaStore((s) => s.connectSsh);
  const deleteSshHost = usePortaStore((s) => s.deleteSshHost);

  const [query, setQuery] = useState("");
  const [wsFilter, setWsFilter] = useState(""); // "" = all
  const [filterOpen, setFilterOpen] = useState(false);
  const [editing, setEditing] = useState<SshHost | null>(null);
  const [adding, setAdding] = useState(false);
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

  const activeFilterName = wsFilter ? wsName.get(wsFilter) : null;

  return (
    <div className="p-2">
      <div className="flex items-center gap-1.5 mb-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search hosts…"
          className="flex-1 min-w-0 px-2 py-1 text-[12px] bg-[#111113] border border-white/[0.08] rounded-lg text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-blue-500/60 transition-colors"
        />
        {workspaces.length > 0 && (
          <div className="relative shrink-0" ref={filterRef}>
            <button
              onClick={() => setFilterOpen((v) => !v)}
              title={activeFilterName ? `Filtered: ${activeFilterName}` : "Filter by workspace"}
              className={`relative flex items-center justify-center w-7 h-7 rounded-lg border transition-colors ${
                wsFilter
                  ? "text-blue-300 bg-blue-500/15 border-blue-500/40"
                  : "text-zinc-400 border-white/[0.08] hover:text-zinc-200 hover:border-white/[0.15]"
              }`}
            >
              <svg width="13" height="13" viewBox="0 0 12 12" fill="none">
                <path d="M1 2h10L7 6.5V10L5 9V6.5L1 2z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
              </svg>
              {wsFilter && <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-blue-400" />}
            </button>
            {filterOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setFilterOpen(false)} />
                <div className="absolute right-0 mt-1 w-44 max-h-64 overflow-y-auto z-50 p-1 bg-[#1a1a1c] border border-white/[0.1] rounded-lg shadow-xl">
                  <button
                    onClick={() => { setWsFilter(""); setFilterOpen(false); }}
                    className={`w-full text-left px-2 py-1 text-[12px] rounded-md ${!wsFilter ? "text-blue-300 bg-blue-500/10" : "text-zinc-300 hover:bg-white/[0.05]"}`}
                  >
                    All workspaces
                  </button>
                  {workspaces.map((w) => (
                    <button
                      key={w.id}
                      onClick={() => { setWsFilter(w.id); setFilterOpen(false); }}
                      className={`w-full text-left px-2 py-1 text-[12px] rounded-md truncate ${wsFilter === w.id ? "text-blue-300 bg-blue-500/10" : "text-zinc-300 hover:bg-white/[0.05]"}`}
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

      <div className="flex flex-col gap-0.5">
        {list.map((h) => {
          const live = liveCount.get(h.id) ?? 0;
          return (
            <div
              key={h.id}
              className="group flex items-center gap-1 px-2 py-1.5 rounded-lg hover:bg-white/[0.05] transition-colors"
            >
              <button
                className="flex-1 text-left min-w-0 flex items-center gap-2"
                onClick={() => connectOrFocusSsh(h.id)}
                title={live ? `Focus session · ${h.username}@${h.hostname}:${h.port}` : `Connect ${h.username}@${h.hostname}:${h.port}`}
              >
                <span className="shrink-0 w-4 text-center text-[13px]" title={h.detected_os ?? undefined}>
                  {osGlyph(h.detected_os)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    {live > 0 && (
                      <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-emerald-400" title={`${live} active session${live > 1 ? "s" : ""}`} />
                    )}
                    <span className="text-[13px] text-zinc-200 truncate">{h.label}</span>
                    {live > 1 && <span className="text-[10px] text-emerald-400/80 tabular-nums">×{live}</span>}
                  </span>
                  <span className="block text-[11px] text-zinc-500 truncate">
                    {h.username}@{h.hostname}
                  </span>
                  {h.workspace_ids.length > 0 && (
                    <span className="flex flex-wrap gap-1 mt-0.5">
                      {h.workspace_ids.map((wid) => (
                        <span key={wid} className="px-1.5 py-px text-[9px] rounded bg-blue-500/15 text-blue-300/90">
                          {wsName.get(wid) ?? "?"}
                        </span>
                      ))}
                    </span>
                  )}
                </span>
              </button>
              <button
                className="opacity-0 group-hover:opacity-100 text-zinc-500 hover:text-emerald-400 text-[13px] px-1 leading-none transition-colors"
                onClick={() => connectSsh(h.id)}
                title="New session"
              >
                ＋
              </button>
              <button
                className="opacity-0 group-hover:opacity-100 text-zinc-500 hover:text-zinc-200 text-[11px] px-1 transition-colors"
                onClick={() => setEditing(h)}
              >
                Edit
              </button>
              <button
                className="opacity-0 group-hover:opacity-100 text-zinc-500 hover:text-red-400 text-[11px] px-1 transition-colors"
                onClick={() => onDelete(h)}
              >
                ✕
              </button>
            </div>
          );
        })}
      </div>

      <button
        onClick={() => setAdding(true)}
        className="w-full mt-2 px-2 py-1.5 text-[12px] text-zinc-400 hover:text-zinc-200 border border-dashed border-white/[0.1] rounded-lg transition-colors"
      >
        + Add host
      </button>
      {adding && <HostFormModal onClose={() => setAdding(false)} />}
      {editing && <HostFormModal host={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
