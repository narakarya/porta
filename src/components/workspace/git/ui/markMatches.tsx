import type { ReactNode } from "react";

/**
 * Wraps every occurrence of `query` inside `text` in a `<mark>`, leaving the
 * text itself byte-for-byte intact — the query is a probe, not a replacement,
 * so `markMatches("src/Sub", "s")` marks both the lowercase and the uppercase
 * `s` and still reads as `src/Sub`.
 *
 * Matching is case-insensitive substring, which is what the reference
 * implementation does (`text-util.js` `highlightMatches`). `query` is expected
 * to arrive already normalised (trimmed, lower-cased) by whoever owns the
 * filter state; it is normalised again here so a caller that forgets can't
 * silently produce a filtered list with nothing marked in it.
 *
 * Colour goes through `--warning` / `--warning-bg` rather than the accent: the
 * accent background is what an *active* row is painted with, and a mark that
 * matched the accent would vanish on exactly the row the user is looking at.
 * A bare `<mark>` is not an option — the UA sheet paints it yellow-on-black,
 * which belongs to none of the seven palettes (and is unreadable on `paper`).
 */
export function markMatches(text: string, query: string): ReactNode {
  const needle = query.trim().toLowerCase();
  if (!needle) return text;

  const haystack = text.toLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  let key = 0;

  for (;;) {
    const hit = haystack.indexOf(needle, cursor);
    if (hit === -1) {
      if (cursor < text.length) parts.push(text.slice(cursor));
      break;
    }
    if (hit > cursor) parts.push(text.slice(cursor, hit));
    parts.push(
      <mark key={key++} className="rounded-[2px] bg-warn-bg text-warn">
        {text.slice(hit, hit + needle.length)}
      </mark>,
    );
    cursor = hit + needle.length;
  }

  return parts;
}
