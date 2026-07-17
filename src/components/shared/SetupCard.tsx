interface Props {
  step: number;
  title: string;
  body: string;
  cmd: string;
  copied: string | null;
  onCopy: (cmd: string) => void;
  onRecheck: () => void;
  recheckLabel: string;
  /** When true, the recheck button shows a spinner and is disabled. Surfaces
   *  feedback during async rechecks that otherwise look like a no-op. */
  loading?: boolean;
  /** Rendered below the button when set — typically a "still not ready"
   *  message after a recheck that didn't change state. */
  hint?: string | null;
}

/**
 * Small numbered card used by the Named-tunnel setup flow. Shows one CLI
 * command with Copy + a "I've done it" recheck button.
 */
export default function SetupCard({ step, title, body, cmd, copied, onCopy, onRecheck, recheckLabel, loading = false, hint = null }: Props) {
  const isCopied = copied === cmd;
  return (
    <div className="p-3 rounded-lg bg-accent-bg border border-[rgba(96,165,250,0.30)] flex flex-col gap-2">
      <div className="flex items-start gap-2.5">
        <span className="shrink-0 w-5 h-5 rounded-full bg-[rgba(96,165,250,0.22)] text-accent-ink text-[11px] font-semibold flex items-center justify-center">
          {step}
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-[12px] font-medium text-ink">{title}</p>
          <p className="text-[11px] text-ink-3 mt-0.5">{body}</p>
        </div>
      </div>
      <div className="relative">
        <code className="block px-2.5 py-2 pr-14 rounded-md bg-surface-code border border-subtle text-[11px] text-ink font-mono whitespace-pre-wrap break-all">
          {cmd}
        </code>
        <button
          type="button"
          onClick={() => onCopy(cmd)}
          className="absolute top-1.5 right-1.5 px-2 py-0.5 text-[10px] font-medium rounded bg-surface-2 hover:bg-white/[0.10] text-ink-2 transition-colors"
          style={{ color: isCopied ? "#a3e635" : undefined }}
        >
          {isCopied ? "Copied!" : "Copy"}
        </button>
      </div>
      <button
        type="button"
        onClick={onRecheck}
        disabled={loading}
        className="self-start flex items-center gap-1.5 px-3 py-1 text-[11px] font-medium rounded-md bg-[rgba(96,165,250,0.12)] hover:bg-[rgba(96,165,250,0.22)] text-accent-ink transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {loading ? (
          <svg className="animate-spin" width="10" height="10" viewBox="0 0 12 12" fill="none">
            <path d="M6 1.5A4.5 4.5 0 1 1 1.5 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        ) : (
          "↻"
        )}
        {loading ? "Checking…" : recheckLabel}
      </button>
      {hint && (
        <p className="text-[10px] text-warn leading-snug">{hint}</p>
      )}
    </div>
  );
}
