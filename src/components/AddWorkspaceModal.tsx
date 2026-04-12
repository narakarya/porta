import React, { useState } from "react";
import { usePortaStore } from "../store";

interface Props {
  onClose: () => void;
}

export default function AddWorkspaceModal({ onClose }: Props) {
  const { addWorkspace } = usePortaStore();
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
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
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <form
        onSubmit={submit}
        className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-80 flex flex-col gap-4"
      >
        <h2 className="font-semibold text-lg">Add Workspace</h2>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-gray-400">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            placeholder="Mediapress"
            className="bg-gray-800 border border-gray-700 rounded-md px-3 py-1.5"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-gray-400">Domain</span>
          <input
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            required
            placeholder="mediapress.test"
            className="bg-gray-800 border border-gray-700 rounded-md px-3 py-1.5"
          />
        </label>

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 text-sm text-gray-400 hover:text-gray-200"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="px-4 py-1.5 text-sm bg-indigo-600 hover:bg-indigo-500 rounded-md disabled:opacity-50"
          >
            {submitting ? "Adding…" : "Add"}
          </button>
        </div>
      </form>
    </div>
  );
}
