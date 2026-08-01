import { useEffect } from "react";
import { usePortaStore } from "../../store";
import CodeEditor, { type CodeLanguage } from "../shared/CodeEditor";
import { Spinner } from "../ui";
import { confirmDialog } from "../../lib/confirm";

type Props = { sessionId: string; active: boolean };

/** Pick a highlighting mode from the filename. Unknown extensions fall back to
 *  plain text rather than guessing — wrong highlighting on a config file reads
 *  as corruption. */
function languageFor(path: string): CodeLanguage {
  const name = path.split("/").pop() ?? "";
  if (/\.(ya?ml)$/i.test(name)) return "yaml";
  if (/\.toml$/i.test(name)) return "toml";
  if (/\.json$/i.test(name) || name === ".babelrc") return "json";
  return "text";
}

/** Edit one remote file in place. */
export default function SftpFileEditor({ sessionId, active }: Props) {
  const open = usePortaStore((s) => s.sftpOpen[sessionId]);
  const edit = usePortaStore((s) => s.sftpEditDraft);
  const save = usePortaStore((s) => s.sftpSaveFile);
  const close = usePortaStore((s) => s.sftpCloseFile);

  const dirty = !!open && open.draft !== open.content;

  // ⌘S saves — but only in the pane you can actually see. Every session tab
  // stays mounted (the hidden ones are just display:none), so an unguarded
  // window listener meant one ⌘S saved every open editor at once, including
  // files in sessions the user had switched away from.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save(sessionId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sessionId, save, active]);

  if (!open) return null;

  async function requestClose() {
    if (!open) return;
    if (dirty) {
      const ok = await confirmDialog(
        `Discard unsaved changes to ${open.path.split("/").pop()}?`,
        { title: "Unsaved changes", okLabel: "Discard" }
      );
      if (!ok) return;
    }
    close(sessionId);
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-subtle shrink-0">
        <button
          onClick={requestClose}
          className="shrink-0 text-[11.5px] text-ink-3 hover:text-ink transition-colors"
        >
          ← Files
        </button>
        <span className="flex-1 min-w-0 truncate text-[12.5px] text-ink font-mono">
          {open.path}
          {dirty && <span className="ml-1.5 text-warn" title="Unsaved changes">•</span>}
        </span>
        <button
          onClick={() => save(sessionId)}
          disabled={open.saving || !dirty || open.binary}
          className="shrink-0 px-3 py-1 text-[11.5px] font-medium bg-accent text-white rounded-control disabled:opacity-40 transition-colors"
        >
          {open.saving ? "Saving…" : "Save"}
        </button>
      </div>

      {open.binary ? (
        <div className="flex-1 flex items-center justify-center px-6 text-center">
          <p className="text-[12.5px] text-ink-3 max-w-sm">
            This file isn't valid UTF-8, so Porta won't open it — decoding it for the editor
            would corrupt it on save.
          </p>
        </div>
      ) : (
        <>
          {open.conflict && (
            <div className="mx-3 mt-3 px-2.5 py-2 bg-warn-bg border border-[var(--warning-border)] rounded-lg">
              <p className="text-[11.5px] text-warn">
                This file changed on the server since you opened it. Nothing was written — your
                edits are still here. Reopen it to see the remote version, or press Save again to
                overwrite.
              </p>
            </div>
          )}
          {open.error && (
            <div className="mx-3 mt-3 px-2.5 py-2 bg-bad-bg border border-[var(--danger-border)] rounded-lg">
              <p className="text-[11.5px] text-bad break-words">{open.error}</p>
            </div>
          )}
          <div className="flex-1 min-h-0 overflow-auto p-3">
            <CodeEditor
              value={open.draft}
              onChange={(v) => edit(sessionId, v)}
              language={languageFor(open.path)}
              maxHeight="100%"
            />
          </div>
          <div className="px-3 py-1.5 border-t border-subtle shrink-0 flex items-center gap-2 text-[10.5px] text-ink-3">
            <span>{open.size} bytes</span>
            {open.permissions !== null && (
              <span className="font-mono">{(open.permissions & 0o7777).toString(8).padStart(4, "0")}</span>
            )}
            {open.saving && <Spinner size={9} />}
            <span className="ml-auto">⌘S to save</span>
          </div>
        </>
      )}
    </div>
  );
}
