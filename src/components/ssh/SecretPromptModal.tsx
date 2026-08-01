import { useState } from "react";
import { usePortaStore } from "../../store";

export default function SecretPromptModal() {
  const prompt = usePortaStore((s) => s.sshPrompt);
  const answerSecret = usePortaStore((s) => s.answerSecret);
  const dismiss = usePortaStore((s) => s.dismissPrompt);
  const cancelPrompt = usePortaStore((s) => s.cancelPrompt);
  const [value, setValue] = useState("");
  const [remember, setRemember] = useState(false);

  if (prompt?.type === "host-key-changed") {
    return (
      <div className="fixed inset-0 bg-black/50 backdrop-blur-[2px] flex items-center justify-center z-50">
        <div className="w-96 p-4 bg-surface-2 border border-[var(--danger-border)] rounded-lg space-y-3">
          <div className="text-[13px] text-bad font-medium">⚠ Host key changed</div>
          <p className="text-[12px] text-ink-2">
            The server's key does not match the one previously trusted. This can indicate a
            man-in-the-middle attack. The connection was blocked.
          </p>
          <code className="block px-2 py-1.5 text-[11px] bg-black/40 rounded text-bad break-all">
            {prompt.fingerprint}
          </code>
          <div className="flex justify-end">
            <button
              className="px-3 py-1 text-[12px] font-medium text-ink-2 hover:text-ink transition-colors"
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
      onClick={cancelPrompt}
    >
      <div
        className="w-80 p-4 bg-surface-2 border border-white/[0.08] rounded-lg space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-[13px] text-ink font-medium">
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
          className="w-full bg-surface-input border border-white/[0.08] rounded-lg px-3 py-2 text-[13px] text-ink placeholder:text-ink-3 outline-none focus:border-[var(--accent)] transition-colors"
        />
        <label className="flex items-center gap-2 text-[12px] text-ink-2">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Remember in macOS Keychain
        </label>
        <div className="flex justify-end gap-2">
          <button className="px-3 py-1 text-[12px] text-ink-2 hover:text-ink transition-colors" onClick={cancelPrompt}>
            Cancel
          </button>
          <button
            className="px-3 py-1 text-[12px] font-medium bg-ok-bg text-ok rounded-lg hover:bg-emerald-500/30 transition-colors"
            onClick={submit}
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}
