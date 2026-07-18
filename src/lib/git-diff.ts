/**
 * Pure unified-diff parser + per-hunk patch reconstruction for `DiffView`'s
 * per-hunk staging. No React, no IO — `gitDiffFile`'s raw output goes in,
 * a `ParsedDiff` comes out; `hunkToPatch` turns one hunk back into a
 * minimal patch that `git apply --cached [--reverse]` accepts.
 */

export type DiffLine = { kind: "ctx" | "add" | "del" | "meta"; text: string };

export type Hunk = {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
};

export type ParsedDiff = { fileHeader: string[]; hunks: Hunk[] };

// `@@ -a[,b] +c[,d] @@[ tail]` — b/d default to 1 when the `,n` is omitted.
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parses a raw unified diff (as returned by `gitDiffFile`) into a file
 *  header (everything before the first `@@`) plus its hunks. */
export function parseUnifiedDiff(raw: string): ParsedDiff {
  // A trailing "\n" produces a spurious empty final element on split; drop
  // it so it isn't mistaken for a blank context line.
  const body = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  const lines = body === "" ? [] : body.split("\n");

  const fileHeader: string[] = [];
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  let i = 0;

  for (; i < lines.length; i++) {
    if (lines[i].startsWith("@@")) break;
    fileHeader.push(lines[i]);
  }

  for (; i < lines.length; i++) {
    const line = lines[i];
    const m = HUNK_HEADER_RE.exec(line);
    if (m) {
      current = {
        header: line,
        oldStart: Number(m[1]),
        oldLines: m[2] !== undefined ? Number(m[2]) : 1,
        newStart: Number(m[3]),
        newLines: m[4] !== undefined ? Number(m[4]) : 1,
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (!current) continue; // stray line before any `@@` — shouldn't happen

    const c = line.charAt(0);
    const kind: DiffLine["kind"] =
      c === "\\" ? "meta" : c === "+" ? "add" : c === "-" ? "del" : "ctx";
    current.lines.push({ kind, text: line });
  }

  return { fileHeader, hunks };
}

/** Rebuilds a minimal single-hunk patch from a parsed file header + one of
 *  its hunks — just the `--- `/`+++ ` lines, the hunk's `@@` header, and its
 *  lines verbatim (each already carries its leading ` `/`+`/`-`). Suitable
 *  for `git apply --cached` (and `--reverse` to unstage). */
export function hunkToPatch(fileHeader: string[], hunk: Hunk): string {
  const headerLines = fileHeader.filter(
    (l) => l.startsWith("--- ") || l.startsWith("+++ "),
  );
  const bodyLines = hunk.lines.map((l) => l.text);
  return [...headerLines, hunk.header, ...bodyLines].join("\n") + "\n";
}
