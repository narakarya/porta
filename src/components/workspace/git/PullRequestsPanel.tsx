import { useEffect, useMemo, useRef, useState } from "react";
import type { App } from "../../../types";
import {
  gitBranches,
  gitPrCapability,
  gitPrCheckout,
  gitPrCreate,
  gitPrDiff,
  gitPrList,
  gitPrMerge,
  gitPrView,
  openExternalUrl,
  type PullRequestCapability,
  type PullRequestEntry,
} from "../../../lib/commands";
import { Button, Input, Select, Spinner } from "../../ui";
import ReadOnlyDiff from "./ReadOnlyDiff";

function stateTone(value: string) {
  const normalized = value.toLowerCase();
  if (["success", "approved", "clean"].includes(normalized)) return "text-ok";
  if (["failure", "failed", "error", "changes_requested", "dirty"].includes(normalized)) return "text-bad";
  if (["pending", "queued", "in_progress", "unstable"].includes(normalized)) return "text-warn";
  return "text-ink-3";
}

function relativeTime(value: string) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  const seconds = Math.max(1, Math.round((Date.now() - time) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

export default function PullRequestsPanel({
  app,
  currentBranch,
  onRepositoryChanged,
}: {
  app: App;
  currentBranch: string;
  onRepositoryChanged?: () => void | Promise<void>;
}) {
  const [capability, setCapability] = useState<PullRequestCapability | null>(null);
  const [requests, setRequests] = useState<PullRequestEntry[]>([]);
  const [selectedNumber, setSelectedNumber] = useState<number | null>(null);
  const [selected, setSelected] = useState<PullRequestEntry | null>(null);
  const [diff, setDiff] = useState("");
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"details" | "diff" | "create">("details");
  const [branches, setBranches] = useState<string[]>([]);
  const [base, setBase] = useState("");
  const [head, setHead] = useState(currentBranch);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [busy, setBusy] = useState("");
  const [confirmMerge, setConfirmMerge] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  async function loadList(preferred?: number | null) {
    const list = await gitPrList(app.root_dir);
    if (!mounted.current) return;
    setRequests(list);
    setSelectedNumber((previous) => {
      const wanted = preferred ?? previous;
      return list.some((item) => item.number === wanted) ? wanted : list[0]?.number ?? null;
    });
  }

  useEffect(() => {
    if (!app.root_dir) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([gitPrCapability(app.root_dir), gitBranches(app.root_dir)])
      .then(async ([nextCapability, branchList]) => {
        if (cancelled) return;
        setCapability(nextCapability);
        setBranches(branchList.local);
        setBase(nextCapability.default_branch || "main");
        setHead(currentBranch || branchList.current || branchList.local[0] || "");
        if (nextCapability.installed && nextCapability.authenticated) {
          await loadList();
        }
      })
      .catch((cause) => { if (!cancelled) setError(String(cause)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [app.root_dir, currentBranch]);

  useEffect(() => {
    if (!app.root_dir || selectedNumber === null || view === "create") {
      setSelected(null);
      setDiff("");
      return;
    }
    let cancelled = false;
    setLoadingDetail(true);
    setError(null);
    const action =
      view === "diff"
        ? Promise.all([gitPrView(app.root_dir, selectedNumber), gitPrDiff(app.root_dir, selectedNumber)])
            .then(([entry, patch]) => ({ entry, patch }))
        : gitPrView(app.root_dir, selectedNumber).then((entry) => ({ entry, patch: "" }));
    action
      .then(({ entry, patch }) => {
        if (cancelled) return;
        setSelected(entry);
        setDiff(patch);
      })
      .catch((cause) => { if (!cancelled) setError(String(cause)); })
      .finally(() => { if (!cancelled) setLoadingDetail(false); });
    return () => { cancelled = true; };
  }, [app.root_dir, selectedNumber, view]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return normalized === ""
      ? requests
      : requests.filter((item) =>
          `${item.number} ${item.title} ${item.author.login} ${item.headRefName}`
            .toLowerCase()
            .includes(normalized),
        );
  }, [requests, query]);

  async function checkout() {
    if (selectedNumber === null || busy) return;
    setBusy("checkout");
    setError(null);
    setNotice("");
    try {
      const output = await gitPrCheckout(app.root_dir, selectedNumber);
      if (mounted.current) setNotice(output || `Checked out PR #${selectedNumber}`);
      await onRepositoryChanged?.();
    } catch (cause) {
      if (mounted.current) setError(String(cause));
    } finally {
      if (mounted.current) setBusy("");
    }
  }

  async function merge() {
    if (selectedNumber === null || busy) return;
    setBusy("merge");
    setError(null);
    setNotice("");
    try {
      const output = await gitPrMerge(app.root_dir, selectedNumber);
      if (mounted.current) {
        setNotice(output || `Merged PR #${selectedNumber}`);
        setConfirmMerge(false);
      }
      await loadList();
      await onRepositoryChanged?.();
    } catch (cause) {
      if (mounted.current) setError(String(cause));
    } finally {
      if (mounted.current) setBusy("");
    }
  }

  async function create() {
    if (!base || !head || busy) return;
    setBusy("create");
    setError(null);
    setNotice("");
    try {
      const output = await gitPrCreate(app.root_dir, base, head, title.trim(), body);
      if (mounted.current) {
        setNotice(output || "Pull request created");
        setTitle("");
        setBody("");
        setView("details");
      }
      await loadList();
    } catch (cause) {
      if (mounted.current) setError(String(cause));
    } finally {
      if (mounted.current) setBusy("");
    }
  }

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-[12px] text-ink-3">
        <Spinner size={12} /> Checking GitHub…
      </div>
    );
  }

  if (!capability?.installed || !capability.authenticated) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-center">
        <div className="max-w-md">
          <div className="text-[13px] text-ink">
            {!capability?.installed ? "GitHub CLI is required" : "Sign in to GitHub CLI"}
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-ink-3">
            {capability?.message || "Install GitHub CLI and run gh auth login to manage pull requests here."}
          </p>
          <Button
            size="sm"
            className="mt-3"
            onClick={() => openExternalUrl("https://cli.github.com/")}
          >
            GitHub CLI
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 min-h-0">
      <aside className="flex w-[290px] shrink-0 flex-col border-r border-subtle bg-surface-1">
        <div className="flex gap-1.5 border-b border-subtle p-2">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search pull requests…"
            className="!py-1"
          />
          <Button size="sm" onClick={() => setView("create")}>New</Button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <div className="px-3 py-4 text-[11px] text-ink-3">No open pull requests.</div>
          ) : filtered.map((item) => (
            <button
              key={item.number}
              onClick={() => {
                setSelectedNumber(item.number);
                setView("details");
                setConfirmMerge(false);
              }}
              className={`mx-1 flex w-[calc(100%_-_8px)] flex-col gap-1 rounded-control px-2.5 py-2 text-left ${
                selectedNumber === item.number && view !== "create"
                  ? "bg-accent-bg"
                  : "hover:bg-white/[0.04]"
              }`}
            >
              <div className="flex w-full items-start gap-2">
                <span className="mt-0.5 shrink-0 font-mono text-[10px] text-accent">#{item.number}</span>
                <span className="min-w-0 flex-1 text-[12px] leading-snug text-ink">{item.title}</span>
                {item.isDraft && <span className="text-[9px] uppercase text-ink-3">draft</span>}
              </div>
              <div className="pl-8 text-[10px] text-ink-3">
                {item.author.login || "unknown"} · {relativeTime(item.updatedAt)}
              </div>
            </button>
          ))}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        {error && (
          <pre className="m-2 mb-0 max-h-32 shrink-0 overflow-y-auto whitespace-pre-wrap break-words rounded-control border border-subtle bg-surface-code px-2.5 py-2 font-mono text-[11px] text-bad">{error}</pre>
        )}
        {notice && (
          <div className="mx-2 mt-2 shrink-0 rounded-control border border-ok/30 bg-ok-bg px-3 py-2 text-[11px] text-ok">
            {notice}
          </div>
        )}

        {view === "create" ? (
          <div className="mx-auto w-full max-w-2xl overflow-y-auto p-4">
            <div className="text-[14px] font-medium text-ink">Create pull request</div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <label className="text-[10px] uppercase tracking-wide text-ink-3">
                Base
                <Select value={base} onChange={(event) => setBase(event.target.value)} className="mt-1 w-full">
                  {Array.from(new Set([capability.default_branch, ...branches])).filter(Boolean).map((branch) => (
                    <option key={branch} value={branch}>{branch}</option>
                  ))}
                </Select>
              </label>
              <label className="text-[10px] uppercase tracking-wide text-ink-3">
                Compare
                <Select value={head} onChange={(event) => setHead(event.target.value)} className="mt-1 w-full">
                  {branches.map((branch) => <option key={branch} value={branch}>{branch}</option>)}
                </Select>
              </label>
            </div>
            <label className="mt-3 block text-[10px] uppercase tracking-wide text-ink-3">
              Title
              <Input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Blank uses commit title"
                className="mt-1"
              />
            </label>
            <label className="mt-3 block text-[10px] uppercase tracking-wide text-ink-3">
              Description
              <textarea
                value={body}
                onChange={(event) => setBody(event.target.value)}
                rows={10}
                placeholder="What changed and why?"
                className="input-base mt-1 w-full resize-y text-[12px]"
              />
            </label>
            <div className="mt-3 flex gap-2">
              <Button variant="primary" loading={busy === "create"} disabled={!base || !head} onClick={create}>
                Create
              </Button>
              <Button onClick={() => setView("details")}>Cancel</Button>
            </div>
          </div>
        ) : loadingDetail ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-[12px] text-ink-3">
            <Spinner size={12} /> Loading pull request…
          </div>
        ) : selected ? (
          <>
            <div className="shrink-0 border-b border-subtle bg-surface-1 px-3 py-2.5">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] text-ink">
                    <span className="font-mono text-accent">#{selected.number}</span>{" "}
                    {selected.title}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-ink-3">
                    <span className="font-mono">{selected.headRefName} → {selected.baseRefName}</span>
                    <span>{selected.author.login}</span>
                    {selected.reviewDecision && (
                      <span className={stateTone(selected.reviewDecision)}>{selected.reviewDecision}</span>
                    )}
                    <span className="text-ok">+{selected.additions}</span>
                    <span className="text-bad">−{selected.deletions}</span>
                  </div>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <Button size="sm" onClick={() => setView(view === "diff" ? "details" : "diff")}>
                    {view === "diff" ? "Details" : "Diff"}
                  </Button>
                  <Button size="sm" loading={busy === "checkout"} onClick={checkout}>Checkout</Button>
                  <Button size="sm" onClick={() => openExternalUrl(selected.url)}>Open</Button>
                  {confirmMerge ? (
                    <>
                      <Button size="sm" variant="danger" loading={busy === "merge"} onClick={merge}>
                        Confirm squash
                      </Button>
                      <Button size="sm" onClick={() => setConfirmMerge(false)}>Cancel</Button>
                    </>
                  ) : (
                    <Button size="sm" variant="primary" onClick={() => setConfirmMerge(true)}>
                      Squash merge
                    </Button>
                  )}
                </div>
              </div>
            </div>
            {view === "diff" ? (
              <div className="flex-1 min-h-0">
                <ReadOnlyDiff diff={diff} loading={loadingDetail} emptyLabel="This pull request has no textual diff." />
              </div>
            ) : (
              <div className="flex-1 min-h-0 overflow-y-auto p-4">
                {selected.labels.length > 0 && (
                  <div className="mb-3 flex flex-wrap gap-1.5">
                    {selected.labels.map((label) => (
                      <span
                        key={label.name}
                        className="rounded-full border border-subtle px-2 py-0.5 text-[10px] text-ink-2"
                        style={{ borderColor: label.color ? `#${label.color}66` : undefined }}
                      >
                        {label.name}
                      </span>
                    ))}
                  </div>
                )}
                <div className="whitespace-pre-wrap text-[12px] leading-relaxed text-ink-2">
                  {selected.body || "No description."}
                </div>
                {selected.statusCheckRollup.length > 0 && (
                  <div className="mt-5 max-w-xl overflow-hidden rounded-card border border-subtle">
                    <div className="border-b border-subtle bg-surface-1 px-3 py-2 text-[11px] font-medium text-ink">
                      Checks · {selected.statusCheckRollup.length}
                    </div>
                    {selected.statusCheckRollup.map((check, index) => {
                      const status = check.conclusion || check.state || check.status || "pending";
                      const label = check.name || check.context || `Check ${index + 1}`;
                      return (
                        <button
                          key={`${label}:${index}`}
                          disabled={!check.detailsUrl && !check.targetUrl}
                          onClick={() => openExternalUrl(check.detailsUrl || check.targetUrl)}
                          className="flex w-full items-center gap-3 border-b border-subtle px-3 py-2 text-left last:border-b-0 hover:bg-white/[0.03] disabled:pointer-events-none"
                        >
                          <span className={`text-[10px] uppercase ${stateTone(status)}`}>● {status}</span>
                          <span className="min-w-0 flex-1 truncate text-[11px] text-ink-2">{label}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-[12px] text-ink-3">
            Select a pull request or create a new one.
          </div>
        )}
      </section>
    </div>
  );
}
