import { useRef, useState } from "react";
import { usePortaStore } from "../../store";
import type { Workspace } from "../../types";
import ModalWrapper from "../shared/ModalWrapper";
import { yieldToFrame } from "../../lib/ui";

type Section = "general" | "danger";

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

interface Props {
  workspace: Workspace;
  onClose: () => void;
}

export default function WorkspaceSettingsModal({ workspace, onClose }: Props) {
  const { updateWorkspace, deleteWorkspace } = usePortaStore();
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
    if (deleteTyped !== workspace.name) return;
    await deleteWorkspace(workspace.id);
    onClose();
  }

  return (
    <ModalWrapper onClose={onClose} className="bg-[#111113] text-zinc-100 font-sans flex h-screen w-screen overflow-hidden">
      {/* Drag region */}
      <div className="drag-region fixed top-0 left-0 right-0 h-8 z-10 pointer-events-none" />

      {/* Sidebar */}
      <aside className="w-[200px] bg-[#1a1a1c] border-r border-white/[0.06] flex flex-col pt-8 pb-3 shrink-0">
        <div className="px-4 mb-4">
          <button
            onClick={onClose}
            className="flex items-center gap-1.5 text-[12px] text-zinc-500 hover:text-zinc-200 transition-colors"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M7.5 2L3.5 6l4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            Back
          </button>
        </div>

        <div className="px-4 mb-1">
          <p className="text-[11px] font-semibold text-zinc-500 uppercase tracking-widest truncate">
            {workspace.name}
          </p>
        </div>
        <div className="px-4 mb-3">
          <p className="text-[11px] text-zinc-600 truncate">{workspace.domain}</p>
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
                    ? id === "danger" ? "bg-red-500/10 text-red-400" : "bg-white/10 text-zinc-100"
                    : id === "danger"
                    ? "text-red-500/60 hover:bg-red-500/[0.07] hover:text-red-400"
                    : "text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-200"
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
                <h1 className="text-[16px] font-semibold text-zinc-100">General</h1>
                <p className="text-[12px] text-zinc-500 mt-1">Basic workspace identity.</p>
              </div>

              <div className="flex flex-col gap-4 p-5 rounded-xl bg-white/[0.03] border border-white/[0.07]">
                <div className="flex flex-col gap-1.5">
                  <label className="text-[12px] font-medium text-zinc-400">Name</label>
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
                  <label className="text-[12px] font-medium text-zinc-400">Domain</label>
                  <input
                    value={domain}
                    onChange={(e) => handleDomainChange(e.target.value)}
                    className={`input-base ${domainError ? "border-red-500/50" : ""}`}
                    placeholder="myproject.test"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  {domainError
                    ? <p className="text-[10px] text-red-400">{domainError}</p>
                    : <p className="text-[10px] text-zinc-600">Changing the domain regenerates SSL certificates for all apps.</p>
                  }
                </div>
              </div>

              <div className="flex items-center gap-2">
                {saveError && <p className="text-[11px] text-red-400 flex-1">{saveError}</p>}
                <div className="flex gap-2 ml-auto">
                  <button onClick={onClose} className="px-4 py-2 text-[13px] text-zinc-500 hover:text-zinc-200 rounded-lg transition-colors">
                    Cancel
                  </button>
                  <button
                    onClick={handleSave}
                    disabled={!canSave || saving}
                    className="px-4 py-2 text-[13px] font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg disabled:opacity-40 transition-colors flex items-center gap-1.5"
                  >
                    {saving && (
                      <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 16 16" fill="none">
                        <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.3" />
                        <path d="M14 8a6 6 0 00-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                      </svg>
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
                <h1 className="text-[16px] font-semibold text-zinc-100">Danger Zone</h1>
                <p className="text-[12px] text-zinc-500 mt-1">Irreversible actions — proceed carefully.</p>
              </div>

              <div className="flex flex-col gap-3 p-5 rounded-xl bg-red-500/[0.04] border border-red-500/20">
                <div>
                  <p className="text-[13px] font-semibold text-red-400">Delete this workspace</p>
                  <p className="text-[12px] text-zinc-500 mt-1 leading-relaxed">
                    Removes the workspace from Porta. Apps won't be deleted but will become standalone.
                  </p>
                </div>
                <label className="flex flex-col gap-1.5">
                  <span className="text-[11px] text-zinc-500">
                    Type <span className="text-zinc-300 font-mono">{workspace.name}</span> to confirm
                  </span>
                  <input
                    ref={deleteInputRef}
                    value={deleteTyped}
                    onChange={(e) => setDeleteTyped(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleDelete()}
                    placeholder={workspace.name}
                    className="input-base focus:border-red-500/60"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
                <button
                  onClick={handleDelete}
                  disabled={deleteTyped !== workspace.name}
                  className="self-start px-4 py-2 text-[13px] font-medium bg-red-600 hover:bg-red-500 text-white rounded-lg disabled:opacity-40 transition-colors"
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
