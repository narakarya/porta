import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  liveAccessLogStart,
  liveAccessLogStop,
  tailAccessLog,
  isTauri,
  type AccessLogEntry,
  type AccessLogStreamEvent,
} from "../../lib/commands";

interface Props {
  appId: string;
  appName: string;
  isOpen: boolean;
  onClose: () => void;
}

type StatusFilter = "all" | "2xx" | "3xx" | "4xx" | "5xx";

const MAX_KEPT = 500;
const METHOD_OPTIONS = ["ALL", "GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"] as const;

function statusBucket(status: number): StatusFilter | "other" {
  if (status >= 200 && status < 300) return "2xx";
  if (status >= 300 && status < 400) return "3xx";
  if (status >= 400 && status < 500) return "4xx";
  if (status >= 500 && status < 600) return "5xx";
  return "other";
}

function fmtTime(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString([], { hour12: false }) + "." + String(d.getMilliseconds()).padStart(3, "0");
}

function fmtDuration(ms: number): string {
  if (ms < 1) return "<1ms";
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

function statusColor(status: number): string {
  if (status >= 500) return "text-red-400";
  if (status >= 400) return "text-amber-400";
  if (status >= 300) return "text-sky-400";
  if (status >= 200) return "text-emerald-400";
  return "text-zinc-400";
}

// Active-pill tint per status bucket — mirrors the row status colors so the
// filter reads as the same vocabulary as the table.
const STATUS_FILTER_ACTIVE: Record<StatusFilter, string> = {
  all: "bg-white/[0.12] text-zinc-100",
  "2xx": "bg-emerald-500/15 text-emerald-400",
  "3xx": "bg-sky-500/15 text-sky-400",
  "4xx": "bg-amber-500/15 text-amber-400",
  "5xx": "bg-red-500/15 text-red-400",
};

function methodColor(method: string): string {
  switch (method) {
    case "GET": return "text-sky-400";
    case "POST": return "text-emerald-400";
    case "PUT": case "PATCH": return "text-amber-400";
    case "DELETE": return "text-red-400";
    default: return "text-zinc-400";
  }
}

// --- JSON syntax highlight ---

type JToken = { type: "key" | "string" | "number" | "bool" | "null" | "other"; text: string };

const TOKEN_CLASS: Record<JToken["type"], string> = {
  key: "text-sky-400",
  string: "text-emerald-400",
  number: "text-yellow-400",
  bool: "text-violet-400",
  null: "text-zinc-500",
  other: "text-zinc-400",
};

function tokenizeJson(json: string): JToken[] {
  const tokens: JToken[] = [];
  let i = 0;
  while (i < json.length) {
    // Whitespace
    if (/[ \t\r\n]/.test(json[i])) {
      const s = i;
      while (i < json.length && /[ \t\r\n]/.test(json[i])) i++;
      tokens.push({ type: "other", text: json.slice(s, i) });
      continue;
    }
    // String
    if (json[i] === '"') {
      const s = i++;
      while (i < json.length) {
        if (json[i] === "\\") { i += 2; continue; }
        if (json[i] === '"') { i++; break; }
        i++;
      }
      const text = json.slice(s, i);
      let j = i;
      while (j < json.length && /[ \t]/.test(json[j])) j++;
      tokens.push({ type: json[j] === ":" ? "key" : "string", text });
      continue;
    }
    // Number
    if (json[i] === "-" || (json[i] >= "0" && json[i] <= "9")) {
      const s = i++;
      while (i < json.length && /[-+\d.eE]/.test(json[i])) i++;
      tokens.push({ type: "number", text: json.slice(s, i) });
      continue;
    }
    // Boolean / null
    if (json.startsWith("true", i))  { tokens.push({ type: "bool", text: "true" });  i += 4; continue; }
    if (json.startsWith("false", i)) { tokens.push({ type: "bool", text: "false" }); i += 5; continue; }
    if (json.startsWith("null", i))  { tokens.push({ type: "null", text: "null" });  i += 4; continue; }
    // Punctuation / other
    tokens.push({ type: "other", text: json[i++] });
  }
  return tokens;
}

function JsonSyntax({ text }: { text: string }) {
  const tokens = useMemo(() => tokenizeJson(text), [text]);
  return (
    <pre className="whitespace-pre-wrap break-all leading-relaxed text-[11px]">
      {tokens.map((t, idx) => (
        <span key={idx} className={TOKEN_CLASS[t.type]}>{t.text}</span>
      ))}
    </pre>
  );
}

// --- Copy button ---

function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "copied" | "err">("idle");

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("err");
    }
    setTimeout(() => setState("idle"), 1500);
  }, [text]);

  return (
    <button
      onClick={handleCopy}
      className={`shrink-0 px-2 py-0.5 text-[10px] font-mono rounded transition-colors ${
        state === "copied"
          ? "text-emerald-400 bg-emerald-500/10"
          : state === "err"
          ? "text-red-400 bg-red-500/10"
          : "text-zinc-500 hover:text-zinc-200 bg-white/[0.04] hover:bg-white/[0.08]"
      }`}
    >
      {state === "copied" ? "Copied!" : state === "err" ? "Failed" : "Copy"}
    </button>
  );
}

export default function TrafficInspectorModal({ appId, appName, isOpen, onClose }: Props) {
  const [entries, setEntries] = useState<AccessLogEntry[]>([]);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [paused, setPaused] = useState(false);
  const [bufferedCount, setBufferedCount] = useState(0);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [methodFilter, setMethodFilter] = useState<string>("ALL");
  const [pathFilter, setPathFilter] = useState<string>("");
  const [activeTab, setActiveTab] = useState<"headers" | "body" | "response">("headers");
  // clearKey: increment to restart stream from current offset without loading old entries.
  const [clearKey, setClearKey] = useState(0);
  const streamIdRef = useRef<string | null>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const bufferRef = useRef<AccessLogEntry[]>([]);

  // Reset clearKey when modal closes so next open loads from beginning.
  useEffect(() => {
    if (!isOpen) setClearKey(0);
  }, [isOpen]);

  // Flush buffer when unpausing.
  useEffect(() => {
    if (paused) return;
    const buf = bufferRef.current.splice(0);
    bufferRef.current = [];
    setBufferedCount(0);
    if (buf.length === 0) return;
    setEntries((prev) => {
      const next = [...buf].reverse().concat(prev);
      return next.slice(0, MAX_KEPT);
    });
  }, [paused]);

  // Load existing entries on open + start live tail.
  // clearKey > 0 means user cleared — skip tailAccessLog, start stream from current EOF.
  useEffect(() => {
    if (!isOpen || !isTauri) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    (async () => {
      try {
        if (clearKey === 0) {
          const initial = await tailAccessLog(appId, 0);
          if (cancelled) return;
          const sorted = [...initial.entries].sort((a, b) => b.ts - a.ts).slice(0, MAX_KEPT);
          setEntries(sorted);
        }

        const id = await liveAccessLogStart(appId);
        if (cancelled) {
          liveAccessLogStop(id).catch(() => {});
          return;
        }
        streamIdRef.current = id;
        unlisten = await listen<AccessLogStreamEvent>(`access-log:${id}`, (e) => {
          const incoming = e.payload.entries;
          if (!incoming.length) return;
          if (pausedRef.current) {
            bufferRef.current = [...incoming, ...bufferRef.current].slice(0, MAX_KEPT);
            setBufferedCount(bufferRef.current.length);
            return;
          }
          setEntries((prev) => {
            const next = [...incoming].reverse().concat(prev);
            return next.slice(0, MAX_KEPT);
          });
        });
      } catch (e) {
        console.error("[traffic] start:", e);
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
      const id = streamIdRef.current;
      streamIdRef.current = null;
      if (id) liveAccessLogStop(id).catch(() => {});
    };
  }, [isOpen, appId, clearKey]);

  // Esc to close.
  useEffect(() => {
    if (!isOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  const filtered = useMemo(() => {
    const q = pathFilter.trim().toLowerCase();
    return entries.filter((e) => {
      if (statusFilter !== "all" && statusBucket(e.status) !== statusFilter) return false;
      if (methodFilter !== "ALL" && e.method !== methodFilter) return false;
      if (q && !e.uri.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [entries, statusFilter, methodFilter, pathFilter]);

  const selected = selectedIdx !== null ? filtered[selectedIdx] : null;

  // Clear: restart stream from current EOF (no file truncation needed — avoids
  // root-owned file permission issue). Old entries are simply not loaded again.
  const handleClear = useCallback(() => {
    setEntries([]);
    setSelectedIdx(null);
    bufferRef.current = [];
    setBufferedCount(0);
    setClearKey((k) => k + 1);
  }, []);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-[#111113] flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 px-5 py-3 border-b border-white/[0.08] shrink-0 flex-wrap">
        <span className="text-[14px] font-semibold text-zinc-100 font-mono">
          Traffic · {appName}
        </span>
        <span
          className="text-[10px] text-zinc-500 font-mono px-1.5 py-0.5 bg-white/[0.04] rounded"
          title="Webhook bodies are captured for debugging — rotated automatically"
        >
          Body capture: max 64 KB
        </span>

        <div className="flex-1" />

        {/* Path search */}
        <div className="relative">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-600 pointer-events-none">
            <circle cx="5" cy="5" r="3.5" stroke="currentColor" strokeWidth="1.3" />
            <path d="M8 8l2 2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
          <input
            type="text"
            placeholder="Search path…"
            value={pathFilter}
            onChange={(e) => setPathFilter(e.target.value)}
            className="w-48 bg-[#1c1c1e] border border-white/[0.1] rounded-lg pl-7 pr-7 py-1.5 text-[11px] text-zinc-200 font-mono placeholder:text-zinc-600 focus:outline-none focus:border-blue-500/50 transition-colors"
          />
          {pathFilter && (
            <button
              onClick={() => setPathFilter("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-600 hover:text-zinc-300"
              title="Clear search"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              </svg>
            </button>
          )}
        </div>

        {/* Status filter — segmented control, active pill tinted by bucket */}
        <div className="flex items-center gap-0.5 bg-white/[0.03] border border-white/[0.06] rounded-lg p-0.5">
          {(["all", "2xx", "3xx", "4xx", "5xx"] as StatusFilter[]).map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-2 py-1 text-[11px] font-mono rounded-md transition-colors ${
                statusFilter === s
                  ? STATUS_FILTER_ACTIVE[s]
                  : "text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.06]"
              }`}
            >
              {s}
            </button>
          ))}
        </div>

        <div className="relative">
          <select
            value={methodFilter}
            onChange={(e) => setMethodFilter(e.target.value)}
            className="appearance-none bg-[#1c1c1e] border border-white/[0.1] rounded-lg pl-2.5 pr-7 py-1.5 text-[11px] text-zinc-200 font-mono cursor-pointer focus:outline-none focus:border-blue-500/50 transition-colors"
          >
            {METHOD_OPTIONS.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
          <svg width="9" height="9" viewBox="0 0 10 10" fill="none" className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none">
            <path d="M2.5 4L5 6.5L7.5 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>

        <button
          onClick={() => setPaused((p) => !p)}
          className={`px-2.5 py-1.5 text-[11px] font-medium rounded-lg transition-colors ${
            paused
              ? "text-amber-400 bg-amber-500/10 hover:bg-amber-500/20"
              : "text-zinc-300 bg-white/[0.06] hover:bg-white/[0.1]"
          }`}
        >
          {paused
            ? bufferedCount > 0
              ? `Resume (${bufferedCount})`
              : "Resume"
            : "Pause"}
        </button>
        <button
          onClick={handleClear}
          className="px-2.5 py-1.5 text-[11px] font-medium text-zinc-300 bg-white/[0.06] hover:bg-white/[0.1] rounded-lg transition-colors"
        >
          Clear
        </button>
        <button
          onClick={onClose}
          className="p-1.5 rounded-lg text-zinc-600 hover:text-zinc-200 hover:bg-white/[0.07] transition-colors"
          title="Close"
        >
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
            <path d="M2 2l9 9M11 2L2 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {/* Body: list + detail panel */}
      <div className="flex-1 min-h-0 flex">
        {/* List */}
        <div className="w-[55%] min-w-0 border-r border-white/[0.06] overflow-y-auto font-mono text-[11px]">
          {filtered.length === 0 ? (
            <div className="flex items-center justify-center h-full text-zinc-600 text-[12px]">
              {entries.length === 0 ? "Waiting for traffic…" : "No requests match the current filter."}
            </div>
          ) : (
            <table className="w-full text-left">
              <thead className="sticky top-0 bg-[#161618] text-[10px] uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="px-3 py-1.5 font-medium">Time</th>
                  <th className="px-2 py-1.5 font-medium">Method</th>
                  <th className="px-2 py-1.5 font-medium">Path</th>
                  <th className="px-2 py-1.5 font-medium text-right">Status</th>
                  <th className="px-2 py-1.5 font-medium text-right">Dur</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((e, idx) => (
                  <tr
                    key={`${e.ts}-${idx}`}
                    onClick={() => setSelectedIdx(idx)}
                    className={`cursor-pointer border-b border-white/[0.04] hover:bg-white/[0.04] ${
                      selectedIdx === idx ? "bg-white/[0.06]" : ""
                    }`}
                  >
                    <td className="px-3 py-1.5 text-zinc-500 whitespace-nowrap">{fmtTime(e.ts)}</td>
                    <td className={`px-2 py-1.5 ${methodColor(e.method)} whitespace-nowrap`}>{e.method}</td>
                    <td className="px-2 py-1.5 text-zinc-300 truncate max-w-0" title={`${e.host}${e.uri}`}>
                      {e.uri || "/"}
                    </td>
                    <td className={`px-2 py-1.5 text-right ${statusColor(e.status)} whitespace-nowrap`}>
                      {e.status || "—"}
                    </td>
                    <td className="px-2 py-1.5 text-right text-zinc-500 whitespace-nowrap">{fmtDuration(e.duration_ms)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Detail panel */}
        <div className="flex-1 min-w-0 flex flex-col">
          {!selected ? (
            <div className="flex items-center justify-center h-full text-zinc-600 text-[12px]">
              Select a request to inspect
            </div>
          ) : (
            <>
              {/* Tab bar */}
              <div className="flex items-center gap-1 px-4 py-2 border-b border-white/[0.06] shrink-0">
                {(["headers", "body", "response"] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setActiveTab(t)}
                    className={`px-2.5 py-1 text-[11px] font-mono rounded transition-colors ${
                      activeTab === t
                        ? "bg-white/[0.10] text-zinc-100"
                        : "text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.05]"
                    }`}
                  >
                    {t === "headers" ? "Headers" : t === "body" ? "Body" : "Response"}
                  </button>
                ))}
                <div className="flex-1" />
                <span className="text-[10px] font-mono text-zinc-500 truncate max-w-[40ch]" title={`${selected.method} ${selected.host}${selected.uri}`}>
                  {selected.method} {selected.host}{selected.uri}
                </span>
              </div>

              {/* Tab content */}
              <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
                {activeTab === "headers" && <DetailHeaders entry={selected} />}
                {activeTab === "body" && <DetailBody entry={selected} />}
                {activeTab === "response" && <DetailResponse entry={selected} />}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function HeaderTable({ title, headers }: { title: string; headers: Record<string, string[]> }) {
  const keys = Object.keys(headers).sort();
  return (
    <div className="mb-4">
      <div className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1 font-mono">{title}</div>
      {keys.length === 0 ? (
        <div className="text-zinc-600 italic text-[11px] font-mono">(none)</div>
      ) : (
        <table className="w-full font-mono text-[11px]">
          <tbody>
            {keys.map((k) => (
              <tr key={k} className="align-top border-b border-white/[0.03]">
                <td className="text-zinc-500 pr-3 py-1 whitespace-nowrap">{k}</td>
                <td className="text-zinc-300 py-1 break-all">{headers[k].join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function DetailHeaders({ entry }: { entry: AccessLogEntry }) {
  return (
    <>
      <HeaderTable title="Request headers" headers={entry.req_headers} />
      <HeaderTable title="Response headers" headers={entry.resp_headers} />
    </>
  );
}

function DetailBody({ entry }: { entry: AccessLogEntry }) {
  const [parsed, pretty] = useMemo<[boolean, string]>(() => {
    if (!entry.req_body) return [false, ""];
    try {
      const v = JSON.parse(entry.req_body);
      return [true, JSON.stringify(v, null, 2)];
    } catch {
      return [false, entry.req_body];
    }
  }, [entry.req_body]);

  if (!entry.req_body || entry.req_body.length === 0) {
    return (
      <div className="text-zinc-500 text-[11px] font-mono">
        No request body captured.
        <div className="mt-1 text-zinc-600 text-[10px]">
          Bodies are captured for the first 64 KB of each request. Binary or
          empty bodies are hidden.
        </div>
      </div>
    );
  }

  return (
    <div className="relative">
      <div className="absolute top-0 right-0 flex items-center gap-1.5 z-10">
        {parsed && (
          <span className="text-[9px] font-mono text-zinc-600 px-1.5 py-0.5 bg-white/[0.04] rounded">
            JSON
          </span>
        )}
        <CopyButton text={pretty} />
      </div>
      <div className="pt-7">
        {parsed ? (
          <JsonSyntax text={pretty} />
        ) : (
          <pre className="whitespace-pre-wrap break-all text-zinc-300 leading-relaxed text-[11px] font-mono">
            {pretty}
          </pre>
        )}
      </div>
    </div>
  );
}

function DetailResponse({ entry }: { entry: AccessLogEntry }) {
  return (
    <div className="space-y-1.5 font-mono text-[11px]">
      <Row label="Status" value={String(entry.status)} valueClass={statusColor(entry.status)} />
      <Row label="Duration" value={fmtDuration(entry.duration_ms)} />
      <Row label="Response size" value={fmtSize(entry.resp_size_bytes)} />
      <Row label="Remote IP" value={entry.remote_ip || "—"} />
      <Row label="Host" value={entry.host} />
      <Row label="Method" value={entry.method} valueClass={methodColor(entry.method)} />
      <Row label="URI" value={entry.uri} />
      <Row label="Timestamp" value={new Date(entry.ts * 1000).toISOString()} />
    </div>
  );
}

function Row({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="flex">
      <div className="w-[120px] text-zinc-500 text-[10px] uppercase tracking-wide">{label}</div>
      <div className={`flex-1 ${valueClass ?? "text-zinc-200"} break-all`}>{value}</div>
    </div>
  );
}
