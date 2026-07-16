import { useState } from "react";
import { usePortaStore } from "../../store";

export default function SecretPromptModal() {
  const prompt = usePortaStore((s) => s.sshPrompt);
  const answerSecret = usePortaStore((s) => s.answerSecret);
  const dismiss = usePortaStore((s) => s.dismissPrompt);
  const [value, setValue] = useState("");
  const [remember, setRemember] = useState(false);

  if (prompt?.type === "host-key-changed") {
    return (
      <div className="fixed inset-0 bg-black/50 backdrop-blur-[2px] flex items-center justify-center z-50">
        <div className="w-96 p-4 bg-[#1a1a1c] border border-red-500/30 rounded-lg space-y-3">
          <div className="text-[13px] text-red-300 font-medium">⚠ Host key changed</div>
          <p className="text-[12px] text-zinc-400">
            The server's key does not match the one previously trusted. This can indicate a
            man-in-the-middle attack. The connection was blocked.
          </p>
          <code className="block px-2 py-1.5 text-[11px] bg-black/40 rounded text-red-300 break-all">
            {prompt.fingerprint}
          </code>
          <div className="flex justify-end">
            <button
              className="px-3 py-1 text-[12px] font-medium text-zinc-300 hover:text-zinc-100 transition-colors"
              onClick={dismiss}
            >
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (prompt?.type !== "secret") return null;

  function submit() {
    answerSecret(value, remember);
    setValue("");
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 backdrop-blur-[2px] flex items-center justify-center z-50"
      onClick={dismiss}
    >
      <div
        className="w-80 p-4 bg-[#1a1a1c] border border-white/[0.08] rounded-lg space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-[13px] text-zinc-200 font-medium">
          {prompt.kind === "password" ? "Password" : "Key passphrase"}
        </div>
        <input
          type="password"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          className="w-full bg-[#111113] border border-white/[0.08] rounded-lg px-3 py-2 text-[13px] text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-blue-500/60 transition-colors"
        />
        <label className="flex items-center gap-2 text-[12px] text-zinc-400">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Remember in macOS Keychain
        </label>
        <div className="flex justify-end gap-2">
          <button className="px-3 py-1 text-[12px] text-zinc-400 hover:text-zinc-200 transition-colors" onClick={dismiss}>
            Cancel
          </button>
          <button
            className="px-3 py-1 text-[12px] font-medium bg-emerald-500/20 text-emerald-300 rounded-lg hover:bg-emerald-500/30 transition-colors"
            onClick={submit}
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}
