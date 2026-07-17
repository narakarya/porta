import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { usePortaStore } from "../../store";
import type { ServiceTemplate } from "../../types";
import ModalWrapper from "../shared/ModalWrapper";
import { yieldToFrame } from "../../lib/ui";

// ── Shared styles ─────────────────────────────────────────────────────────────

const inputCls =
  "w-full bg-[#111113] border border-white/[0.08] rounded-lg px-3 py-2 text-[13px] text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-blue-500/60 transition-colors";
const labelCls = "text-[11px] font-medium text-zinc-500 uppercase tracking-wide";

// ── Presets ───────────────────────────────────────────────────────────────────

interface Preset {
  label: string;
  icon: string;
  image: string;
  tag: string;
  versions: string[]; // curated tag suggestions; user can still type custom
  port: number;
  env_vars: Record<string, string>;
  volumes: string[];
}

const PRESETS: Preset[] = [
  {
    label: "PostgreSQL",
    icon: "🐘",
    image: "postgres",
    tag: "17",
    versions: ["17", "17-alpine", "16", "16-alpine", "15", "15-alpine", "14", "13"],
    port: 5432,
    env_vars: { POSTGRES_PASSWORD: "postgres", POSTGRES_USER: "postgres", POSTGRES_DB: "app" },
    volumes: ["pgdata:/var/lib/postgresql/data"],
  },
  {
    label: "MySQL",
    icon: "🐬",
    image: "mysql",
    tag: "8",
    versions: ["8.4", "8.0", "8", "5.7"],
    port: 3306,
    env_vars: { MYSQL_ROOT_PASSWORD: "root", MYSQL_DATABASE: "app" },
    volumes: ["mysqldata:/var/lib/mysql"],
  },
  {
    label: "Redis",
    icon: "⚡",
    image: "redis",
    tag: "7-alpine",
    versions: ["7", "7-alpine", "6", "6-alpine"],
    port: 6379,
    env_vars: {},
    volumes: ["redisdata:/data"],
  },
  {
    label: "MongoDB",
    icon: "🍃",
    image: "mongo",
    tag: "7",
    versions: ["7", "7-jammy", "6", "5"],
    port: 27017,
    env_vars: { MONGO_INITDB_ROOT_USERNAME: "root", MONGO_INITDB_ROOT_PASSWORD: "root" },
    volumes: ["mongodata:/data/db"],
  },
  {
    label: "MariaDB",
    icon: "🦭",
    image: "mariadb",
    tag: "11",
    versions: ["11", "10.11", "10.6"],
    port: 3306,
    env_vars: { MARIADB_ROOT_PASSWORD: "root", MARIADB_DATABASE: "app" },
    volumes: ["mariadbdata:/var/lib/mysql"],
  },
  {
    label: "RabbitMQ",
    icon: "🐇",
    image: "rabbitmq",
    tag: "3-management-alpine",
    versions: ["3-management-alpine", "3-management", "3-alpine", "3"],
    port: 5672,
    env_vars: { RABBITMQ_DEFAULT_USER: "admin", RABBITMQ_DEFAULT_PASS: "admin" },
    volumes: [],
  },
  {
    label: "MinIO",
    icon: "🗄️",
    image: "minio/minio",
    tag: "latest",
    versions: ["latest"],
    port: 9000,
    env_vars: { MINIO_ROOT_USER: "minioadmin", MINIO_ROOT_PASSWORD: "minioadmin" },
    volumes: ["miniodata:/data"],
  },
  {
    label: "Custom",
    icon: "📦",
    image: "",
    tag: "latest",
    versions: [],
    port: 8080,
    env_vars: {},
    volumes: [],
  },
];

// ── Env / Volume row types ────────────────────────────────────────────────────

interface EnvRow { id: string; key: string; value: string; }
interface VolRow { id: string; source: string; target: string; }

let _rowId = 0;
const newId = () => String(++_rowId);

function envRowsFromRecord(rec: Record<string, string>): EnvRow[] {
  const rows = Object.entries(rec).map(([key, value]) => ({ id: newId(), key, value }));
  return rows.length > 0 ? rows : [{ id: newId(), key: "", value: "" }];
}

function volRowsFromStrings(vols: string[]): VolRow[] {
  const rows = vols.map((v) => {
    const idx = v.indexOf(":");
    return { id: newId(), source: v.slice(0, idx), target: v.slice(idx + 1) };
  });
  return rows;
}

// ── Sub-editors ───────────────────────────────────────────────────────────────

function EnvEditor({ rows, onChange }: { rows: EnvRow[]; onChange: (r: EnvRow[]) => void }) {
  function update(id: string, field: "key" | "value", val: string) {
    onChange(rows.map((r) => r.id === id ? { ...r, [field]: val } : r));
  }
  function remove(id: string) { onChange(rows.filter((r) => r.id !== id)); }
  function add() { onChange([...rows, { id: newId(), key: "", value: "" }]); }

  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((row) => (
        <div key={row.id} className="flex gap-1.5 items-center">
          <input
            value={row.key}
            onChange={(e) => update(row.id, "key", e.target.value)}
            placeholder="KEY"
            spellCheck={false}
            className="w-[42%] bg-[#111113] border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-[12px] font-mono text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-blue-500/60 transition-colors"
          />
          <span className="text-zinc-700 text-[11px] shrink-0">=</span>
          <input
            value={row.value}
            onChange={(e) => update(row.id, "value", e.target.value)}
            placeholder="value"
            spellCheck={false}
            className="flex-1 bg-[#111113] border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-[12px] font-mono text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-blue-500/60 transition-colors"
          />
          <button
            type="button"
            onClick={() => remove(row.id)}
            className="p-1 text-zinc-700 hover:text-red-400 hover:bg-red-500/10 rounded transition-colors shrink-0"
            title="Remove"
          >
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
              <path d="M1.5 1.5l8 8M9.5 1.5l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={add}
        className="flex items-center gap-1.5 text-[11px] text-zinc-600 hover:text-zinc-300 transition-colors w-fit mt-0.5"
      >
        <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
          <path d="M5.5 1v9M1 5.5h9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
        </svg>
        Add variable
      </button>
    </div>
  );
}

function VolumeEditor({ rows, onChange }: { rows: VolRow[]; onChange: (r: VolRow[]) => void }) {
  function update(id: string, field: "source" | "target", val: string) {
    onChange(rows.map((r) => r.id === id ? { ...r, [field]: val } : r));
  }
  function remove(id: string) { onChange(rows.filter((r) => r.id !== id)); }
  function add() { onChange([...rows, { id: newId(), source: "", target: "" }]); }

  return (
    <div className="flex flex-col gap-1.5">
      {rows.length === 0 && (
        <p className="text-[11px] text-zinc-700 italic">No volumes — data won't persist after stop.</p>
      )}
      {rows.map((row) => (
        <div key={row.id} className="flex gap-1.5 items-center">
          <input
            value={row.source}
            onChange={(e) => update(row.id, "source", e.target.value)}
            placeholder="name or /host/path"
            spellCheck={false}
            className="flex-1 bg-[#111113] border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-[12px] font-mono text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-blue-500/60 transition-colors"
          />
          <span className="text-zinc-700 text-[11px] shrink-0">:</span>
          <input
            value={row.target}
            onChange={(e) => update(row.id, "target", e.target.value)}
            placeholder="/container/path"
            spellCheck={false}
            className="flex-1 bg-[#111113] border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-[12px] font-mono text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-blue-500/60 transition-colors"
          />
          <button
            type="button"
            onClick={() => remove(row.id)}
            className="p-1 text-zinc-700 hover:text-red-400 hover:bg-red-500/10 rounded transition-colors shrink-0"
            title="Remove"
          >
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
              <path d="M1.5 1.5l8 8M9.5 1.5l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={add}
        className="flex items-center gap-1.5 text-[11px] text-zinc-600 hover:text-zinc-300 transition-colors w-fit mt-0.5"
      >
        <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
          <path d="M5.5 1v9M1 5.5h9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
        </svg>
        Add volume
      </button>
    </div>
  );
}

// ── Main modal ────────────────────────────────────────────────────────────────

interface Props {
  onClose: () => void;
  /**
   * Pre-select the scope dropdown. Callers opening the modal from inside a
   * workspace pass that workspace's id so the new service stays scoped to
   * it by default; the user can still flip it to global in the form.
   */
  defaultScope?: "global" | string;
  /**
   * Pre-fill the form from a built-in preset by its label (e.g. "PostgreSQL",
   * "Redis"). Used by the Services template picker so a chip opens the modal
   * ready to submit. Matched against `allPresets` on mount; unknown labels are
   * ignored (modal opens on the empty preset grid).
   */
  initialPreset?: string;
}

function sanitizeVolumeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

type PresetEntry = Preset & { userTemplateId?: string };

export default function AddServiceModal({ onClose, defaultScope, initialPreset }: Props) {
  const {
    workspaces,
    services,
    serviceTemplates,
    addService,
    saveServiceTemplate,
    deleteServiceTemplate,
  } = usePortaStore();
  const [selectedPreset, setSelectedPreset] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [image, setImage] = useState("");
  const [tag, setTag] = useState("latest");
  const [versions, setVersions] = useState<string[]>([]);
  const [port, setPort] = useState<number>(8080);
  const [envRows, setEnvRows] = useState<EnvRow[]>([]);
  const [volRows, setVolRows] = useState<VolRow[]>([]);
  const [scope, setScope] = useState<"global" | string>(defaultScope ?? "global");
  const [submitting, setSubmitting] = useState(false);
  const [collisionHint, setCollisionHint] = useState<string | null>(null);
  const [saveAsTemplate, setSaveAsTemplate] = useState(false);
  const [templateLabel, setTemplateLabel] = useState("");
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);

  // Combined preset grid: built-ins first, then user templates, then Custom (escape hatch).
  const allPresets = useMemo<PresetEntry[]>(() => {
    const builtins = PRESETS.slice(0, -1);
    const custom = PRESETS[PRESETS.length - 1];
    const userEntries: PresetEntry[] = serviceTemplates.map((t) => ({
      label: t.label,
      icon: t.icon,
      image: t.image,
      tag: t.tag,
      versions: t.versions,
      port: t.port,
      env_vars: t.env_vars,
      volumes: t.volumes,
      userTemplateId: t.id,
    }));
    return [...builtins, ...userEntries, custom];
  }, [serviceTemplates]);

  function selectPreset(index: number) {
    const p = allPresets[index];
    setSelectedPreset(index);
    setEditingTemplateId(p.userTemplateId ?? null);
    setSaveAsTemplate(false);
    setTemplateLabel(p.label);
    setImage(p.image);
    setTag(p.tag);
    setVersions(p.versions);
    setEnvRows(envRowsFromRecord(p.env_vars));

    if (p.label === "Custom") {
      setName("");
      setPort(p.port);
      setVolRows(volRowsFromStrings(p.volumes));
      setCollisionHint(null);
      return;
    }

    // Detect collisions with existing services sharing the same image, then
    // auto-suggest a unique name, free port, and per-instance volume sources.
    const sameImage = services.filter((s) => s.image === p.image);
    const takenNames = new Set(services.map((s) => s.name));
    const takenPorts = new Set(services.map((s) => s.port));

    let suggestedName = p.label;
    if (sameImage.length > 0) {
      const byTag = `${p.label}-${p.tag}`;
      if (!takenNames.has(byTag)) {
        suggestedName = byTag;
      } else {
        let n = 2;
        while (takenNames.has(`${p.label}-${n}`)) n++;
        suggestedName = `${p.label}-${n}`;
      }
    }

    let suggestedPort = p.port;
    while (takenPorts.has(suggestedPort)) suggestedPort++;

    const nameChanged = suggestedName !== p.label;
    const suggestedVolumes = nameChanged
      ? p.volumes.map((v) => {
          const idx = v.indexOf(":");
          const src = v.slice(0, idx);
          const tgt = v.slice(idx + 1);
          return `${sanitizeVolumeName(suggestedName)}-${src}:${tgt}`;
        })
      : p.volumes;

    setName(suggestedName);
    setPort(suggestedPort);
    setVolRows(volRowsFromStrings(suggestedVolumes));

    if (sameImage.length > 0) {
      const parts: string[] = [];
      if (nameChanged) parts.push(`name → ${suggestedName}`);
      if (suggestedPort !== p.port) parts.push(`port → ${suggestedPort}`);
      setCollisionHint(
        parts.length > 0
          ? `${sameImage.length} existing ${p.image} service — adjusted ${parts.join(", ")}`
          : null,
      );
    } else {
      setCollisionHint(null);
    }
  }

  // Template picker → pre-fill from a built-in preset once on mount. Matched
  // by label against the combined preset list; ignored if not found.
  const didPrefill = useRef(false);
  useEffect(() => {
    if (didPrefill.current || !initialPreset) return;
    const idx = allPresets.findIndex((p) => p.label === initialPreset);
    if (idx >= 0) {
      didPrefill.current = true;
      selectPreset(idx);
    }
    // selectPreset/allPresets are stable enough for a one-shot prefill; the ref
    // guard prevents re-running if allPresets identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPreset, allPresets]);

  function toEnvRecord(): Record<string, string> {
    const rec: Record<string, string> = {};
    for (const r of envRows) {
      if (r.key.trim()) rec[r.key.trim()] = r.value;
    }
    return rec;
  }

  function toVolumeStrings(): string[] {
    return volRows
      .filter((r) => r.source.trim() && r.target.trim())
      .map((r) => `${r.source.trim()}:${r.target.trim()}`);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name || !image) return;
    setSubmitting(true);
    await yieldToFrame();
    try {
      const envRecord = toEnvRecord();
      const volumeStrings = toVolumeStrings();
      if (saveAsTemplate && templateLabel.trim()) {
        const currentPreset = selectedPreset !== null ? allPresets[selectedPreset] : null;
        const template: ServiceTemplate = {
          id: editingTemplateId ?? `tpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          label: templateLabel.trim(),
          icon: currentPreset?.icon ?? "📦",
          image,
          tag,
          versions: currentPreset?.versions ?? [],
          port,
          env_vars: envRecord,
          volumes: volumeStrings,
        };
        await saveServiceTemplate(template);
      }
      await addService({ name, image, tag, port, env_vars: envRecord, volumes: volumeStrings, scope });
      onClose();
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDeleteTemplate(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    if (!window.confirm("Delete this template?")) return;
    await deleteServiceTemplate(id);
    if (selectedPreset !== null && allPresets[selectedPreset]?.userTemplateId === id) {
      setSelectedPreset(null);
      setEditingTemplateId(null);
    }
  }

  const showForm = selectedPreset !== null;

  return (
    <ModalWrapper onClose={onClose} className="bg-[#1c1c1e] border border-white/[0.08] rounded-2xl shadow-2xl max-h-[90vh] overflow-y-auto">
      <form
        onSubmit={submit}
        className="p-6 w-[500px] flex flex-col gap-5"
      >
        {/* Header */}
        <div>
          <h2 className="text-[15px] font-semibold text-zinc-100">Add Service</h2>
          <p className="text-[12px] text-zinc-500 mt-0.5">Start a Docker container managed by Porta</p>
        </div>

        {/* Preset grid */}
        <div className="flex flex-col gap-2">
          <span className={labelCls}>Pick a preset</span>
          <div className="grid grid-cols-4 gap-1.5">
            {allPresets.map((p, i) => (
              <div key={p.userTemplateId ?? `builtin-${p.label}`} className="relative group">
                <button
                  type="button"
                  onClick={() => selectPreset(i)}
                  className={`w-full flex flex-col items-start px-2.5 py-2 rounded-lg border text-left transition-all duration-100 ${
                    selectedPreset === i
                      ? "bg-blue-500/10 border-blue-500/30 text-blue-400"
                      : p.userTemplateId
                        ? "bg-emerald-500/[0.04] border-emerald-500/15 text-zinc-400 hover:bg-emerald-500/[0.08] hover:text-zinc-200"
                        : "bg-white/[0.03] border-white/[0.06] text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200"
                  }`}
                >
                  <span className="text-[14px] mb-0.5">{p.icon}</span>
                  <p className="text-[11px] font-medium leading-tight truncate w-full">{p.label}</p>
                  {p.image && (
                    <p className="text-[10px] text-zinc-600 mt-0.5 leading-tight truncate w-full">
                      {p.image}:{p.tag}
                    </p>
                  )}
                </button>
                {p.userTemplateId && (
                  <button
                    type="button"
                    onClick={(e) => handleDeleteTemplate(e, p.userTemplateId!)}
                    title="Delete template"
                    className="absolute top-1 right-1 p-1 rounded bg-zinc-900/80 text-zinc-500 hover:text-red-400 hover:bg-red-500/20 opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <svg width="9" height="9" viewBox="0 0 11 11" fill="none">
                      <path d="M1.5 1.5l8 8M9.5 1.5l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
                    </svg>
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Form — shown after picking */}
        {showForm && (
          <>
            <div className="h-px bg-white/[0.05]" />

            {collisionHint && (
              <div className="text-[11px] text-amber-300/90 bg-amber-500/5 border border-amber-500/15 rounded-lg px-3 py-2">
                {collisionHint}
              </div>
            )}

            {/* Name + Image + Tag */}
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1.5">
                <span className={labelCls}>Name</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  placeholder="my-database"
                  className={inputCls}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>

              <div className="flex gap-2">
                <label className="flex flex-col gap-1.5 flex-1">
                  <span className={labelCls}>Image</span>
                  <input
                    value={image}
                    onChange={(e) => setImage(e.target.value)}
                    required
                    placeholder="postgres"
                    className={inputCls}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
                <label className="flex flex-col gap-1.5 w-28">
                  <span className={labelCls}>Version</span>
                  <input
                    value={tag}
                    onChange={(e) => setTag(e.target.value)}
                    placeholder="latest"
                    list={versions.length > 0 ? `versions-${selectedPreset}` : undefined}
                    className={inputCls}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  {versions.length > 0 && (
                    <datalist id={`versions-${selectedPreset}`}>
                      {versions.map((v) => <option key={v} value={v} />)}
                    </datalist>
                  )}
                </label>
                <label className="flex flex-col gap-1.5 w-24">
                  <span className={labelCls}>Port</span>
                  <input
                    type="number"
                    value={port}
                    onChange={(e) => setPort(Number(e.target.value))}
                    className={inputCls}
                  />
                </label>
              </div>
            </div>

            {/* Env vars */}
            <div className="flex flex-col gap-2">
              <span className={labelCls}>Environment variables</span>
              <EnvEditor rows={envRows} onChange={setEnvRows} />
            </div>

            {/* Volumes */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <span className={labelCls}>Volumes</span>
                <span className="text-[10px] text-zinc-700">source : container path</span>
              </div>
              <VolumeEditor rows={volRows} onChange={setVolRows} />
            </div>

            {/* Scope */}
            {workspaces.length > 0 && (
              <label className="flex flex-col gap-1.5">
                <span className={labelCls}>Scope</span>
                <select
                  value={scope}
                  onChange={(e) => setScope(e.target.value)}
                  className={`${inputCls} appearance-none cursor-pointer`}
                >
                  <option value="global">Global (all workspaces)</option>
                  {workspaces.map((w) => (
                    <option key={w.id} value={w.id}>{w.name}</option>
                  ))}
                </select>
              </label>
            )}

            {/* Save as template */}
            <div className="flex flex-col gap-1.5 pt-1 border-t border-white/[0.05]">
              <label className="flex items-center gap-2 text-[12px] text-zinc-400 cursor-pointer select-none pt-3">
                <input
                  type="checkbox"
                  checked={saveAsTemplate}
                  onChange={(e) => setSaveAsTemplate(e.target.checked)}
                  className="accent-blue-500"
                />
                {editingTemplateId ? "Update this template" : "Save as template for reuse"}
              </label>
              {saveAsTemplate && (
                <input
                  value={templateLabel}
                  onChange={(e) => setTemplateLabel(e.target.value)}
                  placeholder="Template name"
                  className={inputCls}
                  autoComplete="off"
                  spellCheck={false}
                />
              )}
            </div>
          </>
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
            type="submit"
            disabled={submitting || !showForm || !name || !image}
            className="px-4 py-1.5 text-[13px] font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg disabled:opacity-50 transition-colors flex items-center gap-2"
          >
            {submitting && (
              <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.3" />
                <path d="M14 8a6 6 0 00-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            )}
            {submitting ? "Adding..." : "Add Service"}
          </button>
        </div>
      </form>
    </ModalWrapper>
  );
}
