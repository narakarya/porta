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
import { renderPreview, langFromPath } from "../../../lib/preview";
import { usePortaStore } from "../../../store";
import { Spinner } from "../../ui";
import MermaidControls from "./MermaidControls";
import SplitHunk from "./SplitHunk";
import { useActivePane } from "./ui/ActivePane";

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

/** The one light palette among the seven declared in src/styles/git-theme.css.
 *  Mermaid picks its diagram colours from a dark/light boolean of its own
 *  rather than from the tab's tokens (see `MermaidOptions`), so this is the one
 *  place the palette id has to be reduced to that boolean. A new light palette
 *  must be added here too, or its diagrams come out dark on a light surface. */
const LIGHT_GIT_THEMES: ReadonlySet<string> = new Set(["paper"]);

/**
 * The rendered-markdown surface: markdown-it → Mermaid → Shiki, composed by
 * `renderPreview`, which writes into a DOM node imperatively.
 *
 * React and that imperative API are reconciled by handing the module a node
 * React will never look inside: the JSX below declares no children, so
 * reconciliation has nothing to diff there and can never paint over what the
 * module wrote. The effect is the only writer, and it is scoped to one node it
 * captures up front — so a render can't outlive its target either.
 *
 * `md-body` is load-bearing, not decoration. Every rule in
 * src/styles/git-preview.css is scoped `.git-tab-root .md-body …`; without the
 * class the preview still renders correctly and is completely unstyled, and no
 * assertion about the markup would notice.
 */
function MarkdownPreview({ source }: { source: string }) {
  const dark = !LIGHT_GIT_THEMES.has(usePortaStore((s) => s.gitTheme));
  const hostRef = useRef<HTMLDivElement>(null);

  // Keyed on the source (and the palette, which Mermaid bakes into the diagram
  // it emits), not on the preview object: a refetch that returns identical
  // content leaves this alone entirely, so the pane never blanks and never
  // re-runs Shiki and Mermaid for a result it already has on screen.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const controller = new AbortController();
    // renderPreview stops writing as soon as it observes the signal but does
    // not roll back what it already committed, so a caller that wants a clean
    // slate resets the target itself — otherwise an abandoned render's
    // half-finished output would sit under the next file's.
    host.replaceChildren();
    // Never rejects (documented on renderPreview): a bad diagram becomes an
    // error node, an unsupported fence becomes escaped text.
    void renderPreview(host, source, { dark }, controller.signal);
    // Aborts on unmount and before every re-run, so an earlier file's pending
    // Shiki/Mermaid work can never write into the node the later one owns.
    return () => controller.abort();
  }, [source, dark]);

  // The wrapper is MermaidControls' own; the `md-body` node below is untouched
  // by it, class and all — every rule in src/styles/git-preview.css hangs off
  // that class, and the controls are a sibling of the rendered document rather
  // than anything inside it.
  return (
    <MermaidControls>
      <div ref={hostRef} className="md-body mx-auto max-w-4xl p-5" />
    </MermaidControls>
  );
}

/**
 * Wraps a whole source file as a single markdown fence, so the `code` kind
 * reaches the screen through the same markdown → mermaid → Shiki pipeline the
 * `markdown` kind uses instead of a second, parallel rendering path. The
 * language is `langFromPath`'s — the backend sends contents and no language,
 * and that map is the module's own; duplicating it here is how the two would
 * drift.
 *
 * The fence is opened with one more backtick than the longest run anywhere in
 * the file. A source file that contains ``` (a README-ish comment, a heredoc,
 * this very repo's markdown fixtures) would otherwise close its own block
 * partway down and have its remainder parsed as markdown.
 *
 * The closing fence needs a newline before it, but almost every file already
 * ends with one — adding a second unconditionally would put a phantom blank
 * line at the bottom of every preview.
 */
function codeAsMarkdown(source: string, path: string): string {
  const longestRun = Math.max(0, ...Array.from(source.matchAll(/`+/g), (m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  const body = source.endsWith("\n") ? source : `${source}\n`;
  return `${fence}${langFromPath(path)}\n${body}${fence}`;
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
  if (preview.kind === "code") return <MarkdownPreview source={codeAsMarkdown(preview.data, path)} />;
  if (preview.kind === "markdown") return <MarkdownPreview source={preview.data} />;
  // Exhaustive by construction: `preview.kind` has narrowed to `never`, so a
  // kind added to GitFilePreview without a branch above fails to compile here
  // rather than silently falling through to whichever branch happened to be
  // last. Not a throw — that would take the whole pane down at runtime if a
  // backend ever sent a kind this build doesn't know; showing the bytes as
  // text is the honest degradation.
  const unhandled: never = preview.kind;
  void unhandled;
  return <MarkdownPreview source={codeAsMarkdown(preview.data, path)} />;
}

/** Corner affordance for a refetch that has previous content still on
 *  screen — deliberately small and `pointer-events-none` so it never steals a
 *  click from the diff underneath it. */
function RefetchIndicator() {
  return (
    <div className="pointer-events-none absolute right-1.5 top-1.5 z-10">
      <Spinner size={11} className="text-ink-3" />
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
  const active = useActivePane();

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // Set once this mounted instance's first fetch has landed. `path` is keyed
  // by the caller (StatusTab), so a new file is always a fresh instance and
  // this starts over at `false` — but a stage/unstage flip on the *same*
  // file reuses this instance, and must not look like a first load.
  const hasLoadedOnce = useRef(false);

  // Idle while the pane is hidden: the Status tab stays mounted behind another
  // tab, and re-reading a diff (plus its file preview) for a surface nobody can
  // see is pure background work. `active` is a dependency, so the diff is
  // re-read the moment the pane comes back rather than being served stale.
  useEffect(() => {
    if (!active) return;
    if (!app.root_dir || path === "") { setParsed(null); return; }
    let cancelled = false;
    const isFirstLoad = !hasLoadedOnce.current;
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
        // Only auto-pick a surface on this instance's first load. A later
        // refetch — staged flipping, a hunk stage/unstage, or the pane coming
        // back into view — must not knock the user off the Preview/Diff
        // surface they'd already chosen.
        if (isFirstLoad) setSurface(nextPreview?.kind === "image" ? "preview" : "diff");
        hasLoadedOnce.current = true;
      })
      .catch((e) => { if (!cancelled) setError(String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [active, app.root_dir, path, staged, refreshKey]);

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

  // Blank the pane only on this instance's genuine first load — `parsed` is
  // still null then because nothing has ever landed. A later refetch on the
  // same instance (staged flip, hunk stage/unstage, the pane regaining focus)
  // sets `loading` back to true too, but `parsed`/`rawDiff`/`preview` still
  // hold the last successful fetch: keep rendering those so the container
  // one level up (StatusTab) never sees its content collapse to a single
  // line and back, which is what was resetting the user's scroll position.
  if (loading && parsed === null) return <div className="text-ink-3">Loading diff…</div>;
  if (error) return <div className="text-bad whitespace-pre-wrap break-words">{error}</div>;
  if (preview && surface === "preview") {
    return (
      <div className="relative flex h-full min-h-[280px] flex-col font-sans">
        {loading && <RefetchIndicator />}
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
      <div className="relative flex items-center justify-between gap-2 text-ink-3">
        {loading && <RefetchIndicator />}
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
      <div className="relative overflow-x-auto">
        {loading && <RefetchIndicator />}
        {parsed.fileHeader.map((line, i) => (
          <div key={`h${i}`} className="whitespace-pre text-ink-3">
            {line === "" ? " " : line}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="relative overflow-x-auto">
      {loading && <RefetchIndicator />}
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
              className="border-r border-strong px-2 py-0.5 text-ink-2 hover:bg-[var(--hover)]"
            >
              Preview
            </button>
          )}
          <button
            onClick={() => setView("unified")}
            className={`px-2 py-0.5 transition-colors duration-fast ${
              view === "unified" ? "bg-accent-bg text-ink" : "text-ink-2 hover:bg-[var(--hover)]"
            }`}
          >
            Unified
          </button>
          <button
            onClick={() => setView("split")}
            className={`px-2 py-0.5 transition-colors duration-fast ${
              view === "split" ? "bg-accent-bg text-ink" : "text-ink-2 hover:bg-[var(--hover)]"
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
                    className="text-[11px] text-bad border border-strong rounded-control px-2 py-0.5 hover:bg-[var(--hover)] disabled:opacity-40 disabled:pointer-events-none transition-colors duration-fast"
                  >
                    Discard hunk
                  </button>
                )}
                <button
                  onClick={() => applyHunk(hunk, hi)}
                  disabled={applying !== null}
                  className="text-[11px] text-ink-2 border border-strong rounded-control px-2 py-0.5 hover:bg-[var(--hover)] disabled:opacity-40 disabled:pointer-events-none transition-colors duration-fast"
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
