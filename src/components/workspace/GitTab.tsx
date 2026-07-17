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
import { Button, Card, Input, EmptyState, Badge } from "../ui";
import type { App } from "../../types";

type Busy = "fetch" | "pull" | "push" | null;

/**
 * Full-panel Git view for the app workbench — the roomy counterpart to the
 * card's GitBadge popover. Reads the same store-backed GitStatus (the Rust
 * poller keeps `appGit[app.id]` fresh) and drives the same git commands.
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

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-xl space-y-4">
        {/* Status + ops */}
        <Card>
          <div className="flex items-center gap-2 mb-3">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="text-ink-3 shrink-0">
              <circle cx="4.5" cy="3.5" r="1.75" stroke="currentColor" strokeWidth="1.3" />
              <circle cx="4.5" cy="12.5" r="1.75" stroke="currentColor" strokeWidth="1.3" />
              <circle cx="11.5" cy="4.5" r="1.75" stroke="currentColor" strokeWidth="1.3" />
              <path d="M4.5 5.25v5.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              <path d="M11.5 6.25c0 2.6-1.9 3.5-4.2 3.9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
            <span className="font-mono text-[14px] text-ink truncate">{branch}</span>
            {detached && <Badge tone="warn">detached</Badge>}
            <span className="ml-auto text-[11px] text-ink-3 font-mono truncate max-w-[16ch]">{upstream ?? "no upstream"}</span>
          </div>

          <div className="grid grid-cols-3 gap-2 mb-3">
            <div className="rounded-control bg-surface-2 px-2.5 py-2">
              <div className="text-[16px] font-mono text-ink">{ahead}</div>
              <div className="text-[10px] text-ink-3">to push ↑</div>
            </div>
            <div className="rounded-control bg-surface-2 px-2.5 py-2">
              <div className="text-[16px] font-mono text-ink">{behind}</div>
              <div className="text-[10px] text-ink-3">to pull ↓</div>
            </div>
            <div className="rounded-control bg-surface-2 px-2.5 py-2">
              <div className="text-[16px] font-mono text-ink">{dirty}</div>
              <div className="text-[10px] text-ink-3">dirty ●</div>
            </div>
          </div>

          <div className="flex gap-2">
            <Button onClick={() => run("fetch")} disabled={busy !== null}>{busy === "fetch" ? "Fetching…" : "Fetch"}</Button>
            <Button onClick={() => run("pull")} disabled={busy !== null || behind === 0}>{busy === "pull" ? "Pulling…" : "Pull"}</Button>
            <Button variant="primary" onClick={() => run("push")} disabled={busy !== null || ahead === 0}>{busy === "push" ? "Pushing…" : "Push"}</Button>
          </div>
        </Card>

        {/* Branch switcher */}
        <Card>
          <div className="text-[12px] text-ink-2 mb-2">Switch branch</div>
          <Input
            value={branchQuery}
            onChange={(e) => setBranchQuery(e.target.value)}
            placeholder="Search or create branch…"
            autoComplete="off"
            spellCheck={false}
          />
          <div className="mt-2 flex flex-col gap-0.5 max-h-64 overflow-y-auto">
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
                  className="w-full flex items-center gap-1 py-1 px-1.5 rounded-control text-left text-[12px] hover:bg-surface-2 disabled:cursor-default disabled:hover:bg-transparent transition-colors"
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
                className="mt-1 w-full text-left text-[11px] text-ok hover:bg-surface-2 rounded-control px-1.5 py-1.5 disabled:opacity-40"
              >
                {switching === q ? "Creating…" : <>Create <span className="font-mono">{q}</span></>}
              </button>
            )}
          </div>
        </Card>

        {error && (
          <Card>
            <pre className="text-[11px] font-mono text-bad whitespace-pre-wrap break-words max-h-32 overflow-y-auto">{error}</pre>
          </Card>
        )}
      </div>
    </div>
  );
}
