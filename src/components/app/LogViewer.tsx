import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Virtualizer, type VirtualizerHandle } from "virtua";
import {
  getAppLogs,
  clearAppLogFile,
  isTauri,
  containersForApp,
  startContainerLogs,
  stopContainerLogs,
  type ContainerInfo,
  type ContainerLogLine,
} from "../../lib/commands";
import { listen } from "@tauri-apps/api/event";

// ── Service source ────────────────────────────────────────────────────────────
// Process apps stream stdout/stderr from the spawned process; docker/compose
// apps stream `docker logs` per container. The viewer unifies both — left
// sidebar lets the user pick which service to follow.
type ServiceItem =
  | { kind: "process"; key: "process"; label: string; state: ProcessState }
  | { kind: "container"; key: string; label: string; state: string };

type ProcessState = "running" | "starting" | "stopped" | "crashed";

interface Props {
  appId: string;
  appName: string;
  appKind?: string; // "static" | "docker" | "compose" | "proxy" | undefined (=process)
  logs: string[];
  isRunning?: boolean;
  isStarting?: boolean;
  crashed?: boolean;
  exitCode?: number | null;
  onClose: () => void;
  onClear: () => void;
  /** Render inline (fill parent) instead of as a full-screen overlay — used
   *  when the viewer is a workbench tab rather than a modal takeover. */
  embedded?: boolean;
  /** The process is a worktree instance, not a primary app. Its stdout is
   *  emitted on `instance:log:<id>` (the disk history is already keyed by the
   *  same id), so without this the viewer subscribes to an event nothing ever
   *  fires and the pane never grows past whatever was on disk at open time. */
  isInstance?: boolean;
}

// ── ANSI stripping ─────────────────────────────────────────────────────────────
// eslint-disable-next-line no-control-regex
const ANSI_RE = /[\x1b\x9b][\[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]/g;
function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, "");
}
const NOISE_RE = /cloudflare\.com\/(website-terms|terms)|Thank you for trying Cloudflare Tunnel|Doing so, you agree/i;

// ── Log level detection ────────────────────────────────────────────────────────
// Strict: only explicit markers count (JSON, logfmt, bracketed, line-start).
// Prose substring heuristics removed — previously "Starting database" matched
// "success" and "user_error_handler" matched "error".
type LogLevel = "error" | "warn" | "info" | "debug" | "trace" | "success" | null;

function normalizeLevel(token: string): LogLevel {
  const t = token.toLowerCase();
  if (t === "error" || t === "err" || t === "erro" || t === "fatal") return "error";
  if (t === "warn" || t === "warning" || t === "warni") return "warn";
  if (t === "info" || t === "notice") return "info";
  if (t === "debug" || t === "debu") return "debug";
  if (t === "trace") return "trace";
  if (t === "success" || t === "ok") return "success";
  return null;
}

function detectLevel(text: string): LogLevel {
  // 1. JSON-style: "level":"error"
  const j = text.match(/"level"\s*:\s*"([^"]+)"/i);
  if (j) {
    const lvl = normalizeLevel(j[1]);
    if (lvl) return lvl;
  }

  // 2. logfmt / key=value: level=error
  const kv = text.match(/\blevel=([a-zA-Z]+)/);
  if (kv) {
    const lvl = normalizeLevel(kv[1]);
    if (lvl) return lvl;
  }

  // 3. Bracketed anywhere: [ERROR], [WARN], …
  const br = text.match(/\[(ERROR|ERR|ERRO|FATAL|WARN(?:ING)?|INFO|NOTICE|DEBUG|TRACE|SUCCESS)\]/i);
  if (br) {
    const lvl = normalizeLevel(br[1]);
    if (lvl) return lvl;
  }

  // 4. Line-start level, optionally after a timestamp/logger prefix.
  //    Matches: "ERROR: foo", "2025-04-24 10:00 ERROR foo",
  //             "[2025-04-24T10:00:00Z] ERROR foo", "ERRO[0000] …" (docker).
  //    Rejects prose where level is a mid-sentence word.
  const ln = text.match(
    /^(?:\[[^\]]*\]\s+|[\d:\-T.Z/ ]+\s+){0,3}(ERROR|ERRO|FATAL|WARN(?:ING)?|INFO|NOTICE|DEBUG|TRACE|SUCCESS)\b[\s:\[]/i
  );
  if (ln) {
    const lvl = normalizeLevel(ln[1]);
    if (lvl) return lvl;
  }

  return null;
}

const LEVEL_CLASS: Record<NonNullable<LogLevel>, string> = {
  error:   "text-red-400",
  warn:    "text-amber-400",
  info:    "text-blue-400",
  debug:   "text-zinc-400",
  trace:   "text-zinc-500",
  success: "text-emerald-400",
};

// Left rail tint for continuation lines — ties a nested block (SQL body,
// `↳` caller, stacktrace) back to the severity of its leveled header without
// coloring the body text itself.
const LEVEL_RAIL: Record<NonNullable<LogLevel>, string> = {
  error:   "border-red-500/30",
  warn:    "border-amber-500/30",
  info:    "border-blue-500/30",
  debug:   "border-zinc-600/40",
  trace:   "border-zinc-700/40",
  success: "border-emerald-500/30",
};

// Compact colored badge per level. Doubles as the copy-entry trigger — clicking
// it copies the whole leveled entry (header + its continuation lines).
const LEVEL_BADGE: Record<NonNullable<LogLevel>, { label: string; cls: string }> = {
  error:   { label: "ERR",  cls: "bg-red-500/15 text-red-400 border-red-500/20" },
  warn:    { label: "WARN", cls: "bg-amber-500/15 text-amber-400 border-amber-500/20" },
  info:    { label: "INFO", cls: "bg-blue-500/15 text-blue-400 border-blue-500/20" },
  debug:   { label: "DBG",  cls: "bg-zinc-700/50 text-zinc-500 border-zinc-700/50" },
  trace:   { label: "TRC",  cls: "bg-zinc-800/50 text-zinc-600 border-zinc-800/50" },
  success: { label: "OK",   cls: "bg-emerald-500/15 text-emerald-400 border-emerald-500/20" },
};

// ── Ingest pipeline ───────────────────────────────────────────────────────────
interface ProcessedLine {
  text: string;
  level: LogLevel;
  /** Absolute, monotonic line number in the stream. Assigned once at ingestion
   *  and never reassigned, so the gutter number for a given physical line stays
   *  stable even as the ring buffer drops older lines off the head. (`processLine`
   *  leaves it 0; every ingestion site overwrites it.) */
  seq: number;
}

function processLine(raw: string): ProcessedLine | null {
  const clean = stripAnsi(raw);
  if (NOISE_RE.test(clean)) return null;
  return { text: clean, level: detectLevel(clean), seq: 0 };
}

const MAX_LINES = 10000;

// ── Clipboard with fallback ───────────────────────────────────────────────────
async function copyToClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

// ── Search highlight ───────────────────────────────────────────────────────────
function highlightLine(line: string, query: string): React.ReactNode {
  if (!query) return line;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = line.split(new RegExp(`(${escaped})`, "gi"));
  return parts.map((part, i) =>
    part.toLowerCase() === query.toLowerCase()
      ? <mark key={i} style={{ background: "rgba(251,191,36,0.25)", color: "#fde68a", borderRadius: 2, padding: "0 1px" }}>{part}</mark>
      : part
  );
}

// ── Level filter ──────────────────────────────────────────────────────────────
type EnabledLevels = Set<NonNullable<LogLevel>>;

// Level filter chips: All + a colored toggle per level. Multi-select — "All"
// clears the set (show everything); each chip toggles its level in the additive
// `enabledLevels` set. Each carries a dot color + an ON skin so an enabled chip
// reads clearly (tinted fill + its level color) vs a dimmed OFF chip. Explicit
// rgba on the fills/borders (opacity modifiers fail on var()-backed tokens).
const FILTER_SEGMENTS: {
  key: NonNullable<LogLevel>;
  label: string;
  dot: string;
  on: string;
}[] = [
  { key: "info",    label: "Info",    dot: "bg-accent",    on: "bg-[rgba(96,165,250,0.14)] text-accent-ink border-[rgba(96,165,250,0.35)]" },
  { key: "warn",    label: "Warn",    dot: "bg-warn",      on: "bg-[rgba(251,191,36,0.14)] text-warn border-[rgba(251,191,36,0.38)]" },
  { key: "error",   label: "Error",   dot: "bg-bad",       on: "bg-[rgba(248,113,113,0.14)] text-bad border-[rgba(248,113,113,0.38)]" },
  { key: "success", label: "Success", dot: "bg-ok",        on: "bg-[rgba(52,211,153,0.14)] text-ok border-[rgba(52,211,153,0.35)]" },
  { key: "debug",   label: "Debug",   dot: "bg-zinc-500",  on: "bg-[rgba(161,161,170,0.14)] text-zinc-300 border-[rgba(161,161,170,0.35)]" },
];

// ── Container name shortening ─────────────────────────────────────────────────
// Porta-managed containers carry a `porta-<uuid>-<appname>-<service>-<idx>`
// prefix. The sidebar only needs the service slug to be readable.
function shortContainerName(full: string, appName: string): string {
  const uuidRe = /^porta-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i;
  let s = full.replace(uuidRe, "");
  if (s.startsWith(`${appName}-`)) s = s.slice(appName.length + 1);
  s = s.replace(/-\d+$/, "");
  return s || full;
}

// ── Service status dot ────────────────────────────────────────────────────────
function serviceDotClass(state: string): string {
  if (state === "running") return "bg-emerald-400";
  if (state === "starting" || state === "restarting") return "bg-amber-400";
  if (state === "crashed" || state === "exited" || state === "dead") return "bg-red-400";
  if (state === "paused") return "bg-blue-400";
  return "bg-zinc-600";
}

// ── Leading timestamp / level extraction (display only) ───────────────────────
// The redesigned row renders the timestamp and the level as their own columns,
// so we peel a leading `HH:MM:SS(.mmm)` stamp and — for leveled headers — a
// redundant leading `[LEVEL]` marker off the visible body. Level detection,
// filtering, and search still run on the full untouched line text; this only
// shapes what each column shows.
const LEAD_TS_RE = /^(\d{1,2}:\d{2}:\d{2}(?:\.\d{1,6})?)\s+/;
const LEAD_LEVEL_RE = /^\[(?:ERROR|ERRO|FATAL|WARN(?:ING)?|INFO|NOTICE|DEBUG|TRACE|SUCCESS)\]\s*/i;

function splitLeadingMeta(text: string, stripLevel: boolean): { ts: string; body: string } {
  let body = text;
  let ts = "";
  const m = body.match(LEAD_TS_RE);
  if (m) {
    ts = m[1];
    body = body.slice(m[0].length);
  }
  if (stripLevel) body = body.replace(LEAD_LEVEL_RE, "");
  return { ts, body };
}

// ── Per-line memoized renderer ────────────────────────────────────────────────
interface LogLineProps {
  text: string;
  level: LogLevel;
  isContinuation: boolean;
  ownerLevel: LogLevel;
  originalIndex: number;
  /** Stable absolute line number for the gutter (see ProcessedLine.seq). */
  seq: number;
  crashed: boolean;
  query: string;
  isActiveMatch: boolean;
  isAlternateBlock: boolean;
  copied: boolean;
  blockCopied: boolean;
  wrap: boolean;
  showTimestamps: boolean;
  onCopy: (text: string, idx: number) => void;
  onCopyBlock: (idx: number) => void;
}

const LogLine = memo(function LogLine({
  text, level, isContinuation, ownerLevel, originalIndex, seq, crashed, query,
  isActiveMatch, isAlternateBlock, copied, blockCopied, wrap, showTimestamps, onCopy, onCopyBlock,
}: LogLineProps) {
  const effectiveLevel = crashed ? "error" : level;
  const showBadge = !isContinuation && !!effectiveLevel;
  const isErrorRow = !isContinuation && effectiveLevel === "error";
  // Peel the leading timestamp (and, on a leveled header, the redundant
  // `[LEVEL]` marker) into their own columns. Severity lives in the level badge,
  // the header text tint, and the continuation rail.
  const { ts, body } = splitLeadingMeta(text, showBadge);

  // A continuation line (SQL body, `↳` caller, stacktrace) belongs to the
  // leveled entry above it — keep the whole block on the same alternating text
  // tone, then tint the left rail with the owner's level so the block reads as
  // one unit tied to its severity.
  const blockTextCls = isAlternateBlock ? "text-cyan-200/70" : "text-zinc-400";
  const continuationLevel = crashed ? "error" : ownerLevel;
  const continuationUsesSeverity = continuationLevel === "error" || continuationLevel === "warn" || continuationLevel === "info" || continuationLevel === "success";
  const headerUsesSeverity = effectiveLevel === "error" || effectiveLevel === "warn" || effectiveLevel === "info" || effectiveLevel === "success";
  const textCls = crashed
    ? LEVEL_CLASS.error
    : isContinuation
      ? continuationUsesSeverity && continuationLevel ? LEVEL_CLASS[continuationLevel] : blockTextCls
      : headerUsesSeverity && effectiveLevel ? LEVEL_CLASS[effectiveLevel] : blockTextCls;
  const badge = showBadge && effectiveLevel ? LEVEL_BADGE[effectiveLevel] : null;
  const railLevel = crashed ? "error" : ownerLevel;
  const railCls = railLevel ? LEVEL_RAIL[railLevel] : "border-zinc-700/40";
  const rowBg = isActiveMatch
    ? "bg-yellow-500/[0.08] ring-1 ring-yellow-500/20"
    : isErrorRow
      ? "bg-red-500/[0.08] border-l-2 border-red-400"
      : "bg-transparent hover:bg-white/[0.025]";

  return (
    <div className={`flex py-[2.5px] rounded px-1 group items-start ${rowBg}`}>
      <span className="text-[11px] text-ink-3 w-8 shrink-0 mr-2 text-right tabular-nums pt-[2px] group-hover:text-ink-2 select-none">
        {seq + 1}
      </span>
      {showTimestamps && ts && (
        <span className="text-[11px] text-[#5f5f5f] tabular-nums mr-2 shrink-0 pt-[2px] select-none">
          {ts}
        </span>
      )}
      <span className="w-8 shrink-0 mr-2 pt-[1px] select-none">
        {badge && (
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onCopyBlock(originalIndex)}
            title="Copy this entry (with its body/stacktrace)"
            className={`text-[9px] font-medium px-1 py-px rounded border transition-all cursor-pointer ${
              blockCopied
                ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
                : `${badge.cls} hover:brightness-125`
            }`}
          >
            {blockCopied ? "✓" : badge.label}
          </button>
        )}
      </span>
      <span
        className={`${wrap ? "terminal-log-line-wrap min-w-0" : "terminal-log-line min-w-max"} flex-1 text-[11px] ${textCls} ${
          isContinuation ? `border-l ${railCls} pl-2` : ""
        }`}
      >
        {highlightLine(body, query)}
      </span>
      <span className="shrink-0 ml-2 flex items-center pt-[2px] select-none">
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onCopy(text, originalIndex)}
          title="Copy line"
          className={`transition-opacity ${
            copied ? "opacity-100 text-emerald-400" : "opacity-0 group-hover:opacity-60 text-zinc-600"
          }`}
        >
          {copied ? (
            <svg width="12" height="12" viewBox="0 0 11 11" fill="none">
              <path d="M2 5.5l2.5 2.5 4.5-4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <rect x="3.4" y="3.4" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.1"/>
              <path d="M2.2 7.4V2.6a.6.6 0 01.6-.6h4.6" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
            </svg>
          )}
        </button>
      </span>
    </div>
  );
});

// ── Component ─────────────────────────────────────────────────────────────────
export default function LogViewer({ appId, appName, appKind, logs, isRunning, isStarting, crashed, exitCode, onClose, onClear, embedded = false, isInstance = false }: Props) {
  const isContainerSource = appKind === "docker" || appKind === "compose";
  const logEvent = isInstance ? `instance:log:${appId}` : `app:log:${appId}`;

  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  // Find is an overlay, not chrome — same deal as the terminal's ⌘F widget. It
  // used to be a permanent pill in the toolbar, which cost header width on every
  // session whether or not anyone was searching.
  const [searchOpen, setSearchOpen] = useState(false);
  // Additive level filter: empty = no filter, show everything. Toggling a pill
  // ON narrows the view to *only* the selected levels.
  const [enabledLevels, setEnabledLevels] = useState<EnabledLevels>(new Set());
  const [followTail, setFollowTail] = useState(true);
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);
  const [copiedLine, setCopiedLine] = useState<number | null>(null);
  const [copiedBlock, setCopiedBlock] = useState<number | null>(null);
  const [wrap, setWrap] = useState(true);
  const [showTimestamps, setShowTimestamps] = useState(true);
  const [copiedToast, setCopiedToast] = useState(false);
  const [localLogs, setLocalLogs] = useState<ProcessedLine[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [services, setServices] = useState<ServiceItem[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const vRef = useRef<VirtualizerHandle>(null);

  // Batch incoming log events per animation frame. Without this each line
  // triggered its own render — at high log rates React couldn't keep up.
  const pendingRef = useRef<ProcessedLine[]>([]);
  const rafRef = useRef<number | null>(null);
  // Next absolute line number to hand out (see ProcessedLine.seq). Reset per
  // source switch so each stream's gutter starts at 1.
  const seqRef = useRef(0);
  // Once the user clicks "Load full history", stop the live ring buffer from
  // re-truncating to MAX_LINES — otherwise the next incoming line would chop the
  // freshly-loaded history right back down and the view would jump.
  const fullHistoryRef = useRef(false);

  // Build the service list. Process apps have a single "process" entry that
  // mirrors the app's run state; docker/compose apps fetch their containers
  // and re-fetch when run state flips (start brings new containers up).
  useEffect(() => {
    if (!isContainerSource) {
      const procState: ProcessState = crashed
        ? "crashed"
        : isRunning
        ? "running"
        : isStarting
        ? "starting"
        : "stopped";
      const item: ServiceItem = { kind: "process", key: "process", label: appName, state: procState };
      setServices([item]);
      setSelectedKey((prev) => prev ?? "process");
      return;
    }
    let cancelled = false;
    containersForApp(appId)
      .then((list: ContainerInfo[]) => {
        if (cancelled) return;
        const items: ServiceItem[] = list.map((c) => ({
          kind: "container",
          key: c.name,
          label: shortContainerName(c.name, appName),
          state: c.state,
        }));
        setServices(items);
        setSelectedKey((prev) => {
          if (prev && items.find((i) => i.key === prev)) return prev;
          const running = items.find((i) => i.state === "running") ?? items[0];
          return running?.key ?? null;
        });
      })
      .catch(() => {
        if (cancelled) return;
        setServices([]);
        setSelectedKey(null);
      });
    return () => {
      cancelled = true;
    };
  }, [isContainerSource, appId, appName, isRunning, isStarting, crashed]);

  // Subscribe to the active service's log stream. Resets on switch.
  useEffect(() => {
    if (!selectedKey) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let streamIdLocal: string | null = null;

    setLocalLogs(null);
    setTruncated(false);
    pendingRef.current = [];
    seqRef.current = 0;
    fullHistoryRef.current = false;
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    function flush() {
      rafRef.current = null;
      if (pendingRef.current.length === 0) return;
      const batch = pendingRef.current;
      pendingRef.current = [];
      // Stamp absolute line numbers here (not inside the setState updater, which
      // React may run twice) so each line's gutter number is assigned exactly once.
      for (const p of batch) p.seq = seqRef.current++;
      setLocalLogs((prev) => {
        const base = prev ?? [];
        const combined = base.concat(batch);
        // After "Load full history" the buffer is intentionally unbounded.
        if (!fullHistoryRef.current && combined.length > MAX_LINES) {
          setTruncated(true);
          return combined.slice(combined.length - MAX_LINES);
        }
        return combined;
      });
    }

    function pushLine(raw: string) {
      const p = processLine(raw);
      if (!p) return;
      pendingRef.current.push(p);
      if (rafRef.current === null) {
        rafRef.current = requestAnimationFrame(flush);
      }
    }

    if (!isContainerSource) {
      // Process source — load history from disk, then subscribe to the live tail.
      getAppLogs(appId)
        .then((rawLines) => {
          if (cancelled) return;
          const processed: ProcessedLine[] = [];
          for (const raw of rawLines) {
            const p = processLine(raw);
            if (p) { p.seq = processed.length; processed.push(p); }
          }
          // Live lines that stream in after this resolve continue the numbering.
          seqRef.current = processed.length;
          if (processed.length > MAX_LINES) {
            setTruncated(true);
            setLocalLogs(processed.slice(processed.length - MAX_LINES));
          } else {
            setLocalLogs(processed);
          }
        })
        .catch(() => {
          if (!cancelled) setLocalLogs([]);
        });

      if (isTauri) {
        listen<string>(logEvent, (e) => pushLine(e.payload)).then((u) => {
          if (cancelled) {
            u();
            return;
          }
          unlisten = u;
        });
      }
    } else {
      // Container source — `tail` parameter on start_container_logs replays
      // recent history; there's no separate disk-history fetch.
      setLocalLogs([]);
      if (isTauri) {
        startContainerLogs(selectedKey, 200)
          .then(async (streamId) => {
            if (cancelled) {
              stopContainerLogs(streamId).catch(() => {});
              return;
            }
            streamIdLocal = streamId;
            const u = await listen<ContainerLogLine>(`container-log:${streamId}`, (e) => {
              pushLine(e.payload.text);
            });
            if (cancelled) {
              u();
              stopContainerLogs(streamId).catch(() => {});
              return;
            }
            unlisten = u;
          })
          .catch((e) => {
            if (!cancelled) {
              setLocalLogs([{ text: `error: ${String(e)}`, level: "error", seq: 0 }]);
            }
          });
      }
    }

    return () => {
      cancelled = true;
      unlisten?.();
      if (streamIdLocal) stopContainerLogs(streamIdLocal).catch(() => {});
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      pendingRef.current = [];
    };
  }, [appId, logEvent, selectedKey, isContainerSource]);

  // Fallback: while the disk read is in flight, render the Zustand capped buffer.
  const fallbackLogs = useMemo<ProcessedLine[]>(() => {
    if (localLogs !== null) return [];
    const out: ProcessedLine[] = [];
    for (const raw of logs) {
      const p = processLine(raw);
      if (p) { p.seq = out.length; out.push(p); }
    }
    return out;
  }, [localLogs, logs]);

  const allLogs = localLogs ?? fallbackLogs;

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 80);
    return () => clearTimeout(t);
  }, [query]);

  function showCopiedToast() {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setCopiedToast(true);
    toastTimer.current = setTimeout(() => setCopiedToast(false), 1500);
  }

  const copyLineRef = useRef<(text: string, index: number) => void>(() => {});
  copyLineRef.current = (text: string, index: number) => {
    void copyToClipboard(text).then((ok) => {
      if (!ok) return;
      setCopiedLine(index);
      showCopiedToast();
      setTimeout(() => setCopiedLine(null), 1200);
    });
  };
  const handleCopyLine = useMemo(() => (text: string, index: number) => copyLineRef.current(text, index), []);

  // Copy a whole leveled entry — the header line plus every continuation
  // (SQL body, `↳` caller, stacktrace) that belongs to it. Clicking the badge
  // anywhere in the block walks up to its header first, then collects down.
  const copyBlockRef = useRef<(index: number) => void>(() => {});
  copyBlockRef.current = (index: number) => {
    let start = index;
    while (start > 0 && lineMeta[start]?.isContinuation) start--;
    const parts = [allLogs[start]?.text ?? ""];
    for (let i = start + 1; i < allLogs.length; i++) {
      if (!lineMeta[i]?.isContinuation) break;
      parts.push(allLogs[i].text);
    }
    void copyToClipboard(parts.join("\n")).then((ok) => {
      if (!ok) return;
      setCopiedBlock(start);
      showCopiedToast();
      setTimeout(() => setCopiedBlock(null), 1200);
    });
  };
  const handleCopyBlock = useMemo(() => (index: number) => copyBlockRef.current(index), []);

  const filterActive = enabledLevels.size > 0;

  function toggleLevel(level: NonNullable<LogLevel>) {
    setEnabledLevels((prev) => {
      const next = new Set(prev);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });
  }

  function resetLevels() {
    setEnabledLevels(new Set());
  }

  // Continuation detection — "orphan inheritance" over the raw stream order.
  // A level-less, non-blank line that trails a leveled entry (or another
  // continuation of one) belongs to it: Ecto's `SELECT …` and `↳ caller`
  // lines attach to the `[debug] QUERY` header above. We record the owning
  // level so the line inherits its parent's severity for both rail tint and
  // filtering. We also assign an alternating block tone: a header and all of
  // its continuations share one tone, then the next physical entry gets the
  // other tone. A blank line resets the chain, and standalone level-less
  // stdout (no leveled header above) is never a continuation. Computed on
  // the full pre-filter array so adjacency reflects physical stream order.
  const lineMeta = useMemo(() => {
    const meta = allLogs.map(() => ({
      isContinuation: false,
      ownerLevel: null as LogLevel,
      isAlternateBlock: false,
    }));
    let chainLevel: LogLevel = null;
    let currentAlternateBlock = true;
    for (let i = 0; i < allLogs.length; i++) {
      const { text, level } = allLogs[i];
      if (text.trim() === "") {
        chainLevel = null;
        currentAlternateBlock = !currentAlternateBlock;
        meta[i].isAlternateBlock = currentAlternateBlock;
        continue;
      }
      if (level) {
        currentAlternateBlock = !currentAlternateBlock;
        chainLevel = level;
        meta[i].isAlternateBlock = currentAlternateBlock;
        continue;
      }
      if (chainLevel) {
        meta[i] = {
          isContinuation: true,
          ownerLevel: chainLevel,
          isAlternateBlock: currentAlternateBlock,
        };
        continue;
      }
      currentAlternateBlock = !currentAlternateBlock;
      meta[i].isAlternateBlock = currentAlternateBlock;
    }
    return meta;
  }, [allLogs]);

  // Standalone level-less lines are always shown — filtering narrows, never
  // gates unclassified output. A continuation, however, inherits its parent's
  // level: hide the header and its nested body goes with it, so a filtered
  // view never strands an orphan SQL body or `↳ caller` under nothing.
  const filteredLines = useMemo(() => {
    const out: { line: ProcessedLine; originalIndex: number }[] = [];
    for (let i = 0; i < allLogs.length; i++) {
      const line = allLogs[i];
      if (filterActive) {
        const meta = lineMeta[i];
        const effLevel = meta.isContinuation ? meta.ownerLevel : line.level;
        // Show only the selected levels (a continuation inherits its owner's
        // level, so error stacktraces ride along with their header). When a
        // filter is active, level-less standalone stdout is hidden too — the
        // view is exactly what was toggled, nothing else.
        if (!effLevel || !enabledLevels.has(effLevel)) continue;
      }
      out.push({ line, originalIndex: i });
    }
    return out;
  }, [allLogs, lineMeta, enabledLevels, filterActive]);

  // Indexes (into filteredLines) of lines containing the query — drives the
  // match counter and scroll-to-match navigation.
  const searchMatches = useMemo(() => {
    if (!debouncedQuery) return [] as number[];
    const lower = debouncedQuery.toLowerCase();
    const matches: number[] = [];
    for (let i = 0; i < filteredLines.length; i++) {
      if (filteredLines[i].line.text.toLowerCase().includes(lower)) matches.push(i);
    }
    return matches;
  }, [filteredLines, debouncedQuery]);

  useEffect(() => {
    if (searchMatches.length === 0) {
      setActiveMatchIndex(0);
    } else if (activeMatchIndex >= searchMatches.length) {
      setActiveMatchIndex(searchMatches.length - 1);
    }
  }, [searchMatches.length, activeMatchIndex]);

  useEffect(() => {
    if (searchMatches.length === 0) return;
    const targetIdx = searchMatches[activeMatchIndex];
    // targetIdx indexes into filteredLines, which is exactly the order the
    // Virtualizer renders — scrollToIndex brings an off-screen match into
    // view (and mounts it) where scrollIntoView couldn't reach a node that
    // was never rendered.
    vRef.current?.scrollToIndex(targetIdx, { align: "center" });
    setFollowTail(false);
  }, [activeMatchIndex, searchMatches]);

  const goToNextMatch = useCallback(() => {
    if (searchMatches.length === 0) return;
    setActiveMatchIndex((prev) => (prev + 1) % searchMatches.length);
  }, [searchMatches.length]);

  const goToPrevMatch = useCallback(() => {
    if (searchMatches.length === 0) return;
    setActiveMatchIndex((prev) => (prev - 1 + searchMatches.length) % searchMatches.length);
  }, [searchMatches.length]);

  const matchCount = debouncedQuery ? searchMatches.length : null;
  const hasMatches = (matchCount ?? 0) > 0;

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    // The input doesn't exist yet on the first ⌘F, so focus after it mounts.
    requestAnimationFrame(() => {
      searchRef.current?.focus();
      searchRef.current?.select();
    });
  }, []);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setQuery("");
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        openSearch();
        return;
      }
      if (e.key === "Escape") {
        // Matches the terminal: first Escape clears a typed query, the second
        // dismisses the widget. Only once find is gone does Escape close the
        // viewer itself.
        if (searchOpen) {
          if (query) setQuery("");
          else closeSearch();
          return;
        }
        onClose();
        return;
      }
      if (searchOpen && document.activeElement === searchRef.current && query) {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          goToNextMatch();
        } else if (e.key === "Enter" && e.shiftKey) {
          e.preventDefault();
          goToPrevMatch();
        } else if (e.key === "ArrowDown") {
          e.preventDefault();
          goToNextMatch();
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          goToPrevMatch();
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, query, searchOpen, openSearch, closeSearch, goToNextMatch, goToPrevMatch]);

  // Tail follow — pin to the last visible (filtered) line as it grows. Driven
  // off filteredLines.length so a non-matching incoming line never yanks the
  // viewport. scrollToIndex(align:end) is instant; "smooth" stacks animations
  // at high log rates and drifts the viewport out of sync.
  useEffect(() => {
    if (!followTail || filteredLines.length === 0) return;
    vRef.current?.scrollToIndex(filteredLines.length - 1, { align: "end" });
  }, [filteredLines.length, followTail]);

  function handleMouseUp() {
    const sel = window.getSelection();
    const text = sel?.toString() ?? "";
    if (text.length > 0) {
      void copyToClipboard(text).then((ok) => { if (ok) showCopiedToast(); });
    }
  }

  function handleScroll() {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (!atBottom && followTail) setFollowTail(false);
    if (atBottom && !followTail) setFollowTail(true);
  }

  async function loadFullHistory() {
    const raw = await getAppLogs(appId);
    const processed: ProcessedLine[] = [];
    for (const line of raw) {
      const p = processLine(line);
      if (p) { p.seq = processed.length; processed.push(p); }
    }
    seqRef.current = processed.length;
    // Keep the full set — don't let the live ring buffer chop it back to
    // MAX_LINES on the next incoming line.
    fullHistoryRef.current = true;
    setLocalLogs(processed);
    setTruncated(false);
  }

  // Track how many lines have arrived since the user stopped following, so the
  // footer can offer "Paused · N new — jump to live". Captured once on the
  // follow→paused transition; stays put while paused.
  const pausedAtRef = useRef(0);
  const prevFollowRef = useRef(followTail);
  useEffect(() => {
    if (!followTail && prevFollowRef.current) {
      pausedAtRef.current = filteredLines.length;
    }
    prevFollowRef.current = followTail;
  }, [followTail, filteredLines.length]);
  const pendingNew = followTail ? 0 : Math.max(0, filteredLines.length - pausedAtRef.current);

  // Footer source label — the active service (container) or the app itself.
  const sourceLabel = services.find((s) => s.key === selectedKey)?.label ?? appName;

  // Error count for the segmented filter's Error badge.
  const errorCount = useMemo(
    () => allLogs.reduce((n, l) => n + (l.level === "error" ? 1 : 0), 0),
    [allLogs],
  );

  // Download the current buffer as a plain-text file.
  function handleExport() {
    const text = allLogs.map((l) => l.text).join("\n");
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${appName}-logs.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <div className={embedded
      ? "h-full w-full flex flex-col overflow-hidden bg-surface-0"
      : "fixed inset-0 bg-[#0a0a0c]/95 backdrop-blur-sm z-50 flex flex-col overflow-hidden"}>
      <div className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-[60] flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 border border-white/10 text-[11px] text-emerald-400 shadow-lg transition-all duration-200 pointer-events-none ${copiedToast ? "opacity-100 translate-y-0" : "opacity-0 translate-y-1"}`}>
        <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
          <path d="M2 5.5l2.5 2.5 4.5-4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        Copied
      </div>

      <div className="flex-1 flex flex-col min-h-0 m-3 rounded-card border border-subtle bg-surface-2 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-subtle bg-surface-1 shrink-0 select-none flex-wrap">
        {/* Live-source dot (app name is redundant — the workbench header already
            shows it). Keep a compact crash/exit badge, it's a real signal here. */}
        <div className="flex items-center gap-2 shrink-0">
          <span className={`w-2 h-2 rounded-full ${
            crashed ? "bg-red-400" :
            isStarting ? "bg-amber-400 pulse-dot" :
            isRunning ? "bg-emerald-400 pulse-dot" :
            "bg-zinc-600"
          }`} title={crashed ? "crashed" : isStarting ? "starting" : isRunning ? "running" : "stopped"} />
          {crashed && exitCode !== null && exitCode !== undefined && (
            <span className="text-[11px] text-red-400 bg-red-500/10 border border-red-500/20 rounded px-1.5 py-0.5">
              exit {exitCode}
            </span>
          )}
        </div>

        {/* Level filter: All + a colored toggle per level (multi-select). An
            enabled chip is filled + colored; a disabled one is dimmed. */}
        <div className="inline-flex items-center gap-1 shrink-0 text-[11px] select-none">
          <button
            onClick={resetLevels}
            className={`px-2.5 py-[3px] rounded-full border transition-colors ${
              !filterActive
                ? "bg-surface-2 text-ink border-strong"
                : "text-ink-3 border-subtle hover:text-ink-2 hover:border-strong"
            }`}
            title="Show all levels"
          >
            All
          </button>
          {FILTER_SEGMENTS.map(({ key, label, dot, on }) => {
            const active = enabledLevels.has(key);
            return (
              <button
                key={key}
                onClick={() => toggleLevel(key)}
                className={`inline-flex items-center gap-1.5 px-2.5 py-[3px] rounded-full border transition-colors ${
                  active ? `${on} font-medium` : "text-ink-3 border-subtle hover:text-ink-2 hover:border-strong"
                }`}
                title={active ? `Showing ${label} — click to hide` : `Show only ${label}`}
                aria-pressed={active}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${dot} ${active ? "" : "opacity-40"}`} />
                {label}
                {key === "error" && errorCount > 0 && (
                  <span className="tabular-nums opacity-80">{errorCount}</span>
                )}
              </button>
            );
          })}
        </div>

        <div className="flex-1" />

        {/* Icon-only controls: follow, find, timestamps, wrap, export, clear.
            Follow lives here rather than in the status bar — it's an action
            (and the one people reach for most), not a readout. */}
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            onClick={() => setFollowTail((f) => !f)}
            aria-pressed={followTail}
            title={followTail
              ? "Following new lines — click to pause"
              : `Jump to the newest line and resume following${pendingNew > 0 ? ` (${pendingNew.toLocaleString()} new)` : ""}`}
            className={`inline-flex items-center gap-1 px-1.5 py-1.5 rounded-control transition-colors ${
              followTail
                ? "text-accent"
                : pendingNew > 0
                  ? "text-accent bg-accent-bg hover:brightness-110"
                  : "text-ink-3 hover:text-ink hover:bg-white/[0.06]"
            }`}
          >
            {/* Arrow-to-line: "stick to the tail". */}
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
              <path d="M8 2.5v7m0 0L5 6.6M8 9.5l3-2.9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M3.5 12.5h9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
            </svg>
            {!followTail && pendingNew > 0 && (
              <span className="text-[10px] font-medium tabular-nums">{pendingNew.toLocaleString()}</span>
            )}
          </button>
          <span className="w-px h-4 bg-[var(--border-subtle)] mx-0.5" aria-hidden />
          <button
            onClick={() => (searchOpen ? closeSearch() : openSearch())}
            title="Find in logs (⌘F)"
            aria-label="Find in logs"
            aria-pressed={searchOpen}
            className={`p-1.5 rounded-control transition-colors ${
              searchOpen ? "text-accent" : "text-ink-3 hover:text-ink hover:bg-white/[0.06]"
            }`}
          >
            <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
              <circle cx="6.5" cy="6.5" r="4" stroke="currentColor" strokeWidth="1.3"/>
              <path d="M9.5 9.5l3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
            </svg>
          </button>
          <button
            onClick={() => setShowTimestamps((s) => !s)}
            title={showTimestamps ? "Hide timestamps" : "Show timestamps"}
            className={`p-1.5 rounded-control transition-colors ${
              showTimestamps ? "text-accent" : "text-ink-3 hover:text-ink hover:bg-white/[0.06]"
            }`}
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.3"/>
              <path d="M8 4.5V8l2.5 1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
          <button
            onClick={() => setWrap((w) => !w)}
            title={wrap ? "Disable soft wrap" : "Soft-wrap long lines"}
            className={`p-1.5 rounded-control transition-colors ${
              wrap ? "text-accent" : "text-ink-3 hover:text-ink hover:bg-white/[0.06]"
            }`}
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
              <path d="M2 3.5h12M2 8h9a2.5 2.5 0 110 5H8m0 0l1.8-1.8M8 13l1.8 1.8M2 12.5h3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
          <button
            onClick={handleExport}
            title="Export logs"
            className="p-1.5 rounded-control text-ink-3 hover:text-ink hover:bg-white/[0.06] transition-colors"
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
              <path d="M8 2v8m0 0L5 7m3 3l3-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M3 12.5h10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
            </svg>
          </button>
          <button
            onClick={async () => {
              if (
                !window.confirm(
                  `Clear all logs for "${appName}"? This wipes the log file on disk. Running apps keep writing — the log just starts fresh.`,
                )
              )
                return;
              try {
                await clearAppLogFile(appId);
              } catch {
                // Truncate failed (file locked/missing) — still clear the view.
              }
              setLocalLogs([]);
              setTruncated(false);
              onClear();
            }}
            title="Clear logs"
            className="p-1.5 rounded-control text-ink-3 hover:text-ink hover:bg-white/[0.06] transition-colors"
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
              <path d="M3 4.5h10M6.5 4.5V3.2a.7.7 0 01.7-.7h1.6a.7.7 0 01.7.7v1.3M4.5 4.5l.6 8a.9.9 0 00.9.8h4a.9.9 0 00.9-.8l.6-8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        </div>

        {!embedded && <button
          onClick={onClose}
          className="p-1.5 rounded-lg text-zinc-600 hover:text-zinc-200 hover:bg-white/[0.07] transition-colors"
          title="Close (Esc)"
        >
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
            <path d="M2 2l9 9M11 2L2 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </button>}
      </div>

      <div className="flex-1 flex min-h-0">
        {isContainerSource && (
          <aside className="w-48 shrink-0 border-r border-white/[0.07] flex flex-col overflow-hidden">
            <div className="px-3 py-2 border-b border-white/[0.05] text-[10px] uppercase tracking-wider text-zinc-600 select-none">
              Services
            </div>
            <div className="flex-1 overflow-y-auto py-1">
              {services.length === 0 ? (
                <p className="px-3 py-3 text-[11px] text-zinc-600 select-none">
                  No containers. Start the app to see logs.
                </p>
              ) : (
                services.map((s) => {
                  const active = s.key === selectedKey;
                  const dotCls = serviceDotClass(s.state);
                  const pulse = s.state === "running" || s.state === "starting" ? "pulse-dot" : "";
                  return (
                    <button
                      key={s.key}
                      onClick={() => setSelectedKey(s.key)}
                      className={`w-full flex items-center gap-2 px-3 py-1.5 text-[12px] font-mono text-left transition-colors ${
                        active
                          ? "bg-white/[0.06] text-zinc-100"
                          : "text-zinc-400 hover:bg-white/[0.03] hover:text-zinc-200"
                      }`}
                      title={s.state}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotCls} ${pulse}`} />
                      <span className="truncate flex-1">{s.label}</span>
                      {active && (
                        <span className="text-zinc-500 text-[10px] shrink-0">◀</span>
                      )}
                    </button>
                  );
                })
              )}
            </div>
          </aside>
        )}

        <div className="relative flex-1 flex flex-col min-w-0">
      {/* Find widget — floats over the log body like the terminal's, so it costs
          no toolbar width when nobody is searching. */}
      {searchOpen && (
        <div className="absolute top-2 right-3 z-20 flex items-center gap-1.5 rounded-lg border border-white/[0.1] bg-[#1a1a1d] pl-2 pr-1.5 py-1 shadow-[0_10px_28px_rgba(0,0,0,0.55)]">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="shrink-0 text-zinc-600">
            <circle cx="5" cy="5" r="3.5" stroke="currentColor" strokeWidth="1.3"/>
            <path d="M8 8l2 2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
          </svg>
          <input
            ref={searchRef}
            spellCheck={false}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find in logs…"
            className="w-[190px] bg-transparent py-0.5 text-[12px] text-zinc-200 placeholder:text-zinc-600 outline-none select-text"
          />
          <span className="shrink-0 text-[11px] tabular-nums text-zinc-600 select-none">
            {matchCount === null ? "" : matchCount === 0 ? "0/0" : `${activeMatchIndex + 1}/${matchCount}`}
          </span>
          <span className="w-px h-4 bg-white/[0.1] shrink-0" />
          <button
            onClick={goToPrevMatch}
            disabled={!hasMatches}
            className="shrink-0 p-1 rounded text-zinc-600 enabled:hover:text-zinc-200 enabled:hover:bg-white/[0.08] disabled:opacity-40 transition-colors"
            title="Previous match (⇧⏎)"
          >
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
              <path d="M2.5 6.75L5.5 3.75l3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
          <button
            onClick={goToNextMatch}
            disabled={!hasMatches}
            className="shrink-0 p-1 rounded text-zinc-600 enabled:hover:text-zinc-200 enabled:hover:bg-white/[0.08] disabled:opacity-40 transition-colors"
            title="Next match (⏎)"
          >
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
              <path d="M2.5 4.25l3 3 3-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
          <button
            onClick={closeSearch}
            className="shrink-0 p-1 rounded text-zinc-600 hover:text-zinc-200 hover:bg-white/[0.08] transition-colors"
            title="Close (Esc)"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
      )}
      {truncated && (
        <div className="flex items-center justify-between gap-2 px-4 py-1.5 bg-amber-500/5 border-b border-amber-500/10 text-[11px] text-amber-400/80 shrink-0">
          <span>
            {isContainerSource
              ? `Showing last ${MAX_LINES.toLocaleString()} lines.`
              : `Showing last ${MAX_LINES.toLocaleString()} lines. Older history is still on disk.`}
          </span>
          {!isContainerSource && (
            <button
              onClick={() => { void loadFullHistory(); }}
              className="px-2 py-0.5 rounded text-amber-300 hover:text-amber-200 hover:bg-amber-500/10 transition-colors"
            >
              Load full history
            </button>
          )}
        </div>
      )}

      <div
        ref={containerRef}
        onScroll={handleScroll}
        onMouseUp={handleMouseUp}
        className="flex-1 overflow-auto px-4 py-3 terminal-log-font select-text bg-surface-0"
      >
        {localLogs === null && (
          <p className="text-[12px] text-zinc-600 mb-3 text-center select-none">Loading logs…</p>
        )}

        {filteredLines.length === 0 ? (
          <p className="text-[12px] text-zinc-600 mt-8 text-center select-none">
            {filterActive ? "No lines match your filter." : "No output yet."}
          </p>
        ) : (
          // Virtualized: only the lines in/near the viewport are mounted to the
          // DOM (~30-50 nodes) regardless of how many thousands are in
          // filteredLines. scrollRef points at our own overflow container so
          // handleScroll's atBottom math keeps working unchanged. Dynamic line
          // heights (wrap mode) are measured automatically.
          <Virtualizer ref={vRef} scrollRef={containerRef}>
            {filteredLines.map(({ line, originalIndex }, filteredIdx) => {
              const isActiveMatch = !!debouncedQuery && searchMatches.length > 0 && searchMatches[activeMatchIndex] === filteredIdx;
              return (
                <LogLine
                  key={line.seq}
                  text={line.text}
                  level={line.level}
                  isContinuation={lineMeta[originalIndex].isContinuation}
                  ownerLevel={lineMeta[originalIndex].ownerLevel}
                  originalIndex={originalIndex}
                  seq={line.seq}
                  crashed={!!crashed}
                  query={debouncedQuery}
                  isActiveMatch={isActiveMatch}
                  isAlternateBlock={lineMeta[originalIndex].isAlternateBlock}
                  copied={copiedLine === originalIndex}
                  blockCopied={copiedBlock === originalIndex}
                  wrap={wrap}
                  showTimestamps={showTimestamps}
                  onCopy={handleCopyLine}
                  onCopyBlock={handleCopyBlock}
                />
              );
            })}
          </Virtualizer>
        )}
      </div>

      <div className="flex items-center gap-2 px-3 py-1.5 border-t border-subtle shrink-0 select-none text-[11px]">
        {/* Follow now lives in the toolbar; the status bar keeps only the
            "you're not at the tail" nudge, which needs to sit next to the
            lines it's talking about. */}
        {!followTail && pendingNew > 0 && (
          <button
            onClick={() => setFollowTail(true)}
            className="flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-accent bg-accent-bg hover:brightness-110 transition-all"
            title="Jump to the newest line and resume following"
          >
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
              <path d="M7 2.5v8m0 0L3.8 7.4M7 10.5l3.2-3.1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            {pendingNew.toLocaleString()} new — jump to live
          </button>
        )}
        <span className="flex-1" />
        <span className="text-ink-3 font-mono tabular-nums">
          {localLogs === null ? (
            "loading…"
          ) : (
            <>
              {sourceLabel} · {filterActive
                ? `${filteredLines.length.toLocaleString()} of ${allLogs.length.toLocaleString()} lines`
                : `${allLogs.length.toLocaleString()} lines`}
              {truncated && <span className="text-warn"> · capped</span>}
            </>
          )}
        </span>
      </div>
        </div>
      </div>
      </div>
    </div>
  );
}
