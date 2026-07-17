import { useEffect, useRef, useState } from "react";
import { usePortaStore } from "../../store";
import {
  gitStatus,
  gitFetch,
  gitPull,
  gitPush,
  gitBranches,
  gitSwitchBranch,
  type BranchList,
} from "../../lib/commands";
import { Card, Input, EmptyState, Badge, Popover } from "../ui";
import type { App } from "../../types";

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

/**
 * Full-panel Git view for the app workbench — the roomy counterpart to the
 * card's GitBadge popover. Reads the same store-backed GitStatus (the Rust
 * poller keeps `appGit[app.id]` fresh) and drives the same git commands.
 *
 * Layout mirrors docs/design-mockups/08_porta_git_tab_full.html: one unified
 * panel that fills the pane, a Changes/History/… sub-nav, a branch pill +
 * Sync/overflow header, and a body. There is NO file-diff/staging backend, so
 * History/Branches/Pull-requests are disabled placeholders and the Changes
 * body shows an honest summary rather than a fabricated file list.
 */
export default function GitTab({ app }: { app: App }) {
  const status = usePortaStore((s) => s.appGit[app.id]);
  const setAppGit = usePortaStore((s) => s.setAppGit);
  const pollError = usePortaStore((s) => s.appGitError[app.id]);
  const setAppGitError = usePortaStore((s) => s.setAppGitError);

  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [branches, setBranches] = useState<BranchList | null>(null);
  const [branchQuery, setBranchQuery] = useState("");
  const [switching, setSwitching] = useState<string | null>(null);
  const [branchOpen, setBranchOpen] = useState(false);
  const [opsOpen, setOpsOpen] = useState(false);
  // Local "probed, not a repo" bookkeeping — the store only holds GitStatus, so
  // a non-repo can't be recorded there; this stops the seeding effect refiring.
  const probedNonRepo = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => { probedNonRepo.current = false; }, [app.root_dir]);

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
      setBranchOpen(false);
    } catch (e) {
      if (mounted.current) setError(String(e));
    } finally {
      if (mounted.current) setSwitching(null);
    }
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

  return (
    <div className="h-full p-3">
      <div className="h-full flex flex-col rounded-card border border-subtle bg-surface-2 overflow-hidden">
        {/* Sub-nav — Changes is live; the rest are disabled placeholders (no backend). */}
        <div className="flex items-center gap-3.5 px-3.5 py-2 border-b border-subtle text-[12px]">
          <span className="text-ink border-b-[1.5px] border-accent pb-2 -mb-2 cursor-default">
            Changes{dirty > 0 && <span className="text-ink-3"> {dirty}</span>}
          </span>
          <span className="text-ink-3 cursor-default" title="Not available yet">History</span>
          <span className="text-ink-3 cursor-default" title="Not available yet">Branches</span>
          <span className="text-ink-3 cursor-default" title="Not available yet">Pull requests</span>
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

        {/* Body — no diff/staging backend, so an honest summary (never a fake file list). */}
        <div className="flex-1 overflow-y-auto px-3.5 py-2.5 flex flex-col">
          {error && (
            <pre className="text-[11px] font-mono text-bad whitespace-pre-wrap break-words max-h-32 overflow-y-auto rounded-control border border-subtle bg-surface-code px-2.5 py-2 mb-3">{error}</pre>
          )}
          <div className="flex-1 flex flex-col items-center justify-center text-center gap-2 py-8">
            <div className="w-10 h-10 rounded-xl bg-white/[0.04] flex items-center justify-center text-ink-3">
              <GitBranchIcon className="scale-125" />
            </div>
            <div className="text-[13px] text-ink">
              {dirty > 0 ? `${dirty} uncommitted change${dirty === 1 ? "" : "s"}` : "Working tree clean"}
            </div>
            <p className="text-[12px] text-ink-3 max-w-xs">
              Porta doesn't show a file-level diff yet. Use the terminal for staging &amp; commits.
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
        </div>
      </div>
    </div>
  );
}
