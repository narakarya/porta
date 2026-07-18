import { useEffect, useRef, useState } from "react";
import type { App } from "../../../types";
import { gitDiffFile, gitApplyHunk } from "../../../lib/commands";
import { parseUnifiedDiff, hunkToPatch, type DiffLine, type Hunk, type ParsedDiff } from "../../../lib/git-diff";
import { Spinner } from "../../ui";
import SplitHunk from "./SplitHunk";

function lineClass(kind: DiffLine["kind"]): string {
  if (kind === "add") return "bg-ok-bg text-ok";
  if (kind === "del") return "bg-bad-bg text-bad";
  if (kind === "meta") return "text-ink-3";
  return "text-ink-2";
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState<number | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [view, setView] = useState<"unified" | "split">("unified");

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
      .then((raw) => { if (!cancelled) setParsed(parseUnifiedDiff(raw)); })
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

  if (loading) return <div className="text-ink-3">Loading diff…</div>;
  if (error) return <div className="text-bad whitespace-pre-wrap break-words">{error}</div>;
  if (!parsed || parsed.hunks.length === 0) {
    return <div className="text-ink-3">No changes.</div>;
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
      {parsed.hunks.map((hunk, hi) => (
        <div key={hi} className="mt-2 first:mt-0">
          <div className="flex items-center justify-between gap-2 whitespace-pre text-accent">
            <span>{hunk.header}</span>
            <button
              onClick={() => applyHunk(hunk, hi)}
              disabled={applying !== null}
              className="shrink-0 font-sans text-[11px] text-ink-2 border border-strong rounded-control px-2 py-0.5 hover:bg-white/[0.05] disabled:opacity-40 disabled:pointer-events-none transition-colors duration-fast"
            >
              {applying === hi ? <Spinner size={11} /> : staged ? "Unstage hunk" : "Stage hunk"}
            </button>
          </div>
          {view === "unified" ? (
            hunk.lines.map((line, li) => (
              <div key={li} className={`whitespace-pre ${lineClass(line.kind)}`}>
                {line.text === "" ? " " : line.text}
              </div>
            ))
          ) : (
            <SplitHunk hunk={hunk} />
          )}
        </div>
      ))}
    </div>
  );
}
