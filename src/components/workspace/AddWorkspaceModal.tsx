import { useState } from "react";
import type { FormEvent } from "react";
import { usePortaStore } from "../../store";
import ModalWrapper from "../shared/ModalWrapper";
import { yieldToFrame } from "../../lib/ui";

const inputCls = "w-full bg-[#111113] border border-white/[0.08] rounded-lg px-3 py-2 text-[13px] text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-blue-500/60 transition-colors";

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function validateDomain(d: string): string | null {
  if (!d) return "Domain is required";
  if (!DOMAIN_RE.test(d)) return "Must be a valid domain (e.g. myproject.test)";
  return null;
}

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
  const [domainError, setDomainError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function handleNameChange(val: string) {
    setName(val);
    if (!domainEdited) {
      const slug = toSlug(val);
      const auto = slug ? `${slug}.test` : "";
      setDomain(auto);
      setDomainError(auto ? null : null);
    }
  }

  function handleDomainChange(val: string) {
    const lower = val.toLowerCase();
    setDomain(lower);
    setDomainEdited(val !== "");
    setDomainError(validateDomain(lower));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const err = validateDomain(domain);
    if (err) { setDomainError(err); return; }
    if (!name) return;
    setSubmitting(true);
    await yieldToFrame();
    try {
      await addWorkspace(name, domain);
      onClose();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ModalWrapper onClose={onClose} className="bg-[#1c1c1e] border border-white/[0.08] rounded-2xl shadow-2xl">
      <form
        onSubmit={submit}
        className="p-6 w-[340px] flex flex-col gap-4"
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
            {submitting && (
              <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.3" />
                <path d="M14 8a6 6 0 00-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            )}
            {submitting ? "Creating…" : "Create"}
          </button>
        </div>
      </form>
    </ModalWrapper>
  );
}
