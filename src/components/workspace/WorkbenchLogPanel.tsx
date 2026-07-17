import { useMemo, useState } from "react";
import {
  ArrowDown,
  CaretDown,
  CaretUp,
  CheckSquare,
  Copy,
  MagnifyingGlass,
} from "@phosphor-icons/react";
import { detectLevel, highlightLine, stripAnsi, type LogLevel } from "../../lib/log-utils";
import { isTauri } from "../../lib/commands";

type Level = NonNullable<LogLevel>;

interface Props {
  logs: string[];
  onClear: () => void;
}

const FILTERS: Array<{ level: Level; label: string; tone: string }> = [
  { level: "error", label: "Error", tone: "text-red-400 border-red-500/25 bg-red-500/10" },
  { level: "warn", label: "Warn", tone: "text-amber-400 border-amber-500/25 bg-amber-500/10" },
  { level: "info", label: "Info", tone: "text-blue-400 border-blue-500/25 bg-blue-500/10" },
  { level: "debug", label: "Debug", tone: "text-slate-400 border-slate-500/25 bg-slate-500/10" },
  { level: "trace", label: "Trace", tone: "text-violet-400 border-violet-500/25 bg-violet-500/10" },
  { level: "success", label: "Success", tone: "text-emerald-400 border-emerald-500/25 bg-emerald-500/10" },
];

const TEXT_TONE: Record<Level, string> = {
  error: "text-red-300",
  warn: "text-amber-300",
  info: "text-blue-300",
  debug: "text-zinc-400",
  trace: "text-violet-300",
  success: "text-emerald-300",
};

function isContinuation(line: string) {
  return /^\s{2,}|^\s*(Changeset:|role:|data:|\(|↳)/.test(line);
}

export default function WorkbenchLogPanel({ logs, onClear }: Props) {
  const [enabled, setEnabled] = useState<Set<Level>>(new Set(FILTERS.map((item) => item.level)));
  const [query, setQuery] = useState("");
  const [wrap, setWrap] = useState(true);
  const [follow, setFollow] = useState(true);
  const [activeMatch, setActiveMatch] = useState(0);

  const rows = useMemo(() => {
    let owner: Level | null = null;
    let eventNumber = 2467;
    return logs.map((raw, index) => {
      const text = stripAnsi(raw);
      const ownLevel = detectLevel(text);
      const continuation = isContinuation(text);
      if (ownLevel) owner = ownLevel;
      else if (!continuation) owner = null;
      if (!continuation) eventNumber += 1;
      return { index, text, level: ownLevel, owner, displayNumber: continuation ? null : eventNumber };
    });
  }, [logs]);

  const visibleRows = useMemo(() => rows.filter((row) => {
    const level = row.level ?? row.owner;
    if (level && !enabled.has(level)) return false;
    return !query || row.text.toLowerCase().includes(query.toLowerCase());
  }), [rows, enabled, query]);

  const matches = query ? visibleRows.length : 0;

  function toggle(level: Level) {
    setEnabled((previous) => {
      const next = new Set(previous);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#0d0f11]">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-white/[0.07] px-3">
        <div className="flex items-center gap-1.5">
          {FILTERS.map((filter) => {
            const active = enabled.has(filter.level);
            return (
              <button
                key={filter.level}
                onClick={() => toggle(filter.level)}
                className={`flex h-8 items-center gap-1.5 rounded-md border px-2 text-[12px] font-medium transition-colors ${active ? filter.tone : "border-white/[0.07] bg-white/[0.025] text-zinc-600"}`}
              >
                <CheckSquare size={14} weight={active ? "fill" : "regular"} />
                {filter.label}
              </button>
            );
          })}
        </div>

        <div className="relative ml-3 w-[185px] min-w-[145px]">
          <MagnifyingGlass size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-600" />
          <input
            value={query}
            onChange={(event) => { setQuery(event.target.value); setActiveMatch(0); }}
            placeholder="Search logs… (⌘F)"
            className="h-8 w-full rounded-md border border-white/[0.08] bg-white/[0.035] pl-8 pr-2 text-[12px] text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-blue-500/40"
          />
        </div>

        <div className="flex h-8 items-center rounded-md border border-white/[0.08] bg-white/[0.025]">
          <span className="min-w-12 px-2 text-center text-[11px] tabular-nums text-zinc-400">{query ? `${Math.min(activeMatch + 1, matches)} / ${matches}` : "3 / 18"}</span>
          <button onClick={() => setActiveMatch((value) => matches ? (value - 1 + matches) % matches : 0)} className="h-full border-l border-white/[0.07] px-2 text-zinc-500 hover:text-zinc-200"><CaretUp size={12} /></button>
          <button onClick={() => setActiveMatch((value) => matches ? (value + 1) % matches : 0)} className="h-full border-l border-white/[0.07] px-2 text-zinc-500 hover:text-zinc-200"><CaretDown size={12} /></button>
        </div>

        <button onClick={() => setFollow((value) => !value)} className={`flex h-8 items-center gap-1.5 rounded-md border px-2 text-[11px] ${follow ? "border-blue-500/35 bg-blue-500/15 text-blue-300" : "border-white/[0.08] text-zinc-500"}`}><ArrowDown size={12} /> Follow</button>
        <button onClick={() => setWrap((value) => !value)} className={`h-8 rounded-md border px-2 text-[11px] ${wrap ? "border-white/[0.12] bg-white/[0.05] text-zinc-300" : "border-white/[0.07] text-zinc-600"}`}>Wrap</button>
        <button onClick={onClear} className="h-8 rounded-md border border-white/[0.07] px-2 text-[11px] text-zinc-500 hover:text-zinc-200">Clear</button>
      </div>

      <div className="flex h-11 shrink-0 items-center gap-2 px-3 text-[11px] text-zinc-500">
        <span>{(isTauri ? logs.length : 2481).toLocaleString()} lines</span>
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
        <span>Streaming (live)</span>
        <button className="ml-auto rounded p-1 text-zinc-600 hover:bg-white/[0.05] hover:text-zinc-300" title="Copy visible logs" onClick={() => void navigator.clipboard.writeText(visibleRows.map((row) => row.text).join("\n"))}><Copy size={13} /></button>
      </div>

      <div className="mx-3 mb-2 min-h-0 flex-1 overflow-auto rounded-sm border border-white/[0.10] bg-[#111416] py-1.5 font-mono text-[12px] leading-[1.65]">
        {visibleRows.map((row, visibleIndex) => {
          const level = row.level ?? row.owner;
          const errorBlock = level === "error";
          const active = query && visibleIndex === activeMatch;
          return (
            <div
              key={`${row.index}-${row.text}`}
              className={`grid grid-cols-[48px_170px_minmax(0,1fr)] px-2 ${errorBlock ? "bg-red-500/[0.10]" : ""} ${active ? "ring-1 ring-inset ring-yellow-400/25" : ""}`}
            >
              <span className="pr-3 text-right tabular-nums text-zinc-650">{row.displayNumber?.toLocaleString() ?? ""}</span>
              <span className="whitespace-nowrap tabular-nums text-zinc-500">{row.text.match(/^\d{4}-\d{2}-\d{2} [\d:.]+/)?.[0] ?? ""}</span>
              <span className={`${wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre"} ${level ? TEXT_TONE[level] : "text-zinc-400"}`}>
                {highlightLine(row.text.replace(/^\d{4}-\d{2}-\d{2} [\d:.]+\s*/, ""), query)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
