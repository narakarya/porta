import { useState } from "react";
import type { FormEvent } from "react";
import { usePortaStore } from "../store";

const inputCls = "w-full bg-[#111113] border border-white/[0.08] rounded-lg px-3 py-2 text-[13px] text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-blue-500/60 transition-colors";

function toSlug(str: string): string {
  return str
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

export default function AddWorkspaceModal({ onClose }: { onClose: () => void }) {
  const { addWorkspace } = usePortaStore();
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [domainEdited, setDomainEdited] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  function handleNameChange(val: string) {
    setName(val);
    // Auto-generate domain from name unless user has manually edited it
    if (!domainEdited) {
      const slug = toSlug(val);
      setDomain(slug ? `${slug}.test` : "");
    }
  }

  function handleDomainChange(val: string) {
    setDomain(val.toLowerCase());
    setDomainEdited(val !== "");
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name || !domain) return;
    setSubmitting(true);
    try {
      await addWorkspace(name, domain);
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
          <h2 className="text-[15px] font-semibold text-zinc-100">New Workspace</h2>
          <p className="text-[12px] text-zinc-500 mt-0.5">Group related apps under a shared domain</p>
        </div>

        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium text-zinc-500 uppercase tracking-wide">Name</span>
            <input
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              required
              placeholder="My Project"
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
              className={inputCls}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose}
            className="px-4 py-1.5 text-[13px] text-zinc-500 hover:text-zinc-200 rounded-lg transition-colors">
            Cancel
          </button>
          <button type="submit" disabled={submitting}
            className="px-4 py-1.5 text-[13px] font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg disabled:opacity-50 transition-colors flex items-center gap-2">
            {submitting && <span className="spinner text-white/70" />}
            {submitting ? "Creating…" : "Create"}
          </button>
        </div>
      </form>
    </div>
  );
}
