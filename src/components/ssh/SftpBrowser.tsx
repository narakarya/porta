import { useEffect, useMemo, useState } from "react";
import { usePortaStore } from "../../store";
import type { SftpEntry } from "../../lib/commands";
import { Spinner } from "../ui";
import SftpFileEditor from "./SftpFileEditor";

type Props = { sessionId: string; active: boolean };

function formatSize(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

function formatWhen(epochSecs: number | null): string {
  if (!epochSecs) return "";
  const d = new Date(epochSecs * 1000);
  const now = Date.now();
  const days = (now - d.getTime()) / 86_400_000;
  // Recent files get a time, older ones a date — the same trade-off `ls -l`
  // makes, and for the same reason.
  return days < 180
    ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : d.toLocaleDateString(undefined, { year: "numeric", month: "short" });
}

/** Remote file browser for one SSH session. */
export default function SftpBrowser({ sessionId, active }: Props) {
  const pane = usePortaStore((s) => s.sftpPanes[sessionId]);
  const open = usePortaStore((s) => s.sftpOpen[sessionId]);
  const sftpInit = usePortaStore((s) => s.sftpInit);
  const navigate = usePortaStore((s) => s.sftpNavigate);
  const refresh = usePortaStore((s) => s.sftpRefresh);
  const openFile = usePortaStore((s) => s.sftpOpenFile);
  const notifyError = usePortaStore((s) => s.notifyError);

  const [filter, setFilter] = useState("");

  // Open the channel only when the user actually looks at this tab — an SFTP
  // subsystem request on every connect would be a round trip (and an sshd
  // session slot) spent on a feature most sessions never touch.
  useEffect(() => {
    if (active) sftpInit(sessionId).catch(() => {});
  }, [active, sessionId, sftpInit]);

  const entries = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const all = pane?.listing?.entries ?? [];
    return q ? all.filter((e) => e.name.toLowerCase().includes(q)) : all;
  }, [pane?.listing, filter]);

  const crumbs = useMemo(() => {
    const path = pane?.cwd ?? "";
    if (!path) return [] as { label: string; path: string }[];
    const parts = path.split("/").filter(Boolean);
    const out = [{ label: "/", path: "/" }];
    let acc = "";
    for (const part of parts) {
      acc += `/${part}`;
      out.push({ label: part, path: acc });
    }
    return out;
  }, [pane?.cwd]);

  async function activate(e: SftpEntry) {
    if (e.kind === "dir") {
      setFilter("");
      await navigate(sessionId, e.path);
      return;
    }
    try {
      await openFile(sessionId, e);
    } catch (err) {
      notifyError(`Couldn't open ${e.name}`, err);
    }
  }

  if (open) return <SftpFileEditor sessionId={sessionId} />;

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-subtle shrink-0">
        <div className="flex-1 min-w-0 flex items-center gap-1 overflow-x-auto text-[11.5px]">
          {crumbs.map((c, i) => (
            <span key={c.path} className="flex items-center gap-1 shrink-0">
              {/* The root crumb is itself "/", so a separator before the first
                  child would render "/ / home". */}
              {i > 1 && <span className="text-ink-3">/</span>}
              <button
                onClick={() => navigate(sessionId, c.path)}
                className={`px-1 rounded transition-colors ${
                  i === crumbs.length - 1
                    ? "text-ink"
                    : "text-ink-3 hover:text-ink-2 hover:bg-white/[0.05]"
                }`}
              >
                {c.label}
              </button>
            </span>
          ))}
        </div>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter…"
          className="shrink-0 w-32 px-2 py-1 text-[12px] bg-surface-input border border-subtle rounded-control text-ink placeholder:text-ink-3 outline-none focus:border-[var(--accent)] transition-colors"
        />
        <button
          onClick={() => refresh(sessionId)}
          title="Refresh"
          aria-label="Refresh"
          className="shrink-0 w-6 h-6 flex items-center justify-center rounded-control text-ink-3 hover:text-ink hover:bg-white/[0.06] transition-colors"
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
            <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
            <path d="M13.5 2v3.5H10" />
          </svg>
        </button>
      </div>

      {pane?.error && (
        <div className="m-3 px-2.5 py-2 bg-bad-bg border border-[var(--danger-border)] rounded-lg">
          <p className="text-[11.5px] text-bad break-words">{pane.error}</p>
        </div>
      )}

      {pane?.loading && !pane.listing && (
        <div className="flex-1 flex items-center justify-center gap-2 text-[12px] text-ink-3">
          <Spinner size={12} />
          Reading remote directory…
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto">
        {pane?.listing && entries.length === 0 && (
          <p className="px-3 py-4 text-[12px] text-ink-3">
            {filter ? "Nothing matches that filter." : "This directory is empty."}
          </p>
        )}

        {pane?.cwd && pane.cwd !== "/" && !filter && (
          <button
            onClick={() => navigate(sessionId, pane.cwd.replace(/\/[^/]+\/?$/, "") || "/")}
            className="w-full flex items-center gap-2 px-3 py-1 text-[12.5px] text-ink-3 hover:bg-white/[0.04] transition-colors"
          >
            <span className="w-4 text-center">↑</span>
            <span>..</span>
          </button>
        )}

        {entries.map((e) => (
          <button
            key={e.path}
            onDoubleClick={() => activate(e)}
            onClick={() => activate(e)}
            disabled={e.lossyName}
            title={
              e.lossyName
                ? "This name didn't survive the server's character decoding, so Porta can't address the file."
                : e.kind === "dir"
                  ? `Open ${e.name}`
                  : `Edit ${e.name}`
            }
            className={`w-full flex items-center gap-2 px-3 py-1 text-left transition-colors ${
              e.lossyName ? "opacity-40 cursor-not-allowed" : "hover:bg-white/[0.04]"
            }`}
          >
            <span className="w-4 shrink-0 text-center text-[12px] text-ink-3">
              {e.kind === "dir" ? "▸" : e.kind === "symlink" ? "↗" : "·"}
            </span>
            <span className={`flex-1 min-w-0 truncate text-[12.5px] ${e.kind === "dir" ? "text-ink" : "text-ink-2"}`}>
              {e.name}
            </span>
            <span className="shrink-0 w-20 text-right text-[11px] text-ink-3 tabular-nums">
              {e.kind === "file" ? formatSize(e.size) : ""}
            </span>
            <span className="shrink-0 w-16 text-right text-[11px] text-ink-3 tabular-nums">
              {formatWhen(e.mtime)}
            </span>
            <span className="shrink-0 w-24 text-right text-[10.5px] text-ink-3 font-mono">
              {e.modeStr ?? ""}
            </span>
          </button>
        ))}

        {pane?.listing?.truncated && (
          // Say it plainly rather than letting a clipped list read as the whole
          // directory.
          <p className="px-3 py-2 text-[11px] text-warn">
            Showing the first {entries.length} of {pane.listing.totalSeen} entries. Use the
            terminal for directories this large.
          </p>
        )}
      </div>
    </div>
  );
}
