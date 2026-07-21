import { useEffect, useRef, useState } from "react";
import { usePortaStore } from "../../store";
import {
  gitStatus,
  gitFetch,
  gitPull,
  gitPush,
  gitBranches,
  gitSwitchBranch,
  gitWorktreeList,
  type BranchList,
  type WorktreeEntry,
} from "../../lib/commands";
import { GIT_THEMES, type GitTheme } from "../../lib/git-theme";
import { Card, Input, EmptyState, Badge, Popover } from "../ui";
import type { App } from "../../types";
import HistoryPanel from "./git/HistoryPanel";
import StashPanel from "./git/StashPanel";
import TagsPanel from "./git/TagsPanel";
import RebasePanel from "./git/RebasePanel";
import StatusTab from "./git/StatusTab";
import BranchesPanel from "./git/BranchesPanel";
import SyncPanel from "./git/SyncPanel";
import PullRequestsPanel from "./git/PullRequestsPanel";

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

// Tab registry — tiers which sub-nav entries need the "advanced" git tools
// setting on. Core tabs (Changes/Branches/Sync) always show; advanced tabs
// (History/Stash/Tags/Rebase) are gated by `gitAdvancedEnabled`.
type GitTabId = "changes" | "branches" | "sync" | "history" | "pull-requests" | "stash" | "tags" | "rebase";
const GIT_TABS: { id: GitTabId; label: string; tier: "core" | "advanced" }[] = [
  { id: "changes", label: "Status", tier: "core" },
  { id: "history", label: "History", tier: "advanced" },
  { id: "pull-requests", label: "Pull Requests", tier: "advanced" },
  { id: "sync", label: "Sync", tier: "core" },
  { id: "branches", label: "Branches", tier: "core" },
  { id: "rebase", label: "Rebase", tier: "advanced" },
  { id: "stash", label: "Stash", tier: "advanced" },
  { id: "tags", label: "Tags", tier: "advanced" },
];

/**
 * Full-panel Git view for the app workbench — the roomy counterpart to the
 * card's GitBadge popover. Reads the same store-backed GitStatus (the Rust
 * poller keeps `appGit[app.id]` fresh) and drives the same git commands.
 *
 * This component is the shell only: the theme root, a branch pill + Sync/
 * overflow header, the Changes/Branches/Sync/History/Stash/Tags/Rebase sub-nav
 * and the body switch. Every tab's content lives in its own component under
 * ./git/ — Status included (`StatusTab`). The History/PR/Stash/Tags/Rebase tabs
 * are "advanced" — hidden from the sub-nav (see `GIT_TABS`) unless the user has
 * opted into advanced git tools. Status is the one tab that stays mounted while
 * another tab is showing, so a commit draft survives the round trip.
 *
 * The whole tree hangs off `.git-tab-root`, which is what scopes the seven git
 * palettes (src/styles/git-theme.css) to this tab and nothing else.
 */
export default function GitTab({ app }: { app: App }) {
  const status = usePortaStore((s) => s.appGit[app.id]);
  const setAppGit = usePortaStore((s) => s.setAppGit);
  const pollError = usePortaStore((s) => s.appGitError[app.id]);
  const setAppGitError = usePortaStore((s) => s.setAppGitError);
  const gitAdvancedEnabled = usePortaStore((s) => s.gitAdvancedEnabled);
  const gitTheme = usePortaStore((s) => s.gitTheme);
  const setGitTheme = usePortaStore((s) => s.setGitTheme);

  const [tab, setTab] = useState<GitTabId>("changes");
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [branches, setBranches] = useState<BranchList | null>(null);
  const [worktrees, setWorktrees] = useState<WorktreeEntry[]>([]);
  const [branchQuery, setBranchQuery] = useState("");
  const [switching, setSwitching] = useState<string | null>(null);
  const [branchOpen, setBranchOpen] = useState(false);
  const [opsOpen, setOpsOpen] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);

  // Local "probed, not a repo" bookkeeping — the store only holds GitStatus, so
  // a non-repo can't be recorded there; this stops the seeding effect refiring.
  const probedNonRepo = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => { probedNonRepo.current = false; }, [app.root_dir]);

  // The error surface sits above the body, so it is on screen for every tab.
  // Nothing else clears it on navigation, and a stale sync failure trailing the
  // user through Branches/Tags/History reads as a fresh failure there — so
  // changing tabs dismisses it.
  useEffect(() => { setError(null); }, [tab]);

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

  // Load branch + worktree lists together. Git refuses to switch a branch
  // already checked out by another worktree, so the UI needs both datasets to
  // explain and disable that action before it reaches the backend.
  useEffect(() => {
    if (!status || !app.root_dir) return;
    gitBranches(app.root_dir).then(setBranches).catch(() => setBranches(null));
    gitWorktreeList(app.root_dir).then(setWorktrees).catch(() => setWorktrees([]));
  }, [status, app.root_dir]);

  // Refresh the header GitStatus badge after a mutation in any tab, keeping the
  // store-backed poller value in sync. Handed to every panel as `onChanged`;
  // the Status tab owns its own changed-file refetch (see StatusTab).
  async function refreshStatus() {
    const fresh = await gitStatus(app.root_dir);
    if (!mounted.current) return;
    if (fresh) setAppGit(app.id, fresh);
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

  // The store applies the palette immediately and then writes it to the Tauri
  // config; if that write fails the picker would otherwise look like it stuck
  // while silently reverting on the next launch. Surface it on the shell's
  // error line instead. No revert: the store setter is the only writer and
  // calling it again would just fail the same way.
  async function pickTheme(id: GitTheme) {
    setError(null);
    try {
      await setGitTheme(id);
    } catch (e) {
      if (mounted.current) setError(`Couldn't save the theme: ${String(e)}`);
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
      await Promise.all([
        gitBranches(app.root_dir).then(setBranches).catch(() => {}),
        gitWorktreeList(app.root_dir).then(setWorktrees).catch(() => {}),
      ]);
      setBranchQuery("");
      setBranchOpen(false);
    } catch (e) {
      if (mounted.current) setError(String(e));
    } finally {
      if (mounted.current) setSwitching(null);
    }
  }

  if (pollError) {
    return (
      <div className="git-tab-root h-full" data-git-theme={gitTheme}>
        <div className="p-6 max-w-xl">
          <Card>
            <div className="text-[13px] text-ink mb-1.5">Porta couldn't read this repo</div>
            <pre className="text-[11px] font-mono text-warn whitespace-pre-wrap break-words max-h-40 overflow-y-auto">{pollError}</pre>
          </Card>
        </div>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="git-tab-root h-full" data-git-theme={gitTheme}>
        <EmptyState
          title="Not a git repository"
          hint={`No .git found under ${app.root_dir || "this app's root"}.`}
        />
      </div>
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
  const branchWorktrees = new Map(
    worktrees
      .filter((worktree) => worktree.path !== app.root_dir && worktree.branch)
      .map((worktree) => [worktree.branch as string, worktree.path]),
  );

  const syncBusy = busy === "fetch" || busy === "pull";
  const clean = ahead === 0 && behind === 0 && dirty === 0;
  const visibleTabs = GIT_TABS.filter((t) => t.tier === "core" || gitAdvancedEnabled);

  return (
    <div className="git-tab-root h-full p-3" data-git-theme={gitTheme}>
      <div className="h-full flex flex-col rounded-card border border-subtle bg-surface-2 overflow-hidden">
        {/* Sub-nav — core and advanced native Git workflows. */}
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
                className="inline-flex items-center gap-1.5 text-[12px] border border-strong rounded-control px-2 py-1 text-ink hover:bg-[var(--hover)] transition-colors duration-fast"
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
                const worktreePath = branchWorktrees.get(r.name);
                const disabled = isCurrent || !!worktreePath || switching !== null;
                return (
                  <button
                    key={`${r.kind}:${r.name}`}
                    disabled={disabled}
                    onClick={() => switchTo(r.name, false)}
                    title={worktreePath ? `Checked out in ${worktreePath}` : r.name}
                    className="w-full flex items-center gap-1 py-1 px-1.5 rounded-control text-left text-[12px] hover:bg-[var(--hover)] disabled:cursor-default disabled:hover:bg-transparent transition-colors"
                  >
                    <span className="font-mono text-ink flex-1 truncate">
                      {isCurrent && <span className="text-ok">● </span>}
                      {r.name}
                      {r.kind === "remote" && <span className="text-ink-3"> ↗</span>}
                    </span>
                    {isCurrent ? (
                      <span className="text-[10px] text-ink-3">current</span>
                    ) : worktreePath ? (
                      <span className="text-[10px] text-warn shrink-0">in worktree</span>
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
                  className="mt-1 w-full text-left text-[11px] text-ok hover:bg-[var(--hover)] rounded-control px-1.5 py-1.5 disabled:opacity-40"
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

            {/* Palette picker — scoped to this tab via `.git-tab-root`. */}
            <Popover
              open={themeOpen}
              onClose={() => setThemeOpen(false)}
              align="right"
              width="w-40"
              anchor={
                <button
                  onClick={() => setThemeOpen((v) => !v)}
                  className="inline-flex items-center gap-1.5 text-[11px] border border-subtle rounded-control px-2 py-1 text-ink-2 hover:bg-[var(--hover)] transition-colors duration-fast"
                >
                  Theme
                  <ChevronDown className="text-ink-3 shrink-0" />
                </button>
              }
            >
              <div role="menu" aria-label="Git tab theme">
                {GIT_THEMES.map((t) => (
                  <button
                    key={t.id}
                    role="menuitem"
                    onClick={() => { setThemeOpen(false); void pickTheme(t.id); }}
                    className={`w-full text-left text-[12px] px-2 py-1.5 rounded-lg hover:bg-[var(--hover)] transition-colors ${t.id === gitTheme ? "text-accent" : "text-ink"}`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </Popover>

            {/* Overflow: explicit Fetch / Pull / Push. */}
            <Popover
              open={opsOpen}
              onClose={() => setOpsOpen(false)}
              align="right"
              width="w-40"
              anchor={
                <button
                  onClick={() => setOpsOpen((v) => !v)}
                  className="inline-flex items-center border border-subtle rounded-control px-2 py-1 text-ink-2 hover:bg-[var(--hover)] transition-colors duration-fast"
                  aria-label="More git actions"
                >
                  <DotsIcon />
                </button>
              }
            >
              <button
                onClick={() => { setOpsOpen(false); run("fetch"); }}
                disabled={busy !== null}
                className="w-full text-left text-[12px] px-2 py-1.5 rounded-lg text-ink hover:bg-[var(--hover)] disabled:opacity-40 disabled:pointer-events-none transition-colors"
              >
                {busy === "fetch" ? "Fetching…" : "Fetch"}
              </button>
              <button
                onClick={() => { setOpsOpen(false); run("pull"); }}
                disabled={busy !== null || behind === 0}
                className="w-full text-left text-[12px] px-2 py-1.5 rounded-lg text-ink hover:bg-[var(--hover)] disabled:opacity-40 disabled:pointer-events-none transition-colors"
              >
                {busy === "pull" ? "Pulling…" : "Pull"}
              </button>
              <button
                onClick={() => { setOpsOpen(false); run("push"); }}
                disabled={busy !== null || ahead === 0}
                className="w-full text-left text-[12px] px-2 py-1.5 rounded-lg text-ink hover:bg-[var(--hover)] disabled:opacity-40 disabled:pointer-events-none transition-colors"
              >
                {busy === "push" ? "Pushing…" : "Push"}
              </button>
            </Popover>
          </div>
        </div>

        {/* Shell-level failures (sync ops, branch switch). */}
        {error && (
          <pre className="shrink-0 text-[11px] font-mono text-bad whitespace-pre-wrap break-words max-h-32 overflow-y-auto rounded-control border border-subtle bg-surface-code px-2.5 py-2 m-3 mb-0">{error}</pre>
        )}

        {/* Body — one component per tab.
            Status is deliberately outside the switch: it holds user-authored
            draft state (commit message, staged selection, an in-progress
            rename) plus an already-loaded changed-file list, none of which may
            be thrown away by a trip to History and back. It stays mounted and
            is hidden while another tab is active; the `hidden` attribute keeps
            it out of the a11y tree, the class does the layout. Every other tab
            keeps its mount-on-demand behaviour — none of them holds a draft. */}
        <div
          className={tab === "changes" ? "flex-1 min-h-0 flex flex-col" : "hidden"}
          hidden={tab !== "changes"}
        >
          <StatusTab app={app} />
        </div>

        {tab === "sync" ? (
          <SyncPanel app={app} status={status} onChanged={refreshStatus} />
        ) : tab === "history" ? (
          <HistoryPanel app={app} onChanged={refreshStatus} />
        ) : tab === "pull-requests" ? (
          <PullRequestsPanel
            app={app}
            currentBranch={branch}
            onRepositoryChanged={refreshStatus}
          />
        ) : tab === "stash" ? (
          <StashPanel app={app} onChanged={refreshStatus} />
        ) : tab === "tags" ? (
          <TagsPanel app={app} />
        ) : tab === "rebase" ? (
          <RebasePanel app={app} onChanged={refreshStatus} />
        ) : tab === "branches" ? (
          <BranchesPanel app={app} onRepositoryChanged={async () => {
            const [fresh, list] = await Promise.all([
              gitStatus(app.root_dir),
              gitBranches(app.root_dir),
            ]);
            if (fresh) setAppGit(app.id, fresh);
            setBranches(list);
          }} />
        ) : null}
      </div>
    </div>
  );
}
