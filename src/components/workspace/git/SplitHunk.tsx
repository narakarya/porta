import type { DiffLine, Hunk } from "../../../lib/git-diff";

/**
 * Split (side-by-side) rendering for one hunk's `lines`. Pairs consecutive
 * `del`/`add` runs into left(old)/right(new) rows by index — row i is
 * `dels[i]` (left) next to `adds[i]` (right); a shorter side leaves its
 * cell empty. `ctx` lines emit one row with identical text on both sides;
 * `meta` (`\ No newline…`) emits a full-width muted row.
 */
type SplitRow =
  | { kind: "change"; left: string | null; right: string | null }
  | { kind: "ctx"; text: string }
  | { kind: "meta"; text: string };

// Strips the leading ` `/`+`/`-` diff marker for display — the column's own
// color already conveys add/del. An empty result (originally blank line)
// falls back to NBSP so the row keeps its height.
function stripMarker(text: string): string {
  const stripped = text.slice(1);
  return stripped === "" ? " " : stripped;
}

function buildSplitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let dels: string[] = [];
  let adds: string[] = [];

  function flush() {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) {
      rows.push({ kind: "change", left: dels[i] ?? null, right: adds[i] ?? null });
    }
    dels = [];
    adds = [];
  }

  for (const line of lines) {
    if (line.kind === "del") {
      dels.push(stripMarker(line.text));
    } else if (line.kind === "add") {
      adds.push(stripMarker(line.text));
    } else if (line.kind === "ctx") {
      flush();
      rows.push({ kind: "ctx", text: stripMarker(line.text) });
    } else {
      flush();
      rows.push({ kind: "meta", text: line.text === "" ? " " : line.text });
    }
  }
  flush();
  return rows;
}

function Cell({
  content,
  side,
  bordered,
}: {
  content: string | null;
  side: "del" | "add";
  bordered?: boolean;
}) {
  const base = `whitespace-pre px-1${bordered ? " border-r border-subtle" : ""}`;
  if (content === null) {
    return <div className={base}>{" "}</div>;
  }
  const colorCls = side === "del" ? "bg-bad-bg text-bad" : "bg-ok-bg text-ok";
  return <div className={`${base} ${colorCls}`}>{content}</div>;
}

export default function SplitHunk({ hunk }: { hunk: Hunk }) {
  const rows = buildSplitRows(hunk.lines);
  return (
    <div>
      {rows.map((row, i) => {
        if (row.kind === "meta") {
          return (
            <div key={i} className="whitespace-pre text-ink-3 px-1">
              {row.text}
            </div>
          );
        }
        if (row.kind === "ctx") {
          return (
            <div key={i} className="grid grid-cols-2">
              <div className="whitespace-pre text-ink-2 px-1 border-r border-subtle">{row.text}</div>
              <div className="whitespace-pre text-ink-2 px-1">{row.text}</div>
            </div>
          );
        }
        return (
          <div key={i} className="grid grid-cols-2">
            <Cell content={row.left} side="del" bordered />
            <Cell content={row.right} side="add" />
          </div>
        );
      })}
    </div>
  );
}
