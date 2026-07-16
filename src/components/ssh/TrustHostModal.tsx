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
        className="w-96 p-4 bg-[#1a1a1c] border border-white/[0.08] rounded-lg space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-[13px] text-zinc-200 font-medium">Unknown host key</div>
        <p className="text-[12px] text-zinc-400">
          The authenticity of <span className="text-zinc-200">{prompt.hostname}</span> can't be established.
          Key type <span className="text-zinc-200">{prompt.keyType}</span>. Fingerprint:
        </p>
        <code className="block px-2 py-1.5 text-[11px] bg-black/40 rounded text-emerald-300 break-all">
          {prompt.fingerprint}
        </code>
        <p className="text-[11px] text-zinc-500">Only continue if this matches the server's real fingerprint.</p>
        <div className="flex justify-end gap-2">
          <button className="px-3 py-1 text-[12px] text-zinc-400 hover:text-zinc-200 transition-colors" onClick={cancelPrompt}>
            Cancel
          </button>
          <button
            className="px-3 py-1 text-[12px] font-medium bg-emerald-500/20 text-emerald-300 rounded-lg hover:bg-emerald-500/30 transition-colors"
            onClick={answerTrust}
          >
            Trust & continue
          </button>
        </div>
      </div>
    </div>
  );
}
