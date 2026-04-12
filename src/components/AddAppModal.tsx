import React, { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  detectStartCommand,
  nextAvailablePort,
} from "../lib/commands";
import { usePortaStore } from "../store";

interface Props {
  workspaceId: string | null;
  onClose: () => void;
}

export default function AddAppModal({ workspaceId, onClose }: Props) {
  const { workspaces, addApp } = usePortaStore();
  const [name, setName] = useState("");
  const [rootDir, setRootDir] = useState("");
  const [command, setCommand] = useState("");
  const [commandSource, setCommandSource] = useState<"auto" | "manual">(
    "manual"
  );
  const [port, setPort] = useState<number>(3000);
  const [subdomain, setSubdomain] = useState("");
  const [wsId, setWsId] = useState<string | null>(workspaceId);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    nextAvailablePort().then(setPort);
  }, []);

  async function pickFolder() {
    const selected = await open({ directory: true, multiple: false });
    if (!selected || typeof selected !== "string") return;
    setRootDir(selected);
    const parts = selected.split("/");
    setName(parts[parts.length - 1] ?? "");
    const result = await detectStartCommand(selected);
    if (result.command) {
      setCommand(result.command);
      setCommandSource(result.source as "auto" | "manual");
    }
  }

  const workspace = workspaces.find((w) => w.id === wsId) ?? null;
  const domain = workspace?.domain ?? "narakarya.test";
  const preview = `${subdomain || name || "…"}.${domain}`;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name || !rootDir) return;
    setSubmitting(true);
    try {
      await addApp({
        workspace_id: wsId,
        name,
        root_dir: rootDir,
        port,
        subdomain: subdomain || null,
        start_command: command,
        start_command_source: commandSource,
      });
      onClose();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <form
        onSubmit={submit}
        className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-96 flex flex-col gap-4"
      >
        <h2 className="font-semibold text-lg">Add App</h2>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-gray-400">Folder</span>
          <div className="flex gap-2">
            <input
              value={rootDir}
              readOnly
              placeholder="Select folder…"
              className="flex-1 bg-gray-800 border border-gray-700 rounded-md px-3 py-1.5 text-sm"
            />
            <button
              type="button"
              onClick={pickFolder}
              className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded-md text-sm"
            >
              …
            </button>
          </div>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-gray-400">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            className="bg-gray-800 border border-gray-700 rounded-md px-3 py-1.5"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-gray-400 flex items-center gap-1">
            Start command
            {commandSource === "auto" && (
              <span className="text-yellow-400 text-xs">⚡ auto-detected</span>
            )}
          </span>
          <input
            value={command}
            onChange={(e) => {
              setCommand(e.target.value);
              setCommandSource("manual");
            }}
            className="bg-gray-800 border border-gray-700 rounded-md px-3 py-1.5"
          />
        </label>

        <div className="flex gap-3">
          <label className="flex flex-col gap-1 text-sm flex-1">
            <span className="text-gray-400">Port</span>
            <input
              type="number"
              value={port}
              onChange={(e) => setPort(Number(e.target.value))}
              className="bg-gray-800 border border-gray-700 rounded-md px-3 py-1.5"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm flex-1">
            <span className="text-gray-400">Subdomain override</span>
            <input
              value={subdomain}
              onChange={(e) => setSubdomain(e.target.value)}
              placeholder="optional"
              className="bg-gray-800 border border-gray-700 rounded-md px-3 py-1.5"
            />
          </label>
        </div>

        <p className="text-xs text-gray-500">→ {preview}</p>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-gray-400">Workspace</span>
          <select
            value={wsId ?? ""}
            onChange={(e) => setWsId(e.target.value || null)}
            className="bg-gray-800 border border-gray-700 rounded-md px-3 py-1.5"
          >
            <option value="">Standalone</option>
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 text-sm text-gray-400 hover:text-gray-200"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="px-4 py-1.5 text-sm bg-indigo-600 hover:bg-indigo-500 rounded-md disabled:opacity-50"
          >
            {submitting ? "Adding…" : "Add"}
          </button>
        </div>
      </form>
    </div>
  );
}
