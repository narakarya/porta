import { useEffect, useState } from "react";
import {
  systemDiskUsage,
  pruneDanglingImages,
  pruneUnusedImages,
  appLogsDiskUsage,
  rotateAppLogs,
  clearAllAppLogs,
  getMaxLogBytes,
  setMaxLogBytes,
  getDefaultMaxUploadBytes,
  setDefaultMaxUploadBytes,
  type SystemDiskUsage,
  type PruneResult,
  type LogsDiskUsage,
} from "../../lib/commands";
import { formatBytes, yieldToFrame } from "../../lib/ui";
import DockerImagesModal from "./DockerImagesModal";

type LoadState = "idle" | "loading" | "ready" | "error";
type ActionState = "idle" | "running" | "success" | "error";

interface ActionResult {
  state: ActionState;
  message?: string;
  result?: PruneResult;
}

const ACTION_IDLE: ActionResult = { state: "idle" };

export default function DiskUsageSection() {
  const [usage, setUsage] = useState<SystemDiskUsage | null>(null);
  const [load, setLoad] = useState<LoadState>("idle");
  const [danglingAction, setDanglingAction] = useState<ActionResult>(ACTION_IDLE);
  const [unusedAction, setUnusedAction] = useState<ActionResult>(ACTION_IDLE);
  const [showImagesModal, setShowImagesModal] = useState(false);

  async function refresh() {
    setLoad("loading");
    try {
      const u = await systemDiskUsage();
      setUsage(u);
      setLoad("ready");
    } catch {
      setLoad("error");
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function handleDangling() {
    if (!window.confirm("Remove dangling images? These are unreferenced layers from past pulls — safe to delete.")) return;
    setDanglingAction({ state: "running" });
    await yieldToFrame();
    try {
      const result = await pruneDanglingImages();
      setDanglingAction({ state: "success", result });
      refresh();
    } catch (e) {
      setDanglingAction({ state: "error", message: String(e) });
    }
  }

  async function handleUnused() {
    const reclaim = usage ? formatBytes(usage.images.reclaimable_bytes) : "";
    const msg = `Remove ALL unused images? This includes images not used by any container right now (${reclaim} reclaimable). You'll re-pull when needed.`;
    if (!window.confirm(msg)) return;
    if (!window.confirm("Are you sure? This is more aggressive than dangling-only cleanup.")) return;
    setUnusedAction({ state: "running" });
    await yieldToFrame();
    try {
      const result = await pruneUnusedImages();
      setUnusedAction({ state: "success", result });
      refresh();
    } catch (e) {
      setUnusedAction({ state: "error", message: String(e) });
    }
  }

  const reclaimable =
    (usage?.images.reclaimable_bytes ?? 0) +
    (usage?.containers.reclaimable_bytes ?? 0) +
    (usage?.volumes.reclaimable_bytes ?? 0) +
    (usage?.build_cache.reclaimable_bytes ?? 0);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-[16px] font-semibold text-ink">Docker Disk Usage</h1>
        <p className="text-[12px] text-ink-3 mt-1 leading-relaxed">
          Track how much disk Docker is using and reclaim space from unused images, stopped containers, and build cache.
        </p>
      </div>

      {/* System totals */}
      <div className="flex flex-col gap-4 p-5 rounded-card bg-surface-1 border border-subtle">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className="w-9 h-9 rounded-card bg-accent-bg border border-[rgba(96,165,250,0.3)] flex items-center justify-center shrink-0">
              <svg width="16" height="16" viewBox="0 0 20 20" fill="none" className="text-accent">
                <ellipse cx="10" cy="5" rx="7" ry="2.5" stroke="currentColor" strokeWidth="1.5"/>
                <path d="M3 5v5c0 1.38 3.13 2.5 7 2.5s7-1.12 7-2.5V5" stroke="currentColor" strokeWidth="1.5"/>
                <path d="M3 10v5c0 1.38 3.13 2.5 7 2.5s7-1.12 7-2.5v-5" stroke="currentColor" strokeWidth="1.5"/>
              </svg>
            </div>
            <div>
              <p className="text-[13px] font-medium text-ink">System Totals</p>
              <p className="text-[12px] text-ink-3 mt-0.5 leading-relaxed">
                Disk used by all of Docker — across every project on this machine, not just Porta-managed apps.
              </p>
            </div>
          </div>
          <button
            onClick={refresh}
            disabled={load === "loading"}
            className="text-[12px] text-ink-2 hover:text-ink disabled:opacity-50 transition-colors flex items-center gap-1.5 shrink-0"
            title="Refresh"
          >
            {load === "loading" ? (
              <svg className="w-3 h-3 animate-spin" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.3" />
                <path d="M14 8a6 6 0 00-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M2 6a4 4 0 017-2.5M10 6a4 4 0 01-7 2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
                <path d="M9 1.5v2.5h-2.5M3 10.5v-2.5h2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            )}
            Refresh
          </button>
        </div>

        {load === "error" && (
          <p className="text-[12px] text-bad">
            Couldn't reach Docker. Make sure Docker Desktop / OrbStack is running.
          </p>
        )}

        {load !== "error" && (
          <div className="grid grid-cols-2 gap-2">
            <UsageRow
              label="Images"
              section={usage?.images}
              onDetails={() => setShowImagesModal(true)}
            />
            <UsageRow label="Containers" section={usage?.containers} />
            <UsageRow label="Volumes" section={usage?.volumes} />
            <UsageRow label="Build cache" section={usage?.build_cache} />
          </div>
        )}

        {load === "ready" && reclaimable > 0 && (
          <div className="flex items-center gap-2 text-[12px]">
            <span className="text-ink-3">Reclaimable across all sections:</span>
            <span className="text-warn font-medium font-mono">{formatBytes(reclaimable)}</span>
          </div>
        )}
      </div>

      {/* Cleanup actions */}
      <div className="flex flex-col gap-4 p-5 rounded-card bg-surface-1 border border-subtle">
        <div className="flex items-start gap-4">
          <div className="w-9 h-9 rounded-card bg-warn-bg border border-[rgba(251,191,36,0.3)] flex items-center justify-center shrink-0">
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" className="text-warn">
              <path d="M5 6h10l-1 10a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
              <path d="M3 6h14M8 3h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </div>
          <div>
            <p className="text-[13px] font-medium text-ink">Cleanup</p>
            <p className="text-[12px] text-ink-3 mt-0.5 leading-relaxed">
              Free up disk by removing dangling layers and (optionally) all images not currently in use.
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          {/* Dangling — safe */}
          <div className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-control bg-white/[0.02] border border-white/[0.04]">
            <div className="flex flex-col gap-0.5 min-w-0">
              <p className="text-[12px] text-ink-2">Free up dangling images</p>
              <p className="text-[11px] text-ink-3">
                Removes unreferenced layers left behind by past pulls. Always safe.
              </p>
            </div>
            <ActionButton
              variant="primary"
              busyLabel="Cleaning…"
              label={
                usage && usage.dangling_image_bytes > 0
                  ? `Free up ${formatBytes(usage.dangling_image_bytes)}`
                  : "No dangling images"
              }
              state={danglingAction}
              onClick={handleDangling}
              disabled={!!usage && usage.dangling_image_bytes === 0}
            />
          </div>

          {/* Unused — aggressive */}
          <div className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-control bg-white/[0.02] border border-white/[0.04]">
            <div className="flex flex-col gap-0.5 min-w-0">
              <p className="text-[12px] text-ink-2">Remove all unused images</p>
              <p className="text-[11px] text-ink-3">
                Aggressive — also drops images for stopped apps. They'll re-pull on next start.
              </p>
            </div>
            <ActionButton
              variant="danger"
              busyLabel="Removing…"
              label="Remove unused"
              state={unusedAction}
              onClick={handleUnused}
            />
          </div>
        </div>
      </div>

      {/* App logs */}
      <LogsCard />

      {/* Proxy upload limit */}
      <UploadLimitCard />

      {showImagesModal && (
        <DockerImagesModal
          onClose={() => setShowImagesModal(false)}
          onPruned={refresh}
        />
      )}
    </div>
  );
}

const UPLOAD_PRESETS_MB = [10, 50, 100, 250, 500] as const;

/**
 * Global default for Caddy's per-route `request_body` limit. Apps without a
 * per-app override inherit this; 0 = unlimited. Changing it re-syncs Caddy.
 */
function UploadLimitCard() {
  const [bytes, setBytes] = useState<number>(100 * 1024 * 1024);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    getDefaultMaxUploadBytes()
      .then((b) => {
        setBytes(b);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  async function choose(next: number) {
    setBytes(next);
    await setDefaultMaxUploadBytes(next);
  }

  const isUnlimited = bytes === 0;

  return (
    <div className="flex flex-col gap-4 p-5 rounded-card bg-surface-1 border border-subtle">
      <div className="flex items-start gap-4">
        <div className="w-9 h-9 rounded-card bg-accent-bg border border-[rgba(96,165,250,0.3)] flex items-center justify-center shrink-0">
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" className="text-accent">
            <path d="M10 13V4M10 4 6.5 7.5M10 4l3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M4 13v2.5h12V13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </div>
        <div>
          <p className="text-[13px] font-medium text-ink">Upload size limit</p>
          <p className="text-[12px] text-ink-3 mt-0.5 leading-relaxed">
            Default cap on request bodies the proxy forwards to an app — larger uploads get a 413.
            Individual apps can override this in their own settings.
          </p>
        </div>
      </div>

      <div>
        <p className="text-[11px] text-ink-3 mb-1.5">
          Default max upload{loaded ? ` · ${isUnlimited ? "unlimited" : formatBytes(bytes)}` : ""}
        </p>
        <div className="flex items-center gap-1.5 flex-wrap">
          {UPLOAD_PRESETS_MB.map((mb) => {
            const b = mb * 1024 * 1024;
            const active = bytes === b;
            return (
              <button
                key={mb}
                onClick={() => choose(b)}
                className={`px-2.5 py-1 text-[11px] rounded-control border transition-colors ${
                  active
                    ? "bg-accent-bg border-[rgba(96,165,250,0.3)] text-accent-ink"
                    : "bg-white/[0.04] border-subtle text-ink-2 hover:bg-white/[0.07]"
                }`}
              >
                {mb} MB
              </button>
            );
          })}
          <button
            onClick={() => choose(0)}
            className={`px-2.5 py-1 text-[11px] rounded-control border transition-colors ${
              isUnlimited
                ? "bg-accent-bg border-[rgba(96,165,250,0.3)] text-accent-ink"
                : "bg-white/[0.04] border-subtle text-ink-2 hover:bg-white/[0.07]"
            }`}
          >
            Unlimited
          </button>
        </div>
      </div>
    </div>
  );
}

const SIZE_PRESETS_MB = [1, 5, 10, 25, 50] as const;

function LogsCard() {
  const [usage, setUsage] = useState<LogsDiskUsage | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [maxBytes, setMaxBytesLocal] = useState<number>(5 * 1024 * 1024);
  const [rotateState, setRotateState] = useState<ActionState>("idle");
  const [clearState, setClearState] = useState<ActionState>("idle");
  const [lastFreed, setLastFreed] = useState<number>(0);

  async function refresh() {
    setLoadState("loading");
    try {
      const [u, m] = await Promise.all([appLogsDiskUsage(), getMaxLogBytes()]);
      setUsage(u);
      setMaxBytesLocal(m);
      setLoadState("ready");
    } catch {
      setLoadState("error");
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function handleRotate() {
    setRotateState("running");
    await yieldToFrame();
    try {
      const r = await rotateAppLogs();
      setLastFreed(r.bytes_freed);
      setRotateState("success");
      refresh();
    } catch {
      setRotateState("error");
    }
  }

  async function handleClearAll() {
    if (!window.confirm("Clear ALL app log files? This wipes runtime history for every app — useful when you just need disk back.")) return;
    setClearState("running");
    await yieldToFrame();
    try {
      const r = await clearAllAppLogs();
      setLastFreed(r.bytes_freed);
      setClearState("success");
      refresh();
    } catch {
      setClearState("error");
    }
  }

  async function handlePresetChange(mb: number) {
    const bytes = mb * 1024 * 1024;
    setMaxBytesLocal(bytes);
    await setMaxLogBytes(bytes);
  }

  const total = usage?.total_bytes ?? 0;
  const overCap = (usage?.per_app ?? []).filter((a) => a.bytes > maxBytes);

  return (
    <div className="flex flex-col gap-4 p-5 rounded-card bg-surface-1 border border-subtle">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          <div className="w-9 h-9 rounded-card bg-accent-bg border border-[rgba(96,165,250,0.3)] flex items-center justify-center shrink-0">
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" className="text-accent">
              <rect x="3" y="3" width="14" height="14" rx="2" stroke="currentColor" strokeWidth="1.5"/>
              <path d="M6 7h8M6 10h8M6 13h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </div>
          <div>
            <p className="text-[13px] font-medium text-ink">App logs</p>
            <p className="text-[12px] text-ink-3 mt-0.5 leading-relaxed">
              Per-app stdout/stderr lives in <span className="font-mono text-ink-2">~/.porta/logs/</span>. Porta auto-rotates oversized files every minute.
            </p>
          </div>
        </div>
        <button
          onClick={refresh}
          disabled={loadState === "loading"}
          className="text-[12px] text-ink-2 hover:text-ink disabled:opacity-50 transition-colors flex items-center gap-1.5 shrink-0"
        >
          {loadState === "loading" ? (
            <svg className="w-3 h-3 animate-spin" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.3" />
              <path d="M14 8a6 6 0 00-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M2 6a4 4 0 017-2.5M10 6a4 4 0 01-7 2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
              <path d="M9 1.5v2.5h-2.5M3 10.5v-2.5h2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          )}
          Refresh
        </button>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <div className="flex flex-col gap-0.5 px-3 py-2.5 rounded-control bg-white/[0.02] border border-white/[0.04]">
          <span className="text-[11px] uppercase tracking-wider text-ink-3">Total</span>
          <span className="text-[15px] text-ink font-medium font-mono">{formatBytes(total)}</span>
        </div>
        <div className="flex flex-col gap-0.5 px-3 py-2.5 rounded-control bg-white/[0.02] border border-white/[0.04]">
          <span className="text-[11px] uppercase tracking-wider text-ink-3">Files</span>
          <span className="text-[15px] text-ink font-medium font-mono">{usage?.per_app.length ?? 0}</span>
        </div>
        <div className="flex flex-col gap-0.5 px-3 py-2.5 rounded-control bg-white/[0.02] border border-white/[0.04]">
          <span className="text-[11px] uppercase tracking-wider text-ink-3">Over cap</span>
          <span className={`text-[15px] font-medium font-mono ${overCap.length > 0 ? "text-warn" : "text-ink"}`}>
            {overCap.length}
          </span>
        </div>
      </div>

      {/* Per-app size — top 5 by size */}
      {usage && usage.per_app.length > 0 && (
        <div className="flex flex-col gap-1">
          {usage.per_app.slice(0, 5).map((a) => {
            const over = a.bytes > maxBytes;
            return (
              <div key={a.app_id} className="flex items-center justify-between text-[11px] font-mono px-3 py-1.5 rounded bg-white/[0.02] border border-white/[0.04]">
                <span className="truncate text-ink-2">{a.app_id}</span>
                <span className={over ? "text-warn" : "text-ink-2"}>{formatBytes(a.bytes)}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* Cap selector */}
      <div>
        <p className="text-[11px] text-ink-3 mb-1.5">Max size per app log</p>
        <div className="flex items-center gap-1.5 flex-wrap">
          {SIZE_PRESETS_MB.map((mb) => {
            const bytes = mb * 1024 * 1024;
            const active = maxBytes === bytes;
            return (
              <button
                key={mb}
                onClick={() => handlePresetChange(mb)}
                className={`px-2.5 py-1 text-[11px] rounded-control border transition-colors ${
                  active
                    ? "bg-accent-bg border-[rgba(96,165,250,0.3)] text-accent-ink"
                    : "bg-white/[0.04] border-subtle text-ink-2 hover:bg-white/[0.07]"
                }`}
              >
                {mb} MB
              </button>
            );
          })}
        </div>
      </div>

      {/* Actions */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-control bg-white/[0.02] border border-white/[0.04]">
          <div className="flex flex-col gap-0.5 min-w-0">
            <p className="text-[12px] text-ink-2">Rotate now</p>
            <p className="text-[11px] text-ink-3">
              Trim every log file over the cap to its last {formatBytes(maxBytes)} (line-aligned).
            </p>
          </div>
          <SmallActionButton
            variant="primary"
            busyLabel="Rotating…"
            label={rotateState === "success" ? `Freed ${formatBytes(lastFreed)}` : "Rotate"}
            state={rotateState}
            onClick={handleRotate}
          />
        </div>

        <div className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-control bg-white/[0.02] border border-white/[0.04]">
          <div className="flex flex-col gap-0.5 min-w-0">
            <p className="text-[12px] text-ink-2">Clear all logs</p>
            <p className="text-[11px] text-ink-3">
              Wipes every log file. Running apps keep writing — files just start fresh.
            </p>
          </div>
          <SmallActionButton
            variant="danger"
            busyLabel="Clearing…"
            label={clearState === "success" ? `Freed ${formatBytes(lastFreed)}` : "Clear all"}
            state={clearState}
            onClick={handleClearAll}
          />
        </div>
      </div>
    </div>
  );
}

function SmallActionButton({
  label,
  busyLabel,
  state,
  onClick,
  variant,
}: {
  label: string;
  busyLabel: string;
  state: ActionState;
  onClick: () => void;
  variant: "primary" | "danger";
}) {
  const cls =
    variant === "primary"
      ? "bg-ok-bg hover:bg-[rgba(52,211,153,0.24)] text-ok border border-[rgba(52,211,153,0.3)]"
      : "bg-bad-bg hover:bg-[rgba(248,113,113,0.24)] text-bad border border-[rgba(248,113,113,0.3)]";
  return (
    <button
      onClick={onClick}
      disabled={state === "running"}
      className={`px-3 py-1.5 text-[12px] font-medium rounded-control transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 shrink-0 ${cls}`}
    >
      {state === "running" && (
        <svg className="w-3 h-3 animate-spin" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.3" />
          <path d="M14 8a6 6 0 00-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      )}
      {state === "running" ? busyLabel : label}
    </button>
  );
}

function UsageRow({
  label,
  section,
  onDetails,
}: {
  label: string;
  section?: { size_bytes: number; reclaimable_bytes: number; total_count: number; active_count: number };
  onDetails?: () => void;
}) {
  return (
    <div
      className={`flex flex-col gap-0.5 px-3 py-2.5 rounded-control bg-white/[0.02] border border-white/[0.04] ${onDetails ? "cursor-pointer hover:bg-white/[0.04] transition-colors group" : ""}`}
      onClick={onDetails}
    >
      <div className="flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-wider text-ink-3">{label}</span>
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-ink-3 font-mono">
            {section ? `${section.active_count}/${section.total_count}` : "—"}
          </span>
          {onDetails && (
            <span className="text-[10px] text-ink-3 group-hover:text-ink-2 transition-colors">Details →</span>
          )}
        </div>
      </div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[15px] text-ink font-medium font-mono">
          {section ? formatBytes(section.size_bytes) : "—"}
        </span>
        {section && section.reclaimable_bytes > 0 && (
          <span className="text-[11px] text-warn font-mono">
            {formatBytes(section.reclaimable_bytes)} reclaimable
          </span>
        )}
      </div>
    </div>
  );
}

function ActionButton({
  label,
  busyLabel,
  state,
  onClick,
  variant,
  disabled = false,
}: {
  label: string;
  busyLabel: string;
  state: ActionResult;
  onClick: () => void;
  variant: "primary" | "danger";
  disabled?: boolean;
}) {
  const baseClass =
    variant === "primary"
      ? "bg-ok-bg hover:bg-[rgba(52,211,153,0.24)] text-ok border border-[rgba(52,211,153,0.3)]"
      : "bg-bad-bg hover:bg-[rgba(248,113,113,0.24)] text-bad border border-[rgba(248,113,113,0.3)]";
  return (
    <div className="flex items-center gap-2 shrink-0">
      {state.state === "success" && state.result && (
        <span className="text-[11px] text-ok font-mono">
          Freed {formatBytes(state.result.freed_bytes)} ({state.result.removed_count})
        </span>
      )}
      {state.state === "error" && (
        <span className="text-[11px] text-bad">Failed</span>
      )}
      <button
        onClick={onClick}
        disabled={disabled || state.state === "running"}
        className={`px-3 py-1.5 text-[12px] font-medium rounded-control transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 ${baseClass}`}
      >
        {state.state === "running" && (
          <svg className="w-3 h-3 animate-spin" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.3" />
            <path d="M14 8a6 6 0 00-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        )}
        {state.state === "running" ? busyLabel : label}
      </button>
    </div>
  );
}
