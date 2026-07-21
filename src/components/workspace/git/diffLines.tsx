import type { CSSProperties, ReactNode } from "react";
import type { StyledToken } from "../../../lib/diff-highlight";
import type { Span } from "../../../lib/word-diff";

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
          {line === "" ? " " : line}
        </div>
      ))}
    </>
  );
}

// Shiki hands back a style as a declaration list ("color:var(--x);font-style:
// italic"), which is what an HTML string wants; React wants an object. Parsed
// once per distinct declaration list — a file has a handful of them and tens of
// thousands of tokens.
const styleCache = new Map<string, CSSProperties | undefined>();

function inlineStyle(style: string): CSSProperties | undefined {
  if (style === "") return undefined;
  if (styleCache.has(style)) return styleCache.get(style);
  const props: Record<string, string> = {};
  for (const declaration of style.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon <= 0) continue;
    const name = declaration
      .slice(0, colon)
      .trim()
      .replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    props[name] = declaration.slice(colon + 1).trim();
  }
  const parsed = Object.keys(props).length ? (props as CSSProperties) : undefined;
  styleCache.set(style, parsed);
  return parsed;
}

/**
 * The tokens for one diff row, or `undefined` when they cannot be trusted.
 *
 * `fileTokens` is the whole file tokenised in context and indexed by line
 * number; `text` is what the diff itself says that line contains. Normally they
 * agree. They can disagree for reasons that are nobody's bug — the working tree
 * moved between reading the diff and reading the blob, a side came back
 * truncated so its tail is simply missing, a rename — and a disagreement here
 * means the row would be painted with some *other* line's colours, which is
 * worse than no colour at all. So the two are compared before use, and a
 * mismatch falls back to plain. Cheap: one string comparison per rendered row.
 */
export function tokensForLine(
  fileTokens: StyledToken[][] | null,
  lineNumber: number | null,
  text: string,
): StyledToken[] | undefined {
  if (!fileTokens || lineNumber === null) return undefined;
  const tokens = fileTokens[lineNumber - 1];
  if (!tokens) return undefined;
  let at = 0;
  for (const token of tokens) {
    if (!text.startsWith(token.content, at)) return undefined;
    at += token.content.length;
  }
  return at === text.length ? tokens : undefined;
}

/**
 * One diff line's inner content, composing two independent segmentations of the
 * very same characters:
 *
 *   - **syntax tokens** — the file tokenised whole and sliced by line
 *     (src/lib/diff-highlight.ts), so a line inside a multi-line string is
 *     coloured as string content;
 *   - **word-diff spans** — the changed ranges within a paired del/add line
 *     (src/lib/word-diff.ts).
 *
 * They are nested, never traded off: every character keeps the colour its
 * grammar gives it *and* the emphasis the diff gives it.
 *
 * **Syntax outside, word-diff inside — and the CSS cascade is what decides it,
 * not taste.** Shiki writes its colour as an *inline* style
 * (`style="color:var(--shiki-token-string)"`), and an inline style beats any
 * class. The word-diff emphasis is a class pair whose foreground
 * (`text-surface-0`) is picked for contrast against its own solid fill — white
 * on the bright success/danger colour measures around 1.9:1, which is why the
 * pair exists at all. Nest the other way and the syntax span sits *inside* the
 * emphasis span, its inline colour overrides `text-surface-0` on every changed
 * run, and the emphasis silently loses the half of itself that made it legible.
 * Inverted, the emphasis class is on the inner element and beats the colour it
 * merely *inherits* from the syntax span around it: a changed run looks exactly
 * as it did before syntax colour existed, and every character outside one is
 * coloured by its grammar.
 *
 * A token straddling a word-diff boundary is split at it — splitting a token
 * costs nothing, since both halves carry the same style.
 *
 * Everything here renders as React elements over text nodes, so source text is
 * escaped by construction rather than by remembering to escape it: a file
 * containing `<script>` cannot emit markup no matter which of the two
 * segmentations cuts it where.
 */
export function DiffLineContent({
  text,
  tokens,
  spans,
  strongClass,
}: {
  /** The line's text with its diff marker already stripped. */
  text: string;
  /** Syntax tokens for this line, if the file could be highlighted. */
  tokens?: StyledToken[];
  /** Word-diff spans, if this line is half of a 1:1 del/add pair. */
  spans?: Span[];
  /** The emphasis classes for a changed run on this line's side. */
  strongClass?: string;
}) {
  const emphasise = (part: string, changed: boolean, key: number): ReactNode =>
    changed && strongClass ? (
      <span key={key} className={strongClass}>
        {part}
      </span>
    ) : (
      part
    );

  // No highlighting for this file (or this line): exactly the previous
  // behaviour, whole-line or word-diffed.
  if (!tokens) {
    if (!spans) return <>{text}</>;
    return <>{spans.map((span, i) => emphasise(span.text, span.changed, i))}</>;
  }

  // Word-diff spans as absolute offsets, so a syntax token can be intersected
  // with them without walking the list from the start each time.
  const ranges: { end: number; changed: boolean }[] = [];
  let covered = 0;
  for (const span of spans ?? []) {
    covered += span.text.length;
    ranges.push({ end: covered, changed: span.changed });
  }

  const out: ReactNode[] = [];
  let start = 0;
  tokens.forEach((token, ti) => {
    const end = start + token.content.length;
    const parts: ReactNode[] = [];
    let at = start;
    for (const range of ranges) {
      if (range.end <= at) continue;
      if (at >= end) break;
      const cut = Math.min(range.end, end);
      parts.push(emphasise(token.content.slice(at - start, cut - start), range.changed, parts.length));
      at = cut;
    }
    // No spans at all, or spans that ran out before this token did.
    if (at < end) parts.push(token.content.slice(at - start));
    out.push(
      <span key={ti} style={inlineStyle(token.style)}>
        {parts}
      </span>,
    );
    start = end;
  });
  return <>{out}</>;
}
