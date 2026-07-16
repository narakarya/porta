import { useMemo, useState } from "react";
import { usePortaStore } from "../../store";
import type { SshHost } from "../../lib/commands";
import HostFormModal from "./HostFormModal";

export default function HostVault() {
  const hosts = usePortaStore((s) => s.sshHosts);
  const workspaces = usePortaStore((s) => s.workspaces);
  const connectSsh = usePortaStore((s) => s.connectSsh);
  const deleteSshHost = usePortaStore((s) => s.deleteSshHost);
  const [query, setQuery] = useState("");
  const [wsFilter, setWsFilter] = useState("");
  const [editing, setEditing] = useState<SshHost | null>(null);
  const [adding, setAdding] = useState(false);

  const wsName = useMemo(
    () => new Map(workspaces.map((w) => [w.id, w.name])),
    [workspaces]
  );

  const groups = useMemo(() => {
    const filtered = hosts.filter(
      (h) =>
        `${h.label} ${h.hostname} ${h.username}`.toLowerCase().includes(query.toLowerCase()) &&
        (!wsFilter || h.workspace_ids.includes(wsFilter))
    );
    const by = new Map<string, SshHost[]>();
    for (const h of filtered) {
      const g = h.group ?? "Ungrouped";
      (by.get(g) ?? by.set(g, []).get(g)!).push(h);
    }
    return [...by.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [hosts, query, wsFilter]);

  return (
    <div className="p-2">
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search hosts…"
        className="w-full mb-2 px-2 py-1 text-[12px] bg-[#111113] border border-white/[0.08] rounded-lg text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-blue-500/60 transition-colors"
      />
      {workspaces.length > 0 && (
        <select
          value={wsFilter}
          onChange={(e) => setWsFilter(e.target.value)}
          className="w-full mb-2 px-2 py-1 text-[12px] bg-[#111113] border border-white/[0.08] rounded-lg text-zinc-300 outline-none focus:border-blue-500/60 transition-colors"
        >
          <option value="">All workspaces</option>
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
      )}
      {groups.map(([group, list]) => (
        <div key={group} className="mb-2">
          <div className="px-1 py-1 text-[10px] uppercase tracking-wide text-zinc-600">{group}</div>
          {list.map((h) => (
            <div
              key={h.id}
              className="group flex items-center gap-1 px-2 py-1.5 rounded-lg hover:bg-white/[0.05] transition-colors"
            >
              <button
                className="flex-1 text-left min-w-0"
                onClick={() => connectSsh(h.id)}
                title={`${h.username}@${h.hostname}:${h.port}`}
              >
                <div className="text-[13px] text-zinc-200 truncate">{h.label}</div>
                <div className="text-[11px] text-zinc-500 truncate">
                  {h.username}@{h.hostname}
                </div>
                {h.workspace_ids.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-0.5">
                    {h.workspace_ids.map((wid) => (
                      <span
                        key={wid}
                        className="px-1.5 py-px text-[9px] rounded bg-blue-500/15 text-blue-300/90"
                      >
                        {wsName.get(wid) ?? "?"}
                      </span>
                    ))}
                  </div>
                )}
              </button>
              <button
                className="opacity-0 group-hover:opacity-100 text-zinc-500 hover:text-zinc-200 text-[11px] px-1 transition-colors"
                onClick={() => setEditing(h)}
              >
                Edit
              </button>
              <button
                className="opacity-0 group-hover:opacity-100 text-zinc-500 hover:text-red-400 text-[11px] px-1 transition-colors"
                onClick={() => {
                  if (confirm(`Delete ${h.label}?`)) deleteSshHost(h.id);
                }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      ))}
      <button
        onClick={() => setAdding(true)}
        className="w-full mt-1 px-2 py-1.5 text-[12px] text-zinc-400 hover:text-zinc-200 border border-dashed border-white/[0.1] rounded-lg transition-colors"
      >
        + Add host
      </button>
      {adding && <HostFormModal onClose={() => setAdding(false)} />}
      {editing && <HostFormModal host={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
