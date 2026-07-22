import type { ReactNode } from "react";

/** A half-open `[start, end)` index pair into the string it was computed from. */
type Range = readonly [start: number, end: number];

const MARK_CLASS = "rounded-[2px] bg-warn-bg text-warn";

/**
 * Case-insensitive occurrences of `needle` in `text`, as `[start, end)` pairs.
 *
 * Occurrences are **non-overlapping**: the scan resumes *after* each hit, so
 * `"aaa"` against `"aa"` yields one range, not two.
 *
 * `needle` must already be lower-cased; the exported entry points do that.
 */
function matchRanges(text: string, needle: string): Range[] {
  const haystack = text.toLowerCase();
  const ranges: Range[] = [];
  let cursor = 0;
  for (;;) {
    const hit = haystack.indexOf(needle, cursor);
    if (hit === -1) return ranges;
    ranges.push([hit, hit + needle.length]);
    cursor = hit + needle.length;
  }
}

/** Sorted, non-overlapping union of several range lists. */
function mergeRanges(lists: Range[][]): Range[] {
  const flat = lists.flat().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const [start, end] of flat) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/**
 * Render `text.slice(start, end)`, wrapping in `<mark>` whatever part of it the
 * given (absolute, over the whole `text`) ranges cover. Ranges that fall wholly
 * outside the window contribute nothing; one that straddles its edge is clipped
 * to it.
 */
function renderWindow(text: string, ranges: Range[], start: number, end: number): ReactNode {
  const parts: ReactNode[] = [];
  let cursor = start;
  let key = 0;
  for (const [from, to] of ranges) {
    const low = Math.max(from, start);
    const high = Math.min(to, end);
    if (high <= low) continue;
    if (low > cursor) parts.push(text.slice(cursor, low));
    parts.push(
      <mark key={key++} className={MARK_CLASS}>
        {text.slice(low, high)}
      </mark>,
    );
    cursor = high;
  }
  if (cursor < end) parts.push(text.slice(cursor, end));
  return parts;
}

/**
 * Wraps every occurrence of `query` inside `text` in a `<mark>`, leaving the
 * text itself byte-for-byte intact — the query is a probe, not a replacement,
 * so `markMatches("src/Sub", "s")` marks both the lowercase and the uppercase
 * `s` and still reads as `src/Sub`.
 *
 * Matching is case-insensitive substring, which is what the reference
 * implementation does (`text-util.js` `highlightMatches`). Occurrences are
 * non-overlapping (see `matchRanges`). `query` is expected to arrive already
 * normalised (trimmed, lower-cased) by whoever owns the filter state; it is
 * normalised again here so a caller that forgets can't silently produce a
 * filtered list with nothing marked in it.
 *
 * Colour goes through `--warning` / `--warning-bg` rather than the accent: the
 * accent background is what an *active* row is painted with, and a mark that
 * matched the accent would vanish on exactly the row the user is looking at.
 * A bare `<mark>` is not an option — the UA sheet paints it yellow-on-black,
 * which belongs to none of the seven palettes (and is unreadable on `paper`).
 *
 * Use this only where the marked text *is* the text that was matched. Rows that
 * show a slice of a path they were filtered by want `markPathWindow`.
 */
export function markMatches(text: string, query: string): ReactNode {
  const needle = query.trim().toLowerCase();
  if (!needle) return text;
  return renderWindow(text, matchRanges(text, needle), 0, text.length);
}

/**
 * Mark a row that displays only *part* of the path it was filtered by.
 *
 * The Status filter matches on the whole path, but no row draws a whole path: a
 * directory row draws one segment, a leaf row draws the basename. Marking each
 * of those fragments against the query independently silently loses every query
 * containing a `/` — `/` only ever occurs at a segment boundary, so `src/giz`
 * matches the path, narrows the list, and then finds nothing to mark in any
 * fragment. So matching is computed against the full path and the resulting
 * ranges are projected onto the window `[start, end)` that this row draws.
 *
 * `paths` is every full path the row stands for — one for a leaf, all of its
 * descendants for a directory row (they agree character-for-character over the
 * directory's own window, but not necessarily on which matches reach into it,
 * so the ranges are unioned rather than taken from an arbitrary one). Text
 * comes from the first entry.
 */
export function markPathWindow(
  paths: readonly string[],
  query: string,
  start: number,
  end: number,
): ReactNode {
  const text = paths[0] ?? "";
  const needle = query.trim().toLowerCase();
  if (!needle) return text.slice(start, end);
  return renderWindow(text, mergeRanges(paths.map((p) => matchRanges(p, needle))), start, end);
}
