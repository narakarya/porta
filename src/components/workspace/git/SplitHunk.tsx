import type { Hunk } from "../../../lib/git-diff";

/**
 * Split (side-by-side) rendering for one hunk's `lines`. Pairs consecutive
 * `del`/`add` runs into left(old)/right(new) rows by index — row i is
 * `dels[i]` (left) next to `adds[i]` (right); a shorter side leaves its
 * cell empty. `ctx` lines emit one row with identical text on both sides;
 * `meta` (`\ No newline…`) emits a full-width muted row.
 *
 * Line numbers walk the same old/new counters `hunkLineNumbers` (DiffView)
 * uses, just grouped by row instead of by raw line: a `ctx` row shows both,
 * a lone del/add row shows only its own side, and a paired change row shows
 * old on the left / new on the right.
 */
type SplitRow =
  | { kind: "change"; left: string | null; right: string | null; leftNum: number | null; rightNum: number | null }
  | { kind: "ctx"; text: string; leftNum: number; rightNum: number }
  | { kind: "meta"; text: string };

// Strips the leading ` `/`+`/`-` diff marker for display — the column's own
// color already conveys add/del. An empty result (originally blank line)
// falls back to NBSP so the row keeps its height.
function stripMarker(text: string): string {
  const stripped = text.slice(1);
  return stripped === "" ? " " : stripped;
}

function buildSplitRows(hunk: Hunk): SplitRow[] {
  const rows: SplitRow[] = [];
  let dels: { text: string; num: number }[] = [];
  let adds: { text: string; num: number }[] = [];
  let oldNum = hunk.oldStart;
  let newNum = hunk.newStart;

  function flush() {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) {
      rows.push({
        kind: "change",
        left: dels[i]?.text ?? null,
        right: adds[i]?.text ?? null,
        leftNum: dels[i]?.num ?? null,
        rightNum: adds[i]?.num ?? null,
      });
    }
    dels = [];
    adds = [];
  }

  for (const line of hunk.lines) {
    if (line.kind === "del") {
      dels.push({ text: stripMarker(line.text), num: oldNum });
      oldNum++;
    } else if (line.kind === "add") {
      adds.push({ text: stripMarker(line.text), num: newNum });
      newNum++;
    } else if (line.kind === "ctx") {
      flush();
      rows.push({ kind: "ctx", text: stripMarker(line.text), leftNum: oldNum, rightNum: newNum });
      oldNum++;
      newNum++;
    } else {
      flush();
      rows.push({ kind: "meta", text: line.text === "" ? " " : line.text });
    }
  }
  flush();
  return rows;
}

const GUTTER_NUM_CLASS = "w-9 shrink-0 pr-1.5 text-right select-none text-ink-3 tabular-nums";

function Cell({
  content,
  num,
  side,
  bordered,
}: {
  content: string | null;
  num: number | null;
  side: "del" | "add";
  bordered?: boolean;
}) {
  const wrap = `flex${bordered ? " border-r border-subtle" : ""}`;
  if (content === null) {
    return (
      <div className={wrap}>
        <span className={GUTTER_NUM_CLASS}>{" "}</span>
        <span className="whitespace-pre px-1 flex-1">{" "}</span>
      </div>
    );
  }
  const colorCls = side === "del" ? "bg-bad-bg text-bad" : "bg-ok-bg text-ok";
  return (
    <div className={wrap}>
      <span className={GUTTER_NUM_CLASS}>{num ?? ""}</span>
      <span className={`whitespace-pre px-1 flex-1 ${colorCls}`}>{content}</span>
    </div>
  );
}

export default function SplitHunk({ hunk }: { hunk: Hunk }) {
  const rows = buildSplitRows(hunk);
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
              <div className="flex border-r border-subtle">
                <span className={GUTTER_NUM_CLASS}>{row.leftNum}</span>
                <span className="whitespace-pre text-ink-2 px-1 flex-1">{row.text}</span>
              </div>
              <div className="flex">
                <span className={GUTTER_NUM_CLASS}>{row.rightNum}</span>
                <span className="whitespace-pre text-ink-2 px-1 flex-1">{row.text}</span>
              </div>
            </div>
          );
        }
        return (
          <div key={i} className="grid grid-cols-2">
            <Cell content={row.left} num={row.leftNum} side="del" bordered />
            <Cell content={row.right} num={row.rightNum} side="add" />
          </div>
        );
      })}
    </div>
  );
}
