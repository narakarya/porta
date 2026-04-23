import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getAppLogs, isTauri } from "../../lib/commands";
import { listen } from "@tauri-apps/api/event";

interface Props {
  appId: string;
  appName: string;
  logs: string[];
  isRunning?: boolean;
  isStarting?: boolean;
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

// ── Ingest pipeline ───────────────────────────────────────────────────────────
interface ProcessedLine {
  text: string;
  level: LogLevel;
}

function processLine(raw: string): ProcessedLine | null {
  const clean = stripAnsi(raw);
  if (NOISE_RE.test(clean)) return null;
  return { text: clean, level: detectLevel(clean) };
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
      ? <mark key={i} style={{ background: "rgba(250,204,21,0.25)", color: "#fef08a", borderRadius: 2, padding: "0 1px" }}>{part}</mark>
      : part
  );
}

// ── Level filter ──────────────────────────────────────────────────────────────
type EnabledLevels = Set<NonNullable<LogLevel>>;
const ALL_FILTER_LEVELS: NonNullable<LogLevel>[] = ["error", "warn", "success", "info", "debug"];

const FILTER_PILLS: { key: NonNullable<LogLevel>; label: string; activeCls: string }[] = [
  { key: "error",   label: "ERR",  activeCls: "bg-red-500/15 text-red-400 border-red-500/25" },
  { key: "warn",    label: "WARN", activeCls: "bg-amber-500/15 text-amber-400 border-amber-500/25" },
  { key: "success", label: "OK",   activeCls: "bg-emerald-500/15 text-emerald-400 border-emerald-500/25" },
  { key: "info",    label: "INFO", activeCls: "bg-blue-500/15 text-blue-400 border-blue-500/25" },
  { key: "debug",   label: "DBG",  activeCls: "bg-zinc-700/50 text-zinc-400 border-zinc-600/40" },
];

// ── Per-line memoized renderer ────────────────────────────────────────────────
interface LogLineProps {
  text: string;
  level: LogLevel;
  originalIndex: number;
  filteredIdx: number;
  crashed: boolean;
  query: string;
  isMatch: boolean;
  isActiveMatch: boolean;
  copied: boolean;
  onCopy: (text: string, idx: number) => void;
  matchRefMap: React.MutableRefObject<Map<number, HTMLDivElement>>;
}

const LogLine = memo(function LogLine({
  text, level, originalIndex, filteredIdx, crashed, query,
  isMatch, isActiveMatch, copied, onCopy, matchRefMap,
}: LogLineProps) {
  const effectiveLevel = crashed ? "error" : level;
  const textCls = effectiveLevel ? LEVEL_CLASS[effectiveLevel] : "text-zinc-300";
  const badge = effectiveLevel ? LEVEL_BADGE[effectiveLevel] : null;

  return (
    <div
      ref={(el) => {
        if (isMatch && el) matchRefMap.current.set(filteredIdx, el);
        else matchRefMap.current.delete(filteredIdx);
      }}
      className={`flex gap-2 py-[1px] hover:bg-white/[0.02] rounded px-1 group items-start ${
        isActiveMatch ? "bg-yellow-500/[0.08] ring-1 ring-yellow-500/20" : ""
      }`}
      // contentVisibility lets the browser skip layout/paint for off-screen
      // lines — cheap virtualization without touching the DOM tree.
      style={{ contentVisibility: "auto", containIntrinsicSize: "20px" }}
    >
      <span className="text-[10px] text-zinc-700 w-8 shrink-0 text-right tabular-nums pt-[2px] group-hover:text-zinc-500 select-none">
        {originalIndex + 1}
      </span>
      <span className="w-8 shrink-0 pt-[1px] select-none">
        {badge && (
          <span className={`text-[9px] font-medium px-1 py-px rounded border ${badge.cls}`}>
            {badge.label}
          </span>
        )}
      </span>
      <span
        className={`flex-1 min-w-0 text-[11px] leading-5 whitespace-pre-wrap ${textCls}`}
        style={{ overflowWrap: "anywhere" }}
      >
        {highlightLine(text, query)}
      </span>
      <button
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onCopy(text, originalIndex)}
        className={`shrink-0 pt-[2px] transition-opacity select-none ${
          copied ? "opacity-100" : "opacity-0 group-hover:opacity-60"
        }`}
        title="Copy line"
      >
        {copied ? (
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
});

// ── Component ─────────────────────────────────────────────────────────────────
export default function LogViewer({ appId, appName, logs, isRunning, isStarting, crashed, exitCode, onClose, onClear }: Props) {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [enabledLevels, setEnabledLevels] = useState<EnabledLevels>(new Set(ALL_FILTER_LEVELS));
  const [followTail, setFollowTail] = useState(true);
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);
  const [copiedLine, setCopiedLine] = useState<number | null>(null);
  const [copiedToast, setCopiedToast] = useState(false);
  const [localLogs, setLocalLogs] = useState<ProcessedLine[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Batch incoming log events per animation frame. Without this each line
  // triggered its own render — at high log rates React couldn't keep up.
  const pendingRef = useRef<ProcessedLine[]>([]);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    getAppLogs(appId).then((rawLines) => {
      if (cancelled) return;
      const processed: ProcessedLine[] = [];
      for (const raw of rawLines) {
        const p = processLine(raw);
        if (p) processed.push(p);
      }
      if (processed.length > MAX_LINES) {
        setTruncated(true);
        setLocalLogs(processed.slice(processed.length - MAX_LINES));
      } else {
        setLocalLogs(processed);
      }
    }).catch(() => { if (!cancelled) setLocalLogs([]); });

    let unlisten: (() => void) | undefined;

    function flush() {
      rafRef.current = null;
      if (pendingRef.current.length === 0) return;
      const batch = pendingRef.current;
      pendingRef.current = [];
      setLocalLogs((prev) => {
        const base = prev ?? [];
        const combined = base.concat(batch);
        if (combined.length > MAX_LINES) {
          setTruncated(true);
          return combined.slice(combined.length - MAX_LINES);
        }
        return combined;
      });
    }

    if (isTauri) {
      listen<string>(`app:log:${appId}`, (e) => {
        const p = processLine(e.payload);
        if (!p) return;
        pendingRef.current.push(p);
        if (rafRef.current === null) {
          rafRef.current = requestAnimationFrame(flush);
        }
      }).then((u) => {
        if (cancelled) { u(); return; }
        unlisten = u;
      });
    }

    return () => {
      cancelled = true;
      unlisten?.();
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      pendingRef.current = [];
    };
  }, [appId]);

  // Fallback: while the disk read is in flight, render the Zustand capped buffer.
  const fallbackLogs = useMemo<ProcessedLine[]>(() => {
    if (localLogs !== null) return [];
    const out: ProcessedLine[] = [];
    for (const raw of logs) {
      const p = processLine(raw);
      if (p) out.push(p);
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

  const allLevelsEnabled = enabledLevels.size === ALL_FILTER_LEVELS.length;

  function toggleLevel(level: NonNullable<LogLevel>) {
    setEnabledLevels((prev) => {
      const next = new Set(prev);
      if (next.has(level)) {
        if (next.size === 1) return prev;
        next.delete(level);
      } else {
        next.add(level);
      }
      return next;
    });
  }

  function resetLevels() {
    setEnabledLevels(new Set(ALL_FILTER_LEVELS));
  }

  // Lines without a detected level are always shown — filtering narrows,
  // never gates unclassified output.
  const filteredLines = useMemo(() => {
    const out: { line: ProcessedLine; originalIndex: number }[] = [];
    for (let i = 0; i < allLogs.length; i++) {
      const line = allLogs[i];
      if (!allLevelsEnabled && line.level && !enabledLevels.has(line.level)) continue;
      out.push({ line, originalIndex: i });
    }
    return out;
  }, [allLogs, enabledLevels, allLevelsEnabled]);

  // Use a Set for O(1) isMatch lookup instead of Array.includes in the render loop.
  const { searchMatches, searchMatchSet } = useMemo(() => {
    if (!debouncedQuery) return { searchMatches: [] as number[], searchMatchSet: new Set<number>() };
    const lower = debouncedQuery.toLowerCase();
    const matches: number[] = [];
    for (let i = 0; i < filteredLines.length; i++) {
      if (filteredLines[i].line.text.toLowerCase().includes(lower)) matches.push(i);
    }
    return { searchMatches: matches, searchMatchSet: new Set(matches) };
  }, [filteredLines, debouncedQuery]);

  useEffect(() => {
    if (searchMatches.length === 0) {
      setActiveMatchIndex(0);
    } else if (activeMatchIndex >= searchMatches.length) {
      setActiveMatchIndex(searchMatches.length - 1);
    }
  }, [searchMatches.length, activeMatchIndex]);

  const matchLineRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  useEffect(() => {
    if (searchMatches.length === 0) return;
    const targetIdx = searchMatches[activeMatchIndex];
    const el = matchLineRefs.current.get(targetIdx);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      setFollowTail(false);
    }
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
      if (document.activeElement === searchRef.current && query) {
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
  }, [onClose, query, goToNextMatch, goToPrevMatch]);

  // Tail follow uses "instant" — "smooth" stacks animations at high log rates
  // and causes the viewport to drift out of sync with the cursor.
  useEffect(() => {
    if (!followTail) return;
    logEndRef.current?.scrollIntoView({ behavior: "instant" as ScrollBehavior });
  }, [allLogs, followTail]);

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
      if (p) processed.push(p);
    }
    setLocalLogs(processed);
    setTruncated(false);
  }

  return (
    <div className="fixed inset-0 bg-[#0a0a0c]/95 backdrop-blur-sm z-50 flex flex-col overflow-hidden">
      <div className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-[60] flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 border border-white/10 text-[11px] text-emerald-400 shadow-lg transition-all duration-200 pointer-events-none ${copiedToast ? "opacity-100 translate-y-0" : "opacity-0 translate-y-1"}`}>
        <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
          <path d="M2 5.5l2.5 2.5 4.5-4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        Copied
      </div>

      <div className="flex items-center gap-3 px-4 py-3 border-b border-white/[0.07] shrink-0 select-none">
        <div className="flex items-center gap-2 shrink-0">
          <span className={`w-2 h-2 rounded-full ${
            crashed ? "bg-red-400" :
            isStarting ? "bg-amber-400 pulse-dot" :
            isRunning ? "bg-emerald-400 pulse-dot" :
            "bg-zinc-600"
          }`} />
          <span className="text-[13px] font-semibold text-zinc-200">{appName}</span>
          {crashed && exitCode !== null && exitCode !== undefined && (
            <span className="text-[11px] text-red-400 bg-red-500/10 border border-red-500/20 rounded px-1.5 py-0.5">
              exit {exitCode}
            </span>
          )}
        </div>

        <span className="text-zinc-700 text-[12px]">·</span>
        <span className="text-[11px] text-zinc-600">
          {localLogs === null ? "loading…" : `${allLogs.length} lines${truncated ? " (capped)" : ""}`}
        </span>

        <div className="flex-1 relative max-w-[400px]">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-600 pointer-events-none">
            <circle cx="5" cy="5" r="3.5" stroke="currentColor" strokeWidth="1.3"/>
            <path d="M8 8l2 2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
          </svg>
          <input spellCheck={false}
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
          <div className="flex items-center gap-1 shrink-0">
            <span className="text-[11px] text-zinc-500">
              {matchCount === 0 ? "no matches" : `${activeMatchIndex + 1}/${matchCount}`}
            </span>
            {matchCount > 0 && (
              <>
                <button
                  onClick={goToPrevMatch}
                  className="p-0.5 rounded text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.06] transition-colors"
                  title="Previous match (Shift+Enter)"
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                    <path d="M2 6.5L5 3.5L8 6.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </button>
                <button
                  onClick={goToNextMatch}
                  className="p-0.5 rounded text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.06] transition-colors"
                  title="Next match (Enter)"
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                    <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </button>
              </>
            )}
          </div>
        )}

        <div className="flex-1" />

        <div className="flex items-center gap-1 shrink-0">
          {FILTER_PILLS.map(({ key, label, activeCls }) => {
            const isActive = enabledLevels.has(key);
            return (
              <button
                key={key}
                onClick={() => toggleLevel(key)}
                className={`px-2 py-1 rounded-md text-[10px] font-medium border transition-colors ${
                  isActive
                    ? activeCls
                    : "bg-white/[0.04] text-zinc-500/40 border border-white/[0.04] hover:text-zinc-400 line-through"
                }`}
              >
                {label}
              </button>
            );
          })}
          {!allLevelsEnabled && (
            <button
              onClick={resetLevels}
              className="px-1.5 py-1 rounded-md text-[10px] font-medium border bg-white/[0.04] text-zinc-500 border-white/[0.06] hover:text-zinc-300 transition-colors"
              title="Show all levels"
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
              logEndRef.current?.scrollIntoView({ behavior: "instant" as ScrollBehavior });
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
          onClick={() => {
            setLocalLogs([]);
            setTruncated(false);
            onClear();
          }}
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

      {truncated && (
        <div className="flex items-center justify-between gap-2 px-4 py-1.5 bg-amber-500/5 border-b border-amber-500/10 text-[11px] text-amber-400/80 shrink-0">
          <span>
            Showing last {MAX_LINES.toLocaleString()} lines. Older history is still on disk.
          </span>
          <button
            onClick={() => { void loadFullHistory(); }}
            className="px-2 py-0.5 rounded text-amber-300 hover:text-amber-200 hover:bg-amber-500/10 transition-colors"
          >
            Load full history
          </button>
        </div>
      )}

      <div
        ref={containerRef}
        onScroll={handleScroll}
        onMouseUp={handleMouseUp}
        className="flex-1 overflow-y-auto px-4 py-3 font-mono select-text"
      >
        {localLogs === null && (
          <p className="text-[12px] text-zinc-600 mb-3 text-center select-none">Loading logs…</p>
        )}

        {filteredLines.length === 0 ? (
          <p className="text-[12px] text-zinc-600 mt-8 text-center select-none">
            {(!allLevelsEnabled) ? "No lines match your filter." : "No output yet."}
          </p>
        ) : (
          <div className="flex flex-col w-full">
            {filteredLines.map(({ line, originalIndex }, filteredIdx) => {
              const isMatch = searchMatchSet.has(filteredIdx);
              const isActiveMatch = !!debouncedQuery && searchMatches.length > 0 && searchMatches[activeMatchIndex] === filteredIdx;
              return (
                <LogLine
                  key={originalIndex}
                  text={line.text}
                  level={line.level}
                  originalIndex={originalIndex}
                  filteredIdx={filteredIdx}
                  crashed={!!crashed}
                  query={debouncedQuery}
                  isMatch={isMatch}
                  isActiveMatch={isActiveMatch}
                  copied={copiedLine === originalIndex}
                  onCopy={handleCopyLine}
                  matchRefMap={matchLineRefs}
                />
              );
            })}
          </div>
        )}
        <div ref={logEndRef} />
      </div>

      <div className="flex items-center gap-3 px-4 py-2 border-t border-white/[0.05] shrink-0 select-none">
        <span className="text-[10px] text-zinc-700 font-mono">
          {(!allLevelsEnabled) ? `Showing ${filteredLines.length} of ${allLogs.length} lines` : `${allLogs.length} lines`}
        </span>
        <div className="flex items-center gap-3 text-[10px] text-zinc-700">
          <span className="text-red-400/60">● ERR</span>
          <span className="text-amber-400/60">● WARN</span>
          <span className="text-emerald-400/60">● OK</span>
          <span className="text-blue-400/60">● INFO</span>
          <span className="text-zinc-500/60">● DBG</span>
        </div>
        <span className="flex-1" />
        <span className="text-[10px] text-zinc-700">Esc close · ⌘F search · Enter/↑↓ navigate · select → auto-copy</span>
      </div>
    </div>
  );
}
