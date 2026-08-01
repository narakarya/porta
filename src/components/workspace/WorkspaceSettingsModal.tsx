import { useRef, useState } from "react";
import { usePortaStore } from "../../store";
import type { Workspace } from "../../types";
import ModalWrapper from "../shared/ModalWrapper";
import { yieldToFrame } from "../../lib/ui";
import { Spinner } from "../ui";

type Section = "general" | "danger";

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

interface Props {
  workspace: Workspace;
  onClose: () => void;
}

export default function WorkspaceSettingsModal({ workspace, onClose }: Props) {
  const { workspaces, updateWorkspace, deleteWorkspace } = usePortaStore();
  const isLastWorkspace = workspaces.length <= 1;
  const [section, setSection] = useState<Section>("general");

  const [name, setName] = useState(workspace.name);
  const [domain, setDomain] = useState(workspace.domain);
  const [domainError, setDomainError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [deleteTyped, setDeleteTyped] = useState("");
  const deleteInputRef = useRef<HTMLInputElement>(null);

  function handleDomainChange(val: string) {
    const lower = val.toLowerCase();
    setDomain(lower);
    setDomainError(DOMAIN_RE.test(lower) || !lower ? null : "Must be a valid domain (e.g. myproject.test)");
  }

  const canSave = name.trim() && domain && !domainError;

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    setSaveError(null);
    await yieldToFrame();
    try {
      await updateWorkspace(workspace.id, name.trim(), domain);
      onClose();
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (deleteTyped !== workspace.name || isLastWorkspace) return;
    await deleteWorkspace(workspace.id);
    onClose();
  }

  return (
    <ModalWrapper onClose={onClose} className="bg-surface-input text-ink font-sans flex h-screen w-screen overflow-hidden">
      {/* Drag region */}
      <div className="drag-region fixed top-0 left-0 right-0 h-8 z-10 pointer-events-none" />

      {/* Sidebar */}
      <aside className="w-[200px] bg-surface-2 border-r border-white/[0.06] flex flex-col pt-8 pb-3 shrink-0">
        <div className="px-4 mb-4">
          <button
            onClick={onClose}
            className="flex items-center gap-1.5 text-[12px] text-ink-3 hover:text-ink transition-colors"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M7.5 2L3.5 6l4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            Back
          </button>
        </div>

        <div className="px-4 mb-1">
          <p className="text-[11px] font-semibold text-ink-3 uppercase tracking-widest truncate">
            {workspace.name}
          </p>
        </div>
        <div className="px-4 mb-3">
          <p className="text-[11px] text-ink-3 truncate">{workspace.domain}</p>
        </div>

        <nav className="flex-1 flex flex-col gap-0.5 px-2 overflow-auto no-drag">
          {(["general", "danger"] as Section[]).map((id) => {
            const label = id === "general" ? "General" : "Danger Zone";
            const active = section === id;
            return (
              <button
                key={id}
                onClick={() => setSection(id)}
                className={`flex items-center px-2 py-1.5 rounded-[6px] text-[13px] w-full text-left transition-all duration-100 ${
                  active
                    ? id === "danger" ? "bg-bad-bg text-bad" : "bg-white/10 text-ink"
                    : id === "danger"
                    ? "text-red-500/60 hover:bg-red-500/[0.07] hover:text-bad"
                    : "text-ink-2 hover:bg-white/[0.05] hover:text-ink"
                }`}
              >
                {label}
              </button>
            );
          })}
        </nav>
      </aside>

      {/* Content */}
      <main className="flex-1 overflow-auto pt-10 px-8 pb-8 no-drag flex flex-col">
        <div className="max-w-[520px] w-full flex flex-col gap-6 flex-1">

          {section === "general" && (
            <>
              <div>
                <h1 className="text-[16px] font-semibold text-ink">General</h1>
                <p className="text-[12px] text-ink-3 mt-1">Basic workspace identity.</p>
              </div>

              <div className="flex flex-col gap-4 p-5 rounded-xl bg-white/[0.03] border border-white/[0.07]">
                <div className="flex flex-col gap-1.5">
                  <label className="text-[12px] font-medium text-ink-2">Name</label>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="input-base"
                    placeholder="My Project"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-[12px] font-medium text-ink-2">Domain</label>
                  <input
                    value={domain}
                    onChange={(e) => handleDomainChange(e.target.value)}
                    className={`input-base ${domainError ? "border-red-500/50" : ""}`}
                    placeholder="myproject.test"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  {domainError
                    ? <p className="text-[10px] text-bad">{domainError}</p>
                    : <p className="text-[10px] text-ink-3">Changing the domain regenerates SSL certificates for all apps.</p>
                  }
                </div>
              </div>

              <div className="flex items-center gap-2">
                {saveError && <p className="text-[11px] text-bad flex-1">{saveError}</p>}
                <div className="flex gap-2 ml-auto">
                  <button onClick={onClose} className="px-4 py-2 text-[13px] text-ink-3 hover:text-ink rounded-lg transition-colors">
                    Cancel
                  </button>
                  <button
                    onClick={handleSave}
                    disabled={!canSave || saving}
                    className="px-4 py-2 text-[13px] font-medium bg-accent hover:bg-accent text-white rounded-lg disabled:opacity-40 transition-colors flex items-center gap-1.5"
                  >
                    {saving && (
                      <Spinner size={14} />
                    )}
                    {saving ? "Saving…" : "Save Changes"}
                  </button>
                </div>
              </div>
            </>
          )}

          {section === "danger" && (
            <>
              <div>
                <h1 className="text-[16px] font-semibold text-ink">Danger Zone</h1>
                <p className="text-[12px] text-ink-3 mt-1">Irreversible actions — proceed carefully.</p>
              </div>

              <div className="flex flex-col gap-3 p-5 rounded-xl bg-red-500/[0.04] border border-[var(--danger-border)]">
                <div>
                  <p className="text-[13px] font-semibold text-bad">Delete this workspace</p>
                  <p className="text-[12px] text-ink-3 mt-1 leading-relaxed">
                    {isLastWorkspace
                      ? "This is your only workspace — it can't be deleted. Create another workspace first."
                      : "Removes the workspace from Porta. Its apps aren't deleted — they move to your first workspace."}
                  </p>
                </div>
                <label className="flex flex-col gap-1.5">
                  <span className="text-[11px] text-ink-3">
                    Type <span className="text-ink-2 font-mono">{workspace.name}</span> to confirm
                  </span>
                  <input
                    ref={deleteInputRef}
                    value={deleteTyped}
                    onChange={(e) => setDeleteTyped(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleDelete()}
                    placeholder={workspace.name}
                    disabled={isLastWorkspace}
                    className="input-base focus:border-red-500/60 disabled:opacity-40 disabled:cursor-not-allowed"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
                <button
                  onClick={handleDelete}
                  disabled={deleteTyped !== workspace.name || isLastWorkspace}
                  className="self-start px-4 py-2 text-[13px] font-medium bg-red-600 hover:bg-bad text-white rounded-lg disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Delete Workspace
                </button>
              </div>
            </>
          )}
        </div>
      </main>
    </ModalWrapper>
  );
}
