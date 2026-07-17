import { lazy, Suspense, useMemo, useState } from "react";
import { usePortaStore } from "../../store";
import type { Service } from "../../types";
import { Button, EmptyState, StatusDot, type Status } from "../ui";

// Modals are click-only surfaces — keep them out of the initial bundle.
const AddServiceModal = lazy(() => import("./AddServiceModal"));
const ServiceSettingsModal = lazy(() => import("./ServiceSettingsModal"));

// Service lifecycle → design-system status. Pull/start are both "in flight".
const STATUS_MAP: Record<Service["status"], Status> = {
  running: "running",
  pulling: "connecting",
  starting: "connecting",
  stopped: "stopped",
};

const PlusIcon = (
  <svg width="11" height="11" viewBox="0 0 10 10" fill="none">
    <path d="M5 2v6M2 5h6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
);

// ── Service-type glyphs ───────────────────────────────────────────────────────
// One shared component, sized per use (17px in card headers, 13px on template
// pills). Kind is derived from image/name — see `serviceIconKind`.
type IconKind = "database" | "bolt" | "broker";

function TypeIcon({ kind, size = 17 }: { kind: IconKind; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 16 16", fill: "none" as const };
  if (kind === "bolt") {
    return (
      <svg {...common}>
        <path
          d="M9 1.5 3.5 9H7l-.5 5.5L12.5 7H9l0-5.5Z"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (kind === "broker") {
    return (
      <svg {...common}>
        <rect x="2" y="3.5" width="12" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
        <path
          d="M2.5 4.5 8 8.5l5.5-4"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <ellipse cx="8" cy="4" rx="5" ry="2" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M3 4v8c0 1.1 2.24 2 5 2s5-.9 5-2V4M3 8c0 1.1 2.24 2 5 2s5-.9 5-2"
        stroke="currentColor"
        strokeWidth="1.3"
      />
    </svg>
  );
}

// postgres/mysql/mongo/mariadb → database, redis → bolt, rabbitmq/kafka →
// broker (envelope). Default is database.
function serviceIconKind(svc: Service): IconKind {
  const key = `${svc.image} ${svc.name}`.toLowerCase();
  if (key.includes("redis")) return "bolt";
  if (
    key.includes("rabbit") ||
    key.includes("kafka") ||
    key.includes("nats") ||
    key.includes("mqtt") ||
    key.includes("amqp")
  ) {
    return "broker";
  }
  return "database";
}

// Below-the-grid template picker → opens AddServiceModal (no preset pre-fill
// prop on the modal, so each pill just opens it).
const TEMPLATES: { label: string; kind: IconKind }[] = [
  { label: "PostgreSQL", kind: "database" },
  { label: "MySQL", kind: "database" },
  { label: "Redis", kind: "bolt" },
  { label: "MongoDB", kind: "database" },
  { label: "RabbitMQ", kind: "broker" },
];

/**
 * Standalone Services domain page (Shell C). Services moved out of the sidebar
 * into their own rail-domain content view: full-height, scrolls inside the
 * layout <main>. Rows open ServiceSettingsModal; per-row Start/Stop drives the
 * store lifecycle actions.
 */
export default function ServicesView() {
  // Select each slice member individually — `s.services` is a stable store
  // reference, so no useShallow / fresh-array selector is needed.
  const services = usePortaStore((s) => s.services);
  const workspaces = usePortaStore((s) => s.workspaces);
  const startService = usePortaStore((s) => s.startService);
  const stopService = usePortaStore((s) => s.stopService);

  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<Service | null>(null);

  const runningCount = useMemo(
    () => services.filter((s) => s.status === "running").length,
    [services],
  );

  const scopeLabel = (scope: Service["scope"]) =>
    scope === "global"
      ? "global"
      : workspaces.find((w) => w.id === scope)?.name ?? scope;

  function actionButton(svc: Service) {
    if (svc.status === "running") {
      return (
        <Button
          size="sm"
          variant="secondary"
          onClick={(e) => {
            e.stopPropagation();
            void stopService(svc.id);
          }}
        >
          Stop
        </Button>
      );
    }
    if (svc.status === "pulling" || svc.status === "starting") {
      return (
        <Button size="sm" variant="ghost" disabled>
          {svc.status === "pulling" ? "Pulling…" : "Starting…"}
        </Button>
      );
    }
    return (
      <Button
        size="sm"
        variant="primary"
        onClick={(e) => {
          e.stopPropagation();
          startService(svc.id);
        }}
      >
        Start
      </Button>
    );
  }

  // Secondary ghost pills — open the settings modal (no dedicated logs/connect
  // handler exists; settings is where those live).
  const pillCls =
    "border border-subtle text-ink-2 text-[11px] rounded-control px-2 py-1 hover:text-ink hover:border-strong transition-colors duration-fast";

  return (
    <div className="max-w-3xl mx-auto">
      {/* Header — compact inline row */}
      <div className="flex items-center gap-2 mb-4">
        <span className="text-[14px] font-medium text-ink">Services</span>
        <span className="text-[11px] text-ink-2">{runningCount} running</span>
        <button
          type="button"
          onClick={() => setShowAdd(true)}
          className="ml-auto inline-flex items-center gap-1 text-[11px] text-accent hover:brightness-110 transition-[filter] duration-fast"
        >
          {PlusIcon}
          Add service
        </button>
      </div>

      {services.length === 0 ? (
        <EmptyState
          icon={<TypeIcon kind="database" size={20} />}
          title="No services yet"
          hint="Run Postgres, Redis, MySQL and other Docker containers alongside your apps — Porta manages their lifecycle."
          action={
            <Button variant="primary" icon={PlusIcon} onClick={() => setShowAdd(true)}>
              New Service
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {services.map((svc) => (
            <div
              key={svc.id}
              role="button"
              tabIndex={0}
              onClick={() => setEditing(svc)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setEditing(svc);
                }
              }}
              className="border border-subtle rounded-[10px] px-[13px] py-[11px] cursor-pointer hover:border-strong transition-colors duration-fast"
            >
              <div className="flex items-center gap-2">
                <span className="text-ink-2 shrink-0">
                  <TypeIcon kind={serviceIconKind(svc)} size={17} />
                </span>
                <span className="text-[13px] font-medium text-ink truncate">{svc.name}</span>
                <StatusDot status={STATUS_MAP[svc.status]} className="ml-auto" />
              </div>
              <div className="mt-1.5 text-[11px] text-ink-3 font-mono truncate">
                {svc.tag} · :{svc.port} · {scopeLabel(svc.scope)}
              </div>
              <div className="mt-3 flex items-center gap-1.5">
                {actionButton(svc)}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditing(svc);
                  }}
                  className={pillCls}
                >
                  Logs
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditing(svc);
                  }}
                  className={pillCls}
                >
                  Connect
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add from template — always available, even at zero services */}
      <div className="mt-3 border border-subtle rounded-[10px] px-[13px] py-[11px]">
        <div className="text-[10px] uppercase tracking-wide text-ink-3 mb-2">Add from template</div>
        <div className="flex flex-wrap gap-2">
          {TEMPLATES.map((t) => (
            <button
              key={t.label}
              type="button"
              onClick={() => setShowAdd(true)}
              className="inline-flex items-center gap-1.5 text-[12px] text-ink-2 border border-subtle rounded-full px-3 py-1 hover:text-ink hover:border-strong transition-colors duration-fast"
            >
              <TypeIcon kind={t.kind} size={13} />
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <Suspense fallback={null}>
        {showAdd && <AddServiceModal defaultScope="global" onClose={() => setShowAdd(false)} />}
        {editing && <ServiceSettingsModal service={editing} onClose={() => setEditing(null)} />}
      </Suspense>
    </div>
  );
}
