import { useEffect, useRef } from "react";
import type { App, Workspace } from "../../types";
import HealthSection from "./HealthSection";
import DangerSection from "./sections/DangerSection";
import GeneralSection from "./config/GeneralSection";
import DomainSection from "./config/DomainSection";
import EnvironmentSection from "./config/EnvironmentSection";
import TunnelingSection from "./config/TunnelingSection";
import {
  useAppConfigDraft,
  AppConfigProvider,
  type Section,
} from "./config/AppConfigContext";

export type { Section };

interface Props {
  app: App;
  workspace: Workspace | null;
  onClose: () => void;
  // Called instead of onClose when the modal closes via a successful save.
  // Lets the parent show a confirmation toast without us threading a result
  // back through onClose's signature. Optional — falls back to onClose.
  onSaved?: () => void;
  // Rendered inline as the workbench "Config" tab (mockup 20) instead of a
  // full-screen modal: no fixed/backdrop/drag-region, fills the tab area. The
  // sidebar sub-nav (General/Domain/Environment/…) is kept — it already
  // matches the mockup. `onClose` then just switches back to another tab.
  embedded?: boolean;
  // Deep-link the sub-nav to a section on open (e.g. Publish tab → Tunneling).
  initialSection?: Section;
}
export default function AppSettingsModal({ app, workspace, onClose, onSaved, embedded = false, initialSection }: Props) {
  const draft = useAppConfigDraft(app, workspace, onClose, onSaved, initialSection);
  const {
    section, setSection,
    saving, saveError, savedAt,
    canSave,
    isDirty, requestClose,
    handleSave, handleDelete,
    isStatic, isProxy,
  } = draft;

  // Refs let the keyboard effect call the latest closures without re-binding
  // the listener on every render (handleSave/requestClose change every render
  // because their deps include all form state).
  const handleSaveRef = useRef<() => void>(() => {});
  const requestCloseRef = useRef<() => void>(() => {});
  handleSaveRef.current = handleSave;
  requestCloseRef.current = requestClose;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        requestCloseRef.current();
        return;
      }
      // Cmd+S / Ctrl+S → save without firing the browser's native save dialog
      if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        handleSaveRef.current();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const NAV: { id: Section; label: string }[] = [
    { id: "general",     label: "General" },
    { id: "domain",      label: "Domain" },
    ...((isStatic || isProxy) ? [] : [{ id: "environment" as Section, label: "Environment" }]),
    { id: "tunneling"   as Section, label: "Tunneling" },
    ...((isStatic || isProxy) ? [] : [{ id: "health" as Section, label: "Health" }]),
    { id: "danger",      label: "Danger" },
  ];

  return (
    <AppConfigProvider value={draft}>
    <div
      className={
        embedded
          ? "h-full w-full bg-surface-0 text-ink font-sans flex overflow-hidden"
          : "fixed inset-0 bg-surface-input text-ink font-sans flex h-screen overflow-hidden z-50"
      }
    >
      {/* Drag region — Back button in the sidebar handles dismissal; Esc still
          works via the global key handler. No top-right ✕ to avoid duplicating.
          Omitted when embedded — the workbench chrome owns the title bar. */}
      {!embedded && (
        <div className="drag-region fixed top-0 left-0 right-0 h-8 z-10 pointer-events-none" />
      )}

      {/* Sidebar */}
      <aside className={`w-[120px] bg-surface-2 border-r border-subtle flex flex-col pb-3 shrink-0 ${embedded ? "pt-3" : "pt-8"}`}>
        {!embedded && (
          <div className="px-4 mb-4">
            <button
              onClick={requestClose}
              className="flex items-center gap-1.5 text-[12px] text-ink-3 hover:text-ink transition-colors"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M7.5 2L3.5 6l4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              Back
            </button>
          </div>
        )}

        <div className="px-4 mb-1">
          <p className="text-[11px] font-semibold text-ink-3 uppercase tracking-widest truncate">
            {app.name}
          </p>
        </div>
        <div className="px-4 mb-3">
          <p className="text-[11px] text-ink-3 truncate">
            {workspace?.domain ?? "standalone"} · {app.kind === "static" ? "static" : `:${app.port}`}
          </p>
        </div>

        <nav className="flex-1 flex flex-col gap-0.5 px-2 overflow-auto no-drag">
          {NAV.map(({ id, label }) => {
            const active = section === id;
            return (
              <button
                key={id}
                onClick={() => setSection(id)}
                className={`flex items-center px-2 py-[5px] rounded-control text-[13px] w-full text-left transition-all duration-100 ${
                  active
                    ? id === "danger" ? "bg-bad-bg text-bad" : "bg-accent-bg text-accent-ink"
                    : id === "danger"
                    ? "text-bad hover:bg-bad-bg"
                    : "text-ink-2 hover:bg-white/[0.05] hover:text-ink"
                }`}
              >
                {label}
              </button>
            );
          })}
        </nav>
      </aside>

      {/* Content */}
      <main className="flex-1 flex flex-col no-drag overflow-hidden">
      <div className={`flex-1 overflow-auto px-8 pb-4 ${embedded ? "pt-5" : "pt-10"}`}>
        <div className="w-full flex flex-col gap-5">

          {section === "general" && <GeneralSection />}

          {section === "domain" && <DomainSection />}

          {section === "environment" && <EnvironmentSection />}

          {section === "tunneling" && <TunnelingSection />}

          {section === "health" && (
            <HealthSection
              appId={app.id}
              appPort={app.port}
              defaultPath={app.health_check_path ?? null}
            />
          )}

          {section === "danger" && (
            <DangerSection appName={app.name} onConfirmDelete={handleDelete} />
          )}
        </div>
      </div>

      {/* Sticky footer — replaces the per-section Save/Cancel rows. Hidden on
          Danger Zone since deletion has its own dedicated confirm flow. */}
      {section !== "danger" && section !== "health" && (
        <footer className="shrink-0 border-t border-subtle bg-surface-input px-8 py-3 flex items-center gap-2">
          {saveError && <p className="text-[11px] text-bad flex-1 truncate" title={saveError}>{saveError}</p>}
          {!saveError && isDirty && (
            <p className="text-[11px] text-warn flex-1">Unsaved changes</p>
          )}
          {!saveError && !isDirty && savedAt !== null && (
            <p className="text-[11px] text-ok flex-1 flex items-center gap-1.5">
              <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                <path d="M2.5 5.5l2.5 2.5L8.5 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Saved
            </p>
          )}
          <div className="flex gap-2 ml-auto">
            <button
              onClick={requestClose}
              className="px-4 py-2 text-[13px] text-ink-3 hover:text-ink rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={!canSave || saving || !isDirty}
              title={!isDirty ? "No changes to save" : undefined}
              className="px-4 py-2 text-[13px] font-medium bg-accent hover:brightness-110 text-white rounded-lg disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5"
            >
              {saving && (
                <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 16 16" fill="none">
                  <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.3" />
                  <path d="M14 8a6 6 0 00-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              )}
              {saving ? "Saving..." : "Save Changes"}
            </button>
          </div>
        </footer>
      )}
      </main>
    </div>
    </AppConfigProvider>
  );
}
