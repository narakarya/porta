// Text filter for the log viewer — the "only show me lines about X" pass, as
// opposed to Find, which leaves every line on screen and just walks the hits.
//
// Syntax (always case-insensitive — log text is not typed consistently enough
// for a case toggle to be worth the button):
//
//   foo bar        every term must appear          (AND)
//   "foo bar"      quoted phrase, spaces included
//   -foo           drop anything containing foo
//   -"foo bar"     drop anything containing the phrase
//
// A query is parsed once per debounced keystroke; matching then runs against a
// lower-cased copy of each line computed once at ingest. So a pass over a full
// 10k-line buffer is N substring scans with zero allocation — no per-pass
// `toLowerCase()`, which is what made the old search pass allocate a fresh copy
// of the entire buffer on every keystroke.

export interface ParsedFilter {
  /** Terms that must all be present. Pre-lowercased. */
  include: string[];
  /** Terms that must all be absent. Pre-lowercased. */
  exclude: string[];
}

// A quoted run (optionally negated) or a bare whitespace-delimited token.
const TOKEN_RE = /-?"[^"]*"|\S+/g;
// Strip quotes only at the edges: `"foo` is an unterminated phrase and should
// filter on `foo`, but `foo"bar` is a literal the user typed and stays whole.
const EDGE_QUOTE_RE = /^"|"$/g;

/** Parse a raw query. Returns null when it carries no usable term. */
export function parseFilter(query: string): ParsedFilter | null {
  const include: string[] = [];
  const exclude: string[] = [];
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(query)) !== null) {
    let tok = m[0];
    // A lone "-" is someone mid-typing `-foo`, not a request for every line
    // containing a hyphen — which is what treating it as a term would do, one
    // keystroke before they finish.
    if (tok === "-") continue;
    const negated = tok.startsWith("-");
    if (negated) tok = tok.slice(1);
    tok = tok.replace(EDGE_QUOTE_RE, "").toLowerCase();
    if (!tok) continue;
    (negated ? exclude : include).push(tok);
  }
  if (include.length === 0 && exclude.length === 0) return null;
  return { include, exclude };
}

/** Does a single lower-cased line satisfy the filter? */
export function matchesFilter(lower: string, f: ParsedFilter): boolean {
  for (let i = 0; i < f.exclude.length; i++) {
    if (lower.includes(f.exclude[i])) return false;
  }
  for (let i = 0; i < f.include.length; i++) {
    if (!lower.includes(f.include[i])) return false;
  }
  return true;
}

/**
 * Does a whole entry — a leveled header plus its continuation lines (an Ecto
 * SQL body, a `↳` caller, a stacktrace) — satisfy the filter?
 *
 * Terms are matched across the entry rather than per line, because the parts of
 * an entry that carry the level and the parts that carry the detail are usually
 * different lines: filtering `error timeout` should keep an `[error]` header
 * whose stacktrace is where "timeout" actually appears. Exclusion is likewise
 * entry-wide — hiding a header while leaving its orphaned body on screen is
 * never what "don't show me this" meant.
 *
 * Operates on a slice of the buffer by index so no subarray is allocated.
 */
export function blockMatchesFilter(
  lines: readonly { lower: string }[],
  start: number,
  end: number,
  f: ParsedFilter,
): boolean {
  for (let i = start; i < end; i++) {
    const lower = lines[i].lower;
    for (let e = 0; e < f.exclude.length; e++) {
      if (lower.includes(f.exclude[e])) return false;
    }
  }
  for (let t = 0; t < f.include.length; t++) {
    const term = f.include[t];
    let found = false;
    for (let i = start; i < end; i++) {
      if (lines[i].lower.includes(term)) {
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

const RE_ESCAPE = /[.*+?^${}()|[\]\\]/g;

/**
 * One alternation regex covering every term, built once per query so the
 * per-row highlighter is a plain `split()` and the memoized row component sees
 * a stable prop identity across renders.
 */
export function buildHighlightRegex(terms: readonly string[]): RegExp | null {
  const parts = terms.filter((t) => t.length > 0).map((t) => t.replace(RE_ESCAPE, "\\$&"));
  if (parts.length === 0) return null;
  // Longest first: alternation is first-match-wins, so an unsorted `foo|foobar`
  // would only ever mark the `foo` prefix of a `foobar` hit.
  parts.sort((a, b) => b.length - a.length);
  return new RegExp(`(${parts.join("|")})`, "gi");
}
