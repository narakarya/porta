import { escapeHtml, langFromPath, tokenizeLines, type StyledToken } from "./preview/highlight";

/**
 * Syntax highlighting for diff lines.
 *
 * A diff renders one line per row, so the obvious implementation — the one the
 * extension ships — hands each line to the tokeniser on its own. That is wrong
 * for any line that is not a self-contained fragment of the language: a line in
 * the middle of a multi-line string is coloured as code, a line in the middle of
 * a block comment is coloured as code, and `def f, do: 1` sitting inside a @doc
 * heredoc is coloured as a definition. The grammar cannot know better; it was
 * never shown the opening delimiter.
 *
 * So tokenise the file once, whole, and slice the result by line. The grammar
 * state then carries across line boundaries exactly as it does when the file is
 * rendered as one block, and each row gets the colours its real context says it
 * should have. Callers highlight the two revisions of a file once each and index
 * the results by line number.
 */

export type { StyledToken };

function renderToken(content: string, style: string): string {
  if (!content) return "";
  const text = escapeHtml(content);
  return style ? `<span style="${escapeHtml(style)}">${text}</span>` : `<span>${text}</span>`;
}

/**
 * Flattens a tokenised file into one HTML fragment per line, line 1 at index 0.
 *
 * Both ways a line boundary can show up in a token stream are honoured: the
 * grouping Shiki returns, and a newline sitting inside a token's own content.
 * The second is the one that matters — a token spanning a newline is a
 * multi-line string or comment, and both of its halves must keep the styling,
 * so it is split rather than dropped onto whichever line it started on. Working
 * from token content, never from emitted markup, is what makes that possible.
 *
 * The result is always exactly `lineCount` entries: a caller indexing by line
 * number gets a fragment or an empty string, never undefined. A blank line is
 * an empty fragment, not a missing one.
 */
export function sliceTokenLines(tokenLines: StyledToken[][], lineCount: number): string[] {
  const lines: string[] = [];
  let current = "";

  for (const tokens of tokenLines) {
    for (const token of tokens) {
      const parts = token.content.split("\n");
      current += renderToken(parts[0], token.style);
      for (let i = 1; i < parts.length; i++) {
        lines.push(current);
        current = renderToken(parts[i], token.style);
      }
    }
    lines.push(current);
    current = "";
  }

  if (lines.length > lineCount) lines.length = lineCount;
  while (lines.length < lineCount) lines.push("");
  return lines;
}

/**
 * Highlights a whole file and returns one HTML fragment per line, line 1 at
 * index 0, with exactly as many entries as `content` has lines.
 *
 * A fragment is the inside of a line — a run of `<span style="color:var(...)">`
 * with the source text escaped — and carries no line wrapper of its own, so the
 * caller drops it into whatever element its row already is. Every colour is a
 * `--shiki-token-*` variable that src/styles/git-theme.css binds to the
 * palette's `--syn-*`; nothing here emits a literal colour.
 *
 * Never throws. An unsupported language, an unloadable grammar or a highlighter
 * failure degrades to escaped plain text — the same lines, uncoloured — because
 * a diff that renders in one palette-neutral colour is a far smaller loss than
 * a diff that fails to render.
 */
export async function highlightFileLines(content: string, path: string): Promise<string[]> {
  const tokenLines = await tokenizeLines(content, langFromPath(path));
  if (!tokenLines) return content.split("\n").map(escapeHtml);
  return sliceTokenLines(tokenLines, content.split("\n").length);
}
