import {
  escapeHtml,
  isSupportedLang,
  langFromPath,
  tokenizeLines,
  type StyledToken,
} from "./preview/highlight";

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
  return sliceTokenLinesToTokens(tokenLines, lineCount).map((tokens) =>
    tokens.map((token) => renderToken(token.content, token.style)).join(""),
  );
}

/**
 * The same slice, stopping one step earlier: tokens per line rather than markup
 * per line.
 *
 * A consumer that only drops a whole line into the DOM wants `sliceTokenLines`.
 * A consumer that has to *subdivide* a line — the diff surface, which must also
 * mark the word-diff's changed ranges inside it — cannot use finished markup: a
 * character range does not intersect an HTML string, only a token stream. So
 * that consumer gets the tokens and assembles the elements itself.
 */
export function sliceTokenLinesToTokens(
  tokenLines: StyledToken[][],
  lineCount: number,
): StyledToken[][] {
  const lines: StyledToken[][] = [];
  let current: StyledToken[] = [];

  function push(content: string, style: string) {
    if (content !== "") current.push({ content, style });
  }

  for (const tokens of tokenLines) {
    for (const token of tokens) {
      const parts = token.content.split("\n");
      push(parts[0], token.style);
      for (let i = 1; i < parts.length; i++) {
        lines.push(current);
        current = [];
        push(parts[i], token.style);
      }
    }
    lines.push(current);
    current = [];
  }

  if (lines.length > lineCount) lines.length = lineCount;
  while (lines.length < lineCount) lines.push([]);
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

/**
 * Whether a path has a grammar at all. Exported so a caller can decide *before*
 * paying for anything: highlighting a file needs both of its sides read out of
 * git, and for a `.txt`, a `Makefile` or a lockfile those two reads buy exactly
 * nothing. Answering up front is the difference between two IPC round trips and
 * none.
 */
export function canHighlightPath(path: string): boolean {
  const lang = langFromPath(path);
  return lang !== "text" && isSupportedLang(lang);
}

/**
 * Half the 512 KB the backend clips a blob to. The tokeniser is *synchronous*
 * over the whole file — that is the price of tokenising in context — so this is
 * a main-thread budget, not a memory one: past it the diff renders in one
 * colour rather than freezing the window while a generated bundle is parsed.
 */
const MAX_HIGHLIGHT_CHARS = 256 * 1024;

/**
 * How many tokenised files to keep. The diff surface shows one file at a time
 * and needs two sides of it, so a handful covers going back and forth between a
 * few files; beyond that the entries are token arrays several times the size of
 * the source and not worth pinning for a session.
 */
const CACHE_LIMIT = 8;

/**
 * Content-addressed, and deliberately so.
 *
 * The obvious key is (path, revision), and it is wrong in both directions.
 * `HEAD` and the index are *moving* revisions: staging a hunk rewrites the
 * index, so a (path, ":") entry would serve the pre-stage text and colour the
 * new diff by the old file. And it is too strict as well — the ordinary case is
 * a refetch that returns byte-identical content (the pane regaining focus, a
 * hunk action on the *other* side, a staged flip that leaves one side alone),
 * which a revision key treats as new work and a content key does not.
 *
 * So the key is what the answer actually depends on: the text, plus the path
 * because the path is where the language comes from. Same bytes, same grammar,
 * same tokens — regardless of which revision they arrived from.
 *
 * The value is the in-flight promise, not the resolved value, so two lines of
 * the same file requested at once tokenise once.
 */
const tokenCache = new Map<string, Promise<StyledToken[][] | null>>();

/** FNV-1a, 32-bit. Cheap enough to be free next to tokenising, and paired with
 *  the length in the key so a collision needs both to agree. Hashing rather
 *  than keying on the content itself keeps a cache entry from pinning a 256 KB
 *  string alive for as long as its tokens. */
function hashContent(content: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    h ^= content.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Highlights a whole file and returns its tokens one line at a time, line 1 at
 * index 0, with exactly as many entries as `content` has lines — the shape a
 * caller needs when it has to compose the colouring with something else that
 * marks the same characters.
 *
 * `null` means "no colouring available": no grammar for this path, a file over
 * the size cap, or a tokeniser failure. It is a distinct answer from "an
 * uncoloured line", so a caller can leave its existing plain rendering exactly
 * as it was rather than wrapping every line in styleless spans.
 *
 * Never throws, and never tokenises the same content twice — see `tokenCache`.
 *
 * Note the trailing-newline shape inherited from the slicer: a file ending in
 * "\n" has a final, empty entry, because that is what `split("\n")` says. Index
 * this by the line numbers the hunk headers give you; do not walk it.
 */
export async function highlightFileTokens(
  content: string,
  path: string,
): Promise<StyledToken[][] | null> {
  if (!canHighlightPath(path) || content.length > MAX_HIGHLIGHT_CHARS) return null;

  const key = `${path} ${content.length} ${hashContent(content)}`;
  const cached = tokenCache.get(key);
  if (cached) {
    // Re-insert so the most recently used entry is the last one out.
    tokenCache.delete(key);
    tokenCache.set(key, cached);
    return cached;
  }

  const work = tokenizeLines(content, langFromPath(path))
    .then((tokenLines) =>
      tokenLines ? sliceTokenLinesToTokens(tokenLines, content.split("\n").length) : null,
    )
    // tokenizeLines already swallows its own failures; this is here so a
    // rejection it grows later degrades to "no colouring" instead of becoming
    // an unhandled rejection cached for every subsequent caller.
    .catch(() => null);
  tokenCache.set(key, work);
  if (tokenCache.size > CACHE_LIMIT) {
    const oldest = tokenCache.keys().next();
    if (!oldest.done) tokenCache.delete(oldest.value);
  }
  return work;
}
