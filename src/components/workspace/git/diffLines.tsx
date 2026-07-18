/**
 * Shared per-line diff colorizer — prefix→class mapping originally in
 * GitTab's Changes pane, reused by HistoryPanel for `git show` patches.
 * Token classes only; no hardcoded hex.
 */
export function diffLineClass(line: string): string {
  if (line.startsWith("@@")) return "text-accent";
  if (line.startsWith("+++") || line.startsWith("---")) return "text-ink-3";
  if (line.startsWith("diff ") || line.startsWith("index ")) return "text-ink-3";
  if (line.startsWith("+")) return "bg-ok-bg text-ok";
  if (line.startsWith("-")) return "bg-bad-bg text-bad";
  return "text-ink-2";
}

/** Renders a raw unified-diff string as one colorized `<div>` per line. */
export function DiffLines({ diff }: { diff: string }) {
  return (
    <>
      {diff.split("\n").map((line, i) => (
        <div key={i} className={`whitespace-pre ${diffLineClass(line)}`}>
          {line === "" ? " " : line}
        </div>
      ))}
    </>
  );
}
