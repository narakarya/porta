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
        <h1 className="text-[16px] font-semibold text-zinc-100">Docker Disk Usage</h1>
        <p className="text-[12px] text-zinc-500 mt-1 leading-relaxed">
          Track how much disk Docker is using and reclaim space from unused images, stopped containers, and build cache.
        </p>
      </div>

      {/* System totals */}
      <div className="flex flex-col gap-4 p-5 rounded-xl bg-white/[0.03] border border-white/[0.07]">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className="w-9 h-9 rounded-xl bg-sky-500/10 border border-sky-500/20 flex items-center justify-center shrink-0">
              <svg width="16" height="16" viewBox="0 0 20 20" fill="none" className="text-sky-400">
                <ellipse cx="10" cy="5" rx="7" ry="2.5" stroke="currentColor" strokeWidth="1.5"/>
                <path d="M3 5v5c0 1.38 3.13 2.5 7 2.5s7-1.12 7-2.5V5" stroke="currentColor" strokeWidth="1.5"/>
                <path d="M3 10v5c0 1.38 3.13 2.5 7 2.5s7-1.12 7-2.5v-5" stroke="currentColor" strokeWidth="1.5"/>
              </svg>
            </div>
            <div>
              <p className="text-[13px] font-medium text-zinc-200">System Totals</p>
              <p className="text-[12px] text-zinc-500 mt-0.5 leading-relaxed">
                Disk used by all of Docker — across every project on this machine, not just Porta-managed apps.
              </p>
            </div>
          </div>
          <button
            onClick={refresh}
            disabled={load === "loading"}
            className="text-[12px] text-zinc-400 hover:text-zinc-200 disabled:opacity-50 transition-colors flex items-center gap-1.5 shrink-0"
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
          <p className="text-[12px] text-red-400">
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
            <span className="text-zinc-500">Reclaimable across all sections:</span>
            <span className="text-amber-400 font-medium font-mono">{formatBytes(reclaimable)}</span>
          </div>
        )}
      </div>

      {/* Cleanup actions */}
      <div className="flex flex-col gap-4 p-5 rounded-xl bg-white/[0.03] border border-white/[0.07]">
        <div className="flex items-start gap-4">
          <div className="w-9 h-9 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center shrink-0">
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" className="text-amber-400">
              <path d="M5 6h10l-1 10a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
              <path d="M3 6h14M8 3h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </div>
          <div>
            <p className="text-[13px] font-medium text-zinc-200">Cleanup</p>
            <p className="text-[12px] text-zinc-500 mt-0.5 leading-relaxed">
              Free up disk by removing dangling layers and (optionally) all images not currently in use.
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          {/* Dangling — safe */}
          <div className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg bg-white/[0.02] border border-white/[0.04]">
            <div className="flex flex-col gap-0.5 min-w-0">
              <p className="text-[12px] text-zinc-300">Free up dangling images</p>
              <p className="text-[11px] text-zinc-600">
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
          <div className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg bg-white/[0.02] border border-white/[0.04]">
            <div className="flex flex-col gap-0.5 min-w-0">
              <p className="text-[12px] text-zinc-300">Remove all unused images</p>
              <p className="text-[11px] text-zinc-600">
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

      {showImagesModal && (
        <DockerImagesModal
          onClose={() => setShowImagesModal(false)}
          onPruned={refresh}
        />
      )}
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
    <div className="flex flex-col gap-4 p-5 rounded-xl bg-white/[0.03] border border-white/[0.07]">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          <div className="w-9 h-9 rounded-xl bg-violet-500/10 border border-violet-500/20 flex items-center justify-center shrink-0">
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" className="text-violet-400">
              <rect x="3" y="3" width="14" height="14" rx="2" stroke="currentColor" strokeWidth="1.5"/>
              <path d="M6 7h8M6 10h8M6 13h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </div>
          <div>
            <p className="text-[13px] font-medium text-zinc-200">App logs</p>
            <p className="text-[12px] text-zinc-500 mt-0.5 leading-relaxed">
              Per-app stdout/stderr lives in <span className="font-mono text-zinc-400">~/.porta/logs/</span>. Porta auto-rotates oversized files every minute.
            </p>
          </div>
        </div>
        <button
          onClick={refresh}
          disabled={loadState === "loading"}
          className="text-[12px] text-zinc-400 hover:text-zinc-200 disabled:opacity-50 transition-colors flex items-center gap-1.5 shrink-0"
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
        <div className="flex flex-col gap-0.5 px-3 py-2.5 rounded-lg bg-white/[0.02] border border-white/[0.04]">
          <span className="text-[11px] uppercase tracking-wider text-zinc-500">Total</span>
          <span className="text-[15px] text-zinc-100 font-medium font-mono">{formatBytes(total)}</span>
        </div>
        <div className="flex flex-col gap-0.5 px-3 py-2.5 rounded-lg bg-white/[0.02] border border-white/[0.04]">
          <span className="text-[11px] uppercase tracking-wider text-zinc-500">Files</span>
          <span className="text-[15px] text-zinc-100 font-medium font-mono">{usage?.per_app.length ?? 0}</span>
        </div>
        <div className="flex flex-col gap-0.5 px-3 py-2.5 rounded-lg bg-white/[0.02] border border-white/[0.04]">
          <span className="text-[11px] uppercase tracking-wider text-zinc-500">Over cap</span>
          <span className={`text-[15px] font-medium font-mono ${overCap.length > 0 ? "text-amber-400" : "text-zinc-100"}`}>
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
                <span className="truncate text-zinc-400">{a.app_id}</span>
                <span className={over ? "text-amber-400" : "text-zinc-300"}>{formatBytes(a.bytes)}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* Cap selector */}
      <div>
        <p className="text-[11px] text-zinc-500 mb-1.5">Max size per app log</p>
        <div className="flex items-center gap-1.5 flex-wrap">
          {SIZE_PRESETS_MB.map((mb) => {
            const bytes = mb * 1024 * 1024;
            const active = maxBytes === bytes;
            return (
              <button
                key={mb}
                onClick={() => handlePresetChange(mb)}
                className={`px-2.5 py-1 text-[11px] rounded-md border transition-colors ${
                  active
                    ? "bg-blue-500/15 border-blue-500/30 text-blue-300"
                    : "bg-white/[0.04] border-white/[0.08] text-zinc-400 hover:bg-white/[0.07]"
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
        <div className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg bg-white/[0.02] border border-white/[0.04]">
          <div className="flex flex-col gap-0.5 min-w-0">
            <p className="text-[12px] text-zinc-300">Rotate now</p>
            <p className="text-[11px] text-zinc-600">
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

        <div className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg bg-white/[0.02] border border-white/[0.04]">
          <div className="flex flex-col gap-0.5 min-w-0">
            <p className="text-[12px] text-zinc-300">Clear all logs</p>
            <p className="text-[11px] text-zinc-600">
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
      ? "bg-emerald-700 hover:bg-emerald-600 text-white"
      : "bg-red-900/60 hover:bg-red-800/70 text-red-100 border border-red-700/40";
  return (
    <button
      onClick={onClick}
      disabled={state === "running"}
      className={`px-3 py-1.5 text-[12px] font-medium rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 shrink-0 ${cls}`}
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
      className={`flex flex-col gap-0.5 px-3 py-2.5 rounded-lg bg-white/[0.02] border border-white/[0.04] ${onDetails ? "cursor-pointer hover:bg-white/[0.04] transition-colors group" : ""}`}
      onClick={onDetails}
    >
      <div className="flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-wider text-zinc-500">{label}</span>
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-zinc-600 font-mono">
            {section ? `${section.active_count}/${section.total_count}` : "—"}
          </span>
          {onDetails && (
            <span className="text-[10px] text-zinc-600 group-hover:text-zinc-400 transition-colors">Details →</span>
          )}
        </div>
      </div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[15px] text-zinc-100 font-medium font-mono">
          {section ? formatBytes(section.size_bytes) : "—"}
        </span>
        {section && section.reclaimable_bytes > 0 && (
          <span className="text-[11px] text-amber-400 font-mono">
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
      ? "bg-emerald-700 hover:bg-emerald-600 text-white"
      : "bg-red-900/60 hover:bg-red-800/70 text-red-100 border border-red-700/40";
  return (
    <div className="flex items-center gap-2 shrink-0">
      {state.state === "success" && state.result && (
        <span className="text-[11px] text-emerald-400 font-mono">
          Freed {formatBytes(state.result.freed_bytes)} ({state.result.removed_count})
        </span>
      )}
      {state.state === "error" && (
        <span className="text-[11px] text-red-400">Failed</span>
      )}
      <button
        onClick={onClick}
        disabled={disabled || state.state === "running"}
        className={`px-3 py-1.5 text-[12px] font-medium rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 ${baseClass}`}
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
