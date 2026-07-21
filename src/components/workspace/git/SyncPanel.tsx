import { useEffect, useRef, useState } from "react";
import type { App } from "../../../types";
import {
  gitAddRemote,
  gitFetch,
  gitPull,
  gitPullRebase,
  gitPush,
  gitPushForceWithLease,
  gitRebaseMain,
  gitRemotes,
  gitRemoveRemote,
  type GitRemote,
  type GitStatus,
} from "../../../lib/commands";
import { Button, Input, Spinner } from "../../ui";

type Action = "fetch" | "pull" | "pull-rebase" | "rebase-main" | "push" | "force-push";

const ACTIONS: Array<{
  id: Action;
  title: string;
  description: string;
  dangerous?: boolean;
}> = [
  { id: "fetch", title: "Fetch + prune", description: "Refresh remote refs and remove stale tracking branches." },
  { id: "pull", title: "Pull (fast-forward)", description: "Update safely without creating an automatic merge commit." },
  { id: "pull-rebase", title: "Pull with rebase", description: "Rebase local commits onto upstream; autostashes local edits." },
  { id: "rebase-main", title: "Rebase from main", description: "Fetch origin, resolve main/master, and replay the current branch on top." },
  { id: "push", title: "Push", description: "Publish local commits to the configured upstream." },
  {
    id: "force-push",
    title: "Force push with lease",
    description: "Rewrite the remote only if nobody else has pushed since your last fetch.",
    dangerous: true,
  },
];

export default function SyncPanel({
  app,
  status,
  onChanged,
}: {
  app: App;
  status: GitStatus;
  onChanged?: () => void;
}) {
  const [busy, setBusy] = useState<Action | null>(null);
  const [confirmForce, setConfirmForce] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [remotes, setRemotes] = useState<GitRemote[]>([]);
  const [remotesLoading, setRemotesLoading] = useState(true);
  const [remoteName, setRemoteName] = useState("");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [remoteBusy, setRemoteBusy] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  function loadRemotes() {
    if (!app.root_dir) return;
    setRemotesLoading(true);
    gitRemotes(app.root_dir)
      .then((rows) => { if (mounted.current) setRemotes(rows); })
      .catch((e) => { if (mounted.current) setError(String(e)); })
      .finally(() => { if (mounted.current) setRemotesLoading(false); });
  }

  useEffect(() => {
    loadRemotes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.root_dir]);

  async function run(action: Action) {
    if (!app.root_dir || busy) return;
    if (action === "force-push" && !confirmForce) {
      setConfirmForce(true);
      return;
    }
    setBusy(action);
    setError(null);
    setResult(null);
    try {
      let output = "";
      if (action === "fetch") await gitFetch(app.root_dir);
      else if (action === "pull") output = await gitPull(app.root_dir);
      else if (action === "pull-rebase") output = await gitPullRebase(app.root_dir);
      else if (action === "rebase-main") output = await gitRebaseMain(app.root_dir);
      else if (action === "push") output = await gitPush(app.root_dir);
      else output = await gitPushForceWithLease(app.root_dir);
      if (!mounted.current) return;
      setResult(output.trim() || `${ACTIONS.find((item) => item.id === action)?.title} complete.`);
      setConfirmForce(false);
      onChanged?.();
    } catch (e) {
      if (mounted.current) setError(String(e));
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  async function addRemote() {
    const name = remoteName.trim();
    const url = remoteUrl.trim();
    if (!app.root_dir || !name || !url || remoteBusy) return;
    setRemoteBusy(`add:${name}`);
    setError(null);
    try {
      await gitAddRemote(app.root_dir, name, url);
      if (mounted.current) {
        setRemoteName("");
        setRemoteUrl("");
      }
      loadRemotes();
    } catch (e) {
      if (mounted.current) setError(String(e));
    } finally {
      if (mounted.current) setRemoteBusy(null);
    }
  }

  async function removeRemote(name: string) {
    if (!app.root_dir || remoteBusy) return;
    setRemoteBusy(`remove:${name}`);
    setError(null);
    try {
      await gitRemoveRemote(app.root_dir, name);
      if (mounted.current) setConfirmRemove(null);
      loadRemotes();
      onChanged?.();
    } catch (e) {
      if (mounted.current) setError(String(e));
    } finally {
      if (mounted.current) setRemoteBusy(null);
    }
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4">
      <div className="flex items-center gap-2 mb-3 text-[12px]">
        <span className="font-mono text-ink">{status.branch}</span>
        <span className="text-ink-3">{status.upstream ? `↕ ${status.upstream}` : "No upstream configured"}</span>
        {status.ahead > 0 && <span className="text-ok">↑ {status.ahead} to push</span>}
        {status.behind > 0 && <span className="text-warn">↓ {status.behind} to pull</span>}
      </div>

      {error && (
        <pre className="mb-3 text-[11px] font-mono text-bad whitespace-pre-wrap break-words max-h-32 overflow-y-auto rounded-control border border-subtle bg-surface-code px-2.5 py-2">{error}</pre>
      )}
      {result && (
        <pre className="mb-3 text-[11px] font-mono text-ok whitespace-pre-wrap break-words max-h-24 overflow-y-auto rounded-control border border-subtle bg-surface-code px-2.5 py-2">{result}</pre>
      )}

      <div className="grid grid-cols-2 xl:grid-cols-3 gap-2.5">
        {ACTIONS.map((action) => {
          const disabled =
            busy !== null ||
            (action.id === "pull" && status.behind === 0) ||
            (action.id === "push" && status.ahead === 0);
          const confirming = action.id === "force-push" && confirmForce;
          return (
            <div
              key={action.id}
              className={`rounded-card border p-3 flex flex-col gap-2 ${action.dangerous ? "border-bad/30 bg-bad-bg" : "border-subtle bg-surface-1"}`}
            >
              <div>
                <div className={`text-[12px] font-medium ${action.dangerous ? "text-bad" : "text-ink"}`}>{action.title}</div>
                <div className="text-[11px] text-ink-3 leading-relaxed mt-0.5">{action.description}</div>
              </div>
              <div className="mt-auto flex items-center gap-1.5">
                {confirming ? (
                  <>
                    <span className="text-[11px] text-bad">Rewrite remote?</span>
                    <Button variant="danger" size="sm" onClick={() => run(action.id)}>Confirm</Button>
                    <button onClick={() => setConfirmForce(false)} className="text-[11px] text-ink-3 hover:text-ink-2">Cancel</button>
                  </>
                ) : (
                  <Button
                    variant={action.dangerous ? "danger" : "secondary"}
                    size="sm"
                    loading={busy === action.id}
                    disabled={disabled}
                    onClick={() => run(action.id)}
                  >
                    {action.title}
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-4 rounded-card border border-subtle bg-surface-1 overflow-hidden">
        <div className="px-3 py-2 border-b border-subtle">
          <div className="text-[12px] font-medium text-ink">Remotes</div>
          <div className="text-[11px] text-ink-3">Manage repository fetch and push destinations.</div>
        </div>
        <div className="p-2.5 border-b border-subtle flex items-center gap-2">
          <Input
            value={remoteName}
            onChange={(e) => setRemoteName(e.target.value)}
            placeholder="Name (e.g. upstream)"
            className="!py-1 max-w-[180px] font-mono"
          />
          <Input
            value={remoteUrl}
            onChange={(e) => setRemoteUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") addRemote(); }}
            placeholder="Git URL"
            className="!py-1 font-mono"
          />
          <Button
            size="sm"
            loading={remoteBusy?.startsWith("add:")}
            disabled={!remoteName.trim() || !remoteUrl.trim() || remoteBusy !== null}
            onClick={addRemote}
          >
            Add remote
          </Button>
        </div>
        <div className="py-1">
          {remotesLoading ? (
            <div className="inline-flex items-center gap-2 px-3 py-2 text-[11px] text-ink-3">
              <Spinner size={11} /> Loading remotes…
            </div>
          ) : remotes.length === 0 ? (
            <div className="px-3 py-2 text-[11px] text-ink-3">No remotes configured.</div>
          ) : remotes.map((remote) => (
            <div key={remote.name} className="mx-1 flex items-center gap-2 px-2 py-1.5 rounded-control hover:bg-[var(--hover)]">
              <span className="font-mono text-[11px] text-ink w-24 shrink-0 truncate">{remote.name}</span>
              <span className="font-mono text-[11px] text-ink-3 flex-1 min-w-0 truncate" title={remote.fetch_url}>
                {remote.fetch_url}
              </span>
              {confirmRemove === remote.name ? (
                <div className="shrink-0 flex items-center gap-1.5">
                  <span className="text-[11px] text-bad">Remove?</span>
                  <button onClick={() => removeRemote(remote.name)} className="text-[11px] font-medium text-bad">Confirm</button>
                  <button onClick={() => setConfirmRemove(null)} className="text-[11px] text-ink-3">Cancel</button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmRemove(remote.name)}
                  disabled={remoteBusy !== null}
                  className="text-[11px] text-ink-3 hover:text-bad px-2 py-1 rounded-control hover:bg-bad-bg disabled:opacity-40"
                >
                  Remove
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
