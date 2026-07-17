import { useState } from "react";

export interface EnvVar {
  key: string;
  value: string;
}

interface EnvVarEditorProps {
  vars: EnvVar[];
  onChange: (vars: EnvVar[]) => void;
}

export default function EnvVarEditor({ vars, onChange }: EnvVarEditorProps) {
  const [revealed, setRevealed] = useState<Set<number>>(new Set());

  function addRow() {
    onChange([...vars, { key: "", value: "" }]);
  }

  function updateRow(i: number, patch: Partial<EnvVar>) {
    onChange(vars.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  function removeRow(i: number) {
    onChange(vars.filter((_, idx) => idx !== i));
  }

  function toggleReveal(i: number) {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <p className="text-[12px] font-medium text-ink-2">Inline Variables</p>
        <button
          onClick={addRow}
          className="text-[11px] text-accent hover:brightness-110 transition"
        >
          + Add
        </button>
      </div>
      <p className="text-[11px] text-ink-3 leading-relaxed">
        Key-value pairs injected at start. <code className="text-ink-2">PORT</code> is always managed by Porta.
      </p>
      {vars.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {vars.map((row, i) => {
            const isRevealed = revealed.has(i);
            return (
              <div key={i} className="flex gap-1.5 items-center">
                <input
                  spellCheck={false}
                  value={row.key}
                  onChange={(e) => updateRow(i, { key: e.target.value })}
                  className="input-base w-[130px] shrink-0 font-mono text-[12px] uppercase"
                  placeholder="KEY"
                />
                <span className="text-ink-3 text-[12px]">=</span>
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
                  {isRevealed ? (
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                      <path d="M1 1l12 12" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                      <path d="M5.4 5.5a2 2 0 0 0 2.8 2.85M3.5 3.6C2.3 4.4 1.3 5.6 1 7c.8 2.3 3 4 6 4 1.2 0 2.3-.3 3.2-.8M9.9 9C11 8.3 11.7 7.3 12 7c-.8-2.3-3-4-6-4-.5 0-1 .05-1.4.15" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                      <path d="M1 7c.8-2.3 3-4 6-4s5.2 1.7 6 4c-.8 2.3-3 4-6 4s-5.2-1.7-6-4Z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                      <circle cx="7" cy="7" r="1.9" stroke="currentColor" strokeWidth="1.2"/>
                    </svg>
                  )}
                </button>
                <button
                  onClick={() => removeRow(i)}
                  aria-label="Remove variable"
                  className="text-ink-3 hover:text-red-400 transition-colors p-1 shrink-0"
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                    <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                  </svg>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
