import { useEffect, useMemo, useRef, useState } from "react";
import type { App } from "../../../types";
import {
  gitBranchDiff,
  gitBranches,
  gitCreateBranch,
  gitDeleteBranch,
  gitDeleteRemoteBranch,
  gitSwitchBranch,
  gitTrackRemoteBranch,
  gitWorktreeList,
  type BranchList,
  type WorktreeEntry,
} from "../../../lib/commands";
import { Button, Input, Select, Spinner } from "../../ui";
import { DiffLines } from "./diffLines";

type Row = { name: string; label: string; kind: "local" | "remote" };

function remoteParts(ref: string): { remote: string; branch: string } | null {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) return null;
  return { remote: ref.slice(0, slash), branch: ref.slice(slash + 1) };
}

export default function BranchesPanel({
  app,
  onRepositoryChanged,
}: {
  app: App;
  onRepositoryChanged?: () => void;
}) {
  const [branches, setBranches] = useState<BranchList | null>(null);
  const [worktrees, setWorktrees] = useState<WorktreeEntry[]>([]);
  const [query, setQuery] = useState("");
  const [newBranch, setNewBranch] = useState("");
  const [startPoint, setStartPoint] = useState("");
  const [compareBase, setCompareBase] = useState("");
  const [selected, setSelected] = useState<Row | null>(null);
  const [diff, setDiff] = useState("");
  const [diffLoading, setDiffLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Row | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  function load() {
    if (!app.root_dir) return;
    setError(null);
    Promise.all([
      gitBranches(app.root_dir),
      gitWorktreeList(app.root_dir).catch(() => [] as WorktreeEntry[]),
    ])
      .then(([list, entries]) => {
        if (!mounted.current) return;
        setBranches(list);
        setWorktrees(entries);
        const defaultBase = list.local.includes("main")
          ? "main"
          : list.local.includes("master")
            ? "master"
            : list.current ?? list.local[0] ?? "";
        setCompareBase((prev) => prev && list.local.includes(prev) ? prev : defaultBase);
        setStartPoint((prev) => prev || list.current || defaultBase);
      })
      .catch((e) => {
        if (!mounted.current) return;
        setWorktrees([]);
        setError(String(e));
      });
  }

  useEffect(() => {
    setBranches(null);
    setSelected(null);
    setDiff("");
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.root_dir]);

  const rows = useMemo<Row[]>(() => {
    if (!branches) return [];
    const q = query.trim().toLowerCase();
    const all: Row[] = [
      ...branches.local.map((name) => ({ name, label: name, kind: "local" as const })),
      ...branches.remote.map((name) => ({ name, label: name, kind: "remote" as const })),
    ];
    return q === "" ? all : all.filter((row) => row.label.toLowerCase().includes(q));
  }, [branches, query]);

  const branchWorktrees = useMemo(
    () => new Map(
      worktrees
        .filter((worktree) => worktree.branch && worktree.path !== app.root_dir)
        .map((worktree) => [worktree.branch!, worktree.path] as const),
    ),
    [app.root_dir, worktrees],
  );

  function preview(row: Row, base = compareBase) {
    if (!app.root_dir || !base || row.name === base) {
      setSelected(row);
      setDiff("");
      return;
    }
    setSelected(row);
    setDiff("");
    setDiffLoading(true);
    setError(null);
    gitBranchDiff(app.root_dir, base, row.name)
      .then((raw) => { if (mounted.current) setDiff(raw); })
      .catch((e) => { if (mounted.current) setError(String(e)); })
      .finally(() => { if (mounted.current) setDiffLoading(false); });
  }

  async function mutate(key: string, action: () => Promise<void>) {
    setBusy(key);
    setError(null);
    try {
      await action();
      if (!mounted.current) return;
      setConfirmDelete(null);
      setSelected(null);
      setDiff("");
      load();
      onRepositoryChanged?.();
    } catch (e) {
      if (mounted.current) setError(String(e));
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  function create() {
    const name = newBranch.trim();
    if (!name || !app.root_dir) return;
    mutate(`create:${name}`, async () => {
      await gitCreateBranch(app.root_dir, name, startPoint);
      if (mounted.current) setNewBranch("");
    });
  }

  function remove(row: Row) {
    if (!app.root_dir) return;
    mutate(`delete:${row.name}`, async () => {
      if (row.kind === "local") {
        await gitDeleteBranch(app.root_dir, row.name);
      } else {
        const parts = remoteParts(row.name);
        if (!parts) throw new Error("Invalid remote branch reference.");
        await gitDeleteRemoteBranch(app.root_dir, parts.remote, parts.branch);
      }
    });
  }

  const local = rows.filter((row) => row.kind === "local");
  const remote = rows.filter((row) => row.kind === "remote");

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="shrink-0 border-b border-subtle bg-surface-1 p-2.5 flex items-center gap-2">
        <Input
          value={newBranch}
          onChange={(e) => setNewBranch(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") create(); }}
          placeholder="New branch name…"
          className="!py-1 font-mono"
        />
        <span className="text-[11px] text-ink-3 shrink-0">from</span>
        <Select
          value={startPoint}
          onChange={(e) => setStartPoint(e.target.value)}
          className="select-base !text-[11px] !py-1 max-w-[190px]"
        >
          {[...(branches?.local ?? []), ...(branches?.remote ?? [])].map((ref) => (
            <option key={ref} value={ref}>{ref}</option>
          ))}
        </Select>
        <Button
          size="sm"
          loading={busy?.startsWith("create:")}
          disabled={!newBranch.trim() || busy !== null}
          onClick={create}
        >
          Create & switch
        </Button>
      </div>

      <div className="shrink-0 border-b border-subtle p-2 flex items-center gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter branches…"
          className="!py-1"
        />
        <span className="text-[11px] text-ink-3 shrink-0">Compare with</span>
        <Select
          value={compareBase}
          onChange={(e) => {
            const base = e.target.value;
            setCompareBase(base);
            if (selected) preview(selected, base);
          }}
          className="select-base !text-[11px] !py-1 max-w-[170px]"
        >
          {(branches?.local ?? []).map((ref) => <option key={ref} value={ref}>{ref}</option>)}
        </Select>
      </div>

      {error && (
        <pre className="shrink-0 text-[11px] font-mono text-bad whitespace-pre-wrap break-words max-h-28 overflow-y-auto rounded-control border border-subtle bg-surface-code px-2.5 py-2 m-2">{error}</pre>
      )}

      <div className="flex-1 min-h-0 flex">
        <div className="w-[340px] shrink-0 border-r border-subtle overflow-y-auto py-1">
          {!branches ? (
            <div className="inline-flex items-center gap-2 px-3 py-3 text-[12px] text-ink-3">
              <Spinner size={12} /> Loading branches…
            </div>
          ) : (
            <>
              {([
                ["Local", local],
                ["Remote", remote],
              ] as const).map(([label, section]) => section.length > 0 && (
                <div key={label}>
                  <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wide text-ink-3">
                    {label} · {section.length}
                  </div>
                  {section.map((row) => {
                    const current = row.kind === "local" && branches.current === row.name;
                    const worktreePath = row.kind === "local" ? branchWorktrees.get(row.name) : undefined;
                    const deleting = confirmDelete?.kind === row.kind && confirmDelete.name === row.name;
                    return (
                      <div
                        key={`${row.kind}:${row.name}`}
                        title={worktreePath ? `Checked out in ${worktreePath}` : row.name}
                        onClick={() => preview(row)}
                        className={`group mx-1 mb-0.5 flex items-center gap-2 px-2 py-1.5 rounded-control cursor-pointer ${selected?.kind === row.kind && selected.name === row.name ? "bg-accent-bg" : "hover:bg-white/[0.04]"}`}
                      >
                        <span className={`font-mono text-[12px] flex-1 min-w-0 truncate ${current ? "text-accent" : "text-ink"}`}>
                          {current && "● "}{row.label}
                        </span>
                        {deleting ? (
                          <div className="shrink-0 flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                            <span className="text-[11px] text-bad">Delete?</span>
                            <button onClick={() => remove(row)} className="text-[11px] font-medium text-bad">Confirm</button>
                            <button onClick={() => setConfirmDelete(null)} className="text-[11px] text-ink-3">Cancel</button>
                          </div>
                        ) : (
                          <div className="shrink-0 flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                            {worktreePath ? (
                              <span
                                className="max-w-[150px] truncate px-2 py-1 text-[10px] text-warn"
                                title={worktreePath}
                              >
                                in {worktreePath}
                              </span>
                            ) : !current && row.kind === "local" && (
                              <button
                                onClick={() => mutate(`switch:${row.name}`, () => gitSwitchBranch(app.root_dir, row.name, false))}
                                disabled={busy !== null}
                                className="text-[11px] text-ink-2 hover:text-ink px-2 py-1 rounded-control hover:bg-white/[0.06]"
                              >
                                Switch
                              </button>
                            )}
                            {row.kind === "remote" && (
                              <button
                                onClick={() => mutate(`track:${row.name}`, () => gitTrackRemoteBranch(app.root_dir, row.name))}
                                disabled={busy !== null}
                                className="text-[11px] text-ink-2 hover:text-ink px-2 py-1 rounded-control hover:bg-white/[0.06]"
                              >
                                Track
                              </button>
                            )}
                            {!current && !worktreePath && (
                              <button
                                onClick={() => setConfirmDelete(row)}
                                disabled={busy !== null}
                                className="opacity-0 group-hover:opacity-100 text-[11px] text-ink-3 hover:text-bad px-2 py-1 rounded-control hover:bg-bad-bg"
                              >
                                Delete
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
              {rows.length === 0 && <div className="px-3 py-3 text-[12px] text-ink-3">No matching branches.</div>}
            </>
          )}
        </div>

        <div className="flex-1 min-w-0 overflow-auto bg-surface-code font-mono text-[11px] leading-[1.7] px-3 py-2.5">
          {!selected ? (
            <div className="h-full flex items-center justify-center text-ink-3 text-[12px] font-sans">
              Select a branch to compare with {compareBase || "the base branch"}
            </div>
          ) : diffLoading ? (
            <div className="text-ink-3">Loading branch comparison…</div>
          ) : diff.trim() === "" ? (
            <div className="text-ink-3">{selected.name === compareBase ? "This is the compare base." : "No changes from the compare base."}</div>
          ) : (
            <DiffLines diff={diff} />
          )}
        </div>
      </div>
    </div>
  );
}
