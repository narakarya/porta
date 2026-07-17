import { useCallback, useEffect, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowsClockwise,
  CaretDown,
  FileText,
  Folder,
  GitBranch,
  SpinnerGap,
  WarningCircle,
} from "@phosphor-icons/react";
import type { App } from "../../types";
import {
  extensionShellRun,
  gitBranches,
  gitPull,
  gitPush,
  gitStatus,
  gitSwitchBranch,
  isTauri,
  type BranchList,
  type GitStatus,
} from "../../lib/commands";

type GitTab = "Status" | "History" | "Sync" | "Branches" | "Rebase" | "Stash" | "Tags" | "PR";
type GitFile = { path: string; code: string; staged: boolean; untracked: boolean };

const TABS: GitTab[] = ["Status", "History", "Sync", "Branches", "Rebase", "Stash", "Tags", "PR"];
const MOCK_FILES: GitFile[] = [
  { path: "docs/superpowers/plans/2026-07-15-people-hub-teacher-profile-sync.md", code: "??", staged: false, untracked: true },
  { path: "docs/superpowers/specs/2026-07-15-people-hub-teacher-profile-sync-design.md", code: "??", staged: false, untracked: true },
  { path: "docs/GAP_SIDIQ_FULL_2026-07-14.md", code: " M", staged: false, untracked: false },
  { path: "lib/narakarya_academic/admin_user_sync.ex", code: " M", staged: false, untracked: false },
  { path: "lib/narakarya_academic_platform_web/platform_user_auth.ex", code: " M", staged: false, untracked: false },
  { path: "test/narakarya_academic/users_test.exs", code: "M ", staged: true, untracked: false },
  { path: "mix.lock", code: "M ", staged: true, untracked: false },
];

const MOCK_HISTORY = [
  "8c21a4f  feat: sync teacher profiles from People Hub",
  "6f0df11  fix: validate academic roles before update",
  "b8d192c  test: cover teacher profile reconciliation",
  "2a6ef42  chore: update Phoenix dependencies",
];

function quoteShell(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function parsePorcelain(stdout: string): GitFile[] {
  return stdout
    .split("\n")
    .filter((line) => line.length >= 4 && !line.startsWith("##"))
    .map((line) => {
      const code = line.slice(0, 2);
      const rawPath = line.slice(3).trim();
      const pathParts = rawPath.split(" -> ");
      const path = rawPath.includes(" -> ") ? pathParts[pathParts.length - 1] : rawPath;
      return {
        path,
        code,
        staged: code[0] !== " " && code[0] !== "?",
        untracked: code === "??",
      };
    });
}

function fileTone(file: GitFile) {
  if (file.untracked) return "bg-zinc-700 text-zinc-300";
  if (file.staged) return "bg-emerald-500/15 text-emerald-300";
  return "bg-amber-500/15 text-amber-300";
}

function fileLabel(file: GitFile) {
  if (file.untracked) return "NEW";
  const marker = file.code.trim();
  return marker || "M";
}

interface Props {
  app: App;
  extensionAvailable: boolean;
  onOpenTerminal: (command: string) => void;
  onOpenExtensions: () => void;
}

export default function WorkbenchGitPanel({ app, extensionAvailable, onOpenTerminal, onOpenExtensions }: Props) {
  const [active, setActive] = useState<GitTab>("Status");
  const [files, setFiles] = useState<GitFile[]>(!isTauri ? MOCK_FILES : []);
  const [status, setStatus] = useState<GitStatus | null>(!isTauri ? { branch: "main", detached: false, upstream: "origin/main", ahead: 0, behind: 0, dirty: 7 } : null);
  const [branches, setBranches] = useState<BranchList | null>(!isTauri ? { local: ["main", "fix/employee-sync", "feat/teacher-profile"], remote: ["origin/main", "origin/develop"], current: "main" } : null);
  const [selected, setSelected] = useState<GitFile | null>(null);
  const [diff, setDiff] = useState("");
  const [query, setQuery] = useState("");
  const [split, setSplit] = useState(false);
  const [branchMenu, setBranchMenu] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tabOutput, setTabOutput] = useState<string[]>([]);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const shell = useCallback(async (command: string) => {
    if (!isTauri) {
      if (command.startsWith("git log")) return MOCK_HISTORY.join("\n");
      if (command.startsWith("git stash list")) return "stash@{0}  WIP on main: teacher profile validation";
      if (command.startsWith("git tag")) return "v0.7.34\nv0.7.33\nv0.7.32";
      if (command.startsWith("gh pr list")) return "#128  Teacher profile sync  fix/employee-sync  OPEN";
      if (command.startsWith("git diff")) return "@@ -42,7 +42,9 @@\n-  role = params.role\n+  role = normalize_role(params.role)\n+  validate_inclusion(role, @academic_roles)";
      return "";
    }
    if (!extensionAvailable) throw new Error("Git Manager extension is not enabled for this app.");
    const result = await extensionShellRun(app.id, "git-manager", command, { timeoutMs: 30_000 });
    if (result.code !== 0) throw new Error(result.stderr || `Command failed (${result.code})`);
    return result.stdout;
  }, [app.id, extensionAvailable]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (!isTauri) {
        return;
      }
      const [nextStatus, nextBranches, porcelain] = await Promise.all([
        gitStatus(app.root_dir),
        gitBranches(app.root_dir).catch(() => null),
        extensionAvailable ? shell("git status --porcelain=v1 --branch") : Promise.resolve(""),
      ]);
      setStatus(nextStatus);
      setBranches(nextBranches);
      setFiles(parsePorcelain(porcelain));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [app.root_dir, extensionAvailable, shell]);

  useEffect(() => {
    if (!isTauri) {
      setFiles(MOCK_FILES);
      setStatus({ branch: "main", detached: false, upstream: "origin/main", ahead: 0, behind: 0, dirty: MOCK_FILES.length });
      setBranches({ local: ["main", "fix/employee-sync", "feat/teacher-profile"], remote: ["origin/main", "origin/develop"], current: "main" });
      setSelected(null);
      setDiff("");
      return;
    }
    void refresh();
  }, [app.id, refresh]);

  useEffect(() => {
    if (active === "Status" || active === "Sync" || active === "Branches" || active === "Rebase") return;
    const command = active === "History"
      ? "git log --oneline --decorate -20"
      : active === "Stash"
        ? "git stash list"
        : active === "Tags"
          ? "git tag --sort=-creatordate"
          : "gh pr list --limit 20";
    setLoading(true);
    setError(null);
    void shell(command)
      .then((output) => setTabOutput(output.trim() ? output.trim().split("\n") : []))
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setLoading(false));
  }, [active, shell]);

  const selectFile = useCallback(async (file: GitFile) => {
    setSelected(file);
    setDiff("Loading diff…");
    try {
      const command = file.untracked
        ? `git diff --no-index -- /dev/null ${quoteShell(file.path)} || true`
        : `git diff ${file.staged ? "--cached " : ""}-- ${quoteShell(file.path)}`;
      const output = await shell(command);
      setDiff(output.trim() || "No textual diff is available for this file.");
    } catch (reason) {
      setDiff(reason instanceof Error ? reason.message : String(reason));
    }
  }, [shell]);

  const runMutation = useCallback(async (label: string, task: () => Promise<unknown>) => {
    setLoading(true);
    setError(null);
    setMessage(null);
    try {
      await task();
      setMessage(label);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [refresh]);

  const switchBranch = useCallback((item: string) => {
    if (!isTauri) {
      setStatus((current) => current ? { ...current, branch: item, upstream: `origin/${item}` } : current);
      setBranches((current) => current ? { ...current, current: item } : current);
      setMessage(`Switched to ${item}`);
      setError(null);
      return;
    }
    void runMutation(`Switched to ${item}`, () => gitSwitchBranch(app.root_dir, item, false));
  }, [app.root_dir, runMutation]);

  const stageAll = useCallback(() => {
    if (!isTauri) {
      setFiles((current) => current.map((file) => ({ ...file, staged: true, code: file.untracked ? "A " : "M " })));
      setSelected(null);
      setMessage("All changes staged");
      setError(null);
      return;
    }
    void runMutation("All changes staged", () => shell("git add -A"));
  }, [runMutation, shell]);

  const unstageAll = useCallback(() => {
    if (!isTauri) {
      setFiles((current) => current.map((file) => ({ ...file, staged: false, code: file.untracked ? "??" : " M" })));
      setSelected(null);
      setMessage("Staging reset");
      setError(null);
      return;
    }
    void runMutation("Staging reset", () => shell("git reset"));
  }, [runMutation, shell]);

  const discardAll = useCallback(() => {
    setConfirmDiscard(false);
    if (!isTauri) {
      setFiles((current) => current.filter((file) => file.staged));
      setSelected(null);
      setDiff("");
      setMessage("Unstaged changes discarded");
      setError(null);
      return;
    }
    void runMutation("Unstaged changes discarded", async () => {
      await shell("git restore --worktree .");
      await shell("git clean -fd");
    });
  }, [runMutation, shell]);

  const pullChanges = useCallback(() => {
    void runMutation("Pull complete", () => gitPull(app.root_dir));
  }, [app.root_dir, runMutation]);

  const pushChanges = useCallback(() => {
    void runMutation("Push complete", () => gitPush(app.root_dir));
  }, [app.root_dir, runMutation]);

  const staged = files.filter((file) => file.staged);
  const changes = files.filter((file) => !file.staged);
  const needle = query.trim().toLowerCase();
  const visible = (list: GitFile[]) => needle ? list.filter((file) => file.path.toLowerCase().includes(needle)) : list;
  const branch = status?.branch || branches?.current || "main";

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-[#101214]">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-white/[0.08] px-3">
        <div className="mr-3 flex items-center gap-2 text-[13px] font-semibold text-zinc-200">
          <GitBranch size={16} className="text-blue-400" /> Git — {app.name}
        </div>
        {TABS.map((tab) => (
          <button key={tab} onClick={() => setActive(tab)} className={`rounded-md px-3 py-1.5 text-[11px] ${active === tab ? "bg-white/[0.09] text-zinc-100" : "text-zinc-500 hover:text-zinc-200"}`}>
            {tab}{tab === "Status" && <span className="ml-1.5 rounded bg-blue-500/20 px-1.5 text-[9px] text-blue-300">{files.length}</span>}
          </button>
        ))}
        <span className="flex-1" />
        <div className="relative">
          <button onClick={() => setBranchMenu((value) => !value)} className="flex items-center gap-1 rounded-md border border-white/[0.08] px-2 py-1.5 text-[11px] text-zinc-400"><GitBranch size={12} /> {branch} <CaretDown size={10} /></button>
          {branchMenu && (
            <div className="absolute right-0 top-full z-20 mt-1 w-52 rounded-lg border border-white/[0.1] bg-[#1b1d20] p-1 shadow-2xl">
              {(branches?.local ?? [branch]).map((item) => (
                <button key={item} onClick={() => { setBranchMenu(false); switchBranch(item); }} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100">
                  <GitBranch size={11} /> {item}{item === branch && <span className="ml-auto text-emerald-400">current</span>}
                </button>
              ))}
            </div>
          )}
        </div>
        <button disabled={loading} onClick={pullChanges} className="ml-1 flex items-center gap-1 rounded-md border border-white/[0.08] px-2 py-1.5 text-[11px] text-zinc-400 disabled:opacity-40"><ArrowDown size={12} /> Pull</button>
        <button disabled={loading} onClick={pushChanges} className="flex items-center gap-1 rounded-md border border-white/[0.08] px-2 py-1.5 text-[11px] text-zinc-400 disabled:opacity-40"><ArrowUp size={12} /> Push</button>
        <button disabled={loading} onClick={() => void refresh()} className="rounded-md p-1.5 text-zinc-500 hover:bg-white/[0.06] disabled:opacity-40" title="Refresh Git"><ArrowsClockwise size={13} className={loading ? "animate-spin" : ""} /></button>
      </div>

      {(message || error) && (
        <div className={`flex h-8 shrink-0 items-center gap-2 border-b px-3 text-[11px] ${error ? "border-red-500/15 bg-red-500/[0.07] text-red-300" : "border-emerald-500/15 bg-emerald-500/[0.07] text-emerald-300"}`}>
          {error && <WarningCircle size={13} />}{error || message}
          <button onClick={() => { setError(null); setMessage(null); }} className="ml-auto text-current opacity-60 hover:opacity-100">Dismiss</button>
        </div>
      )}

      {active === "Status" ? (
        <div className="flex min-h-0 flex-1">
          <div className="flex w-[42%] min-w-[360px] flex-col border-r border-white/[0.08]">
            <div className="border-b border-white/[0.07] p-2.5"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter files…" className="h-8 w-[280px] rounded-md border border-white/[0.08] bg-[#0d0f11] px-3 text-[11px] text-zinc-200 outline-none" /></div>
            <div className="flex-1 overflow-auto px-3 py-3 text-[12px]">
              {!extensionAvailable && isTauri && (
                <div className="mb-4 rounded-lg border border-violet-500/20 bg-violet-500/[0.07] p-3 text-[11px] text-zinc-400">Enable Git Manager to load file status and diffs.<button onClick={onOpenExtensions} className="ml-2 text-violet-300">Open Extensions</button></div>
              )}
              <FileSection title="Staged" files={visible(staged)} empty="Nothing staged" action="Unstage all" onAction={unstageAll} selected={selected} onSelect={selectFile} />
              <FileSection title="Changes" files={visible(changes)} empty="Working tree clean" action="Stage all" secondaryAction="Discard all" onAction={stageAll} onSecondaryAction={() => setConfirmDiscard(true)} selected={selected} onSelect={selectFile} />
            </div>
          </div>
          <div className="flex min-w-0 flex-1 flex-col bg-[#17191c]">
            <div className="flex h-10 items-center justify-end border-b border-white/[0.07] px-3"><button onClick={() => setSplit(false)} className={`rounded-l-md border border-white/[0.08] px-2 py-1 text-[10px] ${!split ? "bg-blue-500/15 text-blue-300" : "text-zinc-500"}`}>Unified</button><button onClick={() => setSplit(true)} className={`rounded-r-md border border-l-0 border-white/[0.08] px-2 py-1 text-[10px] ${split ? "bg-blue-500/15 text-blue-300" : "text-zinc-500"}`}>Split</button></div>
            {selected ? <pre className={`min-h-0 flex-1 overflow-auto p-4 font-mono text-[11px] leading-relaxed text-zinc-300 ${split ? "columns-2 gap-8" : ""}`}>{diff}</pre> : <div className="flex flex-1 items-center justify-center p-8 text-[12px] text-zinc-600">Select a file to review changes</div>}
          </div>
        </div>
      ) : active === "Sync" ? (
        <div className="flex flex-1 items-center justify-center"><div className="w-[420px] rounded-xl border border-white/[0.08] bg-white/[0.025] p-5"><h3 className="text-[14px] font-semibold text-zinc-200">Sync {branch}</h3><p className="mt-2 text-[12px] text-zinc-500">Tracking {status?.upstream || "no upstream"} · {status?.ahead ?? 0} ahead · {status?.behind ?? 0} behind</p><div className="mt-4 flex gap-2"><button onClick={pullChanges} className="rounded-md bg-blue-500/15 px-3 py-2 text-[11px] text-blue-300">Pull changes</button><button onClick={pushChanges} className="rounded-md border border-white/[0.09] px-3 py-2 text-[11px] text-zinc-300">Push commits</button></div></div></div>
      ) : active === "Branches" ? (
        <div className="min-h-0 flex-1 overflow-auto p-5"><h3 className="mb-3 text-[12px] font-semibold uppercase tracking-widest text-zinc-500">Local branches</h3><div className="max-w-xl space-y-1">{(branches?.local ?? []).map((item) => <button key={item} onClick={() => switchBranch(item)} className="flex w-full items-center gap-2 rounded-lg border border-white/[0.06] px-3 py-2 text-left text-[12px] text-zinc-400 hover:bg-white/[0.04]"><GitBranch size={13} className="text-blue-400" />{item}{item === branch && <span className="ml-auto text-[10px] text-emerald-400">current</span>}</button>)}</div></div>
      ) : active === "Rebase" ? (
        <div className="flex flex-1 items-center justify-center"><div className="w-[420px] rounded-xl border border-white/[0.08] bg-white/[0.025] p-5"><h3 className="text-[14px] font-semibold text-zinc-200">Interactive rebase</h3><p className="mt-2 text-[12px] leading-relaxed text-zinc-500">Open a terminal session for an interactive rebase of {branch} onto main. Porta keeps the Git workbench visible while the session runs.</p><button onClick={() => onOpenTerminal("git rebase -i main")} className="mt-4 rounded-md bg-violet-500/15 px-3 py-2 text-[11px] text-violet-300">Open rebase terminal</button></div></div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-5"><div className="mx-auto max-w-4xl"><h3 className="mb-3 text-[12px] font-semibold uppercase tracking-widest text-zinc-500">{active}</h3>{loading ? <div className="flex items-center gap-2 text-[12px] text-zinc-500"><SpinnerGap size={14} className="animate-spin" />Loading…</div> : tabOutput.length ? <div className="space-y-1">{tabOutput.map((line, index) => <div key={`${line}-${index}`} className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 font-mono text-[11px] text-zinc-400">{line}</div>)}</div> : <p className="text-[12px] text-zinc-600">No {active.toLowerCase()} entries.</p>}</div></div>
      )}

      {confirmDiscard && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/60 p-6"><div className="w-[390px] rounded-xl border border-white/[0.12] bg-[#1b1d20] p-5 shadow-2xl"><h3 className="text-[14px] font-semibold text-zinc-100">Discard all unstaged changes?</h3><p className="mt-2 text-[12px] leading-relaxed text-zinc-500">Tracked changes will be restored and untracked files will be removed. This cannot be undone.</p><div className="mt-5 flex justify-end gap-2"><button onClick={() => setConfirmDiscard(false)} className="rounded-md px-3 py-2 text-[11px] text-zinc-400">Cancel</button><button onClick={discardAll} className="rounded-md bg-red-500/15 px-3 py-2 text-[11px] text-red-300">Discard all</button></div></div></div>
      )}
    </div>
  );
}

function FileSection({ title, files, empty, action, secondaryAction, onAction, onSecondaryAction, selected, onSelect }: { title: string; files: GitFile[]; empty: string; action: string; secondaryAction?: string; onAction: () => void; onSecondaryAction?: () => void; selected: GitFile | null; onSelect: (file: GitFile) => void }) {
  return (
    <section className="mb-7"><div className="mb-2 flex items-center text-[10px] font-semibold uppercase tracking-widest text-zinc-500"><span>{title}</span><span className="ml-2 rounded bg-white/[0.06] px-1.5">{files.length}</span><button disabled={files.length === 0} onClick={onAction} className="ml-auto text-zinc-500 disabled:opacity-30">{action}</button>{secondaryAction && <button disabled={files.length === 0} onClick={onSecondaryAction} className="ml-4 text-zinc-500 disabled:opacity-30">{secondaryAction}</button>}</div>{files.length === 0 ? <p className="py-5 text-center text-zinc-600">{empty}</p> : <div className="space-y-0.5">{files.map((file) => { const slash = file.path.lastIndexOf("/"); const folder = slash >= 0 ? file.path.slice(0, slash) : ""; const name = slash >= 0 ? file.path.slice(slash + 1) : file.path; return <button key={`${file.code}-${file.path}`} onClick={() => onSelect(file)} className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left ${selected?.path === file.path ? "bg-blue-500/10 text-zinc-100" : "text-zinc-400 hover:bg-white/[0.04]"}`}><Folder size={13} className="shrink-0 text-blue-400" /><span className="min-w-0 flex-1 truncate"><span className="text-zinc-600">{folder ? `${folder}/` : ""}</span>{name}</span><FileText size={12} /><span className={`rounded px-1.5 text-[9px] ${fileTone(file)}`}>{fileLabel(file)}</span></button>; })}</div>}</section>
  );
}
