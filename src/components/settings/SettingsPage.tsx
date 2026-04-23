import { useState } from "react";
import SetupWizard from "../setup/SetupWizard";
import SetupSection from "./SetupSection";
import NotificationsSection from "./NotificationsSection";
import BackupSection from "./BackupSection";
import SyncSection from "./SyncSection";
import TunnelsSection from "./TunnelsSection";
import TailscaleSection from "./TailscaleSection";

type Section = "setup" | "tunnels" | "tailscale" | "notifications" | "backup" | "sync";

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
    id: "tunnels",
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
    id: "backup",
    label: "Data & Backup",
    icon: (
      <svg width="13" height="13" viewBox="0 0 20 20" fill="none">
        <ellipse cx="10" cy="5" rx="7" ry="2.5" stroke="currentColor" strokeWidth="1.5"/>
        <path d="M3 5v5c0 1.38 3.13 2.5 7 2.5s7-1.12 7-2.5V5" stroke="currentColor" strokeWidth="1.5"/>
        <path d="M3 10v5c0 1.38 3.13 2.5 7 2.5s7-1.12 7-2.5v-5" stroke="currentColor" strokeWidth="1.5"/>
      </svg>
    ),
  },
  {
    id: "sync",
    label: "Sync",
    icon: (
      <svg width="13" height="13" viewBox="0 0 20 20" fill="none">
        <path d="M3 10a7 7 0 0112.9-3.8M17 10a7 7 0 01-12.9 3.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        <path d="M15 3v4h-4M5 17v-4h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    ),
  },
];

interface Props {
  onBack: () => void;
}

export default function SettingsPage({ onBack }: Props) {
  const [activeSection, setActiveSection] = useState<Section>("setup");
  const [showSetupWizard, setShowSetupWizard] = useState(false);

  return (
    <div className="flex h-screen bg-[#111113] text-zinc-100 font-sans overflow-hidden">
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

      {/* Content area — swaps immediately on nav click. Each section is
          responsible for its own internal loading/skeleton UI so the target
          container shows up right away. */}
      <main className="flex-1 overflow-auto pt-10 px-8 pb-8 no-drag">
        {activeSection === "setup" && (
          <SetupSection onOpenWizard={() => setShowSetupWizard(true)} />
        )}
        {activeSection === "tunnels" && <TunnelsSection />}
        {activeSection === "tailscale" && <TailscaleSection />}
        {activeSection === "notifications" && <NotificationsSection />}
        {activeSection === "backup" && <BackupSection />}
        {activeSection === "sync" && <SyncSection />}
      </main>

      {showSetupWizard && (
        <SetupWizard forceShow onClose={() => setShowSetupWizard(false)} />
      )}
    </div>
  );
}
