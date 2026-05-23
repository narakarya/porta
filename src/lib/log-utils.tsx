import React from "react";

// ── ANSI stripping ─────────────────────────────────────────────────────────────
// eslint-disable-next-line no-control-regex
export const ANSI_RE = /(?:\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b[P\^_X][\s\S]*?\x1b\\|[\x1b\x9b]\[[0-?]*[ -/]*[@-~]|\x1b[()][A-Za-z0-9]|\x1b[ -/]*[@-~])/g;
export function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, "");
}

// ── Noise filter ───────────────────────────────────────────────────────────────
const NOISE_RE = /cloudflare\.com\/(website-terms|terms)|Thank you for trying Cloudflare Tunnel|Doing so, you agree/i;
export function filterNoise(lines: string[]): string[] {
  return lines.filter((l) => !NOISE_RE.test(stripAnsi(l)));
}

// ── Log level detection ────────────────────────────────────────────────────────
export type LogLevel = "error" | "warn" | "info" | "debug" | "trace" | "success" | null;
export type LevelFilter = NonNullable<LogLevel> | "all";

const LEVEL_PATTERNS: [LogLevel, RegExp][] = [
  ["error",   /\b(error|err|fatal|exception|crash|failed|failure)\b/i],
  ["warn",    /\b(warn(?:ing)?|deprecated|caution)\b/i],
  ["success", /\b(compiled|generated|ok|done|started|ready|success(?:ful)?|listening)\b/i],
  ["info",    /\b(info(?:rmation)?|notice|log)\b/i],
  ["debug",   /\b(debug|verbose)\b/i],
  ["trace",   /\b(trace)\b/i],
];

export function detectLevel(line: string): LogLevel {
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

export const LEVEL_CLS: Record<NonNullable<LogLevel>, string> = {
  error:   "text-red-400",
  warn:    "text-amber-400",
  info:    "text-blue-400",
  debug:   "text-zinc-500",
  trace:   "text-zinc-600",
  success: "text-emerald-400",
};

export const LEVEL_BADGE: Record<NonNullable<LogLevel>, { label: string; cls: string }> = {
  error:   { label: "ERR",  cls: "bg-red-500/15 text-red-400 border-red-500/20" },
  warn:    { label: "WARN", cls: "bg-amber-500/15 text-amber-400 border-amber-500/20" },
  info:    { label: "INFO", cls: "bg-blue-500/15 text-blue-400 border-blue-500/20" },
  debug:   { label: "DBG",  cls: "bg-zinc-700/50 text-zinc-500 border-zinc-700/50" },
  trace:   { label: "TRC",  cls: "bg-zinc-800/50 text-zinc-600 border-zinc-800/50" },
  success: { label: "OK",   cls: "bg-emerald-500/15 text-emerald-400 border-emerald-500/20" },
};

export const FILTER_PILLS: { key: NonNullable<LogLevel>; label: string; activeCls: string }[] = [
  { key: "error",   label: "ERR",  activeCls: "bg-red-500/15 text-red-400 border-red-500/25" },
  { key: "warn",    label: "WARN", activeCls: "bg-amber-500/15 text-amber-400 border-amber-500/25" },
  { key: "success", label: "OK",   activeCls: "bg-emerald-500/15 text-emerald-400 border-emerald-500/25" },
  { key: "info",    label: "INFO", activeCls: "bg-blue-500/15 text-blue-400 border-blue-500/25" },
  { key: "debug",   label: "DBG",  activeCls: "bg-zinc-700/50 text-zinc-400 border-zinc-600/40" },
];

// ── Search highlight ───────────────────────────────────────────────────────────
export function highlightLine(line: string, query: string): React.ReactNode {
  if (!query) return line;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = line.split(new RegExp(`(${escaped})`, "gi"));
  return parts.map((part, i) =>
    part.toLowerCase() === query.toLowerCase()
      ? <mark key={i} style={{ background: "rgba(250,204,21,0.25)", color: "#fef08a", borderRadius: 2, padding: "0 1px" }}>{part}</mark>
      : part
  );
}
