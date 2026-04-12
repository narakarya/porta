import { useRef, useState } from "react";
import { usePortaStore } from "../store";
import type { Workspace } from "../types";

type Section = "general" | "danger";

const NAV: { id: Section; label: string }[] = [
  { id: "general", label: "General" },
  { id: "danger",  label: "Danger Zone" },
];

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
    <div className="fixed inset-0 bg-[#111113]/90 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-[#1c1c1e] border border-white/[0.08] rounded-2xl w-[520px] max-h-[80vh] shadow-2xl flex flex-col overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.06] shrink-0">
          <div>
            <h2 className="text-[14px] font-semibold text-zinc-100">{workspace.name}</h2>
            <p className="text-[11px] text-zinc-500 mt-0.5">{workspace.domain}</p>
          </div>
          <button onClick={onClose} className="text-zinc-600 hover:text-zinc-300 transition-colors">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </button>
        </div>

        <div className="flex flex-1 overflow-hidden">
          {/* Side nav */}
          <nav className="w-[140px] border-r border-white/[0.06] flex flex-col gap-0.5 px-2 py-3 shrink-0">
            {NAV.map((item) => (
              <button
                key={item.id}
                onClick={() => setSection(item.id)}
                className={`px-2.5 py-1.5 rounded-[6px] text-[13px] text-left transition-colors ${
                  section === item.id
                    ? "bg-white/10 text-zinc-100"
                    : item.id === "danger"
                    ? "text-red-500/70 hover:bg-red-500/10 hover:text-red-400"
                    : "text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-200"
                }`}
              >
                {item.label}
              </button>
            ))}
          </nav>

          {/* Content */}
          <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-4">

            {section === "general" && (
              <>
                <div className="flex flex-col gap-1">
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

                <div className="flex flex-col gap-1">
                  <label className="text-[12px] font-medium text-zinc-400">Domain</label>
                  <input
                    value={domain}
                    onChange={(e) => handleDomainChange(e.target.value)}
                    className={`input-base ${domainError ? "border-red-500/50" : ""}`}
                    placeholder="myproject.test"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  {domainError && <p className="text-[10px] text-red-400">{domainError}</p>}
                  <p className="text-[10px] text-zinc-600">
                    Changing the domain regenerates SSL certificates for all apps.
                  </p>
                </div>
              </>
            )}

            {section === "danger" && (
              <div className="flex flex-col gap-4">
                <div className="px-4 py-4 bg-red-500/[0.05] border border-red-500/20 rounded-xl flex flex-col gap-3">
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
                    className="self-start px-4 py-1.5 text-[13px] font-medium bg-red-600 hover:bg-red-500 text-white rounded-lg disabled:opacity-40 transition-colors"
                  >
                    Delete Workspace
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer — only for General */}
        {section === "general" && (
          <div className="flex items-center justify-between px-5 py-3 border-t border-white/[0.06] shrink-0">
            {saveError && <p className="text-[11px] text-red-400 flex-1 mr-3">{saveError}</p>}
            <div className="flex gap-2 ml-auto">
              <button onClick={onClose} className="px-4 py-1.5 text-[13px] text-zinc-500 hover:text-zinc-200 rounded-lg transition-colors">
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={!canSave || saving}
                className="px-4 py-1.5 text-[13px] font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg disabled:opacity-40 transition-colors"
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
