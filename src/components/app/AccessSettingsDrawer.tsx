import { useEffect, useRef, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { GlobeHemisphereWest, X } from "@phosphor-icons/react";
import type { App, Workspace } from "../../types";
import AppSettingsModal from "./AppSettingsModal";

export type AccessSettingsSection = "domain" | "tunneling";

interface Props {
  app: App;
  workspace: Workspace | null;
  initialSection?: AccessSettingsSection;
  onClose: () => void;
}

/**
 * Persistent editing surface for everything that changes how an app is
 * reached. The Open popover stays optimized for quick actions; this drawer
 * owns the longer forms, validation, credentials, and save lifecycle.
 */
export default function AccessSettingsDrawer({
  app,
  workspace,
  initialSection = "domain",
  onClose,
}: Props) {
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const appRoot = document.getElementById("root");
    const wasInert = appRoot?.inert ?? false;
    if (appRoot) appRoot.inert = true;
    closeRef.current?.focus();
    return () => {
      if (appRoot) appRoot.inert = wasInert;
    };
  }, []);

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;

    const focusable = Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    ).filter((element) => !element.hidden);
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[70] flex justify-end">
      <div
        aria-hidden="true"
        onMouseDown={onClose}
        className="absolute inset-0 cursor-default bg-black/55 backdrop-blur-[1px]"
      />

      <section
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="access-settings-title"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className="relative flex h-full w-[min(900px,calc(100vw-3rem))] flex-col border-l border-subtle bg-surface-0 shadow-[-24px_0_64px_rgba(0,0,0,0.38)]"
      >
        <header className="flex h-[58px] shrink-0 items-center gap-3 border-b border-subtle px-5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] bg-accent-bg text-accent-ink">
            <GlobeHemisphereWest size={17} weight="regular" />
          </span>
          <div className="min-w-0">
            <h2 id="access-settings-title" className="text-[13px] font-medium text-ink">
              Routes & Access
            </h2>
            <p className="truncate text-[10px] text-ink-3">
              {app.name} · {workspace?.domain ?? `localhost:${app.port}`}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close routes and access settings"
            className="ml-auto rounded-control p-1.5 text-ink-3 transition-colors hover:bg-white/[0.04] hover:text-ink"
          >
            <X size={16} weight="regular" />
          </button>
        </header>

        <div className="min-h-0 flex-1">
          <AppSettingsModal
            embedded
            accessOnly
            app={app}
            workspace={workspace}
            initialSection={initialSection}
            onClose={onClose}
            onSaved={onClose}
          />
        </div>
      </section>
    </div>,
    document.body,
  );
}
