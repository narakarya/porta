import { useEffect, useRef, useState } from "react";
import { usePortaStore } from "../../store";
import {
  gitStatus,
  gitFetch,
  gitPull,
  gitPush,
  gitBranches,
  gitSwitchBranch,
  gitChangedFiles,
  gitStage,
  gitUnstage,
  gitDiscard,
  gitCommit,
  gitCommitAmend,
  type BranchList,
  type ChangedFile,
} from "../../lib/commands";
import { Card, Input, EmptyState, Badge, Popover, Button, Spinner } from "../ui";
import type { App } from "../../types";
import HistoryPanel from "./git/HistoryPanel";
import StashPanel from "./git/StashPanel";
import TagsPanel from "./git/TagsPanel";
import RebasePanel from "./git/RebasePanel";
import DiffView from "./git/DiffView";

type Busy = "fetch" | "pull" | "push" | null;

// ── Inline icons (14px) — kept local so the panel has no icon-font dep ──────
function GitBranchIcon({ className = "" }: { className?: string }) {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <circle cx="4.5" cy="3.5" r="1.75" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="4.5" cy="12.5" r="1.75" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="11.5" cy="4.5" r="1.75" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4.5 5.25v5.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M11.5 6.25c0 2.6-1.9 3.5-4.2 3.9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
function ChevronDown({ className = "" }: { className?: string }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className={className} aria-hidden="true">
      <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function RefreshIcon({ className = "" }: { className?: string }) {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path d="M13 8a5 5 0 1 1-1.46-3.54" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M13 3v2.5h-2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function DotsIcon({ className = "" }: { className?: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" className={className} aria-hidden="true">
      <circle cx="3.5" cy="8" r="1.1" />
      <circle cx="8" cy="8" r="1.1" />
      <circle cx="12.5" cy="8" r="1.1" />
    </svg>
  );
}
function PlusIcon({ className = "" }: { className?: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={className} aria-hidden="true">
      <path d="M6 2.5v7M2.5 6h7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
function MinusIcon({ className = "" }: { className?: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={className} aria-hidden="true">
      <path d="M2.5 6h7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
function TrashIcon({ className = "" }: { className?: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path d="M3 4.5h10M6.5 4.5V3.2c0-.4.3-.7.7-.7h1.6c.4 0 .7.3.7.7v1.3M5 4.5l.5 8c0 .4.3.7.7.7h3.6c.4 0 .7-.3.7-.7l.5-8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function CheckboxIcon({ checked, className = "" }: { checked: boolean; className?: string }) {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <rect x="2.5" y="2.5" width="11" height="11" rx="2.5" stroke="currentColor" strokeWidth="1.3" />
      {checked && <path d="M5 8.2l2 2 4-4.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  );
}

// XY status badge — colour by section + git status char.
function statusBadge(f: ChangedFile, staged: boolean): { char: string; cls: string } {
  if (staged) {
    const c = f.staged_status && f.staged_status !== "." ? f.staged_status : "M";
    return { char: c, cls: "text-ok" };
  }
  if (f.untracked) return { char: "?", cls: "text-accent" };
  const c = f.unstaged_status && f.unstaged_status !== "." ? f.unstaged_status : "M";
  if (c === "D") return { char: "D", cls: "text-bad" };
  if (c === "U") return { char: "U", cls: "text-accent" };
  return { char: c, cls: "text-warn" };
}

function splitPath(path: string): { dir: string; base: string } {
  const i = path.lastIndexOf("/");
  return i >= 0 ? { dir: path.slice(0, i + 1), base: path.slice(i + 1) } : { dir: "", base: path };
}

// Re-derive `selected` against a freshly-fetched `changed` list: keep it if
// the file still has content in its current `selected.staged` section, flip
// to the other section if it moved there (e.g. the whole file — or its last
// remaining hunk — just got staged/unstaged), or clear it if the file no
// longer appears in either section. Shared by every mutation path that can
// move a file between sections (whole-file stage/unstage/discard, per-hunk
// staging, stash push/pop/drop, rebase) so none of them dead-end the diff
// pane on a file that just left the Changes list.
function deriveSelected(
  files: ChangedFile[],
  selected: { path: string; staged: boolean } | null,
): { path: string; staged: boolean } | null {
  if (!selected) return null;
  const inSection = (staged: boolean) =>
    files.some((f) => f.path === selected.path && (staged ? f.staged : f.unstaged || f.untracked));
  if (inSection(selected.staged)) return selected;
  if (inSection(!selected.staged)) return { path: selected.path, staged: !selected.staged };
  return null;
}

// Tab registry — tiers which sub-nav entries need the "advanced" git tools
// setting on. Core tabs (Changes/Branches/Sync) always show; advanced tabs
// (History/Stash/Tags/Rebase) are gated by `gitAdvancedEnabled`.
type GitTabId = "changes" | "branches" | "sync" | "history" | "stash" | "tags" | "rebase";
const GIT_TABS: { id: GitTabId; label: string; tier: "core" | "advanced" }[] = [
  { id: "changes", label: "Changes", tier: "core" },
  { id: "branches", label: "Branches", tier: "core" },
  { id: "sync", label: "Sync", tier: "core" },
  { id: "history", label: "History", tier: "advanced" },
  { id: "stash", label: "Stash", tier: "advanced" },
  { id: "tags", label: "Tags", tier: "advanced" },
  { id: "rebase", label: "Rebase", tier: "advanced" },
];

/**
 * Full-panel Git view for the app workbench — the roomy counterpart to the
 * card's GitBadge popover. Reads the same store-backed GitStatus (the Rust
 * poller keeps `appGit[app.id]` fresh) and drives the same git commands.
 *
 * Layout mirrors docs/design-mockups/08_porta_git_tab_full.html: one unified
 * panel that fills the pane, a Changes/Branches/Sync/History/Stash/Tags/Rebase
 * sub-nav, a branch pill + Sync/overflow header, and a body. Changes (two-pane
 * diff/stage/commit) and Branches (list + switch + create) are live tabs
 * backed by real git commands; Sync is an inline fetch/pull/push panel; the
 * remaining tabs render their (currently stub) panel components. The
 * History/Stash/Tags/Rebase tabs are "advanced" — hidden from the sub-nav
 * (see `GIT_TABS`) unless the user has opted into advanced git tools.
 */
export default function GitTab({ app }: { app: App }) {
  const status = usePortaStore((s) => s.appGit[app.id]);
  const setAppGit = usePortaStore((s) => s.setAppGit);
  const pollError = usePortaStore((s) => s.appGitError[app.id]);
  const setAppGitError = usePortaStore((s) => s.setAppGitError);
  const gitAdvancedEnabled = usePortaStore((s) => s.gitAdvancedEnabled);

  const [tab, setTab] = useState<GitTabId>("changes");
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [branches, setBranches] = useState<BranchList | null>(null);
  const [branchQuery, setBranchQuery] = useState("");
  const [newBranch, setNewBranch] = useState("");
  const [switching, setSwitching] = useState<string | null>(null);
  const [branchOpen, setBranchOpen] = useState(false);
  const [opsOpen, setOpsOpen] = useState(false);

  // ── Working-surface state (changed files / diff / commit box) ──────────────
  const [changed, setChanged] = useState<ChangedFile[]>([]);
  const [selected, setSelected] = useState<{ path: string; staged: boolean } | null>(null);
  const [commitMsg, setCommitMsg] = useState("");
  const [amend, setAmend] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [mutating, setMutating] = useState<string | null>(null);
  // Local "probed, not a repo" bookkeeping — the store only holds GitStatus, so
  // a non-repo can't be recorded there; this stops the seeding effect refiring.
  const probedNonRepo = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => { probedNonRepo.current = false; }, [app.root_dir]);

  // If advanced tools get disabled while an advanced tab is open, snap back
  // to Changes so the active tab is never hidden from the sub-nav.
  useEffect(() => {
    if (!gitAdvancedEnabled && GIT_TABS.find((t) => t.id === tab)?.tier === "advanced") {
      setTab("changes");
    }
  }, [gitAdvancedEnabled, tab]);

  // Seed status once if the poller hasn't written it yet.
  useEffect(() => {
    if (status || probedNonRepo.current || !app.root_dir) return;
    let cancelled = false;
    gitStatus(app.root_dir)
      .then((s) => {
        if (cancelled) return;
        if (s) setAppGit(app.id, s);
        else probedNonRepo.current = true;
      })
      .catch((e) => { if (!cancelled) setAppGitError(app.id, String(e)); });
    return () => { cancelled = true; };
  }, [app.id, app.root_dir, status, setAppGit, setAppGitError]);

  // Load branch list once we know it's a repo.
  useEffect(() => {
    if (!status || !app.root_dir) return;
    gitBranches(app.root_dir).then(setBranches).catch(() => setBranches(null));
  }, [status, app.root_dir]);

  // Load changed files once we know it's a repo (mirrors the branches effect).
  useEffect(() => {
    if (!status || !app.root_dir) return;
    let cancelled = false;
    gitChangedFiles(app.root_dir)
      .then((files) => { if (!cancelled) setChanged(files); })
      .catch(() => { if (!cancelled) setChanged([]); });
    return () => { cancelled = true; };
  }, [status, app.root_dir]);

  // Refresh both the changed-file list and the header GitStatus badge after any
  // mutation, keeping the store-backed poller value in sync — and re-derive
  // `selected` (via `deriveSelected`) against the fresh list so the diff pane
  // follows a file that moved sections instead of dead-ending. This is the
  // shared refetch handed to DiffView (per-hunk staging), StashPanel and
  // RebasePanel as `onChanged`, so all of those paths get the same treatment.
  async function refreshAfterMutation(): Promise<ChangedFile[]> {
    const [files, fresh] = await Promise.all([
      gitChangedFiles(app.root_dir),
      gitStatus(app.root_dir),
    ]);
    if (!mounted.current) return files;
    setChanged(files);
    if (fresh) setAppGit(app.id, fresh);
    setSelected((sel) => deriveSelected(files, sel));
    return files;
  }

  // stage(+) / unstage(−) / discard a whole file. `refreshAfterMutation`
  // already re-derives `selected` (see above), so there's nothing left to do
  // here once it resolves.
  async function mutateFile(path: string, fn: () => Promise<void>) {
    setMutating(path);
    setError(null);
    try {
      await fn();
      await refreshAfterMutation();
    } catch (e) {
      if (mounted.current) setError(String(e));
    } finally {
      if (mounted.current) setMutating(null);
    }
  }

  async function doCommit(thenPush: boolean) {
    const msg = commitMsg.trim();
    setCommitting(true);
    setError(null);
    try {
      if (amend) await gitCommitAmend(app.root_dir, msg);
      else await gitCommit(app.root_dir, msg);
      if (thenPush) await gitPush(app.root_dir);
      await refreshAfterMutation();
      if (!mounted.current) return;
      setCommitMsg("");
      setAmend(false);
      setSelected(null);
    } catch (e) {
      if (mounted.current) setError(String(e));
    } finally {
      if (mounted.current) setCommitting(false);
    }
  }

  async function run(kind: Exclude<Busy, null>) {
    setBusy(kind);
    setError(null);
    try {
      if (kind === "fetch") await gitFetch(app.root_dir);
      else if (kind === "pull") await gitPull(app.root_dir);
      else await gitPush(app.root_dir);
      const fresh = await gitStatus(app.root_dir);
      if (!mounted.current) return;
      if (fresh) setAppGit(app.id, fresh);
    } catch (e) {
      if (mounted.current) setError(String(e));
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  async function switchTo(name: string, create: boolean) {
    setSwitching(name);
    setError(null);
    try {
      await gitSwitchBranch(app.root_dir, name, create);
      const fresh = await gitStatus(app.root_dir);
      if (!mounted.current) return;
      if (fresh) setAppGit(app.id, fresh);
      await gitBranches(app.root_dir).then(setBranches).catch(() => {});
      setBranchQuery("");
      setNewBranch("");
      setBranchOpen(false);
    } catch (e) {
      if (mounted.current) setError(String(e));
    } finally {
      if (mounted.current) setSwitching(null);
    }
  }

  // ＋ New branch (Branches tab): git switch -c off current HEAD.
  function createBranch() {
    const name = newBranch.trim();
    if (name === "" || switching !== null) return;
    switchTo(name, true);
  }

  if (pollError) {
    return (
      <div className="p-6 max-w-xl">
        <Card>
          <div className="text-[13px] text-ink mb-1.5">Porta couldn't read this repo</div>
          <pre className="text-[11px] font-mono text-warn whitespace-pre-wrap break-words max-h-40 overflow-y-auto">{pollError}</pre>
        </Card>
      </div>
    );
  }

  if (!status) {
    return (
      <EmptyState
        title="Not a git repository"
        hint={`No .git found under ${app.root_dir || "this app's root"}.`}
      />
    );
  }

  const { branch, ahead, behind, dirty, upstream, detached } = status;

  // Merge local + unambiguous remote-only branches into a switch list.
  const rows: Array<{ name: string; kind: "local" | "remote" }> = [];
  if (branches) {
    const localSet = new Set(branches.local);
    for (const name of branches.local) rows.push({ name, kind: "local" });
    const remoteShort = new Map<string, number>();
    for (const r of branches.remote) {
      const short = r.replace(/^[^/]+\//, "");
      remoteShort.set(short, (remoteShort.get(short) ?? 0) + 1);
    }
    for (const [short, count] of remoteShort) {
      if (count === 1 && !localSet.has(short)) rows.push({ name: short, kind: "remote" });
    }
  }
  const q = branchQuery.trim();
  const filtered = rows.filter((r) => q === "" || r.name.toLowerCase().includes(q.toLowerCase()));
  const exactMatch = rows.some((r) => r.name === q);
  const showCreate = q !== "" && !exactMatch;

  const syncBusy = busy === "fetch" || busy === "pull";
  const clean = ahead === 0 && behind === 0 && dirty === 0;
  const visibleTabs = GIT_TABS.filter((t) => t.tier === "core" || gitAdvancedEnabled);

  const stagedFiles = changed.filter((f) => f.staged);
  const unstagedFiles = changed.filter((f) => f.unstaged || f.untracked);
  const canCommit = !committing && (amend || (stagedFiles.length > 0 && commitMsg.trim() !== ""));

  return (
    <div className="h-full p-3">
      <div className="h-full flex flex-col rounded-card border border-subtle bg-surface-2 overflow-hidden">
        {/* Sub-nav — Changes/Branches/Sync are live; History/Stash/Tags/Rebase
            render their (stub-for-now) panel components. */}
        <div className="flex items-center gap-1 px-3.5 py-2 border-b border-subtle text-[12px]">
          {visibleTabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-2.5 py-1 rounded-control transition-colors duration-fast ${tab === t.id ? "bg-accent-bg text-ink" : "text-ink-2 hover:bg-surface-1"}`}
            >
              {t.label}
              {t.id === "changes" && dirty > 0 && <span className="text-ink-3"> {dirty}</span>}
              {t.id === "branches" && branches && <span className="text-ink-3"> {branches.local.length}</span>}
            </button>
          ))}
          <span className="ml-auto text-[11px] text-ink-3 font-mono truncate max-w-[22ch]" title={upstream ?? undefined}>
            {upstream ? `↕ ${upstream}` : "no upstream"}
          </span>
        </div>

        {/* Branch pill + sync / overflow ops. */}
        <div className="flex items-center gap-2.5 px-3.5 py-2.5 border-b border-subtle bg-surface-1">
          <Popover
            open={branchOpen}
            onClose={() => setBranchOpen(false)}
            width="w-72"
            anchor={
              <button
                onClick={() => setBranchOpen((v) => !v)}
                className="inline-flex items-center gap-1.5 text-[12px] border border-strong rounded-control px-2 py-1 text-ink hover:bg-white/[0.05] transition-colors duration-fast"
              >
                <GitBranchIcon className="text-ink-3 shrink-0" />
                <span className="font-mono truncate max-w-[18ch]">{branch}</span>
                {detached && <Badge tone="warn">detached</Badge>}
                <ChevronDown className="text-ink-3 shrink-0" />
              </button>
            }
          >
            <div className="text-[11px] text-ink-3 px-1 pb-1.5">Switch branch</div>
            <Input
              value={branchQuery}
              onChange={(e) => setBranchQuery(e.target.value)}
              placeholder="Search or create branch…"
              autoComplete="off"
              spellCheck={false}
            />
            <div className="mt-2 flex flex-col gap-0.5 max-h-56 overflow-y-auto">
              {filtered.length === 0 && !showCreate && (
                <div className="text-[11px] text-ink-3 px-1 py-1">No matching branch.</div>
              )}
              {filtered.map((r) => {
                const isCurrent = branches?.current === r.name;
                const disabled = isCurrent || switching !== null;
                return (
                  <button
                    key={`${r.kind}:${r.name}`}
                    disabled={disabled}
                    onClick={() => switchTo(r.name, false)}
                    className="w-full flex items-center gap-1 py-1 px-1.5 rounded-control text-left text-[12px] hover:bg-white/[0.05] disabled:cursor-default disabled:hover:bg-transparent transition-colors"
                  >
                    <span className="font-mono text-ink flex-1 truncate">
                      {isCurrent && <span className="text-ok">● </span>}
                      {r.name}
                      {r.kind === "remote" && <span className="text-ink-3"> ↗</span>}
                    </span>
                    {isCurrent ? (
                      <span className="text-[10px] text-ink-3">current</span>
                    ) : switching === r.name ? (
                      <span className="text-[10px] text-ink-3">…</span>
                    ) : null}
                  </button>
                );
              })}
              {showCreate && (
                <button
                  disabled={switching !== null}
                  onClick={() => switchTo(q, true)}
                  className="mt-1 w-full text-left text-[11px] text-ok hover:bg-white/[0.05] rounded-control px-1.5 py-1.5 disabled:opacity-40"
                >
                  {switching === q ? "Creating…" : <>Create <span className="font-mono">{q}</span></>}
                </button>
              )}
            </div>
          </Popover>

          {/* Inline ahead/behind/dirty indicators. */}
          {clean ? (
            <span className="text-[11px] text-ink-3">in sync</span>
          ) : (
            <span className="inline-flex items-center gap-2 text-[11px] font-mono">
              {ahead > 0 && <span className="text-ink-2" title={`${ahead} to push`}>↑{ahead}</span>}
              {behind > 0 && <span className="text-ink-2" title={`${behind} to pull`}>↓{behind}</span>}
              {dirty > 0 && <span className="text-warn" title={`${dirty} uncommitted`}>●{dirty}</span>}
            </span>
          )}

          <div className="ml-auto flex items-center gap-1.5">
            {/* Single accent Sync — fetch, or pull when behind. */}
            <button
              onClick={() => run(behind > 0 ? "pull" : "fetch")}
              disabled={busy !== null}
              className="inline-flex items-center gap-1.5 text-[11px] text-accent-ink bg-accent-bg rounded-control px-2.5 py-1 hover:brightness-110 disabled:opacity-40 disabled:pointer-events-none transition duration-fast"
            >
              <RefreshIcon className={syncBusy ? "animate-spin" : ""} />
              {syncBusy ? "Syncing…" : "Sync"}
            </button>

            {/* Overflow: explicit Fetch / Pull / Push. */}
            <Popover
              open={opsOpen}
              onClose={() => setOpsOpen(false)}
              align="right"
              width="w-40"
              anchor={
                <button
                  onClick={() => setOpsOpen((v) => !v)}
                  className="inline-flex items-center border border-subtle rounded-control px-2 py-1 text-ink-2 hover:bg-white/[0.05] transition-colors duration-fast"
                  aria-label="More git actions"
                >
                  <DotsIcon />
                </button>
              }
            >
              <button
                onClick={() => { setOpsOpen(false); run("fetch"); }}
                disabled={busy !== null}
                className="w-full text-left text-[12px] px-2 py-1.5 rounded-lg text-ink hover:bg-white/[0.05] disabled:opacity-40 disabled:pointer-events-none transition-colors"
              >
                {busy === "fetch" ? "Fetching…" : "Fetch"}
              </button>
              <button
                onClick={() => { setOpsOpen(false); run("pull"); }}
                disabled={busy !== null || behind === 0}
                className="w-full text-left text-[12px] px-2 py-1.5 rounded-lg text-ink hover:bg-white/[0.05] disabled:opacity-40 disabled:pointer-events-none transition-colors"
              >
                {busy === "pull" ? "Pulling…" : "Pull"}
              </button>
              <button
                onClick={() => { setOpsOpen(false); run("push"); }}
                disabled={busy !== null || ahead === 0}
                className="w-full text-left text-[12px] px-2 py-1.5 rounded-lg text-ink hover:bg-white/[0.05] disabled:opacity-40 disabled:pointer-events-none transition-colors"
              >
                {busy === "push" ? "Pushing…" : "Push"}
              </button>
            </Popover>
          </div>
        </div>

        {/* Body — Branches list, Sync panel, stub panels, or the two-pane
            Changes working surface. */}
        {tab === "sync" ? (
          <div className="flex-1 min-h-0 flex flex-col gap-3 p-4">
            {error && (
              <pre className="shrink-0 text-[11px] font-mono text-bad whitespace-pre-wrap break-words max-h-32 overflow-y-auto rounded-control border border-subtle bg-surface-code px-2.5 py-2">{error}</pre>
            )}
            <div className="flex items-center gap-2">
              <Button size="sm" loading={busy === "fetch"} disabled={busy !== null} onClick={() => run("fetch")}>
                Fetch
              </Button>
              <Button size="sm" loading={busy === "pull"} disabled={busy !== null || behind === 0} onClick={() => run("pull")}>
                Pull
              </Button>
              <Button size="sm" loading={busy === "push"} disabled={busy !== null || ahead === 0} onClick={() => run("push")}>
                Push
              </Button>
            </div>
            <div className="text-[12px] text-ink-3">
              {clean ? (
                <>Up to date{upstream ? ` with ${upstream}` : ""}.</>
              ) : (
                <>
                  {ahead > 0 && `${ahead} to push`}
                  {ahead > 0 && behind > 0 && " · "}
                  {behind > 0 && `${behind} to pull`}
                  {upstream ? ` (${upstream})` : ""}
                </>
              )}
            </div>
          </div>
        ) : tab === "history" ? (
          <HistoryPanel app={app} />
        ) : tab === "stash" ? (
          <StashPanel app={app} onChanged={refreshAfterMutation} />
        ) : tab === "tags" ? (
          <TagsPanel app={app} />
        ) : tab === "rebase" ? (
          <RebasePanel app={app} onChanged={refreshAfterMutation} />
        ) : tab === "branches" ? (
          <div className="flex-1 min-h-0 flex flex-col">
            {error && (
              <pre className="shrink-0 text-[11px] font-mono text-bad whitespace-pre-wrap break-words max-h-32 overflow-y-auto rounded-control border border-subtle bg-surface-code px-2.5 py-2 m-3 mb-0">{error}</pre>
            )}

            {/* ＋ New branch — git switch -c off current HEAD. */}
            <div className="shrink-0 flex items-center gap-2 px-3.5 py-2.5 border-b border-subtle">
              <Input
                value={newBranch}
                onChange={(e) => setNewBranch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); createBranch(); }
                }}
                placeholder="New branch name…"
                autoComplete="off"
                spellCheck={false}
              />
              <Button
                size="sm"
                icon={<PlusIcon />}
                loading={switching !== null && switching === newBranch.trim()}
                disabled={newBranch.trim() === "" || switching !== null}
                onClick={createBranch}
                className="shrink-0 whitespace-nowrap"
              >
                New branch
              </Button>
            </div>

            {/* Local branch list — current is highlighted; others get a Switch. */}
            <div className="flex-1 min-h-0 overflow-y-auto py-1">
              {!branches ? (
                <div className="inline-flex items-center gap-2 px-3.5 py-3 text-[12px] text-ink-3">
                  <Spinner size={12} /> Loading branches…
                </div>
              ) : branches.local.length === 0 ? (
                <div className="px-3.5 py-3 text-[12px] text-ink-3">No local branches.</div>
              ) : (
                branches.local.map((name) => {
                  const isCurrent = branches.current === name;
                  return (
                    <div
                      key={name}
                      className={`flex items-center gap-2.5 mx-1 px-2.5 py-1.5 rounded-control transition-colors duration-fast ${isCurrent ? "bg-accent-bg" : "hover:bg-white/[0.04]"}`}
                    >
                      <GitBranchIcon className={`shrink-0 ${isCurrent ? "text-accent" : "text-ink-3"}`} />
                      <span className="flex-1 min-w-0 truncate font-mono text-[12px] text-ink" title={name}>
                        {name}
                        {isCurrent && <span className="text-ok"> ●</span>}
                      </span>
                      {isCurrent ? (
                        <span className="shrink-0 text-[10px] text-ink-3">current</span>
                      ) : (
                        <Button
                          size="sm"
                          loading={switching === name}
                          disabled={switching !== null}
                          onClick={() => switchTo(name, false)}
                          className="shrink-0"
                        >
                          Switch
                        </Button>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        ) : (
        <div className="flex-1 min-h-0 flex flex-col">
          {error && (
            <pre className="shrink-0 text-[11px] font-mono text-bad whitespace-pre-wrap break-words max-h-32 overflow-y-auto rounded-control border border-subtle bg-surface-code px-2.5 py-2 m-3 mb-0">{error}</pre>
          )}

          {changed.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center gap-2 py-8">
              <div className="w-10 h-10 rounded-xl bg-white/[0.04] flex items-center justify-center text-ink-3">
                <GitBranchIcon className="scale-125" />
              </div>
              <div className="text-[13px] text-ink">Working tree clean</div>
              <p className="text-[12px] text-ink-3 max-w-xs">
                Nothing staged or modified.
                {(ahead > 0 || behind > 0) && (
                  <>
                    {" "}
                    {ahead > 0 && `${ahead} to push`}
                    {ahead > 0 && behind > 0 && " · "}
                    {behind > 0 && `${behind} to pull`}
                    .
                  </>
                )}
              </p>
            </div>
          ) : (
            <div className="flex-1 min-h-0 flex">
              {/* Left pane — Staged / Changes sections. */}
              <div className="w-[240px] shrink-0 border-r border-subtle overflow-y-auto py-1">
                {stagedFiles.length > 0 && (
                  <>
                    <div className="text-[10px] uppercase tracking-wide text-ink-3 px-3 pt-2 pb-1">
                      Staged Changes · {stagedFiles.length}
                    </div>
                    {stagedFiles.map((f) => (
                      <FileRow
                        key={`staged:${f.path}`}
                        file={f}
                        staged
                        active={selected?.path === f.path && selected?.staged === true}
                        busy={mutating === f.path}
                        onSelect={() => setSelected({ path: f.path, staged: true })}
                        onToggle={() => mutateFile(f.path, () => gitUnstage(app.root_dir, f.path))}
                        onDiscard={() => mutateFile(f.path, () => gitDiscard(app.root_dir, f.path))}
                      />
                    ))}
                  </>
                )}
                {unstagedFiles.length > 0 && (
                  <>
                    <div className="text-[10px] uppercase tracking-wide text-ink-3 px-3 pt-2 pb-1">
                      Changes · {unstagedFiles.length}
                    </div>
                    {unstagedFiles.map((f) => (
                      <FileRow
                        key={`work:${f.path}`}
                        file={f}
                        staged={false}
                        active={selected?.path === f.path && selected?.staged === false}
                        busy={mutating === f.path}
                        onSelect={() => setSelected({ path: f.path, staged: false })}
                        onToggle={() => mutateFile(f.path, () => gitStage(app.root_dir, f.path))}
                        onDiscard={() => mutateFile(f.path, () => gitDiscard(app.root_dir, f.path))}
                      />
                    ))}
                  </>
                )}
              </div>

              {/* Right pane — unified diff + commit box. */}
              <div className="flex-1 min-w-0 flex flex-col">
                <div className="flex-1 min-h-0 overflow-auto bg-surface-code font-mono text-[11px] leading-[1.7] px-3 py-2.5">
                  {!selected ? (
                    <div className="h-full flex items-center justify-center text-ink-3 text-[12px] font-sans">
                      Select a file to view its diff
                    </div>
                  ) : (
                    <DiffView
                      app={app}
                      path={selected.path}
                      staged={selected.staged}
                      onChanged={refreshAfterMutation}
                    />
                  )}
                </div>

                {/* Commit box. */}
                <div className="shrink-0 border-t border-subtle p-3 bg-surface-1">
                  <textarea
                    value={commitMsg}
                    onChange={(e) => setCommitMsg(e.target.value)}
                    onKeyDown={(e) => {
                      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                        e.preventDefault();
                        if (canCommit) doCommit(false);
                      }
                    }}
                    placeholder={amend ? "Amend message (blank keeps existing)…" : "Commit message…"}
                    rows={2}
                    spellCheck={false}
                    className="w-full resize-none rounded-control border border-subtle bg-surface-input text-[12px] text-ink placeholder:text-ink-3 px-2.5 py-1.5 mb-2 focus:outline-none focus:border-strong"
                  />
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => doCommit(false)}
                      disabled={!canCommit}
                      className="text-[11px] text-accent-ink bg-accent-bg rounded-control px-3 py-1 hover:brightness-110 disabled:opacity-40 disabled:pointer-events-none transition duration-fast"
                    >
                      {committing ? "Committing…" : amend ? "Amend" : "Commit"}
                    </button>
                    <button
                      onClick={() => doCommit(true)}
                      disabled={!canCommit}
                      className="text-[11px] text-ink border border-strong rounded-control px-3 py-1 hover:bg-white/[0.05] disabled:opacity-40 disabled:pointer-events-none transition-colors duration-fast"
                    >
                      Commit &amp; push
                    </button>
                    <button
                      onClick={() => setAmend((v) => !v)}
                      className={`ml-auto inline-flex items-center gap-1.5 text-[11px] rounded-control px-2 py-1 transition-colors duration-fast ${amend ? "text-accent" : "text-ink-2 hover:bg-white/[0.05]"}`}
                      aria-pressed={amend}
                    >
                      <CheckboxIcon checked={amend} />
                      Amend
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
        )}
      </div>
    </div>
  );
}

// ── One row in the changes list ─────────────────────────────────────────────
function FileRow({
  file,
  staged,
  active,
  busy,
  onSelect,
  onToggle,
  onDiscard,
}: {
  file: ChangedFile;
  staged: boolean;
  active: boolean;
  busy: boolean;
  onSelect: () => void;
  onToggle: () => void;
  onDiscard: () => void;
}) {
  const { char, cls } = statusBadge(file, staged);
  const { dir, base } = splitPath(file.path);
  return (
    <div
      onClick={onSelect}
      className={`group flex items-center gap-2 mx-1 px-2 py-1 rounded-control cursor-pointer transition-colors duration-fast ${active ? "bg-accent-bg" : "hover:bg-white/[0.04]"}`}
    >
      <span className={`w-3 shrink-0 text-center font-mono text-[11px] ${cls}`}>{char}</span>
      <span className="flex-1 min-w-0 truncate font-mono text-[12px]" title={file.path}>
        <span className="text-ink-3">{dir}</span>
        <span className="text-ink">{base}</span>
      </span>
      <button
        onClick={(e) => { e.stopPropagation(); onDiscard(); }}
        disabled={busy}
        title="Discard changes"
        className="shrink-0 opacity-0 group-hover:opacity-100 text-ink-3 hover:text-bad disabled:opacity-30 transition-colors"
      >
        <TrashIcon />
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); onToggle(); }}
        disabled={busy}
        title={staged ? "Unstage" : "Stage"}
        className="shrink-0 text-ink-3 hover:text-ink disabled:opacity-30 transition-colors"
      >
        {staged ? <MinusIcon /> : <PlusIcon />}
      </button>
    </div>
  );
}
