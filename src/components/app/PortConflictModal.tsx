import { useEffect, useState } from "react";
import ModalWrapper from "../shared/ModalWrapper";
import {
  applyPortChange,
  suggestAlternativePort,
} from "../../lib/commands";

interface Props {
  appId: string;
  appName: string;
  port: number;
  /** True when the app uses a compose file — only then do we have something
   *  to rewrite on disk, so we can offer Apply. Otherwise the modal degrades
   *  to a "kill PID / cancel" advisory. */
  hasComposeFile: boolean;
  /** Called after Apply finishes (caller can then retry start). */
  onApplied: (newPort: number) => void;
  onClose: () => void;
}

export default function PortConflictModal({
  appId,
  appName,
  port,
  hasComposeFile,
  onApplied,
  onClose,
}: Props) {
  const [suggested, setSuggested] = useState<number | null>(null);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    suggestAlternativePort(port)
      .then((p) => { if (!cancelled) setSuggested(p === port ? null : p); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [port]);

  async function handleApply() {
    if (!suggested) return;
    setApplying(true);
    setError(null);
    try {
      await applyPortChange(appId, port, suggested);
      onApplied(suggested);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setApplying(false);
    }
  }

  const canApply = hasComposeFile && suggested !== null;

  return (
    <ModalWrapper onClose={onClose}>
      <div className="w-[420px] p-5">
        <div className="flex items-center gap-2 mb-3">
          <span className="text-amber-400">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M7 2l5 9H2l5-9z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/>
              <path d="M7 6v2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
              <circle cx="7" cy="10.2" r="0.6" fill="currentColor"/>
            </svg>
          </span>
          <h2 className="text-[14px] font-semibold text-zinc-100">Port conflict</h2>
        </div>

        <p className="text-[12px] text-zinc-400 leading-relaxed mb-4">
          Suggest an alternative port for{" "}
          <span className="text-zinc-200">{appName}</span> to resolve the
          conflict on <span className="font-mono text-zinc-100">:{port}</span>.
        </p>

        {suggested !== null ? (
          <div className="mb-4 px-3 py-2.5 rounded-md bg-emerald-500/[0.06] border border-emerald-500/20">
            <p className="text-[12px] text-zinc-300">
              Suggested free port:{" "}
              <span className="font-mono font-semibold text-emerald-300">:{suggested}</span>
            </p>
          </div>
        ) : (
          <div className="mb-4 px-3 py-2.5 rounded-md bg-red-500/[0.06] border border-red-500/20">
            <p className="text-[12px] text-zinc-300">
              No free port found in :{port + 1}–:{port + 50}.
            </p>
          </div>
        )}

        {hasComposeFile && suggested !== null && (
          <div className="mb-4">
            <p className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1.5">
              Compose change preview
            </p>
            <div className="rounded-md bg-black/30 border border-white/[0.06] p-2.5 font-mono text-[11px] leading-relaxed">
              <div className="flex">
                <span className="text-red-400/80 w-3 shrink-0">-</span>
                <span className="text-zinc-400">
                  - <span className="text-red-300">"{port}</span>:&lt;container&gt;"
                </span>
              </div>
              <div className="flex">
                <span className="text-emerald-400/80 w-3 shrink-0">+</span>
                <span className="text-zinc-400">
                  - <span className="text-emerald-300">"{suggested}</span>:&lt;container&gt;"
                </span>
              </div>
            </div>
          </div>
        )}

        {!hasComposeFile && (
          <p className="mb-4 text-[11px] text-zinc-500 italic">
            This app has no compose file — auto-fix only applies to compose-based apps.
            Free the port manually or change it in app settings.
          </p>
        )}

        {error && (
          <div className="mb-3 px-3 py-2 rounded-md bg-red-500/10 border border-red-500/20">
            <p className="text-[11px] text-red-300 break-words">{error}</p>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            onClick={onClose}
            disabled={applying}
            className="px-3 py-1.5 text-[12px] font-medium text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.05] rounded-md transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleApply}
            disabled={!canApply || applying}
            className="px-3 py-1.5 text-[12px] font-medium text-white bg-emerald-600/90 hover:bg-emerald-500 rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {applying ? "Applying…" : "Apply suggestion"}
          </button>
        </div>
      </div>
    </ModalWrapper>
  );
}
