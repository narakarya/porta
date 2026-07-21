import type { PaneSession } from "../../store/slices/terminal";

const DOT: Record<PaneSession["state"], string> = {
  idle: "bg-zinc-600",
  running: "bg-emerald-400",
  exited: "bg-amber-400",
};

interface Props {
  /** The focused pane, or the tab's only pane. Null while a tab is seeding. */
  pane: PaneSession | null;
  lineCount: number;
  matchCount: number | null;
  onRestart: () => void;
}

/**
 * One quiet row under the terminal describing the focused pane. It absorbs the
 * line/match counts that used to sit in the header, and is the only place an
 * exited shell offers a way back.
 */
export default function TerminalStatusBar({ pane, lineCount, matchCount, onRestart }: Props) {
  if (!pane) return null;

  const label =
    pane.state === "exited"
      ? `exited (${pane.exitCode ?? 0})`
      : pane.state === "running"
        ? "running"
        : "idle";

  return (
    <div className="flex items-center gap-3 px-3 py-1 border-t border-subtle shrink-0 font-mono text-[10px] text-zinc-500">
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${DOT[pane.state]}`} aria-hidden />
      <span>{label}</span>
      {/* Only the command name — never a "zsh" fallback. The tab label
          already reads "zsh" for a default shell, and split-view panes with
          no header of their own are the one place this isn't already said
          somewhere on screen. */}
      {pane.startupCommand?.trim() && <span>{pane.startupCommand.trim().split(/\s+/)[0]}</span>}
      {pane.pid ? <span>pid {pane.pid}</span> : null}
      {pane.state === "exited" && (
        <button
          onClick={onRestart}
          className="px-1.5 rounded text-zinc-400 hover:text-ink hover:bg-white/[0.06] transition-colors"
        >
          Restart
        </button>
      )}
      <div className="flex-1" />
      <span>{lineCount.toLocaleString()} lines</span>
      {matchCount !== null && <span>{matchCount.toLocaleString()} matches</span>}
    </div>
  );
}
