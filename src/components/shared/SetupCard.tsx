interface Props {
  step: number;
  title: string;
  body: string;
  cmd: string;
  copied: string | null;
  onCopy: (cmd: string) => void;
  onRecheck: () => void;
  recheckLabel: string;
}

/**
 * Small numbered card used by the Named-tunnel setup flow. Shows one CLI
 * command with Copy + a "I've done it" recheck button.
 */
export default function SetupCard({ step, title, body, cmd, copied, onCopy, onRecheck, recheckLabel }: Props) {
  const isCopied = copied === cmd;
  return (
    <div className="p-3 rounded-lg bg-blue-500/[0.06] border border-blue-500/20 flex flex-col gap-2">
      <div className="flex items-start gap-2.5">
        <span className="shrink-0 w-5 h-5 rounded-full bg-blue-500/20 text-blue-300 text-[11px] font-semibold flex items-center justify-center">
          {step}
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-[12px] font-medium text-zinc-200">{title}</p>
          <p className="text-[11px] text-zinc-500 mt-0.5">{body}</p>
        </div>
      </div>
      <div className="relative">
        <code className="block px-2.5 py-2 pr-14 rounded-md bg-[#0d0d0f] border border-white/[0.06] text-[11px] text-zinc-200 font-mono whitespace-pre-wrap break-all">
          {cmd}
        </code>
        <button
          type="button"
          onClick={() => onCopy(cmd)}
          className="absolute top-1.5 right-1.5 px-2 py-0.5 text-[10px] font-medium rounded bg-white/[0.06] hover:bg-white/[0.10] text-zinc-300 transition-colors"
          style={{ color: isCopied ? "#a3e635" : undefined }}
        >
          {isCopied ? "Copied!" : "Copy"}
        </button>
      </div>
      <button
        type="button"
        onClick={onRecheck}
        className="self-start px-3 py-1 text-[11px] font-medium rounded-md bg-blue-500/10 hover:bg-blue-500/20 text-blue-300 transition-colors"
      >
        ↻ {recheckLabel}
      </button>
    </div>
  );
}
