import { useEffect, useState } from "react";
import ModalWrapper from "../shared/ModalWrapper";
import {
  listDockerImages,
  pruneDanglingImages,
  pruneUnusedImages,
  type DockerImageList,
  type ImageDetail,
  type PruneResult,
} from "../../lib/commands";
import { formatBytes, yieldToFrame } from "../../lib/ui";

type Tab = "dangling" | "unused" | "used";
type LoadState = "idle" | "loading" | "ready" | "error";
type ActionState = "idle" | "running" | "done";

interface Props {
  onClose: () => void;
  onPruned?: () => void;
}

export default function DockerImagesModal({ onClose, onPruned }: Props) {
  const [data, setData] = useState<DockerImageList | null>(null);
  const [load, setLoad] = useState<LoadState>("idle");
  const [tab, setTab] = useState<Tab>("dangling");
  const [danglingAction, setDanglingAction] = useState<ActionState>("idle");
  const [unusedAction, setUnusedAction] = useState<ActionState>("idle");
  const [pruneResult, setPruneResult] = useState<PruneResult | null>(null);

  async function refresh() {
    setLoad("loading");
    try {
      const d = await listDockerImages();
      setData(d);
      setLoad("ready");
    } catch {
      setLoad("error");
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function handlePruneDangling() {
    if (!window.confirm("Remove dangling images? These are unreferenced layers — safe to delete.")) return;
    setDanglingAction("running");
    await yieldToFrame();
    try {
      const r = await pruneDanglingImages();
      setPruneResult(r);
      setDanglingAction("done");
      onPruned?.();
      await refresh();
    } catch {
      setDanglingAction("idle");
    }
  }

  async function handlePruneUnused() {
    if (!window.confirm("Remove ALL unused images? Images not used by any container will be deleted.")) return;
    if (!window.confirm("Are you sure? This is more aggressive than dangling-only cleanup.")) return;
    setUnusedAction("running");
    await yieldToFrame();
    try {
      const r = await pruneUnusedImages();
      setPruneResult(r);
      setUnusedAction("done");
      onPruned?.();
      await refresh();
    } catch {
      setUnusedAction("idle");
    }
  }

  const rows: ImageDetail[] = data ? data[tab] : [];
  const totalCount = data ? data.dangling.length + data.unused.length + data.used.length : 0;

  return (
    <ModalWrapper onClose={onClose} className="bg-[#1a1a1c] border border-white/[0.08] rounded-2xl shadow-2xl w-[680px] max-h-[80vh] flex flex-col">
      {/* Header */}
      <div className="px-6 pt-5 pb-4 border-b border-white/[0.06] shrink-0">
        <div className="flex items-center justify-between pr-6">
          <div>
            <h2 className="text-[14px] font-semibold text-zinc-100">Docker Images</h2>
            <p className="text-[11px] text-zinc-500 mt-0.5">
              {load === "ready" ? `${totalCount} images across all projects` : "Loading…"}
            </p>
          </div>
          <button
            onClick={refresh}
            disabled={load === "loading"}
            className="text-[11px] text-zinc-500 hover:text-zinc-300 disabled:opacity-40 transition-colors flex items-center gap-1"
          >
            {load === "loading" ? (
              <svg className="w-3 h-3 animate-spin" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.3" />
                <path d="M14 8a6 6 0 00-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            ) : (
              <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                <path d="M2 6a4 4 0 017-2.5M10 6a4 4 0 01-7 2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
                <path d="M9 1.5v2.5h-2.5M3 10.5v-2.5h2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            )}
            Refresh
          </button>
        </div>

        {/* Summary chips */}
        {load === "ready" && data && (
          <div className="flex items-center gap-2 mt-3">
            <SummaryChip
              label="Dangling"
              count={data.dangling.length}
              bytes={data.dangling_bytes}
              color="amber"
              active={tab === "dangling"}
              onClick={() => setTab("dangling")}
            />
            <SummaryChip
              label="Unused"
              count={data.unused.length}
              bytes={data.unused_bytes}
              color="orange"
              active={tab === "unused"}
              onClick={() => setTab("unused")}
            />
            <SummaryChip
              label="Used"
              count={data.used.length}
              bytes={data.used_bytes}
              color="sky"
              active={tab === "used"}
              onClick={() => setTab("used")}
            />
          </div>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {load === "error" && (
          <div className="px-6 py-8 text-center text-[12px] text-red-400">
            Couldn't reach Docker. Make sure Docker Desktop / OrbStack is running.
          </div>
        )}

        {load === "loading" && (
          <div className="px-6 py-10 text-center text-[12px] text-zinc-500">Loading images…</div>
        )}

        {load === "ready" && rows.length === 0 && (
          <div className="px-6 py-10 text-center text-[12px] text-zinc-500">
            No {tab} images found.
          </div>
        )}

        {load === "ready" && rows.length > 0 && (
          <div className="flex flex-col">
            {/* Column header */}
            <div className="grid grid-cols-[1fr_80px_80px] gap-2 px-6 py-2 border-b border-white/[0.04]">
              <span className="text-[10px] uppercase tracking-wider text-zinc-600">Image</span>
              <span className="text-[10px] uppercase tracking-wider text-zinc-600 text-right">ID</span>
              <span className="text-[10px] uppercase tracking-wider text-zinc-600 text-right">Size</span>
            </div>
            {rows.map((img) => (
              <ImageRow key={`${img.id}-${img.tag}`} img={img} />
            ))}
          </div>
        )}
      </div>

      {/* Footer actions */}
      {load === "ready" && (
        <div className="px-6 py-4 border-t border-white/[0.06] flex items-center justify-between gap-4 shrink-0">
          <div className="text-[11px] text-zinc-500">
            {pruneResult && (
              <span className="text-emerald-400">
                Freed {formatBytes(pruneResult.freed_bytes)} — {pruneResult.removed_count} removed
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {(tab === "dangling" || tab === "unused") && tab === "dangling" && data && data.dangling.length > 0 && (
              <PruneButton
                label={`Free up ${formatBytes(data.dangling_bytes)}`}
                busyLabel="Pruning…"
                state={danglingAction}
                onClick={handlePruneDangling}
                variant="primary"
              />
            )}
            {tab === "unused" && data && data.unused.length > 0 && (
              <PruneButton
                label={`Remove ${data.unused.length} unused`}
                busyLabel="Removing…"
                state={unusedAction}
                onClick={handlePruneUnused}
                variant="danger"
              />
            )}
          </div>
        </div>
      )}
    </ModalWrapper>
  );
}

function ImageRow({ img }: { img: ImageDetail }) {
  const name = img.repository === "<none>" ? "<none>" : `${img.repository}`;
  const tagLabel = img.tag === "<none>" ? "" : `:${img.tag}`;
  const shortId = img.id.replace("sha256:", "").slice(0, 12);

  return (
    <div className="grid grid-cols-[1fr_80px_80px] gap-2 px-6 py-2 border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors items-center">
      <div className="min-w-0">
        <span className="text-[12px] font-mono text-zinc-300 truncate block">
          {name}<span className="text-zinc-500">{tagLabel}</span>
        </span>
      </div>
      <span className="text-[11px] font-mono text-zinc-600 text-right truncate">{shortId}</span>
      <span className="text-[12px] font-mono text-zinc-300 text-right">{formatBytes(img.size_bytes)}</span>
    </div>
  );
}

function SummaryChip({
  label,
  count,
  bytes,
  color,
  active,
  onClick,
}: {
  label: string;
  count: number;
  bytes: number;
  color: "amber" | "orange" | "sky";
  active: boolean;
  onClick: () => void;
}) {
  const colorMap = {
    amber: {
      active: "bg-amber-500/15 border-amber-500/30 text-amber-300",
      inactive: "bg-white/[0.03] border-white/[0.06] text-zinc-400 hover:bg-white/[0.06]",
      dot: "bg-amber-400",
    },
    orange: {
      active: "bg-orange-500/15 border-orange-500/30 text-orange-300",
      inactive: "bg-white/[0.03] border-white/[0.06] text-zinc-400 hover:bg-white/[0.06]",
      dot: "bg-orange-400",
    },
    sky: {
      active: "bg-sky-500/15 border-sky-500/30 text-sky-300",
      inactive: "bg-white/[0.03] border-white/[0.06] text-zinc-400 hover:bg-white/[0.06]",
      dot: "bg-sky-400",
    },
  };
  const c = colorMap[color];

  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-[12px] transition-colors ${active ? c.active : c.inactive}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${c.dot}`} />
      <span className="font-medium">{label}</span>
      <span className="font-mono opacity-70">{count} · {formatBytes(bytes)}</span>
    </button>
  );
}

function PruneButton({
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
      className={`px-3 py-1.5 text-[12px] font-medium rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 ${cls}`}
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
