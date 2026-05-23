export type CustomForm = { id: string; label: string; rawArgs: string; interactive: boolean };

interface DeployCustomCmdFormProps {
  form: CustomForm;
  error: string;
  onChange: (form: CustomForm) => void;
  onSave: () => void;
  onCancel: () => void;
}

export default function DeployCustomCmdForm({ form, error, onChange, onSave, onCancel }: DeployCustomCmdFormProps) {
  return (
    <div className="border-t border-white/5 p-3 space-y-2">
      <p className="text-xs font-medium text-zinc-400">
        {form.id ? "Edit command" : "New command"}
      </p>
      <input
        type="text"
        placeholder="Label"
        value={form.label}
        onChange={(e) => onChange({ ...form, label: e.target.value })}
        className="w-full text-xs bg-white/5 border border-white/10 rounded px-2 py-1.5 text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-white/25"
      />
      <input
        type="text"
        placeholder="Args (e.g. app exec -i bin/console)"
        value={form.rawArgs}
        onChange={(e) => onChange({ ...form, rawArgs: e.target.value })}
        className="w-full text-xs bg-white/5 border border-white/10 rounded px-2 py-1.5 text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-white/25"
      />
      <label className="flex items-center gap-2 text-xs text-zinc-400 cursor-pointer">
        <input
          type="checkbox"
          checked={form.interactive}
          onChange={(e) => onChange({ ...form, interactive: e.target.checked })}
          className="rounded"
        />
        Interactive (opens terminal pane)
      </label>
      {error && (
        <p className="text-xs text-red-400">{error}</p>
      )}
      <div className="flex gap-2">
        <button
          onClick={onSave}
          className="flex-1 text-xs bg-indigo-600 hover:bg-indigo-500 text-white rounded px-2 py-1.5"
        >
          Save
        </button>
        <button
          onClick={onCancel}
          className="flex-1 text-xs bg-white/5 hover:bg-white/10 text-zinc-400 rounded px-2 py-1.5"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
