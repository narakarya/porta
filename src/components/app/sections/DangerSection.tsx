import { useEffect, useRef, useState } from "react";

interface Props {
  /** App name used as the type-to-confirm token. */
  appName: string;
  /** Called once the user has typed the app name and clicked Delete. */
  onConfirmDelete: () => void | Promise<void>;
}

/**
 * Lifted out of `AppSettingsModal.tsx` so the modal file doesn't have to
 * mix this section's confirm-text local state with the rest of the form.
 *
 * The "type the app name to enable Delete" pattern is local to this section
 * — no other section reads or writes it — so owning it here keeps the
 * parent's state surface smaller and the Danger Zone self-contained.
 *
 * Auto-focuses the input when first rendered so the user can confirm
 * without an extra mouse hop.
 */
export default function DangerSection({ appName, onConfirmDelete }: Props) {
  const [typed, setTyped] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const canDelete = typed === appName;

  return (
    <>
      <div>
        <h1 className="text-[16px] font-semibold text-zinc-100">Danger Zone</h1>
        <p className="text-[12px] text-zinc-500 mt-1">Irreversible actions — proceed carefully.</p>
      </div>

      <div className="flex flex-col gap-3 p-5 rounded-xl bg-red-500/[0.04] border border-red-500/20">
        <div>
          <p className="text-[13px] font-semibold text-red-400">Delete this app</p>
          <p className="text-[12px] text-zinc-500 mt-1 leading-relaxed">
            Removes the app from Porta. The files on disk won't be deleted.
          </p>
        </div>
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] text-zinc-500">
            Type <span className="text-zinc-300 font-mono">{appName}</span> to confirm
          </span>
          <input
            spellCheck={false}
            ref={inputRef}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && canDelete) void onConfirmDelete(); }}
            placeholder={appName}
            className="input-base focus:border-red-500/60"
            autoComplete="off"
          />
        </label>
        <button
          onClick={() => { if (canDelete) void onConfirmDelete(); }}
          disabled={!canDelete}
          className="self-start px-4 py-2 text-[13px] font-medium bg-red-600 hover:bg-red-500 text-white rounded-lg disabled:opacity-40 transition-colors"
        >
          Delete App
        </button>
      </div>
    </>
  );
}
