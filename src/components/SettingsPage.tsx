import { useState } from "react";
import SetupWizard from "./SetupWizard";

type Section = "setup";

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

      {/* Content area */}
      <main className="flex-1 overflow-auto pt-10 px-8 pb-8 no-drag">
        {activeSection === "setup" && (
          <SetupSection onOpenWizard={() => setShowSetupWizard(true)} />
        )}
      </main>

      {showSetupWizard && (
        <SetupWizard forceShow onClose={() => setShowSetupWizard(false)} />
      )}
    </div>
  );
}

function SetupSection({ onOpenWizard }: { onOpenWizard: () => void }) {
  return (
    <div className="max-w-[520px] flex flex-col gap-6">
      <div>
        <h1 className="text-[16px] font-semibold text-zinc-100">Setup &amp; Certificates</h1>
        <p className="text-[12px] text-zinc-500 mt-1 leading-relaxed">
          Manage local infrastructure — Caddy reverse proxy, dnsmasq DNS resolver, and mkcert SSL certificates.
        </p>
      </div>

      {/* Card */}
      <div className="flex flex-col gap-4 p-5 rounded-xl bg-white/[0.03] border border-white/[0.07]">
        <div className="flex items-start gap-4">
          <div className="w-9 h-9 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center shrink-0">
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" className="text-blue-400">
              <path d="M10 2L3 6v4c0 3.5 3 6.7 7 8 4-1.3 7-4.5 7-8V6l-7-4z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
            </svg>
          </div>
          <div>
            <p className="text-[13px] font-medium text-zinc-200">Re-run Setup Wizard</p>
            <p className="text-[12px] text-zinc-500 mt-0.5 leading-relaxed">
              Installs or repairs Caddy, dnsmasq, and mkcert. Regenerates SSL wildcard certificates for all your workspace domains.
            </p>
          </div>
        </div>
        <button
          onClick={onOpenWizard}
          className="self-start px-4 py-2 text-[13px] font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors"
        >
          Open Setup Wizard
        </button>
      </div>

      {/* Info rows */}
      <div className="flex flex-col gap-2">
        <InfoRow label="Cert location" value="~/.porta/certs/test.pem" />
        <InfoRow label="Caddy admin" value="http://localhost:2019" />
        <InfoRow label="DNS resolver" value="/etc/resolver/test" />
      </div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-white/[0.02] border border-white/[0.04]">
      <span className="text-[12px] text-zinc-500">{label}</span>
      <span className="text-[12px] text-zinc-400 font-mono">{value}</span>
    </div>
  );
}
