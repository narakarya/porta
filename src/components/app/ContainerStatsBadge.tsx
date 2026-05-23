import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  containerStats,
  containersForApp,
  type ContainerInfo,
  type ContainerStats,
} from "../../lib/commands";
import { useFloatingPosition, useMeasuredSize } from "../shared/useFloatingPosition";

interface Props {
  appId: string;
  /** Whether the card is currently considered visible. Polling pauses when false. */
  active: boolean;
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export default function ContainerStatsBadge({ appId, active }: Props) {
  const [stats, setStats] = useState<ContainerStats | null>(null);
  const [containerName, setContainerName] = useState<string | null>(null);
  const [hover, setHover] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  // Resolve a container to poll. Use the first running container for the app.
  useEffect(() => {
    cancelledRef.current = false;
    if (!active) return;

    let cancelled = false;
    async function resolve() {
      try {
        const list: ContainerInfo[] = await containersForApp(appId);
        if (cancelled) return;
        const running = list.find((c) => c.state === "running") ?? list[0];
        setContainerName(running ? running.name : null);
        if (!running) setStats(null);
      } catch {
        if (!cancelled) setContainerName(null);
      }
    }
    resolve();
    const id = window.setInterval(resolve, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [appId, active]);

  // Poll stats every 3s while visible.
  useEffect(() => {
    if (!active || !containerName) {
      setStats(null);
      return;
    }
    let cancelled = false;
    async function tick() {
      try {
        const s = await containerStats(containerName!);
        if (!cancelled) {
          setStats(s);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    }
    tick();
    const id = window.setInterval(tick, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [containerName, active]);

  const triggerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelSize = useMeasuredSize(panelRef, hover);
  const coords = useFloatingPosition({
    triggerRef,
    panelSize,
    active: hover,
    side: "bottom",
    align: "start",
    gap: 4,
  });

  if (!containerName || !stats) return null;
  if (error) return null;

  const cpu = stats.cpu_pct.toFixed(1);
  const mem = stats.mem_pct.toFixed(1);

  return (
    <div
      ref={triggerRef}
      className="relative inline-flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity duration-150"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <span
        className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-blue-500/10 text-blue-300 border border-blue-500/20"
        title="CPU%"
      >
        {cpu}%
      </span>
      <span
        className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-emerald-500/10 text-emerald-300 border border-emerald-500/20"
        title="Memory%"
      >
        {mem}%
      </span>
      {hover && createPortal(
        <div
          ref={panelRef}
          className="fixed z-[60] w-56 rounded-md bg-zinc-900 border border-white/10 shadow-xl p-2 text-[11px] font-mono text-zinc-300 space-y-0.5 pointer-events-none"
          style={coords ? { top: coords.top, left: coords.left } : { top: -9999, left: -9999, visibility: "hidden" }}
        >
          <div className="text-zinc-500 truncate">{containerName}</div>
          <div className="flex justify-between">
            <span className="text-zinc-500">CPU</span>
            <span>{cpu}%</span>
          </div>
          <div className="flex justify-between">
            <span className="text-zinc-500">MEM</span>
            <span>
              {fmtBytes(stats.mem_usage_bytes)} / {fmtBytes(stats.mem_limit_bytes)} ({mem}%)
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-zinc-500">Net</span>
            <span>
              ↓ {fmtBytes(stats.net_rx_bytes)} · ↑ {fmtBytes(stats.net_tx_bytes)}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-zinc-500">Disk</span>
            <span>
              R {fmtBytes(stats.block_read_bytes)} · W {fmtBytes(stats.block_write_bytes)}
            </span>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
