import { useEffect, useRef, useState } from "react";
import type { App } from "../../../types";
import { gitDiffFile, gitApplyHunk, gitDiscardHunk } from "../../../lib/commands";
import { parseUnifiedDiff, hunkToPatch, type DiffLine, type Hunk, type ParsedDiff } from "../../../lib/git-diff";
import { Spinner } from "../../ui";
import SplitHunk from "./SplitHunk";

function lineClass(kind: DiffLine["kind"]): string {
  if (kind === "add") return "bg-ok-bg text-ok";
  if (kind === "del") return "bg-bad-bg text-bad";
  if (kind === "meta") return "text-ink-3";
  return "text-ink-2";
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
    gitDiffFile(app.root_dir, path, staged)
      .then((raw) => {
        if (cancelled) return;
        setRawDiff(raw);
        setParsed(parseUnifiedDiff(raw));
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
  // Only a truly empty fetched diff means "no changes" — a binary file or a
  // mode-only change comes back non-empty but with zero `@@` hunks.
  if (!parsed || rawDiff.trim() === "") {
    return <div className="text-ink-3">No changes.</div>;
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
            hunk.lines.map((line, li) => (
              <div key={li} className="flex">
                <span className={GUTTER_NUM_CLASS}>{nums[li].old ?? ""}</span>
                <span className={GUTTER_NUM_CLASS}>{nums[li].new ?? ""}</span>
                <span className={`whitespace-pre flex-1 ${lineClass(line.kind)}`}>
                  {line.text === "" ? " " : line.text}
                </span>
              </div>
            ))
          ) : (
            <SplitHunk hunk={hunk} />
          )}
        </div>
        );
      })}
    </div>
  );
}
