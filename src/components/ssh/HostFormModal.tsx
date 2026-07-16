import { useEffect, useState } from "react";
import { usePortaStore } from "../../store";
import type { SshHost, SshAuth } from "../../lib/commands";

type Props = { host?: SshHost; onClose: () => void };

export default function HostFormModal({ host, onClose }: Props) {
  const addSshHost = usePortaStore((s) => s.addSshHost);
  const updateSshHost = usePortaStore((s) => s.updateSshHost);

  const [label, setLabel] = useState(host?.label ?? "");
  const [group, setGroup] = useState(host?.group ?? "");
  const [hostname, setHostname] = useState(host?.hostname ?? "");
  const [port, setPort] = useState(String(host?.port ?? 22));
  const [username, setUsername] = useState(host?.username ?? "");
  const [authKind, setAuthKind] = useState<SshAuth["kind"]>(host?.auth.kind ?? "agent");
  const [keyPath, setKeyPath] = useState(host?.auth.kind === "key_file" ? host.auth.path : "");

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
        ? { kind: "key_file", path: keyPath }
        : authKind === "password"
          ? { kind: "password" }
          : { kind: "agent" };
    const payload: SshHost = {
      id: host?.id ?? "",
      label,
      group: group || null,
      hostname,
      port: Number(port) || 22,
      username,
      auth,
      jump_host_id: host?.jump_host_id ?? null,
      created_at: host?.created_at ?? 0,
      last_used_at: host?.last_used_at ?? null,
    };
    if (host) await updateSshHost(payload);
    else await addSshHost(payload);
    onClose();
  }

  const field =
    "w-full bg-[#111113] border border-white/[0.08] rounded-lg px-3 py-2 text-[13px] text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-blue-500/60 transition-colors";

  return (
    <div
      className="fixed inset-0 bg-black/50 backdrop-blur-[2px] flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="w-80 p-4 bg-[#1a1a1c] border border-white/[0.08] rounded-lg space-y-2"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-[13px] text-zinc-200 font-medium mb-1">{host ? "Edit host" : "Add host"}</div>
        <input className={field} placeholder="Label" value={label} onChange={(e) => setLabel(e.target.value)} />
        <input
          className={field}
          placeholder="Group (optional)"
          value={group}
          onChange={(e) => setGroup(e.target.value)}
        />
        <input
          className={field}
          placeholder="Hostname / IP"
          value={hostname}
          onChange={(e) => setHostname(e.target.value)}
        />
        <div className="flex gap-2">
          <input className={field} placeholder="User" value={username} onChange={(e) => setUsername(e.target.value)} />
          <input className={`${field} w-20`} placeholder="Port" value={port} onChange={(e) => setPort(e.target.value)} />
        </div>
        <select
          className={field}
          value={authKind}
          onChange={(e) => setAuthKind(e.target.value as SshAuth["kind"])}
        >
          <option value="agent">SSH agent</option>
          <option value="key_file">Key file</option>
          <option value="password">Password</option>
        </select>
        {authKind === "key_file" && (
          <input
            className={field}
            placeholder="~/.ssh/id_ed25519"
            value={keyPath}
            onChange={(e) => setKeyPath(e.target.value)}
          />
        )}
        <div className="flex justify-end gap-2 pt-1">
          <button className="px-3 py-1 text-[12px] text-zinc-400 hover:text-zinc-200 transition-colors" onClick={onClose}>
            Cancel
          </button>
          <button
            className="px-3 py-1 text-[12px] font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg disabled:opacity-40 transition-colors"
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
