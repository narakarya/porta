import { useEffect, useRef, useState } from "react";
import { usePortaStore } from "../../store";
import {
  containerStats,
  containersForApp,
  type ContainerStats,
} from "../../lib/commands";
import type { App } from "../../types";

/** Samples kept per app — 60 × ~2s ≈ two minutes of history, memory only. */
const HISTORY = 60;

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

/** CPU history as a polyline, normalised against the row's own peak. */
function Sparkline({ points }: { points: number[] }) {
  if (points.length < 2) return <div className="h-4 w-16" />;
  const peak = Math.max(...points, 1);
  const step = 64 / (HISTORY - 1);
  const d = points
    .map((p, i) => `${(i * step).toFixed(1)},${(16 - (p / peak) * 15).toFixed(1)}`)
    .join(" ");
  return (
    <svg width="64" height="16" className="text-blue-400/70 shrink-0">
      <polyline points={d} fill="none" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

/** Docker/compose rows poll `docker stats`; process rows ride the existing
 *  `app:metrics:{id}` event, so they cost nothing extra. */
function DockerRow({ app, expanded, onToggle }: {
  app: App;
  expanded: boolean;
  onToggle: () => void;
}) {
  const [stats, setStats] = useState<ContainerStats | null>(null);
  const [name, setName] = useState<string | null>(null);
  const history = useRef<number[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function resolve() {
      try {
        const list = await containersForApp(app.id);
        if (cancelled) return;
        const running = list.find((c) => c.state === "running") ?? list[0];
        setName(running ? running.name : null);
      } catch {
        if (!cancelled) setName(null);
      }
    }
    resolve();
    const id = window.setInterval(resolve, 15000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [app.id]);

  useEffect(() => {
    if (!name) { setStats(null); return; }
    let cancelled = false;
    async function tick() {
      try {
        const s = await containerStats(name!);
        if (cancelled) return;
        history.current = [...history.current, s.cpu_pct].slice(-HISTORY);
        setStats(s);
      } catch { /* container died mid-poll; next tick re-resolves */ }
    }
    tick();
    const id = window.setInterval(tick, 3000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [name]);

  if (!stats) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-zinc-600">
        <span className="flex-1 truncate">{app.name}</span>
        <span className="font-mono">—</span>
      </div>
    );
  }

  return (
    <div className="border-b border-white/[0.04]">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-white/[0.03] transition-colors"
      >
        <span className="flex-1 truncate text-left text-[11px] text-zinc-300">{app.name}</span>
        <Sparkline points={history.current} />
        <span className="w-12 text-right text-[11px] font-mono text-blue-300 tabular-nums">
          {stats.cpu_pct.toFixed(1)}%
        </span>
        <span className="w-16 text-right text-[11px] font-mono text-emerald-300 tabular-nums">
          {fmtBytes(stats.mem_usage_bytes)}
        </span>
      </button>
      {expanded && (
        <div className="px-3 pb-2 space-y-0.5 text-[10px] font-mono text-zinc-500">
          <div className="flex justify-between">
            <span>Memory</span>
            <span>{fmtBytes(stats.mem_usage_bytes)} / {fmtBytes(stats.mem_limit_bytes)} ({stats.mem_pct.toFixed(1)}%)</span>
          </div>
          <div className="flex justify-between">
            <span>Net</span>
            <span>↓ {fmtBytes(stats.net_rx_bytes)} · ↑ {fmtBytes(stats.net_tx_bytes)}</span>
          </div>
          <div className="flex justify-between">
            <span>Disk</span>
            <span>R {fmtBytes(stats.block_read_bytes)} · W {fmtBytes(stats.block_write_bytes)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function ProcessRow({ app }: { app: App }) {
  const metrics = usePortaStore((s) => s.appMetrics[app.id]);
  const history = useRef<number[]>([]);

  useEffect(() => {
    if (metrics) history.current = [...history.current, metrics.cpu].slice(-HISTORY);
  }, [metrics]);

  if (!metrics) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 border-b border-white/[0.04] text-[11px] text-zinc-600">
        <span className="flex-1 truncate">{app.name}</span>
        <span className="font-mono">—</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 px-3 py-2 border-b border-white/[0.04]">
      <span className="flex-1 truncate text-[11px] text-zinc-300">{app.name}</span>
      <Sparkline points={history.current} />
      <span className="w-12 text-right text-[11px] font-mono text-blue-300 tabular-nums">
        {metrics.cpu.toFixed(1)}%
      </span>
      <span className="w-16 text-right text-[11px] font-mono text-emerald-300 tabular-nums">
        {metrics.mem_mb} MB
      </span>
    </div>
  );
}

export default function ResourceDrawer() {
  const open = usePortaStore((s) => s.resourceDrawerOpen);
  const toggle = usePortaStore((s) => s.toggleResourceDrawer);
  const apps = usePortaStore((s) => s.apps);
  const metrics = usePortaStore((s) => s.appMetrics);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") toggle();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, toggle]);

  // Unmount entirely when closed. Docker rows poll on mount, so this is what
  // actually stops the `docker stats` calls — not a CSS `hidden`.
  if (!open) return null;

  // Running first, then by CPU descending. Stopped apps sink to the bottom with
  // a dash, rather than vanishing — you want to see they exist.
  const sorted = [...apps].sort((a, b) => {
    const ra = a.status === "running" ? 1 : 0;
    const rb = b.status === "running" ? 1 : 0;
    if (ra !== rb) return rb - ra;
    return (metrics[b.id]?.cpu ?? 0) - (metrics[a.id]?.cpu ?? 0);
  });

  return (
    <aside className="fixed top-11 right-0 bottom-0 w-[380px] z-20 bg-[#141416] border-l border-white/[0.06] flex flex-col no-drag">
      <div className="flex items-center px-3 h-9 border-b border-white/[0.06] shrink-0">
        <h2 className="text-[11px] font-semibold text-zinc-300 flex-1">Resources</h2>
        <button
          onClick={toggle}
          className="text-zinc-600 hover:text-zinc-300 transition-colors"
          title="Close (Esc)"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
          </svg>
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {sorted.length === 0 && (
          <p className="px-3 py-4 text-[11px] text-zinc-600">No apps in this workspace.</p>
        )}
        {sorted.map((app) =>
          app.kind === "docker" || app.kind === "compose" ? (
            <DockerRow
              key={app.id}
              app={app}
              expanded={expanded === app.id}
              onToggle={() => setExpanded((e) => (e === app.id ? null : app.id))}
            />
          ) : (
            <ProcessRow key={app.id} app={app} />
          )
        )}
      </div>
    </aside>
  );
}
