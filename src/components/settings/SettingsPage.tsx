import { lazy, Suspense, useEffect, useState } from "react";
import SetupWizard from "../setup/SetupWizard";
import { usePortaStore } from "../../store";
import { useShallow } from "zustand/react/shallow";
import type { SettingsSection as Section } from "../../store/slices/ui";

// Code-split each section so the Settings page can paint the sidebar
// instantly. Without this, opening Settings forced a synchronous parse of
// every section's module + transitive deps (Codemirror, dialog plugin,
// xterm in Tailscale, etc.) and the user saw a macOS beachball cursor.
const SetupSection = lazy(() => import("./SetupSection"));
const NotificationsSection = lazy(() => import("./NotificationsSection"));
const GitSection = lazy(() => import("./GitSection"));
const BackupSection = lazy(() => import("./BackupSection"));
const CloudflareSection = lazy(() => import("./CloudflareSection"));
const TailscaleSection = lazy(() => import("./TailscaleSection"));
const RemoteSection = lazy(() => import("./RemoteSection"));
const DiskUsageSection = lazy(() => import("./DiskUsageSection"));
const ExtensionsSection = lazy(() => import("./ExtensionsSection"));
const AboutSection = lazy(() => import("./AboutSection"));

function SectionFallback() {
  return (
    <div className="flex flex-col gap-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-14 rounded-xl bg-white/[0.03] border border-white/[0.05] animate-pulse" style={{ animationDelay: `${i * 80}ms` }} />
      ))}
    </div>
  );
}


// Grouped nav — the flat 10-item list is bucketed into 4 labeled groups so
// the sidebar reads as a hierarchy instead of a long undifferentiated list.
// Items are text-only (no leading icons) per the settings redesign.
const NAV_GROUPS: { label: string; items: { id: Section; label: string }[] }[] = [
  {
    label: "General",
    items: [
      { id: "notifications", label: "Notifications" },
      { id: "git", label: "Git & defaults" },
      { id: "about", label: "About & updates" },
    ],
  },
  {
    label: "System",
    items: [
      { id: "setup", label: "Setup & dependencies" },
      { id: "disk", label: "Disk Usage" },
      { id: "extensions", label: "Extensions" },
    ],
  },
  {
    label: "Integrations",
    items: [
      { id: "cloudflare", label: "Cloudflare" },
      { id: "tailscale", label: "Tailscale" },
      { id: "remote", label: "Remote / VPS" },
    ],
  },
  {
    label: "Data",
    items: [
      { id: "backup", label: "Backup" },
    ],
  },
];

interface Props {
  onBack: () => void;
}

export default function SettingsPage({ onBack }: Props) {
  const { settingsSection, clearSettingsSection } = usePortaStore(
    useShallow((s) => ({
      settingsSection: s.settingsSection,
      clearSettingsSection: s.clearSettingsSection,
    }))
  );
  const [activeSection, setActiveSection] = useState<Section>("setup");
  useEffect(() => {
    if (settingsSection) {
      setActiveSection(settingsSection);
      clearSettingsSection();
    }
  }, [settingsSection, clearSettingsSection]);
  const [showSetupWizard, setShowSetupWizard] = useState(false);
  // Sections that have ever been visited stay mounted so re-clicking a nav
  // item is instant — fixes the lag on each Cloudflare click. Tabs not yet
  // visited remain un-mounted so we don't fire API calls (e.g. Tailscale
  // status, CF zones list) for sections the user hasn't asked for.
  const [visited, setVisited] = useState<Set<Section>>(() => new Set<Section>(["setup"]));
  useEffect(() => {
    setVisited((prev) => prev.has(activeSection) ? prev : new Set([...prev, activeSection]));
  }, [activeSection]);

  return (
    <div className="flex h-screen bg-[#0d0d0f] text-zinc-100 font-sans overflow-hidden">
      {/* Drag region */}
      <div className="drag-region fixed top-0 left-0 right-0 h-8 z-10 pointer-events-none" />

      {/* Settings sidebar */}
      <aside className="w-[172px] bg-[#1a1a1c] border-r border-white/[0.06] flex flex-col pt-8 pb-3 shrink-0">
        {/* Back button */}
        <div className="px-4 mb-4">
          <button
            onClick={onBack}
            className="flex items-center gap-1.5 text-[12px] text-zinc-500 hover:text-zinc-200 transition-colors"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M7.5 2L3.5 6l4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            Back
          </button>
        </div>

        <nav className="flex-1 flex flex-col px-2 overflow-auto no-drag">
          {NAV_GROUPS.map((group) => (
            <div key={group.label}>
              <div className="px-3 pt-2.5 pb-1 text-[10px] uppercase tracking-[0.04em] text-zinc-600">
                {group.label}
              </div>
              {group.items.map((item) => {
                const active = activeSection === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => setActiveSection(item.id)}
                    className={`block w-full text-left truncate px-2 py-[5px] rounded-[6px] text-[13px] transition-colors duration-100 ${
                      active
                        ? "bg-accent-bg text-zinc-100"
                        : "text-ink-2 hover:bg-white/[0.04]"
                    }`}
                  >
                    {item.label}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
      </aside>

      {/* Content area — every visited section stays mounted (just hidden
          via CSS when inactive) so clicking back to a section is instant.
          Tabs not yet visited remain un-mounted to avoid firing the
          section's effects (network calls, event subscriptions). */}
      <main className="flex-1 overflow-auto pt-10 px-8 pb-8 no-drag">
        <Suspense fallback={<SectionFallback />}>
          {visited.has("setup") && (
            <div hidden={activeSection !== "setup"}>
              <SetupSection onOpenWizard={() => setShowSetupWizard(true)} />
            </div>
          )}
          {visited.has("cloudflare") && (
            <div hidden={activeSection !== "cloudflare"}>
              <CloudflareSection />
            </div>
          )}
          {visited.has("tailscale") && (
            <div hidden={activeSection !== "tailscale"}>
              <TailscaleSection />
            </div>
          )}
          {visited.has("remote") && (
            <div hidden={activeSection !== "remote"}>
              <RemoteSection />
            </div>
          )}
          {visited.has("notifications") && (
            <div hidden={activeSection !== "notifications"}>
              <NotificationsSection />
            </div>
          )}
          {visited.has("git") && (
            <div hidden={activeSection !== "git"}>
              <GitSection />
            </div>
          )}
          {visited.has("backup") && (
            <div hidden={activeSection !== "backup"}>
              <BackupSection />
            </div>
          )}
          {visited.has("disk") && (
            <div hidden={activeSection !== "disk"}>
              <DiskUsageSection />
            </div>
          )}
          {visited.has("extensions") && (
            <div hidden={activeSection !== "extensions"}>
              <ExtensionsSection />
            </div>
          )}
          {visited.has("about") && (
            <div hidden={activeSection !== "about"}>
              <AboutSection />
            </div>
          )}
        </Suspense>
      </main>

      {showSetupWizard && (
        <SetupWizard forceShow onClose={() => setShowSetupWizard(false)} />
      )}
    </div>
  );
}
