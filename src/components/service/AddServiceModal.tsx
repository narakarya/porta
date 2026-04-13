import { useState } from "react";
import type { FormEvent } from "react";
import { usePortaStore } from "../../store";

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
  port: number;
  env_vars: Record<string, string>;
  volumes: string[];
}

const PRESETS: Preset[] = [
  {
    label: "PostgreSQL",
    icon: "🐘",
    image: "postgres",
    tag: "16",
    port: 5432,
    env_vars: { POSTGRES_PASSWORD: "postgres", POSTGRES_USER: "postgres", POSTGRES_DB: "app" },
    volumes: ["pgdata:/var/lib/postgresql/data"],
  },
  {
    label: "MySQL",
    icon: "🐬",
    image: "mysql",
    tag: "8",
    port: 3306,
    env_vars: { MYSQL_ROOT_PASSWORD: "root", MYSQL_DATABASE: "app" },
    volumes: ["mysqldata:/var/lib/mysql"],
  },
  {
    label: "Redis",
    icon: "⚡",
    image: "redis",
    tag: "7-alpine",
    port: 6379,
    env_vars: {},
    volumes: ["redisdata:/data"],
  },
  {
    label: "MongoDB",
    icon: "🍃",
    image: "mongo",
    tag: "7",
    port: 27017,
    env_vars: { MONGO_INITDB_ROOT_USERNAME: "root", MONGO_INITDB_ROOT_PASSWORD: "root" },
    volumes: ["mongodata:/data/db"],
  },
  {
    label: "MariaDB",
    icon: "🦭",
    image: "mariadb",
    tag: "11",
    port: 3306,
    env_vars: { MARIADB_ROOT_PASSWORD: "root", MARIADB_DATABASE: "app" },
    volumes: ["mariadbdata:/var/lib/mysql"],
  },
  {
    label: "RabbitMQ",
    icon: "🐇",
    image: "rabbitmq",
    tag: "3-management-alpine",
    port: 5672,
    env_vars: { RABBITMQ_DEFAULT_USER: "admin", RABBITMQ_DEFAULT_PASS: "admin" },
    volumes: [],
  },
  {
    label: "MinIO",
    icon: "🗄️",
    image: "minio/minio",
    tag: "latest",
    port: 9000,
    env_vars: { MINIO_ROOT_USER: "minioadmin", MINIO_ROOT_PASSWORD: "minioadmin" },
    volumes: ["miniodata:/data"],
  },
  {
    label: "Custom",
    icon: "📦",
    image: "",
    tag: "latest",
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

interface Props { onClose: () => void; }

export default function AddServiceModal({ onClose }: Props) {
  const { workspaces, addService } = usePortaStore();
  const [selectedPreset, setSelectedPreset] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [image, setImage] = useState("");
  const [tag, setTag] = useState("latest");
  const [port, setPort] = useState<number>(8080);
  const [envRows, setEnvRows] = useState<EnvRow[]>([]);
  const [volRows, setVolRows] = useState<VolRow[]>([]);
  const [scope, setScope] = useState<"global" | string>("global");
  const [submitting, setSubmitting] = useState(false);

  function selectPreset(index: number) {
    const p = PRESETS[index];
    setSelectedPreset(index);
    setName(p.label === "Custom" ? "" : p.label);
    setImage(p.image);
    setTag(p.tag);
    setPort(p.port);
    setEnvRows(envRowsFromRecord(p.env_vars));
    setVolRows(volRowsFromStrings(p.volumes));
  }

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
    try {
      await addService({ name, image, tag, port, env_vars: toEnvRecord(), volumes: toVolumeStrings(), scope });
      onClose();
    } finally {
      setSubmitting(false);
    }
  }

  const showForm = selectedPreset !== null;

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-[2px] flex items-center justify-center z-50">
      <form
        onSubmit={submit}
        className="bg-[#1c1c1e] border border-white/[0.08] rounded-2xl p-6 w-[500px] flex flex-col gap-5 shadow-2xl max-h-[90vh] overflow-y-auto"
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
            {PRESETS.map((p, i) => (
              <button
                key={p.label}
                type="button"
                onClick={() => selectPreset(i)}
                className={`flex flex-col items-start px-2.5 py-2 rounded-lg border text-left transition-all duration-100 ${
                  selectedPreset === i
                    ? "bg-blue-500/10 border-blue-500/30 text-blue-400"
                    : "bg-white/[0.03] border-white/[0.06] text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200"
                }`}
              >
                <span className="text-[14px] mb-0.5">{p.icon}</span>
                <p className="text-[11px] font-medium leading-tight">{p.label}</p>
                {p.image && (
                  <p className="text-[10px] text-zinc-600 mt-0.5 leading-tight truncate w-full">
                    {p.image}:{p.tag}
                  </p>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Form — shown after picking */}
        {showForm && (
          <>
            <div className="h-px bg-white/[0.05]" />

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
                <label className="flex flex-col gap-1.5 w-24">
                  <span className={labelCls}>Tag</span>
                  <input
                    value={tag}
                    onChange={(e) => setTag(e.target.value)}
                    placeholder="latest"
                    className={inputCls}
                    autoComplete="off"
                    spellCheck={false}
                  />
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
            {submitting && <span className="w-3.5 h-3.5 border border-white/50 border-t-transparent rounded-full animate-spin" />}
            {submitting ? "Adding..." : "Add Service"}
          </button>
        </div>
      </form>
    </div>
  );
}
