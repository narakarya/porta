import { useEffect, useRef, useState } from "react";
import type { App } from "../../../types";
import {
  gitDiffFile,
  gitApplyHunk,
  gitDiscardHunk,
  gitFilePreview,
  type GitFilePreview,
} from "../../../lib/commands";
import { parseUnifiedDiff, hunkToPatch, type DiffLine, type Hunk, type ParsedDiff } from "../../../lib/git-diff";
import { tokenDiff, type Span } from "../../../lib/word-diff";
import { Spinner } from "../../ui";
import SplitHunk from "./SplitHunk";

function previewTable(preview: GitFilePreview) {
  const separator = preview.kind === "tsv" ? "\t" : ",";
  const rows = preview.data
    .split(/\r?\n/)
    .filter((line) => line !== "")
    .slice(0, 200)
    .map((line) => line.split(separator));
  return (
    <div className="overflow-auto p-3 font-sans">
      <table className="min-w-full border-collapse text-[11px]">
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex} className={rowIndex === 0 ? "bg-surface-1 text-ink" : "text-ink-2"}>
              {row.map((cell, cellIndex) => {
                const Cell = rowIndex === 0 ? "th" : "td";
                return (
                  <Cell
                    key={cellIndex}
                    className="max-w-[320px] truncate border border-subtle px-2 py-1 text-left font-normal"
                    title={cell}
                  >
                    {cell}
                  </Cell>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PreviewSurface({ preview, path }: { preview: GitFilePreview; path: string }) {
  if (preview.kind === "image") {
    return (
      <div className="flex min-h-full items-center justify-center bg-[linear-gradient(45deg,var(--color-surface-1)_25%,transparent_25%),linear-gradient(-45deg,var(--color-surface-1)_25%,transparent_25%),linear-gradient(45deg,transparent_75%,var(--color-surface-1)_75%),linear-gradient(-45deg,transparent_75%,var(--color-surface-1)_75%)] bg-[length:20px_20px] p-5">
        <img
          src={`data:${preview.mime};base64,${preview.data}`}
          alt={path}
          className="max-h-[70vh] max-w-full rounded-control object-contain shadow-xl"
        />
      </div>
    );
  }
  if (preview.kind === "html") {
    const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">`;
    return (
      <iframe
        title={`Preview ${path}`}
        sandbox=""
        srcDoc={`${policy}${preview.data}`}
        className="h-full min-h-[360px] w-full border-0 bg-white"
      />
    );
  }
  if (preview.kind === "csv" || preview.kind === "tsv") return previewTable(preview);
  return (
    <div className="mx-auto max-w-4xl p-5 font-sans text-[13px] leading-relaxed text-ink-2">
      {preview.data.split(/\r?\n/).map((line, index) => {
        if (line.startsWith("### ")) return <h3 key={index} className="mb-1 mt-4 text-[14px] font-semibold text-ink">{line.slice(4)}</h3>;
        if (line.startsWith("## ")) return <h2 key={index} className="mb-1 mt-5 text-[16px] font-semibold text-ink">{line.slice(3)}</h2>;
        if (line.startsWith("# ")) return <h1 key={index} className="mb-2 mt-2 text-[20px] font-semibold text-ink">{line.slice(2)}</h1>;
        if (line.startsWith("- ") || line.startsWith("* ")) return <div key={index} className="pl-3">• {line.slice(2)}</div>;
        return <div key={index} className={line === "" ? "h-3" : "whitespace-pre-wrap"}>{line}</div>;
      })}
    </div>
  );
}

function lineClass(kind: DiffLine["kind"]): string {
  if (kind === "add") return "bg-ok-bg text-ok";
  if (kind === "del") return "bg-bad-bg text-bad";
  if (kind === "meta") return "text-ink-3";
  return "text-ink-2";
}

// Stronger background for the word-diff's changed run within a paired
// del/add line — same "dim vs strong" contrast SplitHunk uses. Dark text on
// the bright bg-ok/bg-bad (white-on-mint is ~1.9 contrast — too low).
function strongLineClass(kind: "add" | "del"): string {
  return kind === "add" ? "bg-ok text-surface-0" : "bg-bad text-surface-0";
}

/** Maps each `del`/`add` line index to its 1:1 counterpart's index, for
 *  word-level highlighting. Consecutive del-run then add-run lines are
 *  paired by position (del[i] ↔ add[i]); a run-length mismatch leaves the
 *  extra lines on the longer side unpaired (they keep the whole-line
 *  background). Mirrors SplitHunk's `buildSplitRows` pairing, just indexed
 *  into the flat unified line list instead of building rows. */
function computeLinePairs(hunk: Hunk): Map<number, number> {
  const pairs = new Map<number, number>();
  let dels: number[] = [];
  let adds: number[] = [];
  function flush() {
    const n = Math.min(dels.length, adds.length);
    for (let i = 0; i < n; i++) {
      pairs.set(dels[i], adds[i]);
      pairs.set(adds[i], dels[i]);
    }
    dels = [];
    adds = [];
  }
  hunk.lines.forEach((line, idx) => {
    if (line.kind === "del") dels.push(idx);
    else if (line.kind === "add") adds.push(idx);
    else flush();
  });
  flush();
  return pairs;
}

/** Runs `tokenDiff` once per paired del/add line and returns each line
 *  index's spans (del → `.old`, add → `.new`) keyed by that line's own
 *  index — computed once here rather than per-render-cell so a pair isn't
 *  diffed twice. */
function computeLineSpans(hunk: Hunk, linePairs: Map<number, number>): Map<number, Span[]> {
  const spans = new Map<number, Span[]>();
  linePairs.forEach((partnerIdx, li) => {
    if (spans.has(li)) return;
    const a = hunk.lines[li];
    const delIdx = a.kind === "del" ? li : partnerIdx;
    const addIdx = a.kind === "del" ? partnerIdx : li;
    const diff = tokenDiff(hunk.lines[delIdx].text.slice(1), hunk.lines[addIdx].text.slice(1));
    spans.set(delIdx, diff.old);
    spans.set(addIdx, diff.new);
  });
  return spans;
}

const GUTTER_NUM_CLASS = "w-9 shrink-0 pr-1.5 text-right select-none text-ink-3 tabular-nums";

/** Walks a hunk's lines from `oldStart`/`newStart`, returning the old/new
 *  line number to show for each — `ctx` advances (and shows) both, `del`
 *  only the old side, `add` only the new side, `meta` neither. */
function hunkLineNumbers(hunk: Hunk): { old: number | null; new: number | null }[] {
  let o = hunk.oldStart;
  let n = hunk.newStart;
  return hunk.lines.map((line) => {
    if (line.kind === "ctx") {
      const nums = { old: o, new: n };
      o++; n++;
      return nums;
    }
    if (line.kind === "del") {
      const nums = { old: o, new: null };
      o++;
      return nums;
    }
    if (line.kind === "add") {
      const nums = { old: null, new: n };
      n++;
      return nums;
    }
    return { old: null, new: null }; // meta — no line-number reality on either side
  });
}

/**
 * Per-hunk diff viewer for the Changes pane — parses `gitDiffFile`'s raw
 * unified diff via `parseUnifiedDiff` and gives every hunk its own
 * Stage/Unstage button, rebuilding a minimal patch with `hunkToPatch` and
 * applying it to the index via `gitApplyHunk` (`reverse = staged`).
 */
export default function DiffView({
  app,
  path,
  staged,
  onChanged,
}: {
  app: App;
  path: string;
  staged: boolean;
  onChanged: () => void;
}) {
  const [parsed, setParsed] = useState<ParsedDiff | null>(null);
  // Raw fetched diff text — a binary-file diff ("Binary files a/x and b/x
  // differ") or a mode-only change produces no `@@` hunks but IS a real,
  // non-empty diff; gating "No changes." on this (rather than
  // `parsed.hunks.length`) keeps those cases from reading as no diff at all.
  const [rawDiff, setRawDiff] = useState("");
  const [preview, setPreview] = useState<GitFilePreview | null>(null);
  const [surface, setSurface] = useState<"diff" | "preview">("diff");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState<number | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [view, setView] = useState<"unified" | "split">("unified");
  // Inline "Discard?" confirm, mirroring StashPanel's Drop confirm — Tauri
  // webview can't rely on window.confirm. Keyed by hunk index.
  const [confirmDiscard, setConfirmDiscard] = useState<number | null>(null);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!app.root_dir || path === "") { setParsed(null); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      gitDiffFile(app.root_dir, path, staged),
      gitFilePreview(app.root_dir, path).catch(() => null),
    ])
      .then(([raw, nextPreview]) => {
        if (cancelled) return;
        setRawDiff(raw);
        setParsed(parseUnifiedDiff(raw));
        setPreview(nextPreview);
        setSurface(nextPreview?.kind === "image" ? "preview" : "diff");
      })
      .catch((e) => { if (!cancelled) setError(String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [app.root_dir, path, staged, refreshKey]);

  async function applyHunk(hunk: Hunk, index: number) {
    if (!parsed) return;
    setApplying(index);
    setError(null);
    try {
      const patch = hunkToPatch(parsed.fileHeader, hunk);
      await gitApplyHunk(app.root_dir, patch, staged);
      if (!mounted.current) return;
      onChanged();
      setRefreshKey(k => k + 1);
    } catch (e) {
      if (mounted.current) setError(String(e));
    } finally {
      if (mounted.current) setApplying(null);
    }
  }

  async function discardHunk(hunk: Hunk, index: number) {
    if (!parsed) return;
    setApplying(index);
    setError(null);
    try {
      const patch = hunkToPatch(parsed.fileHeader, hunk);
      await gitDiscardHunk(app.root_dir, patch);
      if (!mounted.current) return;
      onChanged();
      setRefreshKey(k => k + 1);
    } catch (e) {
      if (mounted.current) setError(String(e));
    } finally {
      if (mounted.current) {
        setApplying(null);
        setConfirmDiscard(null);
      }
    }
  }

  if (loading) return <div className="text-ink-3">Loading diff…</div>;
  if (error) return <div className="text-bad whitespace-pre-wrap break-words">{error}</div>;
  if (preview && surface === "preview") {
    return (
      <div className="flex h-full min-h-[280px] flex-col font-sans">
        <div className="flex shrink-0 items-center gap-2 border-b border-subtle bg-surface-1 px-2.5 py-1.5">
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink">{path}</span>
          {preview.truncated && <span className="text-[10px] text-warn">Preview limited to 512 KB</span>}
          {staged && <span className="text-[10px] text-ink-3">working tree preview</span>}
          <div className="flex overflow-hidden rounded-control border border-strong text-[10px]">
            <button onClick={() => setSurface("preview")} className="bg-accent-bg px-2 py-0.5 text-ink">Preview</button>
            <button onClick={() => setSurface("diff")} className="px-2 py-0.5 text-ink-3 hover:text-ink">Diff</button>
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-auto">
          <PreviewSurface preview={preview} path={path} />
        </div>
      </div>
    );
  }
  // Only a truly empty fetched diff means "no changes" — a binary file or a
  // mode-only change comes back non-empty but with zero `@@` hunks.
  if (!parsed || rawDiff.trim() === "") {
    return (
      <div className="flex items-center justify-between gap-2 text-ink-3">
        <span>No changes.</span>
        {preview && (
          <button onClick={() => setSurface("preview")} className="rounded-control border border-strong px-2 py-0.5 font-sans text-[11px] text-ink-2">
            Preview
          </button>
        )}
      </div>
    );
  }
  if (parsed.hunks.length === 0) {
    return (
      <div className="overflow-x-auto">
        {parsed.fileHeader.map((line, i) => (
          <div key={`h${i}`} className="whitespace-pre text-ink-3">
            {line === "" ? " " : line}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          {parsed.fileHeader.map((line, i) => (
            <div key={`h${i}`} className="whitespace-pre text-ink-3">
              {line === "" ? " " : line}
            </div>
          ))}
        </div>
        <div className="shrink-0 flex rounded-control border border-strong overflow-hidden font-sans text-[11px]">
          {preview && (
            <button
              onClick={() => setSurface("preview")}
              className="border-r border-strong px-2 py-0.5 text-ink-2 hover:bg-white/[0.05]"
            >
              Preview
            </button>
          )}
          <button
            onClick={() => setView("unified")}
            className={`px-2 py-0.5 transition-colors duration-fast ${
              view === "unified" ? "bg-accent-bg text-ink" : "text-ink-2 hover:bg-white/[0.05]"
            }`}
          >
            Unified
          </button>
          <button
            onClick={() => setView("split")}
            className={`px-2 py-0.5 transition-colors duration-fast ${
              view === "split" ? "bg-accent-bg text-ink" : "text-ink-2 hover:bg-white/[0.05]"
            }`}
          >
            Split
          </button>
        </div>
      </div>
      {parsed.hunks.map((hunk, hi) => {
        const confirming = confirmDiscard === hi;
        const nums = hunkLineNumbers(hunk);
        const lineSpans = computeLineSpans(hunk, computeLinePairs(hunk));
        return (
        <div key={hi} className="mt-2 first:mt-0">
          <div className="flex items-center justify-between gap-2 whitespace-pre text-accent">
            <span>{hunk.header}</span>
            {confirming ? (
              <div className="shrink-0 flex items-center gap-1.5 font-sans">
                <span className="text-[11px] text-bad">Discard?</span>
                <button
                  onClick={() => discardHunk(hunk, hi)}
                  disabled={applying !== null}
                  className="text-[11px] font-medium text-bad hover:brightness-125 disabled:opacity-40 disabled:pointer-events-none transition-colors duration-fast"
                >
                  {applying === hi ? <Spinner size={11} /> : "Confirm"}
                </button>
                <button
                  onClick={() => setConfirmDiscard(null)}
                  disabled={applying !== null}
                  className="text-[11px] text-ink-3 hover:text-ink-2 disabled:opacity-40 disabled:pointer-events-none transition-colors duration-fast"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <div className="shrink-0 flex items-center gap-1.5 font-sans">
                {!staged && (
                  <button
                    onClick={() => setConfirmDiscard(hi)}
                    disabled={applying !== null}
                    className="text-[11px] text-bad border border-strong rounded-control px-2 py-0.5 hover:bg-white/[0.05] disabled:opacity-40 disabled:pointer-events-none transition-colors duration-fast"
                  >
                    Discard hunk
                  </button>
                )}
                <button
                  onClick={() => applyHunk(hunk, hi)}
                  disabled={applying !== null}
                  className="text-[11px] text-ink-2 border border-strong rounded-control px-2 py-0.5 hover:bg-white/[0.05] disabled:opacity-40 disabled:pointer-events-none transition-colors duration-fast"
                >
                  {applying === hi ? <Spinner size={11} /> : staged ? "Unstage hunk" : "Stage hunk"}
                </button>
              </div>
            )}
          </div>
          {view === "unified" ? (
            hunk.lines.map((line, li) => {
              const spans = line.kind === "del" || line.kind === "add" ? lineSpans.get(li) : undefined;
              return (
                <div key={li} className="flex">
                  <span className={GUTTER_NUM_CLASS}>{nums[li].old ?? ""}</span>
                  <span className={GUTTER_NUM_CLASS}>{nums[li].new ?? ""}</span>
                  <span className={`whitespace-pre flex-1 ${lineClass(line.kind)}`}>
                    {line.text === "" ? " " : spans ? (
                      <>
                        {line.text.charAt(0)}
                        {spans.map((s, si) => (
                          <span
                            key={si}
                            className={s.changed ? strongLineClass(line.kind as "add" | "del") : undefined}
                          >
                            {s.text}
                          </span>
                        ))}
                      </>
                    ) : line.text}
                  </span>
                </div>
              );
            })
          ) : (
            <SplitHunk hunk={hunk} />
          )}
        </div>
        );
      })}
    </div>
  );
}
