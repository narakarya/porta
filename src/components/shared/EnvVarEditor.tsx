export interface EnvVar {
  key: string;
  value: string;
}

interface EnvVarEditorProps {
  vars: EnvVar[];
  onChange: (vars: EnvVar[]) => void;
}

export default function EnvVarEditor({ vars, onChange }: EnvVarEditorProps) {
  function addRow() {
    onChange([...vars, { key: "", value: "" }]);
  }

  function updateRow(i: number, patch: Partial<EnvVar>) {
    onChange(vars.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  function removeRow(i: number) {
    onChange(vars.filter((_, idx) => idx !== i));
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <p className="text-[12px] font-medium text-zinc-300">Inline Variables</p>
        <button
          onClick={addRow}
          className="text-[11px] text-blue-400 hover:text-blue-300 transition-colors"
        >
          + Add
        </button>
      </div>
      <p className="text-[11px] text-zinc-500 leading-relaxed">
        Key-value pairs injected at start. <code className="text-zinc-400">PORT</code> is always managed by Porta.
      </p>
      {vars.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {vars.map((row, i) => (
            <div key={i} className="flex gap-1.5 items-center">
              <input
                spellCheck={false}
                value={row.key}
                onChange={(e) => updateRow(i, { key: e.target.value })}
                className="input-base flex-1 font-mono text-[12px] uppercase"
                placeholder="KEY"
              />
              <span className="text-zinc-600 text-[12px]">=</span>
              <input
                spellCheck={false}
                value={row.value}
                onChange={(e) => updateRow(i, { value: e.target.value })}
                className="input-base flex-[2] font-mono text-[12px]"
                placeholder="value"
              />
              <button
                onClick={() => removeRow(i)}
                className="text-zinc-600 hover:text-red-400 transition-colors p-1 shrink-0"
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
