import { useState } from "react";
import type { FormEvent } from "react";
import { usePortaStore } from "../../store";
import type { Service } from "../../types";
import ModalWrapper from "../shared/ModalWrapper";

const inputCls =
  "w-full bg-[#111113] border border-white/[0.08] rounded-lg px-3 py-2 text-[13px] text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-blue-500/60 transition-colors";
const labelCls = "text-[11px] font-medium text-zinc-500 uppercase tracking-wide";

// ── Row types (same as AddServiceModal) ───────────────────────────────────────

interface EnvRow { id: string; key: string; value: string; }
interface VolRow { id: string; source: string; target: string; }

let _rowId = 1000;
const newId = () => String(++_rowId);

function envRowsFromRecord(rec: Record<string, string>): EnvRow[] {
  const rows = Object.entries(rec).map(([key, value]) => ({ id: newId(), key, value }));
  return rows.length > 0 ? rows : [{ id: newId(), key: "", value: "" }];
}

function volRowsFromStrings(vols: string[]): VolRow[] {
  return vols.map((v) => {
    const idx = v.indexOf(":");
    return { id: newId(), source: idx >= 0 ? v.slice(0, idx) : v, target: idx >= 0 ? v.slice(idx + 1) : "" };
  });
}

// ── Env/Volume editors (self-contained, same pattern as Add modal) ─────────────

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
  service: Service;
  onClose: () => void;
}

export default function ServiceSettingsModal({ service, onClose }: Props) {
  const { workspaces, updateService, deleteService } = usePortaStore();

  const [name, setName] = useState(service.name);
  const [image, setImage] = useState(service.image);
  const [tag, setTag] = useState(service.tag);
  const [port, setPort] = useState(service.port);
  const [scope, setScope] = useState(service.scope);
  const [envRows, setEnvRows] = useState<EnvRow[]>(() => envRowsFromRecord(service.env_vars));
  const [volRows, setVolRows] = useState<VolRow[]>(() => volRowsFromStrings(service.volumes ?? []));
  const [submitting, setSubmitting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

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
    setSubmitting(true);
    try {
      await updateService(service.id, {
        name, image, tag, port, scope,
        env_vars: toEnvRecord(),
        volumes: toVolumeStrings(),
      });
      onClose();
    } finally {
      setSubmitting(false);
    }
  }

  const isRunning = service.status !== "stopped";

  return (
    <ModalWrapper onClose={onClose} className="bg-[#1c1c1e] border border-white/[0.08] rounded-2xl shadow-2xl max-h-[90vh] overflow-y-auto">
      <form
        onSubmit={submit}
        className="p-6 w-[500px] flex flex-col gap-5"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-[15px] font-semibold text-zinc-100">{service.name}</h2>
            <p className="text-[12px] text-zinc-500 mt-0.5 font-mono">
              {service.image}:{service.tag}
              {service.container_id && (
                <span className="ml-2 text-zinc-600">· {service.container_id.slice(0, 12)}</span>
              )}
            </p>
          </div>
          {isRunning && (
            <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/20 shrink-0 mt-0.5">
              running
            </span>
          )}
        </div>

        <div className="h-px bg-white/[0.05]" />

        {/* Name */}
        <label className="flex flex-col gap-1.5">
          <span className={labelCls}>Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            className={inputCls}
            autoComplete="off"
            spellCheck={false}
          />
        </label>

        {/* Image + Tag + Port */}
        <div className="flex gap-2">
          <label className="flex flex-col gap-1.5 flex-1">
            <span className={labelCls}>Image</span>
            <input
              value={image}
              onChange={(e) => setImage(e.target.value)}
              required
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

        {/* Danger zone — only when stopped */}
        {!isRunning && (
          <div className="border border-white/[0.05] rounded-lg p-3">
            <p className="text-[11px] text-zinc-600 mb-2">Danger zone</p>
            {!confirmDelete ? (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="text-[12px] font-medium text-red-400/70 hover:text-red-300 transition-colors"
              >
                Delete this service
              </button>
            ) : (
              <div className="flex items-center gap-3">
                <p className="text-[12px] text-red-400 flex-1">Delete permanently?</p>
                <button
                  type="button"
                  onClick={() => { deleteService(service.id); onClose(); }}
                  className="text-[12px] font-medium text-red-400 hover:text-red-200 transition-colors"
                >
                  Delete
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className="text-[12px] text-zinc-600 hover:text-zinc-300 transition-colors"
                >
                  Cancel
                </button>
              </div>
            )}
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
            type="submit"
            disabled={submitting || !name || !image}
            className="px-4 py-1.5 text-[13px] font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg disabled:opacity-50 transition-colors flex items-center gap-2"
          >
            {submitting && <span className="w-3.5 h-3.5 border border-white/50 border-t-transparent rounded-full animate-spin" />}
            {submitting ? "Saving..." : "Save Changes"}
          </button>
        </div>
      </form>
    </ModalWrapper>
  );
}
