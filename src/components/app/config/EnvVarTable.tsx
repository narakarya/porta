import { useState } from "react";
import { IconPlus, IconRemove, IconCheck, IconCopy, IconEye, IconEyeOff, IconFileImport } from "./icons";

/** Vercel-style key/value env table for the active profile. Owns its own
 * reveal/copy/export view-state; the persisted data lives in `vars` (mapped
 * back to app.env_vars on Save by the parent — unchanged). The PORT row is
 * synthetic and read-only: Porta always manages the port, so it is never part
 * of the editable `vars` array. */
export default function EnvVarTable({
  vars,
  onChange,
  port,
  envFile,
  onImportFile,
  onClearFile,
}: {
  vars: { key: string; value: string }[];
  onChange: (vars: { key: string; value: string }[]) => void;
  port: number;
  envFile: string;
  onImportFile: () => void;
  onClearFile: () => void;
}) {
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [exported, setExported] = useState(false);

  const updateRow = (i: number, patch: Partial<{ key: string; value: string }>) =>
    onChange(vars.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const removeRow = (i: number) => onChange(vars.filter((_, idx) => idx !== i));
  const addRow = () => onChange([...vars, { key: "", value: "" }]);
  const toggleReveal = (i: number) =>
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  const copyValue = (i: number, value: string) => {
    navigator.clipboard.writeText(value).then(() => {
      setCopiedIdx(i);
      setTimeout(() => setCopiedIdx((cur) => (cur === i ? null : cur)), 1200);
    });
  };
  const exportEnv = () => {
    const text = vars
      .filter((v) => v.key.trim())
      .map((v) => `${v.key.trim()}=${v.value}`)
      .join("\n");
    navigator.clipboard.writeText(text).then(() => {
      setExported(true);
      setTimeout(() => setExported(false), 1500);
    });
  };

  return (
    <div className="flex flex-col">
      <div className="font-mono text-[12px]">
        {vars.map((row, i) => {
          const isRevealed = revealed.has(i);
          return (
            <div key={i} className="flex items-center gap-2 py-1.5 border-b border-subtle">
              <input
                spellCheck={false}
                value={row.key}
                onChange={(e) => updateRow(i, { key: e.target.value })}
                className="input-base w-[150px] shrink-0 font-mono text-[12px] uppercase"
                placeholder="KEY"
              />
              <input
                spellCheck={false}
                type={isRevealed ? "text" : "password"}
                value={row.value}
                onChange={(e) => updateRow(i, { value: e.target.value })}
                className="input-base flex-1 min-w-0 font-mono text-[12px]"
                placeholder="value"
              />
              <button
                type="button"
                onClick={() => toggleReveal(i)}
                aria-label={isRevealed ? "Hide value" : "Reveal value"}
                title={isRevealed ? "Hide value" : "Reveal value"}
                className="text-ink-3 hover:text-ink-2 transition-colors p-1 shrink-0"
              >
                {isRevealed ? <IconEyeOff /> : <IconEye />}
              </button>
              <button
                type="button"
                onClick={() => copyValue(i, row.value)}
                aria-label="Copy value"
                title="Copy value"
                className={`transition-colors p-1 shrink-0 ${copiedIdx === i ? "text-ok" : "text-ink-3 hover:text-ink-2"}`}
              >
                {copiedIdx === i ? <IconCheck /> : <IconCopy />}
              </button>
              <button
                type="button"
                onClick={() => removeRow(i)}
                aria-label="Remove variable"
                title="Remove variable"
                className="text-ink-3 hover:text-bad transition-colors p-1 shrink-0"
              >
                <IconRemove />
              </button>
            </div>
          );
        })}

        {/* Porta-managed PORT row — read-only, never part of env_vars. */}
        <div className="flex items-center gap-2 py-1.5 border-b border-subtle">
          <span className="w-[150px] shrink-0 text-ink-3 px-2.5">PORT</span>
          <span className="flex-1 min-w-0 text-ink-3 px-2.5 truncate">{port}</span>
          <span className="text-[10px] font-sans text-ink-3 shrink-0 pr-1">managed by Porta</span>
        </div>
      </div>

      {/* Inline add-variable row */}
      <button
        type="button"
        onClick={addRow}
        className="mt-2 self-start inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] text-ink-2 hover:text-ink border border-dashed border-strong rounded-control transition-colors"
      >
        <IconPlus /> Add variable
      </button>

      {/* Footer: import / export (mockup 20). Import reuses the existing
          env-file browse handler; Clear reuses the existing setter. */}
      <div className="flex items-center gap-3 mt-4 pt-3 border-t border-subtle text-[11px]">
        <button
          type="button"
          onClick={onImportFile}
          className="inline-flex items-center gap-1.5 text-ink-2 hover:text-ink transition-colors"
        >
          <IconFileImport /> Import .env
        </button>
        <button
          type="button"
          onClick={exportEnv}
          className={`inline-flex items-center gap-1.5 transition-colors ${exported ? "text-ok" : "text-ink-2 hover:text-ink"}`}
        >
          {exported ? <IconCheck /> : <IconCopy />} {exported ? "Copied" : "Export"}
        </button>
        {envFile && (
          <span className="ml-auto inline-flex items-center gap-1.5 min-w-0">
            <code className="font-mono text-ink-3 truncate max-w-[180px]" title={envFile}>{envFile}</code>
            <button type="button" onClick={onClearFile} className="text-ink-3 hover:text-ink-2 transition-colors shrink-0">
              Clear
            </button>
          </span>
        )}
      </div>
    </div>
  );
}
