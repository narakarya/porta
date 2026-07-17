import { lazy, Suspense, useMemo, useState } from "react";
import { usePortaStore } from "../../store";
import type { Service } from "../../types";
import { Button, Card, EmptyState, StatusDot, type Status } from "../ui";

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

const ServiceIcon = (
  <svg width="20" height="20" viewBox="0 0 16 16" fill="none">
    <ellipse cx="8" cy="4" rx="5" ry="2" stroke="currentColor" strokeWidth="1.3" />
    <path d="M3 4v8c0 1.1 2.24 2 5 2s5-.9 5-2V4M3 8c0 1.1 2.24 2 5 2s5-.9 5-2" stroke="currentColor" strokeWidth="1.3" />
  </svg>
);

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

  return (
    <div className="max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 mb-5">
        <div className="min-w-0">
          <h1 className="text-[17px] font-semibold text-ink leading-tight">Services</h1>
          <p className="text-[12px] text-ink-3 mt-0.5">
            {runningCount} running · {services.length} total
          </p>
        </div>
        <Button
          variant="primary"
          icon={PlusIcon}
          onClick={() => setShowAdd(true)}
          className="ml-auto shrink-0"
        >
          New Service
        </Button>
      </div>

      {services.length === 0 ? (
        <EmptyState
          icon={ServiceIcon}
          title="No services yet"
          hint="Run Postgres, Redis, MySQL and other Docker containers alongside your apps — Porta manages their lifecycle."
          action={
            <Button variant="primary" icon={PlusIcon} onClick={() => setShowAdd(true)}>
              New Service
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          {services.map((svc) => (
            <Card
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
              className="cursor-pointer hover:border-strong transition-colors duration-fast"
            >
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-medium text-ink truncate">{svc.name}</span>
                <StatusDot status={STATUS_MAP[svc.status]} className="ml-auto" />
              </div>
              <div className="mt-1.5 text-[11px] text-ink-3 font-mono truncate">
                {svc.image}:{svc.tag} · :{svc.port} · {scopeLabel(svc.scope)}
              </div>
              <div className="mt-3 flex">{actionButton(svc)}</div>
            </Card>
          ))}
        </div>
      )}

      <Suspense fallback={null}>
        {showAdd && <AddServiceModal defaultScope="global" onClose={() => setShowAdd(false)} />}
        {editing && <ServiceSettingsModal service={editing} onClose={() => setEditing(null)} />}
      </Suspense>
    </div>
  );
}
