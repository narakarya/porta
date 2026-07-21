import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { App } from "../../../types";
import {
  gitBranchDiffOptions,
  gitBranchInfo,
  gitCreateBranch,
  gitDeleteBranch,
  gitDeleteRemoteBranch,
  gitLogRef,
  gitSwitchBranch,
  gitTrackRemoteBranch,
  gitWorktreeList,
  type BranchInfo,
  type BranchInfoList,
  type CommitEntry,
  type WorktreeEntry,
} from "../../../lib/commands";
import { Button, Input, Select, Spinner } from "../../ui";
import ReadOnlyDiff, { type ReadOnlyDiffOptions } from "./ReadOnlyDiff";

type Facet = "all" | "identical" | "merged" | "unmerged" | "local-only" | "on-remote";
type DetailMode = "compare" | "commits";

function remoteParts(ref: string): { remote: string; branch: string } | null {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) return null;
  return { remote: ref.slice(0, slash), branch: ref.slice(slash + 1) };
}

function facetMatches(branch: BranchInfo, facet: Facet): boolean {
  if (branch.remote || facet === "all") return true;
  if (facet === "identical") return branch.identical;
  if (facet === "merged") return branch.merged;
  if (facet === "unmerged") return !branch.merged;
  if (facet === "local-only") return !branch.has_remote;
  return branch.has_remote;
}

function BranchBadge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "ok" | "warn" | "bad" | "accent" }) {
  const tones = {
    neutral: "bg-[var(--hover)] text-ink-3",
    ok: "bg-ok-bg text-ok",
    warn: "bg-warn-bg text-warn",
    bad: "bg-bad-bg text-bad",
    accent: "bg-accent-bg text-accent",
  };
  return <span className={`rounded-control px-1.5 py-0.5 text-[9px] ${tones[tone]}`}>{children}</span>;
}

export default function BranchesPanel({
  app,
  onRepositoryChanged,
}: {
  app: App;
  onRepositoryChanged?: () => void;
}) {
  const [branches, setBranches] = useState<BranchInfoList | null>(null);
  const [worktrees, setWorktrees] = useState<WorktreeEntry[]>([]);
  const [query, setQuery] = useState("");
  const [facet, setFacet] = useState<Facet>("all");
  const [newBranch, setNewBranch] = useState("");
  const [startPoint, setStartPoint] = useState("");
  const [compareBase, setCompareBase] = useState("");
  const [selected, setSelected] = useState<BranchInfo | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [detailMode, setDetailMode] = useState<DetailMode>("compare");
  const [diff, setDiff] = useState("");
  const [commits, setCommits] = useState<CommitEntry[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [diffOptions, setDiffOptions] = useState<ReadOnlyDiffOptions>({
    context: 8,
    ignoreWhitespace: false,
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<BranchInfo | null>(null);
  const [forceDelete, setForceDelete] = useState<BranchInfo | null>(null);
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [forceBulk, setForceBulk] = useState<string[]>([]);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  async function load(base = compareBase) {
    if (!app.root_dir) return;
    setError(null);
    try {
      const [list, entries] = await Promise.all([
        gitBranchInfo(app.root_dir, base),
        gitWorktreeList(app.root_dir).catch(() => [] as WorktreeEntry[]),
      ]);
      if (!mounted.current) return;
      setBranches(list);
      setWorktrees(entries);
      setCompareBase(list.compare_base);
      const refs = [...list.local, ...list.remote].map((branch) => branch.name);
      setStartPoint((previous) =>
        previous && refs.includes(previous)
          ? previous
          : list.current ?? list.compare_base ?? refs[0] ?? "",
      );
      setChecked((previous) => {
        const live = new Set(refs);
        return new Set([...previous].filter((name) => live.has(name)));
      });
    } catch (cause) {
      if (mounted.current) setError(String(cause));
    }
  }

  useEffect(() => {
    setBranches(null);
    setSelected(null);
    setDiff("");
    setCommits([]);
    setChecked(new Set());
    load("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.root_dir]);

  const branchWorktrees = useMemo(
    () => new Map(
      worktrees
        .filter((worktree) => worktree.branch && worktree.path !== app.root_dir)
        .map((worktree) => [worktree.branch!, worktree.path] as const),
    ),
    [app.root_dir, worktrees],
  );

  const all = useMemo(
    () => [...(branches?.local ?? []), ...(branches?.remote ?? [])],
    [branches],
  );
  const filtered = useMemo(() => {
    const text = query.trim().toLowerCase();
    return all.filter((branch) =>
      facetMatches(branch, facet) &&
      (text === "" || `${branch.name} ${branch.subject} ${branch.upstream ?? ""}`.toLowerCase().includes(text)),
    );
  }, [all, facet, query]);
  const local = filtered.filter((branch) => !branch.remote);
  const remote = filtered.filter((branch) => branch.remote);

  useEffect(() => {
    if (!app.root_dir || !selected || !compareBase) return;
    let cancelled = false;
    setDetailLoading(true);
    setError(null);
    if (detailMode === "commits") {
      gitLogRef(app.root_dir, `${compareBase}..${selected.name}`, "", 100, 0)
        .then((rows) => { if (!cancelled && mounted.current) setCommits(rows); })
        .catch((cause) => { if (!cancelled && mounted.current) setError(String(cause)); })
        .finally(() => { if (!cancelled && mounted.current) setDetailLoading(false); });
    } else {
      gitBranchDiffOptions(
        app.root_dir,
        compareBase,
        selected.name,
        diffOptions.context,
        diffOptions.ignoreWhitespace,
      )
        .then((raw) => { if (!cancelled && mounted.current) setDiff(raw); })
        .catch((cause) => { if (!cancelled && mounted.current) setError(String(cause)); })
        .finally(() => { if (!cancelled && mounted.current) setDetailLoading(false); });
    }
    return () => { cancelled = true; };
  }, [app.root_dir, compareBase, selected, detailMode, diffOptions]);

  async function mutate(key: string, action: () => Promise<void>) {
    setBusy(key);
    setError(null);
    try {
      await action();
      if (!mounted.current) return;
      setConfirmDelete(null);
      setForceDelete(null);
      setSelected(null);
      setDiff("");
      setCommits([]);
      await load();
      onRepositoryChanged?.();
    } catch (cause) {
      if (mounted.current) setError(String(cause));
      throw cause;
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
    }).catch(() => {});
  }

  async function remove(branch: BranchInfo, force = false) {
    if (!app.root_dir) return;
    try {
      await mutate(`delete:${branch.name}`, async () => {
        if (!branch.remote) {
          await gitDeleteBranch(app.root_dir, branch.name, force);
        } else {
          const parts = remoteParts(branch.name);
          if (!parts) throw new Error("Invalid remote branch reference.");
          await gitDeleteRemoteBranch(app.root_dir, parts.remote, parts.branch);
        }
      });
    } catch {
      if (!branch.remote && !force && mounted.current) {
        setConfirmDelete(null);
        setForceDelete(branch);
      }
    }
  }

  async function removeSelected(forceNames: string[] = []) {
    if (!app.root_dir || checked.size === 0) return;
    setBusy("bulk-delete");
    setError(null);
    setConfirmBulk(false);
    setForceBulk([]);
    const needsForce: string[] = [];
    const failures: string[] = [];
    for (const name of checked) {
      const branch = all.find((item) => item.name === name);
      if (!branch || branch.current || branchWorktrees.has(branch.name)) continue;
      try {
        if (branch.remote) {
          const parts = remoteParts(branch.name);
          if (!parts) throw new Error("Invalid remote branch reference.");
          await gitDeleteRemoteBranch(app.root_dir, parts.remote, parts.branch);
        } else {
          await gitDeleteBranch(app.root_dir, branch.name, forceNames.includes(branch.name));
        }
      } catch {
        if (!branch.remote && !forceNames.includes(branch.name)) needsForce.push(branch.name);
        else failures.push(branch.name);
      }
    }
    if (!mounted.current) return;
    setBusy(null);
    if (needsForce.length > 0) {
      setForceBulk(needsForce);
      setChecked(new Set(needsForce));
      return;
    }
    setChecked(new Set());
    if (failures.length > 0) setError(`Could not remove: ${failures.join(", ")}`);
    await load();
    onRepositoryChanged?.();
  }

  function toggleChecked(name: string) {
    setChecked((previous) => {
      const next = new Set(previous);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function selectBranch(branch: BranchInfo, mode: DetailMode) {
    setSelected(branch);
    setDetailMode(mode);
    setDiff("");
    setCommits([]);
  }

  const facetItems: Array<{ id: Facet; label: string; count: number }> = [
    { id: "all", label: "All", count: branches?.local.length ?? 0 },
    { id: "identical", label: "Identical", count: branches?.local.filter((branch) => branch.identical).length ?? 0 },
    { id: "merged", label: "Merged", count: branches?.local.filter((branch) => branch.merged).length ?? 0 },
    { id: "unmerged", label: "Unmerged", count: branches?.local.filter((branch) => !branch.merged).length ?? 0 },
    { id: "local-only", label: "Local-only", count: branches?.local.filter((branch) => !branch.has_remote).length ?? 0 },
    { id: "on-remote", label: "On remote", count: branches?.local.filter((branch) => branch.has_remote).length ?? 0 },
  ];

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="shrink-0 border-b border-subtle bg-surface-1 p-2.5 flex flex-wrap items-center gap-2">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter branches…"
          className="!py-1 min-w-[180px] flex-1"
        />
        <span className="text-[11px] text-ink-3 shrink-0">Compare with</span>
        <Select
          value={compareBase}
          onChange={(event) => {
            setCompareBase(event.target.value);
            load(event.target.value);
          }}
          className="select-base !text-[11px] !py-1 max-w-[190px]"
        >
          {all.map((branch) => <option key={branch.name} value={branch.name}>{branch.name}</option>)}
        </Select>
        <Input
          value={newBranch}
          onChange={(event) => setNewBranch(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") create(); }}
          placeholder="New branch…"
          className="!py-1 max-w-[180px] font-mono"
        />
        <Select
          value={startPoint}
          onChange={(event) => setStartPoint(event.target.value)}
          className="select-base !text-[11px] !py-1 max-w-[170px]"
        >
          {all.map((branch) => <option key={branch.name} value={branch.name}>from {branch.name}</option>)}
        </Select>
        <Button
          size="sm"
          loading={busy?.startsWith("create:")}
          disabled={!newBranch.trim() || busy !== null}
          onClick={create}
        >
          Create
        </Button>
      </div>

      <div className="shrink-0 flex flex-wrap items-center gap-1 border-b border-subtle bg-surface-1 px-2.5 py-1.5">
        {facetItems.map((item) => (
          <button
            key={item.id}
            onClick={() => setFacet(item.id)}
            className={`rounded-full px-2 py-1 text-[10px] ${
              facet === item.id ? "bg-accent-bg text-accent" : "text-ink-3 hover:bg-[var(--hover)] hover:text-ink"
            }`}
          >
            {item.label} {item.count}
          </button>
        ))}
        {checked.size > 0 && (
          <div className="ml-auto flex items-center gap-1.5">
            <span className="text-[10px] text-ink-3">{checked.size} selected</span>
            <button onClick={() => setChecked(new Set())} className="text-[10px] text-ink-3 hover:text-ink">Clear</button>
            {forceBulk.length > 0 ? (
              <>
                <span className="text-[10px] text-bad">Unmerged. Force remove?</span>
                <button onClick={() => removeSelected(forceBulk)} className="text-[10px] font-medium text-bad">Confirm</button>
                <button onClick={() => setForceBulk([])} className="text-[10px] text-ink-3">Cancel</button>
              </>
            ) : confirmBulk ? (
              <>
                <span className="text-[10px] text-bad">Remove selected?</span>
                <button onClick={() => removeSelected()} className="text-[10px] font-medium text-bad">Confirm</button>
                <button onClick={() => setConfirmBulk(false)} className="text-[10px] text-ink-3">Cancel</button>
              </>
            ) : (
              <Button variant="danger" size="sm" onClick={() => setConfirmBulk(true)}>Remove selected</Button>
            )}
          </div>
        )}
      </div>

      {error && (
        <pre className="shrink-0 text-[11px] font-mono text-bad whitespace-pre-wrap break-words max-h-28 overflow-y-auto rounded-control border border-subtle bg-surface-code px-2.5 py-2 m-2">{error}</pre>
      )}

      <div className="flex-1 min-h-0 flex">
        <div className="w-[440px] shrink-0 border-r border-subtle overflow-y-auto py-1">
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
                  {section.map((branch) => {
                    const worktreePath = !branch.remote ? branchWorktrees.get(branch.name) : undefined;
                    const selectable = !branch.current && !worktreePath;
                    const confirming = confirmDelete?.name === branch.name;
                    const forcing = forceDelete?.name === branch.name;
                    return (
                      <div
                        key={`${branch.remote ? "remote" : "local"}:${branch.name}`}
                        title={worktreePath ? `Checked out in ${worktreePath}` : branch.name}
                        className={`group mx-1 mb-0.5 rounded-control px-2 py-1.5 ${
                          selected?.name === branch.name ? "bg-accent-bg" : "hover:bg-[var(--hover)]"
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          {branch.current ? (
                            <span className="w-3 text-center text-[10px] text-ok">●</span>
                          ) : selectable ? (
                            <input
                              type="checkbox"
                              checked={checked.has(branch.name)}
                              onChange={() => toggleChecked(branch.name)}
                              className="w-3 shrink-0 accent-[var(--color-accent)]"
                              aria-label={`Select ${branch.name}`}
                            />
                          ) : <span className="w-3" />}
                          <button
                            onClick={() => selectBranch(branch, "compare")}
                            className="min-w-0 flex-1 text-left"
                          >
                            <div className="flex items-center gap-1.5">
                              <span className={`min-w-0 truncate font-mono text-[12px] ${branch.current ? "text-accent" : "text-ink"}`}>
                                {branch.name}
                              </span>
                              {branch.identical ? <BranchBadge tone="ok">identical</BranchBadge> : !branch.remote && (
                                <BranchBadge tone={branch.merged ? "ok" : "warn"}>{branch.merged ? "merged" : "unmerged"}</BranchBadge>
                              )}
                              {!branch.remote && <BranchBadge tone={branch.has_remote ? "accent" : "neutral"}>{branch.has_remote ? "on remote" : "local-only"}</BranchBadge>}
                              {(branch.ahead > 0 || branch.behind > 0) && (
                                <BranchBadge tone="warn">
                                  {branch.ahead > 0 && `↑${branch.ahead}`}{branch.behind > 0 && ` ↓${branch.behind}`}
                                </BranchBadge>
                              )}
                            </div>
                            <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-ink-3">
                              <span className="truncate">{branch.subject || "No commit subject"}</span>
                              <span>·</span>
                              <span className="shrink-0">{branch.relative_date}</span>
                              {!branch.current && <span className="shrink-0 text-accent">{branch.unique_commits} commits</span>}
                            </div>
                          </button>
                          {worktreePath ? (
                            <span className="max-w-[110px] truncate text-[10px] text-warn" title={worktreePath}>in {worktreePath}</span>
                          ) : confirming || forcing ? (
                            <div className="flex items-center gap-1">
                              <span className="text-[10px] text-bad">{forcing ? "Force remove?" : "Remove?"}</span>
                              <button onClick={() => remove(branch, forcing)} className="text-[10px] font-medium text-bad">Confirm</button>
                              <button onClick={() => { setConfirmDelete(null); setForceDelete(null); }} className="text-[10px] text-ink-3">Cancel</button>
                            </div>
                          ) : (
                            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
                              {branch.name !== compareBase && (
                                <button
                                  onClick={() => selectBranch(branch, "compare")}
                                  className="rounded-control px-1.5 py-1 text-[10px] text-ink-3 hover:bg-[var(--hover)] hover:text-ink"
                                >
                                  Compare
                                </button>
                              )}
                              {!branch.current && (
                                <button
                                  onClick={() => selectBranch(branch, "commits")}
                                  className="rounded-control px-1.5 py-1 text-[10px] text-ink-3 hover:bg-[var(--hover)] hover:text-ink"
                                >
                                  Commits
                                </button>
                              )}
                              {!branch.current && !branch.remote && (
                                <button
                                  onClick={() => mutate(`switch:${branch.name}`, () => gitSwitchBranch(app.root_dir, branch.name, false)).catch(() => {})}
                                  disabled={busy !== null}
                                  className="rounded-control px-1.5 py-1 text-[10px] text-ink-3 hover:bg-[var(--hover)] hover:text-ink"
                                >
                                  Switch
                                </button>
                              )}
                              {branch.remote && (
                                <button
                                  onClick={() => mutate(`track:${branch.name}`, () => gitTrackRemoteBranch(app.root_dir, branch.name)).catch(() => {})}
                                  disabled={busy !== null}
                                  className="rounded-control px-1.5 py-1 text-[10px] text-ink-3 hover:bg-[var(--hover)] hover:text-ink"
                                >
                                  Track
                                </button>
                              )}
                              {!branch.current && (
                                <button
                                  onClick={() => setConfirmDelete(branch)}
                                  disabled={busy !== null}
                                  className="rounded-control px-1.5 py-1 text-[10px] text-ink-3 hover:bg-bad-bg hover:text-bad"
                                >
                                  Remove
                                </button>
                              )}
                              <button
                                onClick={() => navigator.clipboard?.writeText(branch.name)}
                                className="rounded-control px-1.5 py-1 text-[10px] text-ink-3 hover:bg-[var(--hover)] hover:text-ink"
                                title="Copy branch name"
                              >
                                Copy
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}
              {filtered.length === 0 && <div className="px-3 py-3 text-[12px] text-ink-3">No matching branches.</div>}
            </>
          )}
        </div>

        <div className="flex-1 min-w-0 bg-surface-code">
          {!selected ? (
            <div className="h-full flex items-center justify-center text-ink-3 text-[12px]">
              Select Compare or Commits on a branch
            </div>
          ) : detailMode === "commits" ? (
            <div className="h-full overflow-y-auto">
              <div className="sticky top-0 z-10 border-b border-subtle bg-surface-1 px-3 py-2 text-[11px] text-ink">
                Commits in <span className="font-mono">{selected.name}</span> not in <span className="font-mono">{compareBase}</span>
              </div>
              {detailLoading ? (
                <div className="flex items-center gap-2 px-3 py-3 text-[12px] text-ink-3"><Spinner size={12} /> Loading commits…</div>
              ) : commits.length === 0 ? (
                <div className="px-3 py-3 text-[12px] text-ink-3">No unique commits.</div>
              ) : commits.map((commit) => (
                <div key={commit.hash} className="border-b border-subtle/60 px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[10px] text-accent">{commit.short_hash}</span>
                    <span className="text-[12px] text-ink">{commit.subject}</span>
                  </div>
                  {commit.body && <div className="mt-1 whitespace-pre-wrap text-[11px] text-ink-2">{commit.body}</div>}
                  <div className="mt-1 text-[10px] text-ink-3">{commit.author} · {new Date(commit.date).toLocaleString()}</div>
                </div>
              ))}
            </div>
          ) : (
            <ReadOnlyDiff
              diff={diff}
              loading={detailLoading}
              options={diffOptions}
              onOptionsChange={setDiffOptions}
              emptyLabel={selected.name === compareBase ? "This is the compare base." : "No changes from the compare base."}
            />
          )}
        </div>
      </div>
    </div>
  );
}
