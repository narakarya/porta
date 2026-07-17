import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { detectStartCommand, nextAvailablePort, listAvailableCommands, parseComposeString, parseDockerCompose } from "../../lib/commands";
import type { CommandSuggestion } from "../../lib/commands";
import type { AppKind } from "../../types";
import { usePortaStore } from "../../store";
import { yieldToFrame } from "../../lib/ui";
import YamlEditor from "../shared/YamlEditor";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function volumeTemplate(appName: string): string {
  const slug = appName.toLowerCase().trim().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "") || "app";
  return `~/projects/docker/volumes/${slug}/data:/data`;
}

async function pickDirectory(): Promise<string | null> {
  if (isTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({ directory: true, multiple: false });
    return typeof selected === "string" ? selected : null;
  }
  // Browser mock: prompt for a path
  return window.prompt("Enter project folder path:", "/Users/dev/my-project");
}

async function pickComposeFileDialog(defaultPath?: string): Promise<string | null> {
  if (isTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      multiple: false,
      defaultPath,
      filters: [{ name: "Docker Compose", extensions: ["yml", "yaml"] }],
    });
    return typeof selected === "string" ? selected : null;
  }
  return window.prompt("Enter path to compose file:", "/Users/dev/my-project/compose.yaml");
}

/** Slugify a string into a valid subdomain — lowercase, hyphenated, alnum only. */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

const inputCls = "w-full bg-surface-input border border-subtle rounded-lg px-3 py-2 text-[13px] text-ink placeholder:text-ink-3 outline-none focus:border-[rgba(96,165,250,0.6)] transition-colors";
const labelCls = "text-[11px] font-medium text-ink-3";

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
  kind?: AppKind;
}

interface Props {
  workspaceId: string | null;
  onClose: () => void;
  defaultValues?: AddAppDefaultValues;
}

export default function AddAppModal({ workspaceId, onClose, defaultValues }: Props) {
  const { workspaces, addApp } = usePortaStore();
  const [name, setName] = useState(defaultValues?.name ?? "");
  const [rootDir, setRootDir] = useState(defaultValues?.root_dir ?? "");
  const [command, setCommand] = useState(defaultValues?.start_command ?? "");
  const [commandSource, setCommandSource] = useState<"auto" | "manual">(
    (defaultValues?.start_command_source as "auto" | "manual") ?? "manual"
  );
  const [kind, setKind] = useState<AppKind>(defaultValues?.kind ?? "process");
  const [dockerImage, setDockerImage] = useState("");
  const [dockerContainerPort, setDockerContainerPort] = useState<number>(80);
  const [dockerArgs, setDockerArgs] = useState("");
  const [dockerVolumes, setDockerVolumes] = useState<string[]>([]);
  const [composeMode, setComposeMode] = useState<"file" | "paste">("paste");
  const [composeFile, setComposeFile] = useState("docker-compose.yml");
  const [composeFileParsing, setComposeFileParsing] = useState(false);
  const [composeYaml, setComposeYaml] = useState("");
  const [networkShare, setNetworkShare] = useState(false);
  const [composeError, setComposeError] = useState<string | null>(null);
  const [composeErrorLine, setComposeErrorLine] = useState<number | undefined>(undefined);
  const [detectedServices, setDetectedServices] = useState<{ name: string; port: number }[]>([]);
  const [portTouched, setPortTouched] = useState(false);
  const [port, setPort] = useState<number>(3000);
  const [subdomain, setSubdomain] = useState("");
  const [subdomainError, setSubdomainError] = useState<string | null>(null);
  // Apps must belong to a workspace now (standalone retired) — default to the
  // passed workspace, else the first one.
  const [wsId, setWsId] = useState<string | null>(workspaceId ?? workspaces[0]?.id ?? null);
  const [submitting, setSubmitting] = useState(false);
  const [suggestions, setSuggestions] = useState<CommandSuggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const cmdInputRef = useRef<HTMLInputElement>(null);
  // Prevents accidental modal close when a press starts inside the form (or
  // when a native dialog like NSOpenPanel re-routes a click to the overlay
  // after dismissal). Only close if both mousedown AND click target the overlay.
  const downOnOverlayRef = useRef(false);

  useEffect(() => {
    nextAvailablePort().then(setPort);
  }, []);

  // Validate pasted YAML + auto-detect exposed ports. Runs debounced so typing
  // doesn't round-trip the backend on every keystroke.
  useEffect(() => {
    if (kind !== "compose" || composeMode !== "paste") {
      setComposeError(null);
      setDetectedServices([]);
      return;
    }
    if (!composeYaml.trim()) {
      setComposeError(null);
      setDetectedServices([]);
      return;
    }
    const handle = setTimeout(() => {
      parseComposeString(composeYaml).then((proj) => {
        setComposeError(null);
        setComposeErrorLine(undefined);
        const svcs: { name: string; port: number }[] = [];
        for (const svc of proj.services) {
          for (const [host, _container] of svc.ports) {
            svcs.push({ name: svc.name, port: host });
          }
        }
        setDetectedServices(svcs);
        // Auto-fill port from first detected mapping if user hasn't typed their own.
        if (!portTouched && svcs.length > 0) setPort(svcs[0].port);
      }).catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        setComposeError(msg);
        const m = msg.match(/line (\d+)/i);
        setComposeErrorLine(m ? parseInt(m[1], 10) : undefined);
        setDetectedServices([]);
      });
    }, 300);
    return () => clearTimeout(handle);
  }, [composeYaml, kind, composeMode, portTouched]);

  async function pickFolder() {
    const selected = await pickDirectory();
    if (!selected) return;
    setRootDir(selected);
    const parts = selected.split("/");
    const folderName = parts[parts.length - 1] ?? "";
    setName(folderName);
    if (!subdomain.trim() && folderName) setSubdomain(slugify(folderName));
    // Auto-detect primary start command and load full suggestion list in parallel
    const [result, cmds] = await Promise.all([
      detectStartCommand(selected),
      listAvailableCommands(selected).catch(() => [] as CommandSuggestion[]),
    ]);
    // Respect the user's explicit kind choice. Auto-detect only fills in
    // when they haven't picked a kind yet (still on the default "process"
    // tab). Otherwise picking a compose folder would silently kick them
    // back to process and wipe their selected kind.
    if (kind === "process") {
      setKind(result.kind);
    }
    if (result.command) {
      setCommand(result.command);
      setCommandSource(result.source as "auto" | "manual");
    }
    setSuggestions(cmds);

    // Try canonical compose filenames in this folder so the user doesn't
    // have to click Browse on the file input separately. Runs whenever the
    // current or auto-detected kind is compose — independent of composeMode,
    // since "paste" is the default and the user shouldn't have to flip the
    // sub-tab just to make detection fire. If we find one, we also switch
    // composeMode → "file" so the picked path is what the form actually uses.
    const goingToCompose = kind === "compose" || (kind === "process" && result.kind === "compose");
    if (goingToCompose) {
      const candidates = [
        "compose.yaml",
        "compose.yml",
        "docker-compose.yaml",
        "docker-compose.yml",
      ];
      for (const name of candidates) {
        const fullPath = `${selected.replace(/\/$/, "")}/${name}`;
        try {
          const proj = await parseDockerCompose(fullPath);
          setComposeFile(fullPath);
          setComposeMode("file");
          setComposeError(null);
          setComposeErrorLine(undefined);
          const svcs: { name: string; port: number }[] = [];
          for (const svc of proj.services) {
            for (const [host, _container] of svc.ports) {
              svcs.push({ name: svc.name, port: host });
            }
          }
          setDetectedServices(svcs);
          if (!portTouched && svcs.length > 0) setPort(svcs[0].port);
          break;
        } catch {
          // Try next candidate filename.
        }
      }
    }
  }

  /**
   * Browse for a compose file on disk, then parse it so we can auto-fill
   * downstream fields:
   *   - composeFile  → the picked path
   *   - rootDir      → parent dir of the file (if not already set)
   *   - name         → parent dir name (if not already set)
   *   - subdomain    → slugified parent dir (if not already set)
   *   - port         → first published host port from the compose (if not touched)
   *   - detectedServices → list of (service, host port) for picker display
   */
  async function pickAndParseComposeFile() {
    const defaultPath = rootDir || undefined;
    const selected = await pickComposeFileDialog(defaultPath);
    if (!selected) return;

    setComposeFile(selected);
    setComposeError(null);
    setComposeErrorLine(undefined);
    setComposeFileParsing(true);

    // Derive parent dir + filename from the picked path. Most users browse
    // for a compose inside their project root; use that as the rootDir +
    // name source unless they've already typed something.
    const segs = selected.split("/").filter(Boolean);
    const filename = segs.pop() ?? "";
    const parentDir = "/" + segs.join("/");
    const parentName = segs[segs.length - 1] ?? "";

    if (!rootDir.trim() && parentDir) setRootDir(parentDir);
    if (!name.trim() && parentName) setName(parentName);
    if (!subdomain.trim() && parentName) setSubdomain(slugify(parentName));

    try {
      const proj = await parseDockerCompose(selected);
      const svcs: { name: string; port: number }[] = [];
      for (const svc of proj.services) {
        for (const [host, _container] of svc.ports) {
          svcs.push({ name: svc.name, port: host });
        }
      }
      setDetectedServices(svcs);
      if (!portTouched && svcs.length > 0) setPort(svcs[0].port);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setComposeError(msg);
      const m = msg.match(/line (\d+)/i);
      setComposeErrorLine(m ? parseInt(m[1], 10) : undefined);
      setDetectedServices([]);
    } finally {
      setComposeFileParsing(false);
    }

    // Suppress unused-binding warning on parentName destructure (filename used
    // only to make the path's structure obvious to the reader).
    void filename;
  }

  const workspace = workspaces.find((w) => w.id === wsId) ?? null;
  const domain = workspace?.domain || "narakarya.test";
  const hostLabel = subdomain || name || "...";

  function handleSubdomainChange(val: string) {
    // Allow * but otherwise force lowercase
    const normalized = val === "*" ? "*" : val.toLowerCase();
    setSubdomain(normalized);
    setSubdomainError(validateSubdomain(normalized));
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const err = validateSubdomain(subdomain);
    if (err) { setSubdomainError(err); return; }
    if (!name) return;
    if (kind !== "docker" && kind !== "compose" && kind !== "proxy" && !rootDir) return;
    if (kind === "docker" && !dockerImage.trim()) return;
    if (kind === "compose") {
      if (composeMode === "file" && !composeFile.trim()) return;
      if (composeMode === "paste" && !composeYaml.trim()) return;
    }
    setSubmitting(true);
    await yieldToFrame();
    try {
      await addApp({
        workspace_id: wsId,
        name,
        root_dir: rootDir,
        port,
        subdomain: subdomain || null,
        start_command: kind === "process" ? command : "",
        start_command_source: commandSource,
        kind,
        docker_image: kind === "docker" ? dockerImage.trim() : null,
        docker_container_port: kind === "docker" ? dockerContainerPort : null,
        docker_args: kind === "docker" ? (dockerArgs.trim() || null) : null,
        docker_volumes: kind === "docker" ? dockerVolumes.filter((v) => v.trim()) : [],
        compose_file: kind === "compose" && composeMode === "file" ? composeFile.trim() : null,
        compose_yaml: kind === "compose" && composeMode === "paste" ? composeYaml : null,
        network_share: (kind === "docker" || kind === "compose") ? networkShare : false,
      });
      onClose();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 backdrop-blur-[2px] flex items-center justify-center z-50"
      onMouseDown={(e) => { downOnOverlayRef.current = e.target === e.currentTarget; }}
      onClick={(e) => {
        if (downOnOverlayRef.current && e.target === e.currentTarget) onClose();
        downOnOverlayRef.current = false;
      }}
    >
      <form
        onSubmit={submit}
        onMouseDown={(e) => e.stopPropagation()}
        className={`relative bg-surface-2 border border-subtle rounded-card flex flex-col shadow-2xl max-h-[90vh] overflow-hidden transition-[width] duration-200 ${
          kind === "compose" ? "w-[720px]" : "w-[420px]"
        }`}
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute top-3 right-3 z-10 p-1 rounded-lg text-ink-3 hover:text-ink-2 hover:bg-white/[0.06] transition-colors"
          title="Close (Esc)"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </button>

        {/* Header band */}
        <div className="px-5 py-3.5 border-b border-subtle shrink-0">
          <h2 className="text-[14px] font-medium text-ink">Add app</h2>
        </div>

        {/* Scrollable body */}
        <div className="flex flex-col gap-4 px-5 py-4 overflow-y-auto min-h-0 flex-1">

        {/* Folder picker — required for process/static, optional for docker, hidden for proxy */}
        {kind !== "proxy" && (
          <label className="flex flex-col gap-1.5">
            <span className={labelCls}>
              {kind === "docker" ? "Working Folder (optional)" :
               kind === "compose" ? "Compose Project Folder" :
               "Project Folder"}
            </span>
            <div className="flex gap-2">
              <input value={rootDir} readOnly placeholder={
                kind === "docker" ? "Base for relative volume paths" :
                kind === "compose" ? "Folder containing docker-compose.yml" :
                "Select a folder..."
              }
                className={`${inputCls} flex-1 cursor-default`} />
              <button type="button" onClick={pickFolder}
                className="px-3 py-2 border border-strong hover:bg-white/[0.06] rounded-lg text-[13px] text-ink-2 transition-colors shrink-0">
                Browse…
              </button>
            </div>
          </label>
        )}

        {/* Stack-detection success banner */}
        {kind === "process" && command && commandSource === "auto" && (
          <div className="flex items-center gap-2 bg-ok-bg rounded-lg px-3 py-2">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
              className="text-ok shrink-0">
              <path d="M12 12c2-2.96 0-7-1-8 0 3.038-1.773 4.741-3 6-1.226 1.26-2 3.24-2 5a6 6 0 1 0 12 0c0-1.532-1.056-3.94-2-5-1.786 3-2.791 3-4 2z" />
            </svg>
            <span className="text-[12px] text-ok">
              Detected start command · <code className="font-mono font-medium">{command}</code>
            </span>
          </div>
        )}

        {/* Kind toggle */}
        <div className="flex flex-col gap-1.5">
          <span className={labelCls}>Type</span>
          <div className="flex gap-1 bg-surface-input border border-subtle rounded-lg p-1">
            {(["process", "static", "docker", "compose", "proxy"] as AppKind[]).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setKind(k)}
                className={`flex-1 px-3 py-1.5 text-[12px] font-medium rounded-md transition-colors capitalize ${
                  kind === k
                    ? "bg-white/[0.08] text-ink"
                    : "text-ink-3 hover:text-ink-2"
                }`}
              >
                {k}
              </button>
            ))}
          </div>
          {kind === "static" && (
            <span className="text-[11px] text-zinc-500">
              Caddy serves files directly from the folder — no command, no port.
            </span>
          )}
          {kind === "docker" && (
            <span className="text-[11px] text-zinc-500">
              Porta runs a container as <code className="font-mono">porta-&lt;id&gt;</code>. Requires Docker Desktop / OrbStack.
            </span>
          )}
          {kind === "compose" && (
            <span className="text-[11px] text-zinc-500">
              Porta runs <code className="font-mono">docker compose up</code>. Port is which published port Caddy proxies — auto-detected from yml.
            </span>
          )}
          {kind === "proxy" && (
            <span className="text-[11px] text-zinc-500">
              Caddy reverse-proxies the domain to an existing local port. You run the upstream yourself.
            </span>
          )}
        </div>

        {/* Name + Port */}
        <div className="flex gap-3">
          <label className="flex flex-col gap-1.5 flex-1">
            <span className={labelCls}>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} required
              placeholder="my-app" className={inputCls} autoComplete="off" spellCheck={false} />
          </label>
          {kind !== "static" && (
            <label className="flex flex-col gap-1.5 w-[76px]">
              <span className={`${labelCls} flex items-center gap-1.5`}>
                {kind === "docker" ? "Host Port" :
                 kind === "compose" ? "Proxy Port" :
                 kind === "proxy" ? "Upstream Port" :
                 "Port"}
                {kind === "compose" && detectedServices.length > 0 && !portTouched && (
                  <span className="text-[9px] normal-case tracking-normal text-emerald-400/80" title="Auto-filled from compose ports:">
                    auto
                  </span>
                )}
              </span>
              <input type="number" value={port}
                onChange={(e) => { setPort(Number(e.target.value)); setPortTouched(true); }}
                className={inputCls} />
              {kind === "compose" && portTouched && detectedServices.length > 0 && (
                <button
                  type="button"
                  onClick={() => { setPort(detectedServices[0].port); setPortTouched(false); }}
                  className="text-[10px] text-zinc-500 hover:text-zinc-300 self-start transition-colors"
                  title="Reset to first detected port"
                >
                  ↻ use {detectedServices[0].port}
                </button>
              )}
            </label>
          )}
        </div>

        {/* Compose fields */}
        {kind === "compose" && (
          <div className="flex flex-col gap-1.5">
            <span className={labelCls}>Compose Source</span>
            <div className="flex gap-1 bg-surface-input border border-subtle rounded-lg p-1">
              {(["paste", "file"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setComposeMode(m)}
                  className={`flex-1 px-3 py-1.5 text-[12px] font-medium rounded-md transition-colors capitalize ${
                    composeMode === m
                      ? "bg-white/[0.08] text-ink"
                      : "text-ink-3 hover:text-ink-2"
                  }`}
                >
                  {m === "paste" ? "Paste YAML" : "File on disk"}
                </button>
              ))}
            </div>
            {composeMode === "file" ? (
              <>
                <div className="flex gap-2">
                  <input
                    value={composeFile}
                    onChange={(e) => setComposeFile(e.target.value)}
                    placeholder="docker-compose.yml"
                    className={`${inputCls} font-mono text-[12px] flex-1`}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    onClick={pickAndParseComposeFile}
                    disabled={composeFileParsing}
                    className="px-3 py-2 text-[12px] rounded-lg bg-white/[0.05] hover:bg-white/[0.08] border border-white/[0.08] text-zinc-300 transition-colors disabled:opacity-50 shrink-0"
                  >
                    {composeFileParsing ? "Parsing…" : "Browse…"}
                  </button>
                </div>
                {composeError && (
                  <div className="px-2.5 py-1.5 rounded-md bg-red-500/10 border border-red-500/30 text-[11px] text-red-300 font-mono whitespace-pre-wrap break-words">
                    {composeError}
                  </div>
                )}
                {!composeError && detectedServices.length > 0 && (
                  <div className="text-[11px] text-emerald-400/80">
                    Detected {detectedServices.length} published port{detectedServices.length > 1 ? "s" : ""}:{" "}
                    {detectedServices.map((s) => `${s.name}:${s.port}`).join(", ")}
                  </div>
                )}
                <span className="text-[11px] text-zinc-500">
                  Relative to Compose Project Folder. Absolute paths also OK. <code className="font-mono">.yaml</code> and <code className="font-mono">.yml</code> both work.
                </span>
              </>
            ) : (
              <>
                <YamlEditor
                  value={composeYaml}
                  onChange={setComposeYaml}
                  placeholder={`services:\n  app:\n    image: postgres:16\n    ports:\n      - "5432:5432"`}
                  rows={18}
                  errorLine={composeErrorLine}
                  errorMessage={composeError ?? undefined}
                />
                {composeError && (
                  <div className="px-2.5 py-1.5 rounded-md bg-red-500/10 border border-red-500/30 text-[11px] text-red-300 font-mono whitespace-pre-wrap break-words">
                    {composeError}
                  </div>
                )}
                {!composeError && detectedServices.length > 0 && (
                  <div className="text-[11px] text-emerald-400/80">
                    Detected {detectedServices.length} published port{detectedServices.length > 1 ? "s" : ""}:{" "}
                    {detectedServices.map((s) => `${s.name}:${s.port}`).join(", ")}
                  </div>
                )}
                <span className="text-[11px] text-zinc-500">
                  Saved to <code className="font-mono">~/.porta/compose/&lt;id&gt;/docker-compose.yml</code>. Relative paths in yml resolve to Compose Project Folder.
                </span>
              </>
            )}
          </div>
        )}

        {/* Docker fields */}
        {kind === "docker" && (
          <>
            <label className="flex flex-col gap-1.5">
              <span className={labelCls}>Image</span>
              <input
                value={dockerImage}
                onChange={(e) => setDockerImage(e.target.value)}
                placeholder="e.g. postgres:16"
                className={inputCls}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className={labelCls}>Container Port</span>
              <input
                type="number"
                value={dockerContainerPort}
                onChange={(e) => setDockerContainerPort(Number(e.target.value))}
                placeholder="80"
                className={inputCls}
              />
              <span className="text-[11px] text-zinc-500">
                Internal port the container listens on. Porta maps host <code className="font-mono">port</code> → this.
              </span>
            </label>
            <div className="flex flex-col gap-1.5">
              <span className={labelCls}>Volumes</span>
              <div className="flex flex-col gap-1.5">
                {dockerVolumes.map((v, i) => (
                  <div key={i} className="flex gap-2">
                    <input
                      value={v}
                      onChange={(e) => setDockerVolumes((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))}
                      placeholder="./data:/var/lib/data"
                      className={`${inputCls} flex-1 font-mono text-[12px]`}
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <button
                      type="button"
                      onClick={() => setDockerVolumes((prev) => prev.map((x, j) => (j === i ? volumeTemplate(name) : x)))}
                      className="px-2.5 text-zinc-500 hover:text-zinc-200 border border-white/[0.08] rounded-lg text-[11px] shrink-0"
                      title={`Fill with ${volumeTemplate(name)}`}
                    >
                      base
                    </button>
                    <button
                      type="button"
                      onClick={() => setDockerVolumes((prev) => prev.filter((_, j) => j !== i))}
                      className="px-2.5 text-zinc-500 hover:text-red-400 border border-white/[0.08] rounded-lg text-[14px] shrink-0"
                      title="Remove"
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => setDockerVolumes((prev) => [...prev, ""])}
                  className="self-start px-2.5 py-1 text-[11px] text-zinc-400 hover:text-zinc-200 border border-dashed border-white/[0.12] rounded-md"
                >
                  + Add volume
                </button>
              </div>
              <span className="text-[11px] text-zinc-500">
                <code className="font-mono">source:target</code> — relative sources resolve against Working Folder.
              </span>
            </div>
            <label className="flex flex-col gap-1.5">
              <span className={labelCls}>Extra Args (optional)</span>
              <input
                value={dockerArgs}
                onChange={(e) => setDockerArgs(e.target.value)}
                placeholder="-e DEBUG=true --network my-net"
                className={`${inputCls} font-mono text-[12px]`}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
          </>
        )}

        {/* Shared workspace network — docker and compose only */}
        {(kind === "docker" || kind === "compose") && (
          <label className="flex items-start gap-2.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={networkShare}
              onChange={(e) => setNetworkShare(e.target.checked)}
              className="mt-0.5 rounded border-white/[0.15] bg-white/[0.05] text-blue-500 focus:ring-blue-500/30 focus:ring-offset-0"
            />
            <div className="flex flex-col gap-0.5">
              <span className="text-[12px] text-zinc-200">Join workspace network</span>
              <span className="text-[11px] text-zinc-500">
                Other apps in the same workspace can reach this via <code className="font-mono">porta-&lt;id&gt;</code>.
              </span>
            </div>
          </label>
        )}

        {/* Start command — process apps only */}
        {kind === "process" && (
          <div className="flex flex-col gap-1.5">
            <span className={labelCls}>Start Command</span>
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
                <div className="absolute top-full left-0 right-0 mt-1 z-50 bg-surface-2 border border-subtle rounded-lg shadow-xl overflow-hidden">
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
        )}

        {/* Subdomain */}
        <label className="flex flex-col gap-1.5">
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

        {/* Preview URL */}
        <div className="flex flex-col gap-1.5">
          <span className={labelCls}>URL</span>
          <div className="flex items-center bg-surface-input border border-subtle rounded-lg px-3 py-2 font-mono text-[12px] truncate">
            <span className="text-ink-2 truncate">{hostLabel}</span>
            <span className="text-ink shrink-0">.{domain}</span>
          </div>
        </div>

        {/* Workspace */}
        {workspaces.length > 0 && (
          <label className="flex flex-col gap-1.5">
            <span className={labelCls}>Workspace</span>
            <select value={wsId ?? ""} onChange={(e) => setWsId(e.target.value || null)}
              className="select-base">
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>{w.name}</option>
              ))}
            </select>
          </label>
        )}

        </div>

        {/* Footer band */}
        <div className="flex justify-end gap-2 px-5 py-3.5 border-t border-subtle bg-surface-1 shrink-0">
          <button type="button" onClick={onClose}
            className="px-4 py-1.5 text-[13px] text-ink-2 hover:text-ink rounded-lg transition-colors">
            Cancel
          </button>
          <button type="submit" disabled={submitting || !!subdomainError}
            className="px-4 py-1.5 text-[13px] font-medium bg-accent hover:brightness-110 text-white rounded-control disabled:opacity-50 transition-colors flex items-center gap-2">
            {submitting && (
              <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.3" />
                <path d="M14 8a6 6 0 00-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            )}
            {submitting ? "Adding…" : "Add app"}
          </button>
        </div>
      </form>
    </div>
  );
}
