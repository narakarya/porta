import { useCallback, useEffect, useRef, useState } from "react";
import type { App } from "../../types";
import { usePortaStore } from "../../store";

const NODE_W = 180;
const NODE_H = 70;
const PADDING = 40;
const COL_GAP = 80;
const ROW_GAP = 48;
const COLS = 3;

type Pos = { x: number; y: number };

function initPositions(apps: App[]): Record<string, Pos> {
  const out: Record<string, Pos> = {};
  apps.forEach((app, i) => {
    out[app.id] = {
      x: PADDING + (i % COLS) * (NODE_W + COL_GAP),
      y: PADDING + Math.floor(i / COLS) * (NODE_H + ROW_GAP),
    };
  });
  return out;
}

function bezierD(from: Pos, to: Pos): string {
  const x1 = from.x + NODE_W;
  const y1 = from.y + NODE_H / 2;
  const x2 = to.x;
  const y2 = to.y + NODE_H / 2;
  const cx = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`;
}

interface Props {
  apps: App[];
  workspace?: unknown;
}

export default function CanvasView({ apps }: Props) {
  const updateApp = usePortaStore((s) => s.updateApp);
  const containerRef = useRef<HTMLDivElement>(null);

  // ── Source of truth for positions during drag — NO React state ─────────────
  // Initialized from grid layout; never triggers re-render during drag.
  const posRef = useRef<Record<string, Pos>>(initPositions(apps));

  // Keep a ref to latest apps so async callbacks don't use stale closures.
  const appsRef = useRef(apps);
  useEffect(() => { appsRef.current = apps; }, [apps]);

  // Trigger a single re-render to sync DOM after drag ends or app list changes.
  const [, tick] = useState(0);
  const commit = useCallback(() => tick((n) => n + 1), []);

  // ── DOM element refs — direct mutation, no re-render ──────────────────────
  const nodeRefs   = useRef<Record<string, HTMLDivElement>>({});
  const pathRefs   = useRef<Record<string, SVGPathElement>>({});
  const btnRefs    = useRef<Record<string, SVGGElement>>({});
  const draftRef   = useRef<SVGPathElement | null>(null);

  // ── Drag state (plain objects, not React state) ────────────────────────────
  const nodeDrag = useRef<{ id: string; ox: number; oy: number } | null>(null);
  const connectDrag = useRef<{ fromId: string } | null>(null);
  const hoverNodeId = useRef<string | null>(null);

  // React state only for connect-drag visibility (needs re-render to show port glow)
  const [connectingFromId, setConnectingFromId] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);

  // ── Sync positions when apps added / removed ──────────────────────────────
  const appIds = apps.map((a) => a.id).join(",");
  useEffect(() => {
    const pos = posRef.current;
    apps.forEach((app) => {
      if (!pos[app.id]) {
        const taken = Object.keys(pos).length;
        pos[app.id] = {
          x: PADDING + (taken % COLS) * (NODE_W + COL_GAP),
          y: PADDING + Math.floor(taken / COLS) * (NODE_H + ROW_GAP),
        };
      }
    });
    const ids = new Set(apps.map((a) => a.id));
    Object.keys(pos).forEach((id) => { if (!ids.has(id)) delete pos[id]; });
    commit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appIds]);

  // ── Direct DOM helpers (called during drag — zero React re-renders) ────────

  function applyNodePos(id: string, pos: Pos) {
    const el = nodeRefs.current[id];
    if (el) el.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
  }

  function updateArrowsForNode(movedId: string) {
    for (const app of appsRef.current) {
      for (const depId of app.depends_on ?? []) {
        if (depId !== movedId && app.id !== movedId) continue;
        const key = `${depId}-${app.id}`;
        const from = posRef.current[depId];
        const to   = posRef.current[app.id];
        if (!from || !to) continue;

        const path = pathRefs.current[key];
        if (path) path.setAttribute("d", bezierD(from, to));

        const btn = btnRefs.current[key];
        if (btn) {
          const mx = (from.x + NODE_W + to.x) / 2;
          const my = (from.y + NODE_H / 2 + to.y + NODE_H / 2) / 2;
          btn.setAttribute("transform", `translate(${mx},${my})`);
        }
      }
    }
  }

  // ── Node drag (Pointer Capture — stays hot even outside the element) ───────

  const onNodePointerDown = useCallback((e: React.PointerEvent, id: string) => {
    if ((e.target as HTMLElement).closest("[data-port]")) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const pos = posRef.current[id]!;
    nodeDrag.current = { id, ox: e.clientX - pos.x, oy: e.clientY - pos.y };
  }, []);

  const onNodePointerMove = useCallback((e: React.PointerEvent, id: string) => {
    if (!nodeDrag.current || nodeDrag.current.id !== id) return;
    const { ox, oy } = nodeDrag.current;
    const x = Math.max(0, e.clientX - ox);
    const y = Math.max(0, e.clientY - oy);
    posRef.current[id] = { x, y };
    // Direct DOM — NO setState, NO re-render
    applyNodePos(id, { x, y });
    updateArrowsForNode(id);
  }, []);

  const onNodePointerUp = useCallback(() => {
    if (!nodeDrag.current) return;
    nodeDrag.current = null;
    commit(); // single re-render to sync SVG canvas bounds
  }, [commit]);

  // ── Connect drag ───────────────────────────────────────────────────────────

  const onPortPointerDown = useCallback((e: React.PointerEvent, fromId: string) => {
    e.preventDefault();
    e.stopPropagation();
    connectDrag.current = { fromId };
    setConnectingFromId(fromId);
  }, []);

  const onContainerPointerMove = useCallback((e: React.PointerEvent) => {
    if (!connectDrag.current) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || !draftRef.current) return;
    const x  = e.clientX - rect.left;
    const y  = e.clientY - rect.top;
    const from = posRef.current[connectDrag.current.fromId];
    if (!from) return;
    const x1 = from.x + NODE_W;
    const y1 = from.y + NODE_H / 2;
    const cx = (x1 + x) / 2;
    // Direct SVG mutation — still zero re-renders
    draftRef.current.setAttribute(
      "d",
      `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y}, ${x} ${y}`
    );
  }, []);

  const onContainerPointerUp = useCallback(() => {
    if (connectDrag.current) {
      const fromId  = connectDrag.current.fromId;
      const targetId = hoverNodeId.current;
      if (targetId && targetId !== fromId) {
        const target = appsRef.current.find((a) => a.id === targetId);
        if (target && !(target.depends_on ?? []).includes(fromId)) {
          saveDepends(target, [...(target.depends_on ?? []), fromId]);
        }
      }
    }
    connectDrag.current = null;
    hoverNodeId.current = null;
    setConnectingFromId(null);
    setHighlightId(null);
    if (draftRef.current) draftRef.current.setAttribute("d", "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Dependency helpers ─────────────────────────────────────────────────────

  function saveDepends(app: App, depends_on: string[]) {
    updateApp({
      id: app.id,
      name: app.name,
      port: app.port,
      subdomain: app.subdomain,
      start_command: app.start_command,
      env_file: app.env_file,
      auto_start: app.auto_start,
      env_vars: app.env_vars,
      restart_policy: app.restart_policy,
      max_retries: app.max_retries,
      health_check_path: app.health_check_path,
      depends_on,
      extra_subdomains: app.extra_subdomains ?? [],
      custom_domain: app.custom_domain ?? null,
    });
  }

  function removeDependency(appId: string, depId: string) {
    const app = appsRef.current.find((a) => a.id === appId);
    if (!app) return;
    saveDepends(app, (app.depends_on ?? []).filter((d) => d !== depId));
  }

  // ── Canvas bounds (used for SVG + container height) ────────────────────────
  const maxX =
    apps.length === 0
      ? 400
      : Math.max(...apps.map((a) => (posRef.current[a.id]?.x ?? 0) + NODE_W)) + PADDING;
  const maxY =
    apps.length === 0
      ? 220
      : Math.max(...apps.map((a) => (posRef.current[a.id]?.y ?? 0) + NODE_H)) + PADDING;

  if (apps.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <p className="text-[13px] text-zinc-500">No apps to display</p>
        <p className="text-[12px] text-zinc-600 mt-1">Add apps to see them on the canvas</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[11px] text-zinc-600 select-none">
        Drag node to move &middot; Drag{" "}
        <span className="inline-block w-2 h-2 rounded-full border border-zinc-500 align-middle" />{" "}
        port to connect dependency
      </p>

      <div
        ref={containerRef}
        className="relative w-full overflow-auto rounded-lg border border-white/[0.06] bg-[#161618]"
        style={{ height: Math.max(maxY + 20, 220) }}
        onPointerMove={onContainerPointerMove}
        onPointerUp={onContainerPointerUp}
      >
        {/* ── SVG layer: arrows ────────────────────────────────────────────── */}
        <svg
          className="absolute inset-0 pointer-events-none"
          style={{ width: maxX, height: maxY }}
        >
          <defs>
            <marker id="cv-arr" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
              <path d="M0,0 L0,6 L8,3 z" fill="rgb(99 102 241)" opacity="0.7" />
            </marker>
            <marker id="cv-arr-draft" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
              <path d="M0,0 L0,6 L8,3 z" fill="rgb(99 102 241)" />
            </marker>
          </defs>

          {/* Committed dependency arrows */}
          {apps.flatMap((app) =>
            (app.depends_on ?? []).map((depId) => {
              const from = posRef.current[depId];
              const to   = posRef.current[app.id];
              if (!from || !to) return null;
              const key = `${depId}-${app.id}`;
              const mx  = (from.x + NODE_W + to.x) / 2;
              const my  = (from.y + NODE_H / 2 + to.y + NODE_H / 2) / 2;
              return (
                <g key={key} style={{ pointerEvents: "auto" }}>
                  <path
                    ref={(el) => { if (el) pathRefs.current[key] = el; }}
                    d={bezierD(from, to)}
                    stroke="rgb(99 102 241)"
                    strokeWidth="1.5"
                    fill="none"
                    opacity="0.6"
                    markerEnd="url(#cv-arr)"
                  />
                  {/* Remove × button at midpoint */}
                  <g
                    ref={(el) => { if (el) btnRefs.current[key] = el; }}
                    transform={`translate(${mx},${my})`}
                    onClick={() => removeDependency(app.id, depId)}
                    className="cursor-pointer"
                  >
                    <circle r="8" fill="#1c1c1e" stroke="rgb(99 102 241)" strokeWidth="1" opacity="0.9" />
                    <line x1="-3" y1="-3" x2="3" y2="3" stroke="#a1a1aa" strokeWidth="1.5" strokeLinecap="round" />
                    <line x1="3" y1="-3" x2="-3" y2="3" stroke="#a1a1aa" strokeWidth="1.5" strokeLinecap="round" />
                  </g>
                </g>
              );
            })
          )}

          {/* Draft line while connecting */}
          <path
            ref={(el) => { draftRef.current = el; }}
            d=""
            stroke="rgb(99 102 241)"
            strokeWidth="1.5"
            strokeDasharray="5 3"
            fill="none"
            markerEnd="url(#cv-arr-draft)"
          />
        </svg>

        {/* ── Node cards ───────────────────────────────────────────────────── */}
        {apps.map((app) => {
          const pos = posRef.current[app.id];
          if (!pos) return null;
          const isTarget = highlightId === app.id && connectingFromId !== app.id;

          return (
            <div
              key={app.id}
              ref={(el) => { if (el) nodeRefs.current[app.id] = el; }}
              className={`absolute top-0 left-0 rounded-lg p-3 select-none cursor-grab active:cursor-grabbing transition-[border-color,background-color] duration-100 ${
                isTarget
                  ? "bg-indigo-500/10 border border-indigo-500/40"
                  : "bg-[#1c1c1e] border border-white/[0.08] hover:border-white/[0.18]"
              }`}
              style={{
                width: NODE_W,
                height: NODE_H,
                transform: `translate(${pos.x}px, ${pos.y}px)`,
                willChange: "transform", // own GPU compositor layer
              }}
              onPointerDown={(e) => onNodePointerDown(e, app.id)}
              onPointerMove={(e) => onNodePointerMove(e, app.id)}
              onPointerUp={onNodePointerUp}
              onMouseEnter={() => {
                if (connectDrag.current) {
                  hoverNodeId.current = app.id;
                  setHighlightId(app.id);
                }
              }}
              onMouseLeave={() => {
                hoverNodeId.current = null;
                setHighlightId(null);
              }}
            >
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${
                    app.status === "running"
                      ? "bg-emerald-400"
                      : app.status === "starting"
                      ? "bg-amber-400 animate-pulse"
                      : "bg-zinc-600"
                  }`}
                />
                <span className="text-[12px] font-medium text-zinc-200 truncate">
                  {app.name}
                </span>
              </div>
              <div className="flex items-center justify-between mt-2">
                <span className="text-[11px] text-zinc-500 font-mono">:{app.port}</span>
                <span className="text-[10px] text-zinc-600 capitalize">{app.status}</span>
              </div>

              {/* Output port handle — right edge */}
              <div
                data-port="true"
                className={`absolute -right-[9px] top-1/2 -translate-y-1/2 w-[18px] h-[18px] rounded-full flex items-center justify-center cursor-crosshair z-10 transition-all duration-100 ${
                  connectingFromId === app.id
                    ? "bg-indigo-500 border-2 border-indigo-300 scale-125"
                    : "bg-[#1c1c1e] border-2 border-zinc-600 hover:border-indigo-400 hover:scale-110"
                }`}
                onPointerDown={(e) => onPortPointerDown(e, app.id)}
                title="Drag to connect dependency"
              />
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-3 text-[10px] text-zinc-600 select-none">
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-5 h-0.5 bg-indigo-500/60" />
          depends on
        </span>
        <span>· Click × on an arrow to remove</span>
      </div>
    </div>
  );
}
