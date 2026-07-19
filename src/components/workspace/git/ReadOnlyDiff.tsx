import { useEffect, useMemo, useState } from "react";
import { parseUnifiedDiff } from "../../../lib/git-diff";
import { Input, Select, Spinner } from "../../ui";
import SplitHunk from "./SplitHunk";
import { DiffLines } from "./diffLines";

export interface ReadOnlyDiffOptions {
  context: number;
  ignoreWhitespace: boolean;
}

type DiffFile = {
  path: string;
  raw: string;
  additions: number;
  deletions: number;
};

function pathFromSection(lines: string[], index: number): string {
  const plus = lines.find((line) => line.startsWith("+++ b/"));
  if (plus) return plus.slice(6).trim();
  const header = lines[0]?.match(/^diff --git a\/(.+?) b\/(.+)$/);
  return header?.[2] ?? header?.[1] ?? `change-${index + 1}`;
}

export function splitDiffFiles(raw: string): DiffFile[] {
  const lines = raw.split("\n");
  const starts: number[] = [];
  lines.forEach((line, index) => {
    if (line.startsWith("diff --git ")) starts.push(index);
  });
  if (starts.length === 0) {
    return raw.trim() === ""
      ? []
      : [{ path: "Diff", raw, additions: 0, deletions: 0 }];
  }
  return starts.map((start, index) => {
    const section = lines.slice(start, starts[index + 1] ?? lines.length);
    let additions = 0;
    let deletions = 0;
    for (const line of section) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions++;
      else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
    }
    return {
      path: pathFromSection(section, index),
      raw: section.join("\n"),
      additions,
      deletions,
    };
  });
}

export default function ReadOnlyDiff({
  diff,
  loading = false,
  emptyLabel = "No textual diff to show.",
  options,
  onOptionsChange,
}: {
  diff: string;
  loading?: boolean;
  emptyLabel?: string;
  options?: ReadOnlyDiffOptions;
  onOptionsChange?: (options: ReadOnlyDiffOptions) => void;
}) {
  const files = useMemo(() => splitDiffFiles(diff), [diff]);
  const [selectedPath, setSelectedPath] = useState("");
  const [filter, setFilter] = useState("");
  const [view, setView] = useState<"unified" | "split">("unified");

  useEffect(() => {
    setSelectedPath((previous) =>
      files.some((file) => file.path === previous) ? previous : files[0]?.path ?? "",
    );
  }, [files]);

  const visible = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return query === ""
      ? files
      : files.filter((file) => file.path.toLowerCase().includes(query));
  }, [files, filter]);
  const selected =
    files.find((file) => file.path === selectedPath) ??
    visible[0] ??
    files[0] ??
    null;
  const parsed = useMemo(
    () => (selected ? parseUnifiedDiff(selected.raw) : null),
    [selected],
  );

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center gap-2 text-[12px] text-ink-3">
        <Spinner size={12} /> Loading diff…
      </div>
    );
  }
  if (files.length === 0) {
    return <div className="h-full flex items-center justify-center text-[12px] text-ink-3">{emptyLabel}</div>;
  }

  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="shrink-0 flex flex-wrap items-center gap-2 border-b border-subtle bg-surface-1 px-2.5 py-2">
        <span className="text-[11px] text-ink-3">
          {files.length} file{files.length === 1 ? "" : "s"}
        </span>
        <span className="text-[11px] text-ok">
          +{files.reduce((sum, file) => sum + file.additions, 0)}
        </span>
        <span className="text-[11px] text-bad">
          −{files.reduce((sum, file) => sum + file.deletions, 0)}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {options && onOptionsChange && (
            <>
              <label className="inline-flex items-center gap-1 text-[10px] text-ink-3">
                <input
                  type="checkbox"
                  checked={options.ignoreWhitespace}
                  onChange={(event) =>
                    onOptionsChange({ ...options, ignoreWhitespace: event.target.checked })
                  }
                  className="accent-[var(--color-accent)]"
                />
                Ignore whitespace
              </label>
              <Select
                value={String(options.context)}
                onChange={(event) =>
                  onOptionsChange({ ...options, context: Number(event.target.value) })
                }
                className="select-base !text-[10px] !py-0.5"
              >
                <option value="8">±8</option>
                <option value="20">±20</option>
                <option value="100000">Full file</option>
              </Select>
            </>
          )}
          <div className="flex rounded-control border border-strong overflow-hidden text-[10px]">
            <button
              onClick={() => setView("unified")}
              className={`px-2 py-0.5 ${view === "unified" ? "bg-accent-bg text-ink" : "text-ink-3 hover:text-ink"}`}
            >
              Unified
            </button>
            <button
              onClick={() => setView("split")}
              className={`px-2 py-0.5 ${view === "split" ? "bg-accent-bg text-ink" : "text-ink-3 hover:text-ink"}`}
            >
              Split
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 flex">
        {files.length > 1 && (
          <div className="w-[230px] shrink-0 border-r border-subtle flex flex-col min-h-0 bg-surface-1">
            <div className="shrink-0 p-2 border-b border-subtle">
              <Input
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter files…"
                className="!py-1"
              />
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto py-1">
              {visible.map((file) => (
                <button
                  key={file.path}
                  onClick={() => setSelectedPath(file.path)}
                  className={`mx-1 flex w-[calc(100%_-_8px)] items-center gap-2 rounded-control px-2 py-1.5 text-left ${
                    selected?.path === file.path ? "bg-accent-bg" : "hover:bg-white/[0.04]"
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink" title={file.path}>
                    {file.path}
                  </span>
                  {file.additions > 0 && <span className="text-[10px] text-ok">+{file.additions}</span>}
                  {file.deletions > 0 && <span className="text-[10px] text-bad">−{file.deletions}</span>}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="flex-1 min-w-0 overflow-auto bg-surface-code font-mono text-[11px] leading-[1.7]">
          {selected && parsed && parsed.hunks.length > 0 ? (
            <div className="min-w-max">
              <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-subtle bg-surface-code px-3 py-1.5">
                <span className="font-mono text-[11px] text-ink">{selected.path}</span>
                <span className="text-[10px]">
                  <span className="text-ok">+{selected.additions}</span>{" "}
                  <span className="text-bad">−{selected.deletions}</span>
                </span>
              </div>
              {parsed.hunks.map((hunk, index) => (
                <div key={`${selected.path}:${index}`} className="border-b border-subtle/60">
                  {view === "split" ? (
                    <SplitHunk hunk={hunk} />
                  ) : (
                    <DiffLines diff={hunk.lines.map((line) => line.text).join("\n")} />
                  )}
                </div>
              ))}
            </div>
          ) : selected ? (
            <div className="px-3 py-2.5">
              <DiffLines diff={selected.raw} />
            </div>
          ) : (
            <div className="h-full flex items-center justify-center text-[12px] text-ink-3">
              No matching files.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
