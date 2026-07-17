import { useEffect, useMemo, useState } from "react";
import { usePortaStore } from "../../store";
import type { SshHost, SshAuth } from "../../lib/commands";

type Props = { host?: SshHost; onClose: () => void };

const DEFAULT_KEY = "~/.ssh/id_ed25519";

export default function HostFormModal({ host, onClose }: Props) {
  const addSshHost = usePortaStore((s) => s.addSshHost);
  const updateSshHost = usePortaStore((s) => s.updateSshHost);
  const workspaces = usePortaStore((s) => s.workspaces);

  const [label, setLabel] = useState(host?.label ?? "");
  const [hostname, setHostname] = useState(host?.hostname ?? "");
  const [port, setPort] = useState(String(host?.port ?? 22));
  const [username, setUsername] = useState(host?.username ?? "");
  const [authKind, setAuthKind] = useState<SshAuth["kind"]>(host?.auth.kind ?? "agent");
  const [keyPath, setKeyPath] = useState(host?.auth.kind === "key_file" ? host.auth.path : "");
  const [workspaceIds, setWorkspaceIds] = useState<string[]>(host?.workspace_ids ?? []);
  const [wsOpen, setWsOpen] = useState(false);
  const [wsQuery, setWsQuery] = useState("");

  const wsName = useMemo(() => new Map(workspaces.map((w) => [w.id, w.name])), [workspaces]);
  const wsFiltered = useMemo(
    () => workspaces.filter((w) => w.name.toLowerCase().includes(wsQuery.toLowerCase())),
    [workspaces, wsQuery]
  );

  function toggleWorkspace(id: string) {
    setWorkspaceIds((prev) => (prev.includes(id) ? prev.filter((w) => w !== id) : [...prev, id]));
  }

  function onAuthChange(kind: SshAuth["kind"]) {
    setAuthKind(kind);
    if (kind === "key_file" && !keyPath) setKeyPath(DEFAULT_KEY);
  }

  async function browseKey() {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const { homeDir } = await import("@tauri-apps/api/path");
      const picked = await open({
        multiple: false,
        directory: false,
        defaultPath: `${await homeDir()}.ssh`,
        title: "Select SSH private key",
      });
      if (typeof picked === "string") setKeyPath(picked);
    } catch {
      /* dialog unavailable (browser dev) — user can still type the path */
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function save() {
    const auth: SshAuth =
      authKind === "key_file"
        ? { kind: "key_file", path: keyPath || DEFAULT_KEY }
        : authKind === "password"
          ? { kind: "password" }
          : { kind: "agent" };
    const payload: SshHost = {
      id: host?.id ?? "",
      label,
      group: host?.group ?? null, // legacy free-text folder — no longer edited here
      hostname,
      port: Number(port) || 22,
      username,
      auth,
      jump_host_id: host?.jump_host_id ?? null,
      created_at: host?.created_at ?? 0,
      last_used_at: host?.last_used_at ?? null,
      workspace_ids: workspaceIds,
      detected_os: host?.detected_os ?? null,
    };
    if (host) await updateSshHost(payload);
    else await addSshHost(payload);
    onClose();
  }

  const field =
    "bg-[#111113] border border-white/[0.08] rounded-lg px-3 py-2 text-[13px] text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-blue-500/60 transition-colors";
  const legend = "text-[10px] uppercase tracking-wide text-zinc-600 mb-1.5";

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-[2px] flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="w-96 max-h-[85vh] overflow-y-auto p-4 bg-[#1a1a1c] border border-white/[0.08] rounded-xl space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-[14px] text-zinc-100 font-semibold">{host ? "Edit host" : "Add host"}</div>

        {/* Connection */}
        <div>
          <div className={legend}>Connection</div>
          <div className="space-y-2">
            <input className={`${field} w-full`} placeholder="Label (e.g. prod-web)" value={label} onChange={(e) => setLabel(e.target.value)} />
            <input className={`${field} w-full`} placeholder="Hostname / IP" value={hostname} onChange={(e) => setHostname(e.target.value)} />
            <div className="flex gap-2">
              <input className={`${field} flex-1 min-w-0`} placeholder="User" value={username} onChange={(e) => setUsername(e.target.value)} />
              <input className={`${field} w-20 shrink-0`} placeholder="Port" value={port} onChange={(e) => setPort(e.target.value)} />
            </div>
          </div>
        </div>

        {/* Authentication */}
        <div>
          <div className={legend}>Authentication</div>
          <div className="space-y-2">
            <select className={`${field} w-full`} value={authKind} onChange={(e) => onAuthChange(e.target.value as SshAuth["kind"])}>
              <option value="agent">SSH agent</option>
              <option value="key_file">Key file</option>
              <option value="password">Password</option>
            </select>
            {authKind === "key_file" && (
              <div className="flex gap-2">
                <input className={`${field} w-full`} placeholder={DEFAULT_KEY} value={keyPath} onChange={(e) => setKeyPath(e.target.value)} />
                <button
                  type="button"
                  onClick={browseKey}
                  className="shrink-0 px-3 text-[12px] text-zinc-300 bg-white/[0.06] hover:bg-white/[0.10] border border-white/[0.08] rounded-lg transition-colors"
                >
                  Browse…
                </button>
              </div>
            )}
            {authKind === "password" && (
              <p className="text-[11px] text-zinc-600">Password is asked at connect and never stored (unless you tick “remember”).</p>
            )}
          </div>
        </div>

        {/* Workspaces */}
        {workspaces.length > 0 && (
          <div>
            <div className={legend}>Workspaces</div>
            <div className="relative">
              <button
                type="button"
                onClick={() => setWsOpen((v) => !v)}
                className={`${field} w-full flex items-center justify-between text-left`}
              >
                <span className={workspaceIds.length ? "text-zinc-200" : "text-zinc-600"}>
                  {workspaceIds.length === 0
                    ? "None (global)"
                    : workspaceIds.length <= 2
                      ? workspaceIds.map((id) => wsName.get(id) ?? "?").join(", ")
                      : `${workspaceIds.length} selected`}
                </span>
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className="text-zinc-500 shrink-0">
                  <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              {wsOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setWsOpen(false)} />
                  <div className="absolute left-0 right-0 mt-1 z-50 bg-[#151517] border border-white/[0.1] rounded-lg shadow-xl overflow-hidden">
                    {workspaces.length > 6 && (
                      <input
                        autoFocus
                        value={wsQuery}
                        onChange={(e) => setWsQuery(e.target.value)}
                        placeholder="Filter…"
                        className="w-full px-3 py-1.5 text-[12px] bg-transparent border-b border-white/[0.06] text-zinc-200 placeholder:text-zinc-600 outline-none"
                      />
                    )}
                    <div className="max-h-52 overflow-y-auto p-1">
                      {wsFiltered.map((w) => {
                        const on = workspaceIds.includes(w.id);
                        return (
                          <button
                            key={w.id}
                            type="button"
                            onClick={() => toggleWorkspace(w.id)}
                            className="w-full flex items-center gap-2 px-2 py-1.5 text-[12px] rounded-md text-zinc-200 hover:bg-white/[0.05] transition-colors"
                          >
                            <span
                              className={`w-3.5 h-3.5 shrink-0 rounded border flex items-center justify-center ${
                                on ? "bg-blue-500 border-blue-500" : "border-white/[0.2]"
                              }`}
                            >
                              {on && (
                                <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
                                  <path d="M1.5 4l1.5 1.5L6.5 2" stroke="#fff" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                                </svg>
                              )}
                            </span>
                            <span className="truncate">{w.name}</span>
                          </button>
                        );
                      })}
                      {wsFiltered.length === 0 && <div className="px-2 py-2 text-[12px] text-zinc-600">No match</div>}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button className="px-3 py-1.5 text-[12px] text-zinc-400 hover:text-zinc-200 transition-colors" onClick={onClose}>
            Cancel
          </button>
          <button
            className="px-3 py-1.5 text-[12px] font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg disabled:opacity-40 transition-colors"
            disabled={!label || !hostname || !username}
            onClick={save}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
