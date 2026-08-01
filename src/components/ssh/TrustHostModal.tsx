import { usePortaStore } from "../../store";

export default function TrustHostModal() {
  const prompt = usePortaStore((s) => s.sshPrompt);
  const answerTrust = usePortaStore((s) => s.answerTrust);
  const cancelPrompt = usePortaStore((s) => s.cancelPrompt);
  if (prompt?.type !== "trust") return null;

  return (
    <div
      className="fixed inset-0 bg-black/50 backdrop-blur-[2px] flex items-center justify-center z-50"
      onClick={cancelPrompt}
    >
      <div
        className="w-96 p-4 bg-surface-2 border border-white/[0.08] rounded-lg space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-[13px] text-ink font-medium">Unknown host key</div>
        <p className="text-[12px] text-ink-2">
          The authenticity of <span className="text-ink">{prompt.hostname}</span> can't be established.
          Key type <span className="text-ink">{prompt.keyType}</span>. Fingerprint:
        </p>
        <code className="block px-2 py-1.5 text-[11px] bg-black/40 rounded text-ok break-all">
          {prompt.fingerprint}
        </code>
        <p className="text-[11px] text-ink-3">Only continue if this matches the server's real fingerprint.</p>
        <div className="flex justify-end gap-2">
          <button className="px-3 py-1 text-[12px] text-ink-2 hover:text-ink transition-colors" onClick={cancelPrompt}>
            Cancel
          </button>
          <button
            className="px-3 py-1 text-[12px] font-medium bg-ok-bg text-ok rounded-lg hover:bg-emerald-500/30 transition-colors"
            onClick={answerTrust}
          >
            Trust & continue
          </button>
        </div>
      </div>
    </div>
  );
}
