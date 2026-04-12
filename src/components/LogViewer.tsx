import { useEffect, useMemo, useRef, useState } from "react";

interface Props {
  appName: string;
  logs: string[];
  crashed?: boolean;
  exitCode?: number | null;
  onClose: () => void;
  onClear: () => void;
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /[\x1b\x9b][\[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]/g;
function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, "");
}

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

export default function LogViewer({ appName, logs, crashed, exitCode, onClose, onClear }: Props) {
  const [query, setQuery] = useState("");
  const [followTail, setFollowTail] = useState(true);
  const [copiedLine, setCopiedLine] = useState<number | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isFirstScroll = useRef(true);

  const cleanLogs = useMemo(() => logs.map(stripAnsi), [logs]);

  function copyLine(line: string, index: number) {
    navigator.clipboard.writeText(line).then(() => {
      setCopiedLine(index);
      setTimeout(() => setCopiedLine(null), 1200);
    });
  }

  // Focus search on open
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        // If search has content, clear it first; second Escape closes viewer
        if (query) {
          setQuery("");
          return;
        }
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

  // Instant jump on open, smooth follow for new lines
  useEffect(() => {
    if (!followTail) return;
    if (isFirstScroll.current) {
      isFirstScroll.current = false;
      logEndRef.current?.scrollIntoView({ behavior: "instant" });
      return;
    }
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs, followTail]);

  // Scrolling up disables follow
  function handleScroll() {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (!atBottom && followTail) setFollowTail(false);
    if (atBottom && !followTail) setFollowTail(true);
  }

  const filteredLines = useMemo(() => {
    if (!query) return cleanLogs.map((line, i) => ({ line, originalIndex: i }));
    const lower = query.toLowerCase();
    return cleanLogs
      .map((line, i) => ({ line, originalIndex: i }))
      .filter(({ line }) => line.toLowerCase().includes(lower));
  }, [cleanLogs, query]);

  const matchCount = query ? filteredLines.length : null;

  return (
    <div className="fixed inset-0 bg-[#0a0a0c]/95 backdrop-blur-sm z-50 flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-white/[0.07] shrink-0">
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
            className="w-full bg-white/[0.05] border border-white/[0.08] rounded-lg pl-7 pr-3 py-1.5 text-[12px] text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-blue-500/50 focus:bg-white/[0.07] transition-all"
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-600 hover:text-zinc-300"
            >
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

        {/* Follow toggle — real toggle */}
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
          title={followTail ? "Following tail — click to pause" : "Click to follow tail"}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path d="M2 3l3 3 3-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M2 6.5h6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
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

      {/* Log body — select-text so native selection works */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-4 py-3 font-mono"
        style={{ userSelect: "text" }}
      >
        {filteredLines.length === 0 ? (
          <p className="text-[12px] text-zinc-600 mt-8 text-center" style={{ userSelect: "none" }}>
            {query ? "No lines match your search." : "No output yet."}
          </p>
        ) : (
          <div className="flex flex-col">
            {filteredLines.map(({ line, originalIndex }) => (
              <div
                key={originalIndex}
                className="flex gap-3 py-[1px] hover:bg-white/[0.02] rounded px-1 group"
              >
                {/* Line number — not selectable */}
                <span
                  className="text-[10px] text-zinc-700 w-8 shrink-0 text-right tabular-nums pt-[1px] group-hover:text-zinc-500"
                  style={{ userSelect: "none" }}
                >
                  {originalIndex + 1}
                </span>

                {/* Log text — fully selectable */}
                <span className={`flex-1 text-[11px] leading-5 whitespace-pre-wrap break-all ${
                  crashed ? "text-red-300/70" : "text-zinc-300"
                }`}>
                  {highlightLine(line, query)}
                </span>

                {/* Copy button — only on hover, doesn't interfere with selection */}
                <button
                  onMouseDown={(e) => e.preventDefault()} // prevent losing text selection
                  onClick={() => copyLine(line, originalIndex)}
                  className={`shrink-0 pt-[1px] transition-opacity ${
                    copiedLine === originalIndex
                      ? "opacity-100"
                      : "opacity-0 group-hover:opacity-100"
                  }`}
                  style={{ userSelect: "none" }}
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
            ))}
          </div>
        )}
        <div ref={logEndRef} />
      </div>

      {/* Footer */}
      <div className="flex items-center gap-3 px-4 py-2 border-t border-white/[0.05] shrink-0" style={{ userSelect: "none" }}>
        <span className="text-[10px] text-zinc-700 font-mono">
          {query ? `Showing ${filteredLines.length} of ${logs.length} lines` : `${logs.length} lines`}
        </span>
        <span className="flex-1" />
        <span className="text-[10px] text-zinc-700">Esc to close · ⌘F to search</span>
      </div>
    </div>
  );
}
