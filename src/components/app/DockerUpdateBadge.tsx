import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { App, ImageUpdateInfo, UpdateRisk, UpdateOptions, RiskLevel } from "../../types";
import {
  checkAppImageUpdates,
  classifyImageUpdate,
  updateAppImages,
  updateComposeImageFor,
} from "../../lib/commands";
import { usePortaStore } from "../../store";
import { useShallow } from "zustand/react/shallow";
import Tooltip from "../shared/Tooltip";
import { detectLevel, LEVEL_CLS, stripAnsi } from "../../lib/log-utils";

interface Props {
  app: App;
  // Prominent mode (workbench Overview): always visible, with an image label +
  // status line + a labeled button. The default (card) mode is a tiny icon that
  // hover-reveals — too easy to miss once the app is opened and the card is gone.
  prominent?: boolean;
}

type CheckState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "ready"; info: ImageUpdateInfo[] }
  | { kind: "error"; message: string };

function hasUpdate(info: ImageUpdateInfo): boolean {
  return info.status === "ok" && (info.has_digest_update || !!info.suggested_tag);
}

interface PopoverPos {
  top: number;
  left: number;
}

const POPOVER_WIDTH = 380;
const MAX_LOG_LINES = 200;

export type UpdatePhase =
  | "idle"
  | "stopping"
  | "snapshotting"
  | "pulling"
  | "starting"
  | "verifying"
  | "rolling_back"
  | "restoring"
  | "done"
  | "error";

const RISK_RANK: Record<RiskLevel, number> = { safe: 0, caution: 1, danger: 2 };
function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_RANK[a] >= RISK_RANK[b] ? a : b;
}

export default function DockerUpdateBadge({ app, prominent = false }: Props) {
  const [state, setState] = useState<CheckState>({ kind: "idle" });
  const [updating, setUpdating] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<PopoverPos | null>(null);
  // Live progress state — populated by Tauri events emitted from
  // update_docker_app / update_compose_app while the update runs.
  const [phase, setPhase] = useState<UpdatePhase>("idle");
  const [logLines, setLogLines] = useState<string[]>([]);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const popoverElRef = useRef<HTMLDivElement | null>(null);
  const imageConfigKeyRef = useRef<string | null>(null);

  const { cachedInfo, setImageUpdateCache, refreshApp } = usePortaStore(
    useShallow((s) => ({
      cachedInfo: s.imageUpdateCache[app.id],
      setImageUpdateCache: s.setImageUpdateCache,
      refreshApp: s.refreshApp,
    }))
  );

  // Sync from background polling cache — skip if user is actively checking
  useEffect(() => {
    if (!cachedInfo) return;
    if (state.kind === "checking") return;
    setState({ kind: "ready", info: cachedInfo });
  }, [cachedInfo]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset whenever the app's image config changes after mount. Do not reset on
  // the first render: background polling may already have cached update info,
  // and wiping local state there hides the per-card update badge while the
  // sidebar still shows an update count.
  useEffect(() => {
    const nextKey = `${app.id}:${app.kind}:${app.docker_image ?? ""}:${app.compose_file ?? ""}`;
    if (imageConfigKeyRef.current === null) {
      imageConfigKeyRef.current = nextKey;
      return;
    }
    if (imageConfigKeyRef.current === nextKey) return;
    imageConfigKeyRef.current = nextKey;
    setState({ kind: "idle" });
    setImageUpdateCache(app.id, []);
  }, [app.id, app.docker_image, app.compose_file, app.kind, setImageUpdateCache]);

  useLayoutEffect(() => {
    if (!open || !anchorRef.current) return;
    function recomputePosition() {
      if (!anchorRef.current) return;
      const rect = anchorRef.current.getBoundingClientRect();
      const margin = 8;
      const maxLeft = window.innerWidth - POPOVER_WIDTH - margin;
      const desired = rect.right - POPOVER_WIDTH;
      const left = Math.max(margin, Math.min(desired, maxLeft));
      setPos({ top: rect.bottom + 4, left });
    }
    recomputePosition();
    window.addEventListener("scroll", recomputePosition, true);
    window.addEventListener("resize", recomputePosition);
    return () => {
      window.removeEventListener("scroll", recomputePosition, true);
      window.removeEventListener("resize", recomputePosition);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      // Keep the popover mounted while an update is in-flight or showing its
      // result — its ProgressView (and any fullscreen log portal it owns) must
      // survive stray outside clicks. Dismiss is via the explicit Close button.
      if (updating || phase === "done" || phase === "error") return;
      const t = e.target as Node;
      if (anchorRef.current?.contains(t)) return;
      if (popoverElRef.current?.contains(t)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, updating, phase]);

  useEffect(() => {
    if (!updating) return;
    let unlistens: Array<() => void> = [];
    let cancelled = false;
    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const u1 = await listen<string>(`app:update-phase:${app.id}`, (e) => {
        setPhase(e.payload as UpdatePhase);
      });
      const u2 = await listen<string>(`app:update-log:${app.id}`, (e) => {
        setLogLines((prev) => {
          const next = [...prev, e.payload];
          return next.length > MAX_LOG_LINES ? next.slice(-MAX_LOG_LINES) : next;
        });
      });
      if (cancelled) {
        u1();
        u2();
      } else {
        unlistens = [u1, u2];
      }
    })();
    return () => {
      cancelled = true;
      unlistens.forEach((fn) => fn());
    };
  }, [updating, app.id]);

  if (app.kind !== "docker" && app.kind !== "compose") return null;

  // `keepOpen` is set for the in-dialog refresh: it re-checks without flipping
  // state to "checking" (which would unmount the popover, since the portal only
  // renders while state.kind === "ready"). The old info stays visible with a
  // spinner on the refresh button until the fresh result lands.
  async function runCheck(opts?: { keepOpen?: boolean }) {
    if (opts?.keepOpen) setRefreshing(true);
    else setState({ kind: "checking" });
    try {
      const info = await checkAppImageUpdates(app.id);
      setImageUpdateCache(app.id, info);
      setState({ kind: "ready", info });
      if (!opts?.keepOpen && info.some(hasUpdate)) setOpen(true);
    } catch (e) {
      setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setRefreshing(false);
    }
  }

  async function runUpdate(replacements: [string, string][], options?: UpdateOptions) {
    setLogLines([]);
    setPhase("idle");
    setUpdating(true);
    try {
      await updateAppImages(app.id, replacements, options);
      setPhase("done");
      await new Promise((r) => setTimeout(r, 1200));
      await refreshApp(app.id);
      setImageUpdateCache(app.id, []);
      setState({ kind: "idle" });
      setOpen(false);
    } catch (e) {
      setPhase("error");
      setLogLines((prev) => [...prev, `error: ${e instanceof Error ? e.message : String(e)}`]);
    } finally {
      setUpdating(false);
    }
  }

  const updates = state.kind === "ready" ? state.info.filter(hasUpdate) : [];
  const hasAny = updates.length > 0;
  // Quiet when nothing actionable: no updates pending, not erroring, not mid-check.
  // The amber "↑ N updates" state and error/checking states stay visible.
  const isQuiet = !hasAny && state.kind !== "error" && state.kind !== "checking";

  // Prominent (workbench Overview) copy: an image label, a status line, and a
  // labeled button — reusing the same check/update/popover logic underneath.
  const imageLabel =
    app.docker_image || (app.kind === "compose" ? "docker compose" : "—");
  const statusText =
    state.kind === "checking" ? "Checking for updates…"
    : state.kind === "error" ? "Couldn't check for updates"
    : state.kind === "ready" && hasAny ? `${updates.length} update${updates.length > 1 ? "s" : ""} available`
    : state.kind === "ready" ? "Up to date"
    : "Update status unknown";
  const checkLabel =
    state.kind === "checking" ? "Checking…"
    : state.kind === "error" ? "Retry"
    : state.kind === "ready" ? "Re-check"
    : "Check for updates";
  const checkIcon =
    state.kind === "checking" ? (
      <svg className="animate-spin" width="13" height="13" viewBox="0 0 13 13" fill="none">
        <path d="M6.5 2A4.5 4.5 0 1 1 2 6.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    ) : state.kind === "ready" ? (
      <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
        <path d="M3 6.5l2.5 2.5L10 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ) : (
      <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
        <path
          d="M11 6.5A4.5 4.5 0 1 1 6.5 2c1.4 0 2.7.6 3.5 1.7M10 1.5v2.5h-2.5"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );

  return (
    <div
      ref={anchorRef}
      className={
        prominent
          ? "flex items-center gap-2 w-full"
          : `inline-flex ${isQuiet ? "opacity-0 group-hover:opacity-100 transition-opacity duration-150" : ""}`
      }
      onClick={(e) => e.stopPropagation()}
    >
      {prominent && (
        <div className="min-w-0 flex-1">
          <div className="text-[12px] text-ink font-mono truncate" title={imageLabel}>{imageLabel}</div>
          <div className={`text-[11px] ${state.kind === "error" ? "text-bad" : hasAny ? "text-warn" : "text-ink-3"}`}>{statusText}</div>
        </div>
      )}
      {state.kind === "ready" && hasAny ? (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setOpen((v) => !v);
          }}
          className={
            prominent
              ? "shrink-0 inline-flex items-center gap-1.5 text-[11px] font-semibold tracking-wider text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 px-2.5 py-1.5 rounded-control uppercase transition-colors"
              : "text-[9px] font-semibold tracking-wider text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 px-1.5 py-0.5 rounded leading-none uppercase transition-colors"
          }
          title={`${updates.length} image${updates.length > 1 ? "s" : ""} can be updated`}
        >
          ↑ {updates.length} update{updates.length > 1 ? "s" : ""}
        </button>
      ) : prominent ? (
        <button
          onClick={(e) => {
            e.stopPropagation();
            runCheck();
          }}
          disabled={state.kind === "checking"}
          className={`shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] rounded-control border transition-colors disabled:opacity-50 ${
            state.kind === "error"
              ? "text-red-400 border-red-500/30 hover:bg-red-500/10"
              : "text-ink-2 border-subtle hover:text-ink hover:border-strong hover:bg-white/[0.03]"
          }`}
        >
          {checkIcon}
          {checkLabel}
        </button>
      ) : (
        <Tooltip
          label={
            state.kind === "error"
              ? `Check failed: ${state.message}`
              : state.kind === "ready"
              ? "All images up to date"
              : state.kind === "checking"
              ? "Checking…"
              : "Check for image updates"
          }
        >
          <button
            onClick={(e) => {
              e.stopPropagation();
              runCheck();
            }}
            disabled={state.kind === "checking"}
            className={`p-1 rounded-md transition-colors disabled:opacity-50 ${
              state.kind === "error"
                ? "text-red-400 hover:bg-red-500/10"
                : state.kind === "ready"
                ? "text-emerald-400/70 hover:text-emerald-300 hover:bg-emerald-500/10"
                : "text-zinc-600 hover:text-zinc-300 hover:bg-white/[0.06]"
            }`}
          >
            {checkIcon}
          </button>
        </Tooltip>
      )}

      {open && state.kind === "ready" && pos &&
        createPortal(
          <div
            ref={popoverElRef}
            style={{ position: "fixed", top: pos.top, left: pos.left, width: POPOVER_WIDTH, zIndex: 60 }}
          >
            <UpdatePopover
              app={app}
              info={state.info}
              updating={updating}
              refreshing={refreshing}
              onRefresh={() => runCheck({ keepOpen: true })}
              phase={phase}
              logLines={logLines}
              onClose={() => {
                setOpen(false);
                // Reset progress state so reopening lands on the updates list
                // instead of the previous error/done view.
                if (phase === "error" || phase === "done") {
                  setPhase("idle");
                  setLogLines([]);
                }
              }}
              onUpdate={runUpdate}
            />
          </div>,
          document.body,
        )}
    </div>
  );
}

interface PopoverProps {
  app: App;
  info: ImageUpdateInfo[];
  updating: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  phase: UpdatePhase;
  logLines: string[];
  onClose: () => void;
  onUpdate: (replacements: [string, string][], options?: UpdateOptions) => void;
}

const PHASE_LABEL: Record<UpdatePhase, string> = {
  idle: "Preparing…",
  stopping: "Stopping container",
  snapshotting: "Snapshotting volumes",
  pulling: "Pulling new image",
  starting: "Starting container",
  verifying: "Verifying health",
  rolling_back: "Rolling back",
  restoring: "Restoring volume from snapshot",
  done: "✓ Update complete",
  error: "✗ Update failed",
};

function PhaseStatus({ phase, size }: { phase: UpdatePhase; size: "sm" | "lg" }) {
  const isError = phase === "error";
  const isDone = phase === "done";
  const isRecovering = phase === "rolling_back" || phase === "restoring";
  const inFlight = !isError && !isDone;
  const dim = size === "lg" ? 15 : 12;
  const textCls = size === "lg" ? "text-[13px]" : "text-[11px]";

  return (
    <div className="flex items-center gap-2 min-w-0">
      {inFlight ? (
        <svg
          className={`animate-spin shrink-0 ${isRecovering ? "text-orange-400" : "text-amber-400"}`}
          width={dim}
          height={dim}
          viewBox="0 0 12 12"
          fill="none"
        >
          <path d="M6 2A4 4 0 1 1 2 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      ) : isDone ? (
        <svg width={dim} height={dim} viewBox="0 0 12 12" fill="none" className="text-emerald-400 shrink-0">
          <path d="M2.5 6.5l2.5 2.5L9.5 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg width={dim} height={dim} viewBox="0 0 12 12" fill="none" className="text-red-400 shrink-0">
          <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      )}
      <p
        className={`${textCls} font-medium truncate ${
          isError
            ? "text-red-300"
            : isDone
            ? "text-emerald-300"
            : isRecovering
            ? "text-orange-300"
            : "text-amber-200"
        }`}
      >
        {PHASE_LABEL[phase]}
      </p>
    </div>
  );
}

/** Render streamed log lines with per-level coloring so errors stand out from
 * ordinary docker output (which otherwise shares the same neutral gray). */
function LogLines({ lines }: { lines: string[] }) {
  if (lines.length === 0) {
    return <p className="text-zinc-600 italic">waiting for output…</p>;
  }
  return (
    <>
      {lines.map((raw, idx) => {
        const line = stripAnsi(raw);
        const level = detectLevel(line);
        const cls = level ? LEVEL_CLS[level] : "text-zinc-400";
        const weight = level === "error" ? "font-medium" : "";
        return (
          <div key={idx} className={`whitespace-pre-wrap break-all ${cls} ${weight}`}>
            {line || " "}
          </div>
        );
      })}
    </>
  );
}

function CopyLogButton({ lines }: { lines: string[] }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    const text = lines.map(stripAnsi).join("\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <button
      onClick={copy}
      disabled={lines.length === 0}
      className="text-[10px] text-zinc-400 hover:text-zinc-200 disabled:opacity-30 disabled:cursor-not-allowed px-1.5 py-0.5 rounded hover:bg-white/[0.06] transition-colors flex items-center gap-1"
      title="Copy log to clipboard"
    >
      {copied ? (
        <>
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" className="text-emerald-400">
            <path d="M2.5 6.5l2.5 2.5L9.5 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Copied
        </>
      ) : (
        <>
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
            <rect x="3.5" y="3.5" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.1" />
            <path d="M2 8V2.5Q2 2 2.5 2H8" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Copy
        </>
      )}
    </button>
  );
}

function ProgressView({ phase, logLines }: { phase: UpdatePhase; logLines: string[] }) {
  const [fullscreen, setFullscreen] = useState(false);
  const logBoxRef = useRef<HTMLDivElement | null>(null);
  const fsLogBoxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (logBoxRef.current) logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
    if (fsLogBoxRef.current) fsLogBoxRef.current.scrollTop = fsLogBoxRef.current.scrollHeight;
  }, [logLines, fullscreen]);

  // Esc exits fullscreen without bubbling up to close the whole popover.
  useEffect(() => {
    if (!fullscreen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        setFullscreen(false);
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [fullscreen]);

  return (
    <div className="px-3 py-3">
      <div className="flex items-center justify-between gap-2 mb-2">
        <PhaseStatus phase={phase} size="sm" />
        <div className="flex items-center gap-0.5 shrink-0">
          <CopyLogButton lines={logLines} />
          <button
            onClick={() => setFullscreen(true)}
            className="text-zinc-400 hover:text-zinc-200 p-1 rounded hover:bg-white/[0.06] transition-colors"
            title="Fullscreen"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M4.5 1.5H1.5V4.5M7.5 1.5H10.5V4.5M4.5 10.5H1.5V7.5M7.5 10.5H10.5V7.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </div>
      <div
        ref={logBoxRef}
        className="bg-black/40 border border-white/[0.06] rounded terminal-log-font text-[10px] leading-[1.4] px-2 py-1.5 max-h-[180px] overflow-y-auto select-text"
      >
        <LogLines lines={logLines} />
      </div>

      {fullscreen &&
        createPortal(
          <div
            className="fixed inset-0 z-[100] bg-[#0a0a0c]/95 backdrop-blur-sm flex flex-col"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <header className="flex items-center justify-between gap-3 px-4 py-3 border-b border-white/[0.08]">
              <PhaseStatus phase={phase} size="lg" />
              <div className="flex items-center gap-1">
                <CopyLogButton lines={logLines} />
                <button
                  onClick={() => setFullscreen(false)}
                  className="text-zinc-400 hover:text-zinc-200 p-1.5 rounded hover:bg-white/[0.06] transition-colors"
                  title="Exit fullscreen (Esc)"
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <path d="M5.5 8.5H2.5V5.5M8.5 5.5H11.5V8.5M5.5 2.5V5.5H2.5M8.5 11.5V8.5H11.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </div>
            </header>
            <div
              ref={fsLogBoxRef}
              className="flex-1 overflow-y-auto select-text terminal-log-font text-[12px] leading-[1.5] px-4 py-3 bg-[#0f0f11]"
            >
              <LogLines lines={logLines} />
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

interface PreflightSummary {
  level: RiskLevel;
  reasons: string[];
  dependents: string[];
  /** Compose-local volume basenames that are stateful, deduped across rows. */
  statefulVolumes: string[];
  /** Aggregated suggestion of an intermediate tag, if any single row had one. */
  intermediateTagHint: { image: string; tag: string } | null;
  /** Friendly stateful labels seen across the affected rows (deduped). */
  statefulLabels: string[];
}

function aggregateRisks(risks: UpdateRisk[]): PreflightSummary {
  let level: RiskLevel = "safe";
  const reasons: string[] = [];
  const dependents = new Set<string>();
  const statefulVolumes = new Set<string>();
  const statefulLabels = new Set<string>();
  let intermediateTagHint: PreflightSummary["intermediateTagHint"] = null;
  for (const r of risks) {
    level = maxRisk(level, r.level);
    for (const reason of r.reasons) reasons.push(reason);
    for (const d of r.dependents) dependents.add(d);
    for (const v of r.volumes) {
      if (v.is_named && v.is_stateful_path) statefulVolumes.add(v.source);
    }
    if (r.stateful_label) statefulLabels.add(r.stateful_label);
    if (r.recommend_intermediate_tag && !intermediateTagHint) {
      intermediateTagHint = {
        image: r.current_image,
        tag: r.recommend_intermediate_tag,
      };
    }
  }
  return {
    level,
    reasons,
    dependents: [...dependents],
    statefulVolumes: [...statefulVolumes],
    intermediateTagHint,
    statefulLabels: [...statefulLabels],
  };
}

interface PreflightProps {
  summary: PreflightSummary;
  defaultSnapshot: boolean;
  defaultRollback: boolean;
  defaultRestore: boolean;
  onConfirm: (opts: {
    snapshot: boolean;
    rollback: boolean;
    restore: boolean;
  }) => void;
  onApplyIntermediate: () => void;
  onCancel: () => void;
}

function PreflightView({
  summary,
  defaultSnapshot,
  defaultRollback,
  defaultRestore,
  onConfirm,
  onApplyIntermediate,
  onCancel,
}: PreflightProps) {
  const [snapshot, setSnapshot] = useState(defaultSnapshot);
  const [rollback, setRollback] = useState(defaultRollback);
  const [restore, setRestore] = useState(defaultRestore);

  const ringClass =
    summary.level === "danger"
      ? "border-red-500/30 bg-red-500/[0.04]"
      : summary.level === "caution"
      ? "border-amber-500/30 bg-amber-500/[0.04]"
      : "border-emerald-500/30 bg-emerald-500/[0.04]";
  const labelClass =
    summary.level === "danger"
      ? "text-red-300"
      : summary.level === "caution"
      ? "text-amber-300"
      : "text-emerald-300";
  const verb =
    summary.level === "danger" ? "Risky update" : summary.level === "caution" ? "Heads-up" : "Looks safe";

  return (
    <div className="px-3 py-3 space-y-3">
      <div className={`border rounded px-2.5 py-2 ${ringClass}`}>
        <p className={`text-[10px] font-semibold uppercase tracking-wider ${labelClass}`}>
          {verb}
        </p>
        {summary.statefulLabels.length > 0 && (
          <p className="mt-1 text-[11px] text-zinc-300">
            Affects: <span className="font-mono">{summary.statefulLabels.join(", ")}</span>
          </p>
        )}
      </div>

      <ul className="space-y-1.5">
        {summary.reasons.map((r, i) => (
          <li key={i} className="text-[11px] text-zinc-300 leading-[1.45] flex gap-1.5">
            <span className="text-zinc-600 mt-[2px]">•</span>
            <span>{r}</span>
          </li>
        ))}
      </ul>

      {summary.intermediateTagHint && (
        <button
          onClick={onApplyIntermediate}
          className="w-full text-left px-2.5 py-1.5 rounded bg-blue-500/[0.08] hover:bg-blue-500/[0.15] border border-blue-500/30 transition-colors"
        >
          <p className="text-[10px] font-semibold uppercase tracking-wider text-blue-300">
            Safer path
          </p>
          <p className="mt-0.5 text-[11px] text-zinc-200">
            Jump to{" "}
            <span className="font-mono text-blue-200">
              {summary.intermediateTagHint.tag}
            </span>{" "}
            first instead.
          </p>
        </button>
      )}

      <div className="space-y-2 pt-1">
        {summary.statefulVolumes.length > 0 && (
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={snapshot}
              onChange={(e) => setSnapshot(e.target.checked)}
              className="mt-[2px] accent-amber-500"
            />
            <span className="text-[11px] text-zinc-300 leading-[1.4]">
              <span className="font-medium">Snapshot volume{summary.statefulVolumes.length > 1 ? "s" : ""} first</span>
              <span className="block text-[10px] text-zinc-500 font-mono mt-0.5">
                {summary.statefulVolumes.join(", ")}
              </span>
            </span>
          </label>
        )}
        <label className="flex items-start gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={rollback}
            onChange={(e) => setRollback(e.target.checked)}
            className="mt-[2px] accent-amber-500"
          />
          <span className="text-[11px] text-zinc-300 leading-[1.4]">
            <span className="font-medium">Auto-rollback on failure</span>
            <span className="block text-[10px] text-zinc-500 mt-0.5">
              Verify health for ~45s and revert if any container can't reach a healthy state.
            </span>
          </span>
        </label>
        {snapshot && rollback && (
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={restore}
              onChange={(e) => setRestore(e.target.checked)}
              className="mt-[2px] accent-orange-500"
            />
            <span className="text-[11px] text-zinc-300 leading-[1.4]">
              <span className="font-medium">Also restore volume on rollback</span>
              <span className="block text-[10px] text-zinc-500 mt-0.5">
                Wipe and restore from the snapshot. Use when the new image may have written to the data dir before crashing.
              </span>
            </span>
          </label>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          onClick={onCancel}
          className="text-[11px] text-zinc-400 hover:text-zinc-200 px-2 py-1 rounded transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={() => onConfirm({ snapshot, rollback, restore })}
          className={`text-[11px] font-medium px-2.5 py-1 rounded border transition-colors ${
            summary.level === "danger"
              ? "text-red-200 bg-red-500/15 hover:bg-red-500/25 border-red-500/40"
              : "text-amber-300 bg-amber-500/15 hover:bg-amber-500/25 border-amber-500/30"
          }`}
        >
          {summary.level === "danger" ? "Update anyway" : "Update"}
        </button>
      </div>
    </div>
  );
}

function UpdatePopover({ app, info, updating, refreshing, onRefresh, phase, logLines, onClose, onUpdate }: PopoverProps) {
  const appId = app.id;
  // Per-row decision: for semver-pinned tags the user can opt to swap to the
  // suggested tag, or just re-pull the same tag. Default is "swap to suggested".
  const [chosenTag, setChosenTag] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const i of info) {
      if (i.suggested_tag) init[i.image] = i.suggested_tag;
    }
    return init;
  });

  const updates = info.filter(
    (i) => i.status === "ok" && (i.has_digest_update || !!i.suggested_tag),
  );

  // Preflight state: when the user clicks Update we first compute risk, then
  // either pop the preflight modal (caution/danger) or skip straight to the
  // update (safe).
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [preflightSummary, setPreflightSummary] = useState<PreflightSummary | null>(null);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  // Carry the replacements decided in the click so the confirm button can fire
  // without recomputing them.
  const [pendingReplacements, setPendingReplacements] = useState<[string, string][]>([]);
  const [pendingVolumes, setPendingVolumes] = useState<string[]>([]);

  function buildReplacements(chosen: Record<string, string>): [string, string][] {
    const replacements: [string, string][] = [];
    for (const i of updates) {
      const tag = chosen[i.image];
      if (tag && tag !== i.tag) replacements.push([i.image, tag]);
    }
    return replacements;
  }

  // `overrideChosen` lets callers (e.g. apply-intermediate) hand in the new
  // chosenTag synchronously without waiting for a setState flush — otherwise
  // the closure here would still read the previous render's chosenTag.
  async function startUpdate(overrideChosen?: Record<string, string>) {
    setPreflightError(null);
    setPreflightLoading(true);
    const effectiveChosen = overrideChosen ?? chosenTag;
    const replacements = buildReplacements(effectiveChosen);
    setPendingReplacements(replacements);
    try {
      // For each affected row, classify. Same-tag re-pulls (digest update only)
      // still need a risk check on stateful images.
      const targets: Array<{ row: ImageUpdateInfo; tag: string | null }> = updates.map((row) => {
        const tag = effectiveChosen[row.image];
        return { row, tag: tag && tag !== row.tag ? tag : null };
      });
      const risks = await Promise.all(
        targets.map(({ row, tag }) =>
          classifyImageUpdate(appId, row.service_name, tag),
        ),
      );
      const summary = aggregateRisks(risks);
      setPreflightSummary(summary);
      setPendingVolumes(summary.statefulVolumes);
      // Safe + no stateful volume + no dependents: skip the modal entirely.
      if (summary.level === "safe") {
        setPreflightSummary(null);
        onUpdate(replacements, undefined);
      }
    } catch (e) {
      setPreflightError(e instanceof Error ? e.message : String(e));
    } finally {
      setPreflightLoading(false);
    }
  }

  function confirmFromPreflight(opts: { snapshot: boolean; rollback: boolean; restore: boolean }) {
    setPreflightSummary(null);
    onUpdate(pendingReplacements, {
      snapshot_first: opts.snapshot,
      auto_rollback: opts.rollback,
      restore_on_rollback: opts.restore,
      snapshot_volumes: opts.snapshot ? pendingVolumes : [],
    });
  }

  async function applyIntermediateAndReclassify() {
    if (!preflightSummary?.intermediateTagHint) return;
    const hint = preflightSummary.intermediateTagHint;
    const newChosen = { ...chosenTag, [hint.image]: hint.tag };
    setChosenTag(newChosen);

    // For compose apps, also patch the compose file on disk so the next
    // compose-up uses the safer tag — otherwise we'd just be holding the
    // recommendation in memory and a fresh `docker compose up` would still
    // pull the original tag from the YAML.
    if (app.kind === "compose" && app.compose_file) {
      try {
        await updateComposeImageFor(app.compose_file, hint.image, hint.tag);
      } catch (e) {
        // Surface the failure so the user knows the YAML wasn't patched
        // and can edit manually.
        window.alert(
          `Couldn't patch compose with ${hint.tag}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    setPreflightSummary(null);
    // Re-classify with the new tag. Pass newChosen explicitly: relying on
    // the chosenTag state here causes a one-render lag — that's why the
    // user previously had to click "Safer path" twice.
    await startUpdate(newChosen);
  }

  const showProgress = updating || phase === "done" || phase === "error";
  const showPreflight = !!preflightSummary && !showProgress;

  return (
    <div className="bg-[#1c1c1e] border border-white/[0.10] rounded-lg shadow-xl overflow-hidden">
      <div className="px-3 py-2 border-b border-white/[0.06] flex items-center justify-between">
        <p className="text-[11px] font-medium text-zinc-300">
          {showProgress
            ? "Updating image"
            : showPreflight
            ? "Pre-flight check"
            : "Image updates"}
        </p>
        <div className="flex items-center gap-1.5">
          {!showProgress && !showPreflight && (
            <button
              onClick={onRefresh}
              disabled={updating || refreshing}
              className="text-zinc-500 hover:text-zinc-300 leading-none disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              title="Re-check for updates"
            >
              <svg
                className={refreshing ? "animate-spin" : ""}
                width="12"
                height="12"
                viewBox="0 0 13 13"
                fill="none"
              >
                <path
                  d="M11 6.5A4.5 4.5 0 1 1 6.5 2c1.4 0 2.7.6 3.5 1.7M10 1.5v2.5h-2.5"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          )}
          <button
            onClick={onClose}
            disabled={updating}
            className="text-zinc-500 hover:text-zinc-300 text-xs leading-none disabled:opacity-30 disabled:cursor-not-allowed"
            title={updating ? "Update in progress" : "Close"}
          >
            ×
          </button>
        </div>
      </div>

      {showProgress ? (
        <>
          <ProgressView phase={phase} logLines={logLines} />
          {phase === "error" && (
            <div className="px-3 py-2 border-t border-white/[0.06] flex items-center justify-end">
              <button
                onClick={onClose}
                className="text-[11px] text-zinc-400 hover:text-zinc-200 px-2 py-1 rounded transition-colors"
              >
                Close
              </button>
            </div>
          )}
        </>
      ) : showPreflight && preflightSummary ? (
        <PreflightView
          summary={preflightSummary}
          defaultSnapshot={preflightSummary.statefulVolumes.length > 0 && preflightSummary.level !== "safe"}
          defaultRollback={preflightSummary.level !== "safe"}
          defaultRestore={preflightSummary.level === "danger"}
          onConfirm={confirmFromPreflight}
          onApplyIntermediate={applyIntermediateAndReclassify}
          onCancel={() => {
            setPreflightSummary(null);
            setPendingReplacements([]);
          }}
        />
      ) : (
        <>
          <div className="max-h-[260px] overflow-y-auto">
            {updates.length === 0 ? (
              <p className="px-3 py-3 text-[11px] text-zinc-500">All images up to date.</p>
            ) : (
              updates.map((i) => (
                <div key={i.image + (i.service_name ?? "")} className="px-3 py-2 border-b border-white/[0.04] last:border-b-0">
                  <div className="flex items-baseline gap-1.5">
                    {i.service_name && (
                      <span className="text-[9px] font-semibold uppercase text-teal-300/80 tracking-wider">
                        {i.service_name}
                      </span>
                    )}
                    <p className="text-[11px] font-mono text-zinc-200 truncate" title={i.image}>
                      {i.image}
                    </p>
                  </div>
                  {i.suggested_tag ? (
                    <div className="mt-1 flex items-center gap-1.5 text-[10px]">
                      <span className="text-zinc-500">tag:</span>
                      <select
                        value={chosenTag[i.image] ?? i.tag}
                        onChange={(e) => setChosenTag((m) => ({ ...m, [i.image]: e.target.value }))}
                        className="bg-white/[0.04] border border-white/[0.08] rounded px-1.5 py-0.5 text-zinc-300 font-mono text-[10px] focus:outline-none focus:border-amber-500/40"
                      >
                        <option value={i.tag}>{i.tag} (current)</option>
                        <option value={i.suggested_tag}>{i.suggested_tag} (newer)</option>
                      </select>
                    </div>
                  ) : (
                    <p className="mt-1 text-[10px] text-zinc-500">
                      Same tag, new image pushed — pulling will fetch the latest.
                    </p>
                  )}
                </div>
              ))
            )}
          </div>

          {info.some((i) => i.status !== "ok") && (
            <div className="px-3 py-2 bg-white/[0.02] border-t border-white/[0.04]">
              {info
                .filter((i) => i.status !== "ok")
                .map((i, idx) => (
                  <p key={idx} className="text-[10px] text-zinc-500 truncate" title={i.message ?? ""}>
                    <span className="font-mono">{i.image}</span> — {i.status}
                    {i.message ? `: ${i.message}` : ""}
                  </p>
                ))}
            </div>
          )}

          {preflightError && (
            <div className="px-3 py-2 bg-red-500/[0.06] border-t border-red-500/30">
              <p className="text-[11px] text-red-300">
                Pre-flight failed: {preflightError}
              </p>
            </div>
          )}

          {updates.length > 0 && (
            <div className="px-3 py-2 border-t border-white/[0.06] flex items-center justify-end gap-2">
              <button
                onClick={onClose}
                className="text-[11px] text-zinc-400 hover:text-zinc-200 px-2 py-1 rounded transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => startUpdate()}
                disabled={preflightLoading}
                className="text-[11px] font-medium text-amber-300 bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 px-2.5 py-1 rounded transition-colors flex items-center gap-1.5 disabled:opacity-50"
              >
                {preflightLoading ? "Checking…" : "Update now"}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
