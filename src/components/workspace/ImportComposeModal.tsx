import { useState } from "react";
import { parseDockerCompose, isTauri } from "../../lib/commands";
import type { ComposeService, ComposeProject } from "../../lib/commands";
import { usePortaStore } from "../../store";

const inputCls =
  "w-full bg-[#111113] border border-white/[0.08] rounded-lg px-3 py-2 text-[13px] text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-blue-500/60 transition-colors";
const labelCls = "text-[11px] font-medium text-zinc-500 uppercase tracking-wide";

type ImportMode = "app" | "service";

interface ServiceSelection {
  checked: boolean;
  mode: ImportMode;
}

async function pickComposeFile(): Promise<string | null> {
  if (isTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      multiple: false,
      filters: [{ name: "Docker Compose", extensions: ["yml", "yaml"] }],
    });
    return typeof selected === "string" ? selected : null;
  }
  return window.prompt("Enter path to docker-compose.yml:");
}

/** Split "image:tag" into [image, tag]. Falls back to "latest" if no tag. */
function splitImageTag(imageStr: string): [string, string] {
  // Handle images with registry prefix like ghcr.io/user/image:tag
  const lastColon = imageStr.lastIndexOf(":");
  // If colon is part of a port/registry (e.g. localhost:5000/image), check for slash after colon
  if (lastColon > 0 && !imageStr.substring(lastColon).includes("/")) {
    return [imageStr.substring(0, lastColon), imageStr.substring(lastColon + 1)];
  }
  return [imageStr, "latest"];
}

interface Props {
  workspaceId: string | null;
  onClose: () => void;
}

export default function ImportComposeModal({ workspaceId, onClose }: Props) {
  const { addApp, addService } = usePortaStore();

  const [filePath, setFilePath] = useState("");
  const [project, setProject] = useState<ComposeProject | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);
  const [selections, setSelections] = useState<Record<string, ServiceSelection>>({});
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);

  async function handlePickFile() {
    const path = await pickComposeFile();
    if (!path) return;
    setFilePath(path);
    setParseError(null);
    setProject(null);
    setImportResult(null);
    setParsing(true);
    try {
      const result = await parseDockerCompose(path);
      setProject(result);
      // Default: all checked, auto-detect mode
      const sel: Record<string, ServiceSelection> = {};
      for (const svc of result.services) {
        const hasImage = !!svc.image;
        sel[svc.name] = {
          checked: true,
          mode: hasImage ? "service" : "app",
        };
      }
      setSelections(sel);
    } catch (e) {
      setParseError(e instanceof Error ? e.message : String(e));
    } finally {
      setParsing(false);
    }
  }

  function toggleChecked(name: string) {
    setSelections((prev) => ({
      ...prev,
      [name]: { ...prev[name], checked: !prev[name].checked },
    }));
  }

  function setMode(name: string, mode: ImportMode) {
    setSelections((prev) => ({
      ...prev,
      [name]: { ...prev[name], mode },
    }));
  }

  const selectedServices = project?.services.filter((s) => selections[s.name]?.checked) ?? [];
  const selectedCount = selectedServices.length;

  async function handleImport() {
    if (!project || selectedCount === 0) return;
    setImporting(true);
    setImportResult(null);
    let imported = 0;
    const errors: string[] = [];

    for (const svc of selectedServices) {
      const sel = selections[svc.name];
      try {
        if (sel.mode === "app") {
          await addApp({
            workspace_id: workspaceId,
            name: svc.name,
            root_dir: svc.build_context || "",
            port: svc.ports.length > 0 ? svc.ports[0][0] : 3000,
            subdomain: null,
            start_command: svc.command || "",
            start_command_source: "docker-compose",
          });
          imported++;
        } else {
          const imageStr = svc.image || "";
          const [image, tag] = splitImageTag(imageStr);
          await addService({
            name: svc.name,
            image,
            tag,
            port: svc.ports.length > 0 ? svc.ports[0][0] : 0,
            env_vars: svc.environment,
            volumes: svc.volumes,
            scope: workspaceId ?? "global",
          });
          imported++;
        }
      } catch (e) {
        errors.push(`${svc.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    setImporting(false);
    if (errors.length > 0) {
      setImportResult(`Imported ${imported}/${selectedCount}. Errors: ${errors.join("; ")}`);
    } else {
      setImportResult(`Successfully imported ${imported} item${imported !== 1 ? "s" : ""}.`);
      setTimeout(onClose, 1200);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-[2px] flex items-center justify-center z-50">
      <div className="bg-[#1c1c1e] border border-white/[0.08] rounded-2xl p-6 w-[560px] flex flex-col gap-5 shadow-2xl max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div>
          <h2 className="text-[15px] font-semibold text-zinc-100">Import from Docker Compose</h2>
          <p className="text-[12px] text-zinc-500 mt-0.5">
            Parse a docker-compose.yml and create Porta apps and services
          </p>
        </div>

        {/* File picker */}
        <label className="flex flex-col gap-1.5">
          <span className={labelCls}>Compose File</span>
          <div className="flex gap-2">
            <input
              value={filePath}
              readOnly
              placeholder="Select a docker-compose.yml..."
              className={`${inputCls} flex-1 cursor-default`}
            />
            <button
              type="button"
              onClick={handlePickFile}
              disabled={parsing}
              className="px-3 py-2 bg-white/[0.07] hover:bg-white/[0.11] border border-white/[0.08] rounded-lg text-[13px] text-zinc-300 transition-colors shrink-0 disabled:opacity-50"
            >
              {parsing ? "Parsing..." : "Browse"}
            </button>
          </div>
        </label>

        {parseError && (
          <div className="px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-lg text-[12px] text-red-400">
            {parseError}
          </div>
        )}

        {/* Parsed services list */}
        {project && project.services.length > 0 && (
          <>
            <div className="h-px bg-white/[0.05]" />

            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className={labelCls}>
                  Services ({project.services.length} found)
                </span>
                <span className="text-[10px] text-zinc-600">
                  {selectedCount} selected
                </span>
              </div>

              <div className="flex flex-col gap-1">
                {project.services.map((svc) => (
                  <ServiceRow
                    key={svc.name}
                    service={svc}
                    selection={selections[svc.name]}
                    onToggle={() => toggleChecked(svc.name)}
                    onModeChange={(mode) => setMode(svc.name, mode)}
                  />
                ))}
              </div>
            </div>

            {/* Preview */}
            {selectedCount > 0 && (
              <>
                <div className="h-px bg-white/[0.05]" />
                <div className="flex flex-col gap-1.5">
                  <span className={labelCls}>Import Preview</span>
                  <div className="flex flex-col gap-1">
                    {selectedServices.map((svc) => {
                      const sel = selections[svc.name];
                      return (
                        <PreviewRow key={svc.name} service={svc} mode={sel.mode} />
                      );
                    })}
                  </div>
                </div>
              </>
            )}
          </>
        )}

        {project && project.services.length === 0 && (
          <div className="px-3 py-4 text-center text-[12px] text-zinc-600">
            No services found in this compose file.
          </div>
        )}

        {importResult && (
          <div
            className={`px-3 py-2 rounded-lg text-[12px] ${
              importResult.includes("Error")
                ? "bg-amber-500/10 border border-amber-500/20 text-amber-400"
                : "bg-emerald-500/10 border border-emerald-500/20 text-emerald-400"
            }`}
          >
            {importResult}
          </div>
        )}

        {/* Footer */}
        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 text-[13px] text-zinc-500 hover:text-zinc-200 rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleImport}
            disabled={importing || selectedCount === 0 || !project}
            className="px-4 py-1.5 text-[13px] font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg disabled:opacity-50 transition-colors flex items-center gap-2"
          >
            {importing && (
              <span className="w-3.5 h-3.5 border border-white/50 border-t-transparent rounded-full animate-spin" />
            )}
            {importing ? "Importing..." : `Import ${selectedCount} Selected`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────────

function ServiceRow({
  service,
  selection,
  onToggle,
  onModeChange,
}: {
  service: ComposeService;
  selection: ServiceSelection;
  onToggle: () => void;
  onModeChange: (mode: ImportMode) => void;
}) {
  const hasImage = !!service.image;
  const hasBuild = !!service.build_context;
  const portStr = service.ports.length > 0
    ? service.ports.map(([h, c]) => (h === c ? String(h) : `${h}:${c}`)).join(", ")
    : "no ports";

  return (
    <div
      className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-colors ${
        selection.checked
          ? "bg-white/[0.03] border-white/[0.08]"
          : "bg-transparent border-transparent opacity-50"
      }`}
    >
      {/* Checkbox */}
      <button
        type="button"
        onClick={onToggle}
        className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors ${
          selection.checked
            ? "bg-blue-600 border-blue-500"
            : "bg-transparent border-zinc-600 hover:border-zinc-400"
        }`}
      >
        {selection.checked && (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path d="M2 5l2.5 2.5L8 3" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>

      {/* Name + details */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium text-zinc-200 truncate">{service.name}</span>
          <span className="text-[10px] text-zinc-600 font-mono truncate">
            {service.image || service.build_context || "no image/build"}
          </span>
        </div>
        <div className="flex items-center gap-3 mt-0.5">
          <span className="text-[10px] text-zinc-600">{portStr}</span>
          {Object.keys(service.environment).length > 0 && (
            <span className="text-[10px] text-zinc-600">
              {Object.keys(service.environment).length} env vars
            </span>
          )}
          {service.volumes.length > 0 && (
            <span className="text-[10px] text-zinc-600">
              {service.volumes.length} volume{service.volumes.length !== 1 ? "s" : ""}
            </span>
          )}
        </div>
      </div>

      {/* Mode toggle */}
      {selection.checked && (
        <div className="flex rounded-md border border-white/[0.08] overflow-hidden shrink-0">
          <button
            type="button"
            onClick={() => onModeChange("app")}
            disabled={!hasBuild && !service.command}
            className={`px-2 py-1 text-[10px] font-medium transition-colors ${
              selection.mode === "app"
                ? "bg-white/[0.10] text-zinc-200"
                : "bg-white/[0.02] text-zinc-500 hover:text-zinc-300"
            } disabled:opacity-30 disabled:cursor-not-allowed`}
            title={!hasBuild && !service.command ? "No build context or command found" : "Import as Porta App"}
          >
            App
          </button>
          <button
            type="button"
            onClick={() => onModeChange("service")}
            disabled={!hasImage}
            className={`px-2 py-1 text-[10px] font-medium transition-colors ${
              selection.mode === "service"
                ? "bg-white/[0.10] text-zinc-200"
                : "bg-white/[0.02] text-zinc-500 hover:text-zinc-300"
            } disabled:opacity-30 disabled:cursor-not-allowed`}
            title={!hasImage ? "No image specified" : "Import as Docker Service"}
          >
            Service
          </button>
        </div>
      )}
    </div>
  );
}

function PreviewRow({ service, mode }: { service: ComposeService; mode: ImportMode }) {
  if (mode === "app") {
    const port = service.ports.length > 0 ? service.ports[0][0] : 3000;
    return (
      <div className="flex items-center gap-2 px-2.5 py-1.5 bg-white/[0.03] rounded-lg border border-white/[0.05]">
        <span className="text-[10px] font-medium text-blue-400 bg-blue-500/10 px-1.5 py-0.5 rounded shrink-0">
          APP
        </span>
        <span className="text-[11px] text-zinc-300 font-medium truncate">{service.name}</span>
        <span className="text-[10px] text-zinc-600 font-mono">:{port}</span>
        {service.build_context && (
          <span className="text-[10px] text-zinc-600 truncate ml-auto">{service.build_context}</span>
        )}
      </div>
    );
  }

  const imageStr = service.image || "";
  const [image, tag] = splitImageTag(imageStr);
  const port = service.ports.length > 0 ? service.ports[0][0] : 0;

  return (
    <div className="flex items-center gap-2 px-2.5 py-1.5 bg-white/[0.03] rounded-lg border border-white/[0.05]">
      <span className="text-[10px] font-medium text-purple-400 bg-purple-500/10 px-1.5 py-0.5 rounded shrink-0">
        SVC
      </span>
      <span className="text-[11px] text-zinc-300 font-medium truncate">{service.name}</span>
      <span className="text-[10px] text-zinc-600 font-mono truncate">
        {image}:{tag}
      </span>
      {port > 0 && <span className="text-[10px] text-zinc-600 font-mono">:{port}</span>}
    </div>
  );
}
