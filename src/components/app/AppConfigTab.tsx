import { useEffect, useRef, useState } from "react";
import type { App, Workspace } from "../../types";
import { Button } from "../ui";
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

/**
 * An app's settings, as the workbench's Config tab.
 *
 * This was `AppSettingsModal`, and for a while it was three things at once: a
 * full-screen modal with its own sidebar and Back button (right-click →
 * Settings), a right-hand "Routes & Access" drawer (`accessOnly`), and this
 * tab. Same form, three shells, each reachable from somewhere different — so
 * the tab grew Routes and Tunnel sections that the other two never showed, and
 * which of the three you landed in depended on where you clicked. Now there is
 * one, and the file says so.
 */
interface Props {
  app: App;
  workspace: Workspace | null;
  /** Leave the tab (the workbench switches back to Overview). */
  onClose: () => void;
  // Called instead of onClose when the form closes via a successful save.
  // Lets the parent show a confirmation toast without us threading a result
  // back through onClose's signature. Optional — falls back to onClose.
  onSaved?: () => void;
  // Deep-link the sub-nav to a section on open (e.g. Publish tab → Tunneling).
  initialSection?: Section;
}

/**
 * Discarding every unsaved edit at once. Rather than hand-resetting the draft's
 * several dozen useStates — where one forgotten field silently survives a
 * "revert" — we remount the form. Its initial state is derived from the saved
 * `app`, so a remount *is* the revert, and it can't drift as fields are added.
 *
 * The sub-nav position is carried across the remount: reverting a typo should
 * not also throw the user back to the General tab.
 */
export default function AppConfigTab(props: Props) {
  const [resetSeq, setResetSeq] = useState(0);
  const lastSection = useRef<Section | undefined>(props.initialSection);
  return (
    <AppConfigForm
      key={resetSeq}
      {...props}
      initialSection={lastSection.current}
      onSectionChange={(s) => { lastSection.current = s; }}
      onRevertAll={() => setResetSeq((n) => n + 1)}
    />
  );
}

function AppConfigForm({
  app,
  workspace,
  onClose,
  onSaved,
  initialSection,
  onSectionChange,
  onRevertAll,
}: Props & { onSectionChange: (s: Section) => void; onRevertAll: () => void }) {
  // A deep link to "domain" or "tunneling" lands where it was aimed. It used
  // to be bounced to General unless you were in the access drawer, which is
  // what made the Publish tab's "Add a domain" link go nowhere useful.
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
  // Report the live sub-nav position up so a revert-remount can restore it.
  useEffect(() => { onSectionChange(section); }, [section, onSectionChange]);

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

  // Routes + Tunnel used to live ONLY in a separate access drawer, reachable
  // from the Open popover. So "change this app's domain" and "point it at a
  // named tunnel" sat somewhere else entirely from the rest of an app's
  // settings. They're sections like any other now.
  const NAV: { id: Section; label: string }[] = [
    { id: "general",     label: "General" },
    { id: "domain",      label: "Routes" },
    { id: "tunneling",   label: "Tunnel" },
    ...((isStatic || isProxy) ? [] : [{ id: "environment" as Section, label: "Environment" }]),
    ...((isStatic || isProxy) ? [] : [{ id: "health" as Section, label: "Health" }]),
    { id: "danger",      label: "Danger" },
  ];

  return (
    <AppConfigProvider value={draft}>
    <div className="h-full w-full bg-surface-0 text-ink font-sans flex flex-col overflow-hidden">
      {/* Horizontal sub-nav, matching every other workbench tab's.
          The vertical sidebar this replaced belonged to the standalone modal —
          inside a tab it was a second column re-stating the app name and domain
          that the workbench header already shows. */}
      <nav className="flex items-center gap-1 px-3.5 py-2 border-b border-subtle text-[12px] shrink-0 overflow-x-auto">
        {NAV.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => setSection(id)}
            className={`shrink-0 px-2.5 py-1 rounded-control transition-colors duration-fast ${
              section === id
                ? id === "danger" ? "bg-bad-bg text-bad" : "bg-accent-bg text-ink"
                : id === "danger"
                  ? "text-bad hover:bg-bad-bg"
                  : "text-ink-2 hover:bg-surface-1"
            }`}
          >
            {label}
          </button>
        ))}
        {/* Sits next to the section the edit was made in, which is why the
            footer doesn't repeat it. */}
        {isDirty && (
          <span className="ml-auto shrink-0 text-[11px] text-warn">Unsaved changes</span>
        )}
      </nav>

      <main className="flex-1 flex flex-col no-drag overflow-hidden min-h-0">
      {/* Matches the Overview tab's own gutter. */}
      <div className="flex-1 overflow-auto px-6 py-5">
        <div className="w-full flex flex-col gap-5 max-w-2xl">

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
        <footer className="shrink-0 border-t border-subtle bg-surface-0 px-6 py-2.5">
          <div className="max-w-2xl flex items-center gap-2">
          {saveError && <p className="text-[11px] text-bad flex-1 truncate" title={saveError}>{saveError}</p>}
          {!saveError && !isDirty && savedAt !== null && (
            <p className="text-[11px] text-ok flex-1 flex items-center gap-1.5">
              <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                <path d="M2.5 5.5l2.5 2.5L8.5 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Saved
            </p>
          )}
          <div className="flex gap-2 ml-auto">
            {isDirty && (
              <Button
                variant="ghost"
                onClick={onRevertAll}
                title="Discard every unsaved change on this app"
                icon={
                  <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                    <path d="M2.2 3.4A3.6 3.6 0 1 1 1.7 6.7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                    <path d="M1.7 1.8v1.9h1.9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                }
              >
                Revert
              </Button>
            )}
            {/* "Close" rather than "Cancel": this leaves for another tab, it
                doesn't undo anything. Revert is what discards. */}
            <Button variant="ghost" onClick={requestClose}>Close</Button>
            <Button
              variant="primary"
              onClick={handleSave}
              loading={saving}
              disabled={!canSave || saving || !isDirty}
              title={!isDirty ? "No changes to save" : undefined}
            >
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </div>
          </div>
        </footer>
      )}
      </main>
    </div>
    </AppConfigProvider>
  );
}
