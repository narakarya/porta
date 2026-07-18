import type { Hunk } from "../../../lib/git-diff";
import { tokenDiff, type Span } from "../../../lib/word-diff";

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

// Whole-line ("dim") vs changed-run ("strong") backgrounds, per side. A
// row with no word-level spans (unpaired del/add) uses `dimCls` across the
// whole cell, matching the previous whole-line-background behavior.
function sideClasses(side: "del" | "add"): { dim: string; strong: string } {
  return side === "del"
    ? { dim: "bg-bad-bg text-bad", strong: "bg-bad text-white" }
    : { dim: "bg-ok-bg text-ok", strong: "bg-ok text-white" };
}

function Cell({
  content,
  num,
  side,
  bordered,
  spans,
}: {
  content: string | null;
  num: number | null;
  side: "del" | "add";
  bordered?: boolean;
  /** Word-diff spans for this side, when paired with the other side of a
   *  1:1 change row. Absent → render `content` with the whole-line color. */
  spans?: Span[];
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
  const { dim, strong } = sideClasses(side);
  return (
    <div className={wrap}>
      <span className={GUTTER_NUM_CLASS}>{num ?? ""}</span>
      <span className={`whitespace-pre px-1 flex-1 ${dim}`}>
        {spans
          ? spans.map((s, si) => (
              <span key={si} className={s.changed ? strong : undefined}>{s.text}</span>
            ))
          : content}
      </span>
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
        // Only a 1:1 change (both sides present) gets word-level highlight —
        // an unpaired del or add (the other side `null`) keeps the whole-line
        // background, since there's nothing on the other side to diff against.
        const diff = row.left !== null && row.right !== null
          ? tokenDiff(row.left, row.right)
          : null;
        return (
          <div key={i} className="grid grid-cols-2">
            <Cell content={row.left} num={row.leftNum} side="del" bordered spans={diff?.old} />
            <Cell content={row.right} num={row.rightNum} side="add" spans={diff?.new} />
          </div>
        );
      })}
    </div>
  );
}
