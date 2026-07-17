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


const NAV: { id: Section; label: string; icon: React.ReactNode }[] = [
  {
    id: "setup",
    label: "Setup & Certificates",
    icon: (
      <svg width="13" height="13" viewBox="0 0 20 20" fill="none">
        <path d="M10 2L3 6v4c0 3.5 3 6.7 7 8 4-1.3 7-4.5 7-8V6l-7-4z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
      </svg>
    ),
  },
  {
    id: "cloudflare",
    label: "Cloudflare",
    icon: (
      <svg width="13" height="13" viewBox="0 0 20 20" fill="none">
        <ellipse cx="10" cy="10" rx="8" ry="4" stroke="currentColor" strokeWidth="1.5"/>
        <ellipse cx="10" cy="10" rx="3" ry="8" stroke="currentColor" strokeWidth="1.5"/>
      </svg>
    ),
  },
  {
    id: "tailscale",
    label: "Tailscale",
    icon: (
      <svg width="13" height="13" viewBox="0 0 20 20" fill="none">
        <circle cx="5" cy="5" r="1.5" fill="currentColor"/>
        <circle cx="10" cy="5" r="1.5" fill="currentColor"/>
        <circle cx="15" cy="5" r="1.5" fill="currentColor"/>
        <circle cx="5" cy="10" r="1.5" fill="currentColor"/>
        <circle cx="10" cy="10" r="1.5" fill="currentColor"/>
        <circle cx="15" cy="10" r="1.5" fill="currentColor"/>
        <circle cx="5" cy="15" r="1.5" fill="currentColor"/>
        <circle cx="10" cy="15" r="1.5" fill="currentColor"/>
        <circle cx="15" cy="15" r="1.5" fill="currentColor"/>
      </svg>
    ),
  },
  {
    id: "remote",
    label: "Remote Servers",
    icon: (
      <svg width="13" height="13" viewBox="0 0 20 20" fill="none">
        <rect x="3" y="4" width="14" height="5" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
        <rect x="3" y="11" width="14" height="5" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
        <circle cx="6" cy="6.5" r="0.8" fill="currentColor"/>
        <circle cx="6" cy="13.5" r="0.8" fill="currentColor"/>
      </svg>
    ),
  },
  {
    id: "notifications",
    label: "Notifications",
    icon: (
      <svg width="13" height="13" viewBox="0 0 20 20" fill="none">
        <path d="M10 2.5C7 2.5 4.5 5 4.5 8v5l-1.5 2h14l-1.5-2V8C15.5 5 13 2.5 10 2.5z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
        <path d="M8 15.5a2 2 0 004 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      </svg>
    ),
  },
  {
    id: "git",
    label: "Git",
    icon: (
      <svg width="13" height="13" viewBox="0 0 20 20" fill="none">
        <circle cx="6" cy="5" r="2" stroke="currentColor" strokeWidth="1.5"/>
        <circle cx="6" cy="15" r="2" stroke="currentColor" strokeWidth="1.5"/>
        <circle cx="14" cy="10" r="2" stroke="currentColor" strokeWidth="1.5"/>
        <path d="M6 7v6M8 15h1a3 3 0 003-3v0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      </svg>
    ),
  },
  {
    id: "backup",
    label: "Backup",
    icon: (
      <svg width="13" height="13" viewBox="0 0 20 20" fill="none">
        <ellipse cx="10" cy="5" rx="7" ry="2.5" stroke="currentColor" strokeWidth="1.5"/>
        <path d="M3 5v5c0 1.38 3.13 2.5 7 2.5s7-1.12 7-2.5V5" stroke="currentColor" strokeWidth="1.5"/>
        <path d="M3 10v5c0 1.38 3.13 2.5 7 2.5s7-1.12 7-2.5v-5" stroke="currentColor" strokeWidth="1.5"/>
      </svg>
    ),
  },
  {
    id: "disk",
    label: "Disk Usage",
    icon: (
      <svg width="13" height="13" viewBox="0 0 20 20" fill="none">
        <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.5"/>
        <circle cx="10" cy="10" r="2" stroke="currentColor" strokeWidth="1.5"/>
        <path d="M10 3v3M10 14v3M3 10h3M14 10h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      </svg>
    ),
  },
  {
    id: "extensions",
    label: "Extensions",
    icon: (
      <svg width="13" height="13" viewBox="0 0 20 20" fill="none">
        <path d="M8 3h4v2c0 1.1.9 2 2 2s2-.9 2-2V3h2a1 1 0 011 1v2.5h-2c-1.1 0-2 .9-2 2s.9 2 2 2H19V13a1 1 0 01-1 1h-2v-2c0-1.1-.9-2-2-2s-2 .9-2 2v2H9a1 1 0 01-1-1v-2.5h2c1.1 0 2-.9 2-2s-.9-2-2-2H8V4a1 1 0 011-1z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
      </svg>
    ),
  },
  {
    id: "about",
    label: "About",
    icon: (
      <svg width="13" height="13" viewBox="0 0 20 20" fill="none">
        <circle cx="10" cy="10" r="7.5" stroke="currentColor" strokeWidth="1.5"/>
        <path d="M10 9v4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        <circle cx="10" cy="6.5" r="0.5" fill="currentColor" stroke="currentColor" strokeWidth="0.6"/>
      </svg>
    ),
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
      <aside className="w-[200px] bg-[#1a1a1c] border-r border-white/[0.06] flex flex-col pt-8 pb-3 shrink-0">
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

        <div className="px-4 mb-3">
          <span className="text-[11px] font-semibold text-zinc-500 uppercase tracking-widest">
            Settings
          </span>
        </div>

        <nav className="flex-1 flex flex-col gap-0.5 px-2 overflow-auto no-drag">
          {NAV.map((item) => {
            const active = activeSection === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setActiveSection(item.id)}
                className={`flex items-center gap-2.5 px-2 py-1.5 rounded-[6px] text-[13px] w-full text-left transition-all duration-100 ${
                  active
                    ? "bg-white/10 text-zinc-100"
                    : "text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-200"
                }`}
              >
                <span className={active ? "text-zinc-300" : "text-zinc-600"}>
                  {item.icon}
                </span>
                <span className="flex-1 truncate">{item.label}</span>
              </button>
            );
          })}
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
