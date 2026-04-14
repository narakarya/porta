import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { detectStartCommand, nextAvailablePort, listAvailableCommands } from "../../lib/commands";
import type { CommandSuggestion } from "../../lib/commands";
import { usePortaStore } from "../../store";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function pickDirectory(): Promise<string | null> {
  if (isTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({ directory: true, multiple: false });
    return typeof selected === "string" ? selected : null;
  }
  // Browser mock: prompt for a path
  return window.prompt("Enter project folder path:", "/Users/dev/my-project");
}

const inputCls = "w-full bg-[#111113] border border-white/[0.08] rounded-lg px-3 py-2 text-[13px] text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-blue-500/60 transition-colors";
const labelCls = "text-[11px] font-medium text-zinc-500 uppercase tracking-wide";

// Valid subdomain: letters/digits/hyphens, or "*" for wildcard
const SUBDOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$|^\*$/;

function validateSubdomain(s: string): string | null {
  if (!s) return null; // empty = use app name (valid)
  if (!SUBDOMAIN_RE.test(s)) return "Use letters, numbers, hyphens — or * for wildcard";
  return null;
}


export interface AddAppDefaultValues {
  name?: string;
  root_dir?: string;
  start_command?: string;
  start_command_source?: string;
}

interface Props {
  workspaceId: string | null;
  onClose: () => void;
  defaultValues?: AddAppDefaultValues;
}

export default function AddAppModal({ workspaceId, onClose, defaultValues }: Props) {
  const { workspaces, addApp, setupStatus } = usePortaStore();
  const scheme = setupStatus?.certs_generated ? "https" : "http";
  const [name, setName] = useState(defaultValues?.name ?? "");
  const [rootDir, setRootDir] = useState(defaultValues?.root_dir ?? "");
  const [command, setCommand] = useState(defaultValues?.start_command ?? "");
  const [commandSource, setCommandSource] = useState<"auto" | "manual">(
    (defaultValues?.start_command_source as "auto" | "manual") ?? "manual"
  );
  const [port, setPort] = useState<number>(3000);
  const [subdomain, setSubdomain] = useState("");
  const [subdomainError, setSubdomainError] = useState<string | null>(null);
  const [wsId, setWsId] = useState<string | null>(workspaceId);
  const [submitting, setSubmitting] = useState(false);
  const [suggestions, setSuggestions] = useState<CommandSuggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const cmdInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nextAvailablePort().then(setPort);
  }, []);

  async function pickFolder() {
    const selected = await pickDirectory();
    if (!selected) return;
    setRootDir(selected);
    const parts = selected.split("/");
    setName(parts[parts.length - 1] ?? "");
    // Auto-detect primary start command and load full suggestion list in parallel
    const [result, cmds] = await Promise.all([
      detectStartCommand(selected),
      listAvailableCommands(selected).catch(() => [] as CommandSuggestion[]),
    ]);
    if (result.command) {
      setCommand(result.command);
      setCommandSource(result.source as "auto" | "manual");
    }
    setSuggestions(cmds);
  }

  const workspace = workspaces.find((w) => w.id === wsId) ?? null;
  const domain = workspace?.domain || "narakarya.test";
  const preview = `${subdomain || name || "..."}.${domain}`;

  function handleSubdomainChange(val: string) {
    // Allow * but otherwise force lowercase
    const normalized = val === "*" ? "*" : val.toLowerCase();
    setSubdomain(normalized);
    setSubdomainError(validateSubdomain(normalized));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const err = validateSubdomain(subdomain);
    if (err) { setSubdomainError(err); return; }
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
    <div className="fixed inset-0 bg-black/50 backdrop-blur-[2px] flex items-center justify-center z-50">
      <form
        onSubmit={submit}
        className="bg-[#1c1c1e] border border-white/[0.08] rounded-2xl p-6 w-[400px] flex flex-col gap-4 shadow-2xl max-h-[90vh] overflow-y-auto"
      >
        <div>
          <h2 className="text-[15px] font-semibold text-zinc-100">Add App</h2>
          <p className="text-[12px] text-zinc-500 mt-0.5">Register a local project with Porta</p>
        </div>

        {/* Folder picker */}
        <label className="flex flex-col gap-1.5">
          <span className={labelCls}>Project Folder</span>
          <div className="flex gap-2">
            <input value={rootDir} readOnly placeholder="Select a folder..."
              className={`${inputCls} flex-1 cursor-default`} />
            <button type="button" onClick={pickFolder}
              className="px-3 py-2 bg-white/[0.07] hover:bg-white/[0.11] border border-white/[0.08] rounded-lg text-[13px] text-zinc-300 transition-colors shrink-0">
              Browse
            </button>
          </div>
        </label>

        {/* Name */}
        <label className="flex flex-col gap-1.5">
          <span className={labelCls}>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required
            placeholder="my-app" className={inputCls} autoComplete="off" spellCheck={false} />
        </label>

        {/* Start command */}
        <div className="flex flex-col gap-1.5">
          <span className={`${labelCls} flex items-center gap-2`}>
            Start Command
            {commandSource === "auto" && (
              <span className="text-[10px] font-medium text-amber-400 bg-amber-400/10 px-1.5 py-0.5 rounded-md normal-case tracking-normal">
                auto-detected
              </span>
            )}
          </span>
          <div className="relative">
            <input
              ref={cmdInputRef}
              value={command}
              onChange={(e) => { setCommand(e.target.value); setCommandSource("manual"); }}
              onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
              onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
              placeholder="npm run dev"
              className={inputCls}
              autoComplete="off"
              spellCheck={false}
            />
            {showSuggestions && suggestions.length > 0 && (
              <div className="absolute top-full left-0 right-0 mt-1 z-50 bg-[#1c1c1e] border border-white/[0.10] rounded-lg shadow-xl overflow-hidden">
                {suggestions.map((s, i) => (
                  <button
                    key={i}
                    type="button"
                    onMouseDown={() => {
                      setCommand(s.label);
                      setCommandSource("auto");
                      setShowSuggestions(false);
                    }}
                    className="w-full flex items-center justify-between gap-3 px-3 py-2 hover:bg-white/[0.07] text-left transition-colors"
                  >
                    <code className="text-[12px] text-zinc-200 font-mono truncate flex-1">{s.label}</code>
                    <span className="text-[10px] text-zinc-600 shrink-0">{s.source}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Port + subdomain */}
        <div className="flex gap-3">
          <label className="flex flex-col gap-1.5 w-28">
            <span className={labelCls}>Port</span>
            <input type="number" value={port}
              onChange={(e) => setPort(Number(e.target.value))}
              className={inputCls} />
          </label>
          <label className="flex flex-col gap-1.5 flex-1">
            <span className={`${labelCls} flex items-center gap-1.5`}>
              Subdomain
              <span className="text-[10px] normal-case text-zinc-600 tracking-normal">* for wildcard</span>
            </span>
            <input value={subdomain} onChange={(e) => handleSubdomainChange(e.target.value)}
              placeholder="optional"
              className={`${inputCls} ${subdomainError ? "border-red-500/60" : ""}`}
              autoComplete="off" spellCheck={false} />
            {subdomainError && (
              <span className="text-[11px] text-red-400">{subdomainError}</span>
            )}
          </label>
        </div>

        {/* Preview URL */}
        <div className="flex items-center gap-2 px-2.5 py-1.5 bg-white/[0.03] rounded-lg border border-white/[0.05]">
          <span className="text-[10px] text-zinc-600 font-medium shrink-0">URL</span>
          <span className="text-[11px] text-zinc-400 font-mono truncate">{scheme}://{preview}</span>
        </div>

        {/* Workspace */}
        {workspaces.length > 0 && (
          <label className="flex flex-col gap-1.5">
            <span className={labelCls}>Workspace</span>
            <select value={wsId ?? ""} onChange={(e) => setWsId(e.target.value || null)}
              className={`${inputCls} appearance-none cursor-pointer`}>
              <option value="">Standalone</option>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>{w.name}</option>
              ))}
            </select>
          </label>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose}
            className="px-4 py-1.5 text-[13px] text-zinc-500 hover:text-zinc-200 rounded-lg transition-colors">
            Cancel
          </button>
          <button type="submit" disabled={submitting || !!subdomainError}
            className="px-4 py-1.5 text-[13px] font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg disabled:opacity-50 transition-colors flex items-center gap-2">
            {submitting && <span className="spinner text-white/70" />}
            {submitting ? "Adding..." : "Add App"}
          </button>
        </div>
      </form>
    </div>
  );
}
