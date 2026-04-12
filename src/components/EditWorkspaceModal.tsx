import { useState } from "react";
import type { FormEvent } from "react";
import { usePortaStore } from "../store";
import type { Workspace } from "../types";

const inputCls = "w-full bg-[#111113] border border-white/[0.08] rounded-lg px-3 py-2 text-[13px] text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-blue-500/60 transition-colors";

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function validateDomain(d: string): string | null {
  if (!d) return "Domain is required";
  if (!DOMAIN_RE.test(d)) return "Must be a valid domain (e.g. myproject.test)";
  return null;
}

interface Props {
  workspace: Workspace;
  onClose: () => void;
}

export default function EditWorkspaceModal({ workspace, onClose }: Props) {
  const { updateWorkspace } = usePortaStore();
  const [name, setName] = useState(workspace.name);
  const [domain, setDomain] = useState(workspace.domain);
  const [domainError, setDomainError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function handleDomainChange(val: string) {
    const lower = val.toLowerCase();
    setDomain(lower);
    setDomainError(validateDomain(lower));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const err = validateDomain(domain);
    if (err) { setDomainError(err); return; }
    if (!name.trim()) return;
    setSubmitting(true);
    try {
      await updateWorkspace(workspace.id, name.trim(), domain);
      onClose();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-[2px] flex items-center justify-center z-50">
      <form
        onSubmit={submit}
        className="bg-[#1c1c1e] border border-white/[0.08] rounded-2xl p-6 w-[340px] flex flex-col gap-4 shadow-2xl"
      >
        <div>
          <h2 className="text-[15px] font-semibold text-zinc-100">Workspace Settings</h2>
          <p className="text-[12px] text-zinc-500 mt-0.5">{workspace.name}</p>
        </div>

        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium text-zinc-500 uppercase tracking-wide">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              className={inputCls}
              autoFocus
              autoComplete="off"
              spellCheck={false}
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium text-zinc-500 uppercase tracking-wide">Domain</span>
            <input
              value={domain}
              onChange={(e) => handleDomainChange(e.target.value)}
              required
              placeholder="myproject.test"
              className={`${inputCls} ${domainError ? "border-red-500/60" : ""}`}
              autoComplete="off"
              spellCheck={false}
            />
            {domainError && (
              <span className="text-[11px] text-red-400">{domainError}</span>
            )}
          </label>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose}
            className="px-4 py-1.5 text-[13px] text-zinc-500 hover:text-zinc-200 rounded-lg transition-colors">
            Cancel
          </button>
          <button type="submit" disabled={submitting || !!domainError}
            className="px-4 py-1.5 text-[13px] font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg disabled:opacity-50 transition-colors flex items-center gap-2">
            {submitting && <span className="spinner text-white/70" />}
            {submitting ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}
