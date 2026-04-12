import { useEffect, useMemo, useRef, useState } from "react";

interface Props {
  appName: string;
  logs: string[];
  crashed?: boolean;
  exitCode?: number | null;
  onClose: () => void;
  onClear: () => void;
}

// ── ANSI stripping ─────────────────────────────────────────────────────────────
// eslint-disable-next-line no-control-regex
const ANSI_RE = /[\x1b\x9b][\[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]/g;
function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, "");
}

// ── Log level detection ────────────────────────────────────────────────────────
type LogLevel = "error" | "warn" | "info" | "debug" | "trace" | "success" | null;

const LEVEL_PATTERNS: [LogLevel, RegExp][] = [
  ["error",   /\b(error|err|fatal|exception|crash|failed|failure)\b/i],
  ["warn",    /\b(warn(?:ing)?|deprecated|caution)\b/i],
  ["success", /\b(compiled|generated|ok|done|started|ready|success(?:ful)?|listening)\b/i],
  ["info",    /\b(info(?:rmation)?|notice|log)\b/i],
  ["debug",   /\b(debug|verbose)\b/i],
  ["trace",   /\b(trace)\b/i],
];

function detectLevel(line: string): LogLevel {
  // Bracketed level markers get priority — [error], [warning], [info], etc.
  const bracketed = line.match(/\[(error|err|fatal|warn(?:ing)?|info|debug|trace|notice)\]/i);
  if (bracketed) {
    const l = bracketed[1].toLowerCase();
    if (l === "error" || l === "err" || l === "fatal") return "error";
    if (l.startsWith("warn")) return "warn";
    if (l === "info" || l === "notice") return "info";
    if (l === "debug") return "debug";
    if (l === "trace") return "trace";
  }

  // PREFIX markers: ERROR:, WARN:, INFO: etc. at start or after timestamp
  const prefix = line.match(/(?:^|\s)(ERROR|FATAL|WARN(?:ING)?|INFO|DEBUG|TRACE|SUCCESS)[\s:]/);
  if (prefix) {
    const l = prefix[1].toLowerCase();
    if (l === "error" || l === "fatal") return "error";
    if (l.startsWith("warn")) return "warn";
    if (l === "info") return "info";
    if (l === "debug") return "debug";
    if (l === "trace") return "trace";
    if (l === "success") return "success";
  }

  // Heuristic scan (lower priority, only if no marker found)
  for (const [level, re] of LEVEL_PATTERNS) {
    if (re.test(line)) return level;
  }

  return null;
}

const LEVEL_CLASS: Record<NonNullable<LogLevel>, string> = {
  error:   "text-red-400",
  warn:    "text-amber-400",
  info:    "text-blue-400",
  debug:   "text-zinc-500",
  trace:   "text-zinc-600",
  success: "text-emerald-400",
};

const LEVEL_BADGE: Record<NonNullable<LogLevel>, { label: string; cls: string }> = {
  error:   { label: "ERR",  cls: "bg-red-500/15 text-red-400 border-red-500/20" },
  warn:    { label: "WARN", cls: "bg-amber-500/15 text-amber-400 border-amber-500/20" },
  info:    { label: "INFO", cls: "bg-blue-500/15 text-blue-400 border-blue-500/20" },
  debug:   { label: "DBG",  cls: "bg-zinc-700/50 text-zinc-500 border-zinc-700/50" },
  trace:   { label: "TRC",  cls: "bg-zinc-800/50 text-zinc-600 border-zinc-800/50" },
  success: { label: "OK",   cls: "bg-emerald-500/15 text-emerald-400 border-emerald-500/20" },
};

// ── Search highlight ───────────────────────────────────────────────────────────
function highlightLine(line: string, query: string): React.ReactNode {
  if (!query) return line;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = line.split(new RegExp(`(${escaped})`, "gi"));
  return parts.map((part, i) =>
    part.toLowerCase() === query.toLowerCase()
      ? <mark key={i} style={{ background: "rgba(250,204,21,0.25)", color: "#fef08a", borderRadius: 2, padding: "0 1px" }}>{part}</mark>
      : part
  );
}

// ── Level filter ──────────────────────────────────────────────────────────────
type LevelFilter = NonNullable<LogLevel> | "all";

const FILTER_PILLS: { key: NonNullable<LogLevel>; label: string; activeCls: string }[] = [
  { key: "error",   label: "ERR",  activeCls: "bg-red-500/15 text-red-400 border-red-500/25" },
  { key: "warn",    label: "WARN", activeCls: "bg-amber-500/15 text-amber-400 border-amber-500/25" },
  { key: "success", label: "OK",   activeCls: "bg-emerald-500/15 text-emerald-400 border-emerald-500/25" },
  { key: "info",    label: "INFO", activeCls: "bg-blue-500/15 text-blue-400 border-blue-500/25" },
  { key: "debug",   label: "DBG",  activeCls: "bg-zinc-700/50 text-zinc-400 border-zinc-600/40" },
];

// ── Component ─────────────────────────────────────────────────────────────────
export default function LogViewer({ appName, logs, crashed, exitCode, onClose, onClear }: Props) {
  const [query, setQuery] = useState("");
  const [levelFilter, setLevelFilter] = useState<LevelFilter>("all");
  const [followTail, setFollowTail] = useState(true);
  const [copiedLine, setCopiedLine] = useState<number | null>(null);
  const [copiedToast, setCopiedToast] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isFirstScroll = useRef(true);

  const cleanLogs = useMemo(() => logs.map(stripAnsi), [logs]);

  function showCopiedToast() {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setCopiedToast(true);
    toastTimer.current = setTimeout(() => setCopiedToast(false), 1500);
  }

  function copyLine(line: string, index: number) {
    navigator.clipboard.writeText(line).then(() => {
      setCopiedLine(index);
      showCopiedToast();
      setTimeout(() => setCopiedLine(null), 1200);
    });
  }

  useEffect(() => { searchRef.current?.focus(); }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (query) { setQuery(""); return; }
        onClose();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, query]);

  useEffect(() => {
    if (!followTail) return;
    if (isFirstScroll.current) {
      isFirstScroll.current = false;
      logEndRef.current?.scrollIntoView({ behavior: "instant" });
      return;
    }
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs, followTail]);

  function handleMouseUp() {
    const sel = window.getSelection();
    if (sel && sel.toString().length > 0) {
      navigator.clipboard.writeText(sel.toString()).then(() => showCopiedToast()).catch(() => {});
    }
  }

  function handleScroll() {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (!atBottom && followTail) setFollowTail(false);
    if (atBottom && !followTail) setFollowTail(true);
  }

  const filteredLines = useMemo(() => {
    const lower = query.toLowerCase();
    return cleanLogs
      .map((line, i) => ({ line, originalIndex: i }))
      .filter(({ line }) => {
        if (query && !line.toLowerCase().includes(lower)) return false;
        if (levelFilter !== "all" && detectLevel(line) !== levelFilter) return false;
        return true;
      });
  }, [cleanLogs, query, levelFilter]);

  const matchCount = query ? filteredLines.length : null;

  return (
    <div className="fixed inset-0 bg-[#0a0a0c]/95 backdrop-blur-sm z-50 flex flex-col">
      {/* Copied toast */}
      <div className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-[60] flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 border border-white/10 text-[11px] text-emerald-400 shadow-lg transition-all duration-200 pointer-events-none ${copiedToast ? "opacity-100 translate-y-0" : "opacity-0 translate-y-1"}`}>
        <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
          <path d="M2 5.5l2.5 2.5 4.5-4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        Copied
      </div>
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-white/[0.07] shrink-0 select-none">
        <div className="flex items-center gap-2 shrink-0">
          <span className={`w-2 h-2 rounded-full ${crashed ? "bg-red-400" : "bg-emerald-400"}`} />
          <span className="text-[13px] font-semibold text-zinc-200">{appName}</span>
          {crashed && exitCode !== null && exitCode !== undefined && (
            <span className="text-[11px] text-red-400 bg-red-500/10 border border-red-500/20 rounded px-1.5 py-0.5">
              exit {exitCode}
            </span>
          )}
        </div>

        <span className="text-zinc-700 text-[12px]">·</span>
        <span className="text-[11px] text-zinc-600">{logs.length} lines</span>

        {/* Search */}
        <div className="flex-1 relative max-w-[400px]">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-600 pointer-events-none">
            <circle cx="5" cy="5" r="3.5" stroke="currentColor" strokeWidth="1.3"/>
            <path d="M8 8l2 2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
          </svg>
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search logs… (⌘F)"
            className="w-full bg-white/[0.05] border border-white/[0.08] rounded-lg pl-7 pr-3 py-1.5 text-[12px] text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-blue-500/50 focus:bg-white/[0.07] transition-all select-text"
          />
          {query && (
            <button onClick={() => setQuery("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-600 hover:text-zinc-300">
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
              </svg>
            </button>
          )}
        </div>

        {matchCount !== null && (
          <span className="text-[11px] text-zinc-500 shrink-0">
            {matchCount === 0 ? "no matches" : `${matchCount} match${matchCount === 1 ? "" : "es"}`}
          </span>
        )}

        <div className="flex-1" />

        {/* Level filter pills */}
        <div className="flex items-center gap-1 shrink-0">
          {FILTER_PILLS.map(({ key, label, activeCls }) => {
            const isActive = levelFilter === key;
            return (
              <button
                key={key}
                onClick={() => setLevelFilter(isActive ? "all" : key)}
                className={`px-2 py-1 rounded-md text-[10px] font-medium border transition-colors ${
                  isActive
                    ? activeCls
                    : "bg-white/[0.04] text-zinc-500 border border-white/[0.06] hover:text-zinc-300"
                }`}
              >
                {label}
              </button>
            );
          })}
          {levelFilter !== "all" && (
            <button
              onClick={() => setLevelFilter("all")}
              className="px-1.5 py-1 rounded-md text-[10px] font-medium border bg-white/[0.04] text-zinc-500 border-white/[0.06] hover:text-zinc-300 transition-colors"
              title="Clear level filter"
            >
              ×
            </button>
          )}
        </div>

        <button
          onClick={() => {
            if (followTail) {
              setFollowTail(false);
            } else {
              setFollowTail(true);
              logEndRef.current?.scrollIntoView({ behavior: "smooth" });
            }
          }}
          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] transition-colors ${
            followTail
              ? "bg-blue-500/15 text-blue-400 border border-blue-500/25"
              : "bg-white/[0.04] text-zinc-500 border border-white/[0.06] hover:text-zinc-300"
          }`}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path d="M5 1v6M2.5 4.5L5 7l2.5-2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M2 9h6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
          </svg>
          {followTail ? "Following" : "Follow"}
        </button>

        <button
          onClick={onClear}
          className="px-2.5 py-1.5 rounded-lg text-[11px] text-zinc-600 hover:text-zinc-300 bg-white/[0.04] border border-white/[0.06] hover:bg-white/[0.07] transition-colors"
        >
          Clear
        </button>

        <button
          onClick={onClose}
          className="p-1.5 rounded-lg text-zinc-600 hover:text-zinc-200 hover:bg-white/[0.07] transition-colors"
          title="Close (Esc)"
        >
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
            <path d="M2 2l9 9M11 2L2 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </button>
      </div>

      {/* Log body — explicitly selectable via webkit prefix */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        onMouseUp={handleMouseUp}
        className="flex-1 overflow-y-auto px-4 py-3 font-mono select-text"
      >
        {filteredLines.length === 0 ? (
          <p className="text-[12px] text-zinc-600 mt-8 text-center select-none">
            {(query || levelFilter !== "all") ? "No lines match your filter." : "No output yet."}
          </p>
        ) : (
          <div className="flex flex-col">
            {filteredLines.map(({ line, originalIndex }) => {
              const level = crashed ? "error" : detectLevel(line);
              const textCls = level ? LEVEL_CLASS[level] : "text-zinc-300";
              const badge = level ? LEVEL_BADGE[level] : null;

              return (
                <div
                  key={originalIndex}
                  className="flex gap-2 py-[1px] hover:bg-white/[0.02] rounded px-1 group items-start"
                >
                  {/* Line number */}
                  <span className="text-[10px] text-zinc-700 w-8 shrink-0 text-right tabular-nums pt-[2px] group-hover:text-zinc-500 select-none">
                    {originalIndex + 1}
                  </span>

                  {/* Level badge */}
                  <span className="w-8 shrink-0 pt-[1px] select-none">
                    {badge && (
                      <span className={`text-[9px] font-medium px-1 py-px rounded border ${badge.cls}`}>
                        {badge.label}
                      </span>
                    )}
                  </span>

                  {/* Log text */}
                  <span className={`flex-1 text-[11px] leading-5 whitespace-pre-wrap break-all ${textCls}`}>
                    {highlightLine(line, query)}
                  </span>

                  {/* Copy button */}
                  <button
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => copyLine(line, originalIndex)}
                    className={`shrink-0 pt-[2px] transition-opacity select-none ${
                      copiedLine === originalIndex ? "opacity-100" : "opacity-0 group-hover:opacity-60"
                    }`}
                    title="Copy line"
                  >
                    {copiedLine === originalIndex ? (
                      <svg width="11" height="11" viewBox="0 0 11 11" fill="none" className="text-emerald-400">
                        <path d="M2 5.5l2.5 2.5 4.5-4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    ) : (
                      <svg width="11" height="11" viewBox="0 0 11 11" fill="none" className="text-zinc-600">
                        <rect x="1" y="3" width="6" height="7" rx="1" stroke="currentColor" strokeWidth="1.1"/>
                        <path d="M3.5 3V2a.5.5 0 01.5-.5h5a.5.5 0 01.5.5v5.5a.5.5 0 01-.5.5H8" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
                      </svg>
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        )}
        <div ref={logEndRef} />
      </div>

      {/* Footer */}
      <div className="flex items-center gap-3 px-4 py-2 border-t border-white/[0.05] shrink-0 select-none">
        <span className="text-[10px] text-zinc-700 font-mono">
          {(query || levelFilter !== "all") ? `Showing ${filteredLines.length} of ${logs.length} lines` : `${logs.length} lines`}
        </span>
        <div className="flex items-center gap-3 text-[10px] text-zinc-700">
          <span className="text-red-400/60">● ERR</span>
          <span className="text-amber-400/60">● WARN</span>
          <span className="text-emerald-400/60">● OK</span>
          <span className="text-blue-400/60">● INFO</span>
          <span className="text-zinc-500/60">● DBG</span>
        </div>
        <span className="flex-1" />
        <span className="text-[10px] text-zinc-700">Esc to close · ⌘F to search</span>
      </div>
    </div>
  );
}
