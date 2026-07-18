/**
 * Pure word/token-level diff for a single old/new line pair. Used by
 * DiffView (unified) and SplitHunk (split) to highlight only the changed
 * run(s) inside a del/add pair, instead of coloring the whole line.
 *
 * Tokenizes on word-vs-non-word runs (`\w+` / `\W+`), which — unlike
 * splitting on whitespace alone — also isolates punctuation as its own
 * token so "foo," vs "foo;" highlights just the trailing punctuation. Every
 * character of the input belongs to exactly one token (the two
 * alternatives partition all of Unicode by `\w`), so the tokens
 * reconstruct the original string exactly.
 */

export type Span = { text: string; changed: boolean };

const TOKEN_RE = /\w+|\W+/g;

function tokenize(text: string): string[] {
  return text.match(TOKEN_RE) ?? [];
}

/** Merges adjacent tokens sharing the same `changed` flag into one Span. */
function toSpans(tokens: string[], changed: boolean[]): Span[] {
  const spans: Span[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const last = spans[spans.length - 1];
    if (last && last.changed === changed[i]) {
      last.text += tokens[i];
    } else {
      spans.push({ text: tokens[i], changed: changed[i] });
    }
  }
  return spans;
}

/**
 * Token-level diff of two strings. Returns spans for each side; tokens in
 * the longest common subsequence are `changed:false`, everything else is
 * `changed:true`. Concatenating a side's spans' text reproduces that side's
 * original string exactly.
 *
 * O(n·m) LCS over tokens (n/m = token counts) — fine for single diff lines.
 */
export function tokenDiff(oldText: string, newText: string): { old: Span[]; new: Span[] } {
  const oldTokens = tokenize(oldText);
  const newTokens = tokenize(newText);
  const n = oldTokens.length;
  const m = newTokens.length;

  // dp[i][j] = LCS length of oldTokens[i:] and newTokens[j:].
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = oldTokens[i] === newTokens[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const oldChanged = new Array<boolean>(n).fill(true);
  const newChanged = new Array<boolean>(m).fill(true);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldTokens[i] === newTokens[j] && dp[i][j] === dp[i + 1][j + 1] + 1) {
      oldChanged[i] = false;
      newChanged[j] = false;
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }

  return {
    old: toSpans(oldTokens, oldChanged),
    new: toSpans(newTokens, newChanged),
  };
}
