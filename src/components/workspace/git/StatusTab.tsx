import { useEffect, useRef, useState } from "react";
import { usePortaStore } from "../../../store";
import {
  gitStatus,
  gitPush,
  gitChangedFiles,
  gitStage,
  gitUnstage,
  gitDiscard,
  gitDiscardAll,
  gitRenamePath,
  gitCommit,
  gitCommitAmend,
  gitStageAll,
  gitUnstageAll,
  type ChangedFile,
} from "../../../lib/commands";
import { Input } from "../../ui";
import type { App } from "../../../types";
import DiffView from "./DiffView";
import FileTree from "./FileTree";

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
function CheckboxIcon({ checked, className = "" }: { checked: boolean; className?: string }) {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <rect x="2.5" y="2.5" width="11" height="11" rx="2.5" stroke="currentColor" strokeWidth="1.3" />
      {checked && <path d="M5 8.2l2 2 4-4.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  );
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

/**
 * The Status tab's two-pane working surface: a Staged/Changes file list on the
 * left, a unified diff plus the commit box on the right. Split out of GitTab
 * so the shell stays a shell; the behaviour is unchanged from when it lived
 * there. The shell keeps this mounted (hidden) on every other tab and while a
 * repo is unreadable or missing, so the commit draft survives; the effects
 * below therefore no-op until the store has a GitStatus for the app.
 */
export default function StatusTab({ app }: { app: App }) {
  const status = usePortaStore((s) => s.appGit[app.id]);
  const setAppGit = usePortaStore((s) => s.setAppGit);

  const [error, setError] = useState<string | null>(null);

  // ── Working-surface state (changed files / diff / commit box) ──────────────
  const [changed, setChanged] = useState<ChangedFile[]>([]);
  const [selected, setSelected] = useState<{ path: string; staged: boolean } | null>(null);
  const [commitMsg, setCommitMsg] = useState("");
  const [amend, setAmend] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [mutating, setMutating] = useState<string | null>(null);
  const [confirmDiscardAll, setConfirmDiscardAll] = useState(false);
  const [checkedStaged, setCheckedStaged] = useState<Set<string>>(new Set());
  const [checkedUnstaged, setCheckedUnstaged] = useState<Set<string>>(new Set());
  const [confirmDiscardSelected, setConfirmDiscardSelected] = useState(false);
  const [renameTarget, setRenameTarget] = useState<{ path: string; staged: boolean } | null>(null);
  const [renameName, setRenameName] = useState("");
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

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
  // shared refetch handed to DiffView (per-hunk staging), so that path gets the
  // same treatment.
  async function refreshAfterMutation(): Promise<ChangedFile[]> {
    const [files, fresh] = await Promise.all([
      gitChangedFiles(app.root_dir),
      gitStatus(app.root_dir),
    ]);
    if (!mounted.current) return files;
    setChanged(files);
    if (fresh) setAppGit(app.id, fresh);
    setSelected((sel) => deriveSelected(files, sel));
    const stagedPaths = new Set(files.filter((file) => file.staged).map((file) => file.path));
    const unstagedPaths = new Set(files.filter((file) => file.unstaged || file.untracked).map((file) => file.path));
    setCheckedStaged((previous) => new Set([...previous].filter((path) => stagedPaths.has(path))));
    setCheckedUnstaged((previous) => new Set([...previous].filter((path) => unstagedPaths.has(path))));
    return files;
  }

  function toggleChecked(stagedSection: boolean, path: string) {
    const setter = stagedSection ? setCheckedStaged : setCheckedUnstaged;
    setter((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    setConfirmDiscardSelected(false);
  }

  function setManyChecked(stagedSection: boolean, paths: string[], nextChecked: boolean) {
    const setter = stagedSection ? setCheckedStaged : setCheckedUnstaged;
    setter((previous) => {
      const next = new Set(previous);
      for (const path of paths) {
        if (nextChecked) next.add(path);
        else next.delete(path);
      }
      return next;
    });
    setConfirmDiscardSelected(false);
  }

  async function mutateSelected(kind: "stage" | "unstage" | "discard") {
    setMutating(`selected:${kind}`);
    setError(null);
    try {
      if (kind === "stage") {
        for (const path of checkedUnstaged) await gitStage(app.root_dir, path);
      } else if (kind === "unstage") {
        for (const path of checkedStaged) await gitUnstage(app.root_dir, path);
      } else {
        const selectedPaths = new Map<string, boolean>();
        for (const path of checkedUnstaged) selectedPaths.set(path, false);
        for (const path of checkedStaged) selectedPaths.set(path, true);
        for (const [path, stagedSection] of selectedPaths) {
          await gitDiscard(app.root_dir, path, stagedSection);
        }
      }
      await refreshAfterMutation();
      if (!mounted.current) return;
      setCheckedStaged(new Set());
      setCheckedUnstaged(new Set());
      setConfirmDiscardSelected(false);
    } catch (cause) {
      if (mounted.current) setError(String(cause));
    } finally {
      if (mounted.current) setMutating(null);
    }
  }

  function beginRename(path: string, stagedSection: boolean) {
    setRenameTarget({ path, staged: stagedSection });
    setRenameName(path.slice(path.lastIndexOf("/") + 1));
    setSelected({ path, staged: stagedSection });
  }

  async function renameSelected() {
    if (!renameTarget || !renameName.trim() || mutating) return;
    setMutating(`rename:${renameTarget.path}`);
    setError(null);
    try {
      const destination = await gitRenamePath(app.root_dir, renameTarget.path, renameName.trim());
      await refreshAfterMutation();
      if (!mounted.current) return;
      setSelected({ path: destination, staged: false });
      setRenameTarget(null);
      setRenameName("");
    } catch (cause) {
      if (mounted.current) setError(String(cause));
    } finally {
      if (mounted.current) setMutating(null);
    }
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

  // stage all / unstage all files. Uses a sentinel marker to gate the disable.
  async function mutateBulk(op: "stageAll" | "unstageAll" | "discardAll") {
    setMutating(op);
    setError(null);
    try {
      if (op === "stageAll") await gitStageAll(app.root_dir);
      else if (op === "unstageAll") await gitUnstageAll(app.root_dir);
      else await gitDiscardAll(app.root_dir);
      await refreshAfterMutation();
      if (mounted.current) setConfirmDiscardAll(false);
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

  const ahead = status?.ahead ?? 0;
  const behind = status?.behind ?? 0;

  const stagedFiles = changed.filter((f) => f.staged);
  const unstagedFiles = changed.filter((f) => f.unstaged || f.untracked);
  const canCommit =
    !committing &&
    (amend
      ? stagedFiles.length > 0 || commitMsg.trim() !== ""
      : stagedFiles.length > 0 && commitMsg.trim() !== "");

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {error && (
        <pre className="shrink-0 text-[11px] font-mono text-bad whitespace-pre-wrap break-words max-h-32 overflow-y-auto rounded-control border border-subtle bg-surface-code px-2.5 py-2 m-3 mb-0">{error}</pre>
      )}

      {changed.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center gap-2 py-8">
          <div className="w-10 h-10 rounded-xl bg-[var(--hover)] flex items-center justify-center text-ink-3">
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
            {(checkedStaged.size > 0 || checkedUnstaged.size > 0) && (
              <div className="flex flex-wrap items-center gap-1.5 border-b border-subtle px-2 py-1.5">
                <span className="mr-auto text-[10px] text-ink-3">
                  {new Set([...checkedStaged, ...checkedUnstaged]).size} selected
                </span>
                {checkedUnstaged.size > 0 && (
                  <button
                    onClick={() => mutateSelected("stage")}
                    disabled={mutating !== null}
                    className="text-[10px] text-ink-2 hover:text-ink disabled:opacity-40"
                  >
                    Stage
                  </button>
                )}
                {checkedStaged.size > 0 && (
                  <button
                    onClick={() => mutateSelected("unstage")}
                    disabled={mutating !== null}
                    className="text-[10px] text-ink-2 hover:text-ink disabled:opacity-40"
                  >
                    Unstage
                  </button>
                )}
                {confirmDiscardSelected ? (
                  <>
                    <button
                      onClick={() => mutateSelected("discard")}
                      disabled={mutating !== null}
                      className="text-[10px] font-medium text-bad hover:brightness-125 disabled:opacity-40"
                    >
                      Confirm
                    </button>
                    <button
                      onClick={() => setConfirmDiscardSelected(false)}
                      disabled={mutating !== null}
                      className="text-[10px] text-ink-3 hover:text-ink"
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => setConfirmDiscardSelected(true)}
                    disabled={mutating !== null}
                    className="text-[10px] text-bad hover:brightness-125 disabled:opacity-40"
                  >
                    Discard
                  </button>
                )}
              </div>
            )}
            <div className="flex items-center justify-end gap-1.5 px-2 py-1 border-b border-subtle">
              {confirmDiscardAll ? (
                <>
                  <span className="text-[11px] text-bad">Discard every change?</span>
                  <button
                    onClick={() => mutateBulk("discardAll")}
                    disabled={mutating !== null}
                    className="text-[11px] font-medium text-bad hover:brightness-125 disabled:opacity-40"
                  >
                    {mutating === "discardAll" ? "Discarding…" : "Confirm"}
                  </button>
                  <button
                    onClick={() => setConfirmDiscardAll(false)}
                    disabled={mutating !== null}
                    className="text-[11px] text-ink-3 hover:text-ink-2 disabled:opacity-40"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  onClick={() => setConfirmDiscardAll(true)}
                  disabled={mutating !== null}
                  className="text-[11px] text-ink-3 hover:text-bad disabled:opacity-40"
                >
                  Discard all
                </button>
              )}
            </div>
            {stagedFiles.length > 0 && (
              <>
                <div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-ink-3 px-3 pt-2 pb-1">
                  <span>Staged Changes · {stagedFiles.length}</span>
                  <button
                    onClick={() => mutateBulk("unstageAll")}
                    disabled={mutating !== null}
                    className="text-ink-3 hover:text-ink-1 text-[11px] disabled:opacity-40 disabled:pointer-events-none transition-colors"
                  >
                    {mutating === "unstageAll" ? "Unstaging…" : "Unstage all"}
                  </button>
                </div>
                <FileTree
                  files={stagedFiles}
                  staged
                  selected={selected}
                  mutating={mutating}
                  checked={checkedStaged}
                  onCheck={(path) => toggleChecked(true, path)}
                  onCheckMany={(paths, value) => setManyChecked(true, paths, value)}
                  onSelect={(path) => setSelected({ path, staged: true })}
                  onToggle={(path) => mutateFile(path, () => gitUnstage(app.root_dir, path))}
                  onDiscard={(path) => mutateFile(path, () => gitDiscard(app.root_dir, path, true))}
                  onRename={(path) => beginRename(path, true)}
                  onCopy={(path) => navigator.clipboard.writeText(path).catch(() => {})}
                />
              </>
            )}
            {unstagedFiles.length > 0 && (
              <>
                <div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-ink-3 px-3 pt-2 pb-1">
                  <span>Changes · {unstagedFiles.length}</span>
                  <button
                    onClick={() => mutateBulk("stageAll")}
                    disabled={mutating !== null}
                    className="text-ink-3 hover:text-ink-1 text-[11px] disabled:opacity-40 disabled:pointer-events-none transition-colors"
                  >
                    {mutating === "stageAll" ? "Staging…" : "Stage all"}
                  </button>
                </div>
                <FileTree
                  files={unstagedFiles}
                  staged={false}
                  selected={selected}
                  mutating={mutating}
                  checked={checkedUnstaged}
                  onCheck={(path) => toggleChecked(false, path)}
                  onCheckMany={(paths, value) => setManyChecked(false, paths, value)}
                  onSelect={(path) => setSelected({ path, staged: false })}
                  onToggle={(path) => mutateFile(path, () => gitStage(app.root_dir, path))}
                  onDiscard={(path) => mutateFile(path, () => gitDiscard(app.root_dir, path, false))}
                  onRename={(path) => beginRename(path, false)}
                  onCopy={(path) => navigator.clipboard.writeText(path).catch(() => {})}
                />
              </>
            )}
          </div>

          {/* Right pane — unified diff + commit box. */}
          <div className="flex-1 min-w-0 flex flex-col">
            {renameTarget && (
              <div className="flex shrink-0 items-center gap-2 border-b border-subtle bg-surface-1 px-3 py-2">
                <span className="shrink-0 text-[11px] text-ink-3">Rename</span>
                <span className="max-w-[35%] truncate font-mono text-[11px] text-ink-2" title={renameTarget.path}>
                  {renameTarget.path}
                </span>
                <Input
                  value={renameName}
                  onChange={(event) => setRenameName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void renameSelected();
                    if (event.key === "Escape") setRenameTarget(null);
                  }}
                  autoFocus
                  className="max-w-sm !py-1 font-mono"
                />
                <button
                  onClick={renameSelected}
                  disabled={!renameName.trim() || mutating !== null}
                  className="text-[11px] font-medium text-accent disabled:opacity-40"
                >
                  Save
                </button>
                <button
                  onClick={() => setRenameTarget(null)}
                  disabled={mutating !== null}
                  className="text-[11px] text-ink-3 hover:text-ink"
                >
                  Cancel
                </button>
              </div>
            )}
            <div className="flex-1 min-h-0 overflow-auto bg-surface-code font-mono text-[11px] leading-[1.7] px-3 py-2.5">
              {!selected ? (
                <div className="h-full flex items-center justify-center text-ink-3 text-[12px] font-sans">
                  Select a file to view its diff
                </div>
              ) : (
                <DiffView
                  key={`${selected.path}:${selected.staged}`}
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
                className="w-full resize-none rounded-control border border-subtle bg-surface-input text-[12px] text-ink placeholder:text-ink-3 px-2.5 py-1.5 mb-1.5 focus:outline-none focus:border-strong"
              />
              <div className="flex items-center justify-between mb-1.5 px-0.5 text-[10px] text-ink-3">
                <span>⌘↵ to commit</span>
                {stagedFiles.length > 0 && <span>{stagedFiles.length} staged</span>}
              </div>
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
                  className="text-[11px] text-ink border border-strong rounded-control px-3 py-1 hover:bg-[var(--hover)] disabled:opacity-40 disabled:pointer-events-none transition-colors duration-fast"
                >
                  Commit &amp; push
                </button>
                <button
                  onClick={() => setAmend((v) => !v)}
                  className={`ml-auto inline-flex items-center gap-1.5 text-[11px] rounded-control px-2 py-1 transition-colors duration-fast ${amend ? "text-accent" : "text-ink-2 hover:bg-[var(--hover)]"}`}
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
  );
}
