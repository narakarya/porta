import { useEffect, useState } from "react";
import SetupWizard from "../setup/SetupWizard";
import CloudflareSection from "./CloudflareSection";
import TailscaleSection from "./TailscaleSection";

interface Props {
  onClose: () => void;
}

type Section = "setup" | "cloudflare" | "tailscale";

export default function SettingsModal({ onClose }: Props) {
  const [showSetup, setShowSetup] = useState(false);
  const [section, setSection] = useState<Section>("setup");

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (showSetup) {
    return <SetupWizard forceShow onClose={() => setShowSetup(false)} />;
  }

  const NAV: { id: Section; label: string }[] = [
    { id: "setup", label: "Setup" },
    { id: "cloudflare", label: "Cloudflare" },
    { id: "tailscale", label: "Tailscale" },
  ];

  return (
    <div
      className="fixed inset-0 bg-[#111113]/90 backdrop-blur-sm flex items-center justify-center z-50"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-surface-2 border border-subtle rounded-card w-[720px] max-h-[85vh] shadow-2xl flex overflow-hidden">
        {/* Sidebar */}
        <aside className="w-[160px] shrink-0 bg-surface-2 border-r border-subtle flex flex-col py-4 px-2">
          <p className="px-3 mb-2 text-[10px] font-medium text-ink-3 uppercase tracking-widest">Settings</p>
          {NAV.map((n) => (
            <button
              key={n.id}
              onClick={() => setSection(n.id)}
              className={`text-left px-3 py-1.5 text-[12px] rounded-control transition-colors ${
                section === n.id ? "bg-white/[0.08] text-ink" : "text-ink-3 hover:text-ink-2 hover:bg-white/[0.04]"
              }`}
            >
              {n.label}
            </button>
          ))}
        </aside>

        {/* Main */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex items-center justify-between px-5 py-4 border-b border-subtle">
            <h2 className="text-[14px] font-semibold text-ink capitalize">{section}</h2>
            <button onClick={onClose} className="text-ink-3 hover:text-ink-2 transition-colors">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-5 py-5">
            {section === "setup" && (
              <div className="flex items-start gap-3 px-3 py-3 rounded-card bg-surface-1 border border-subtle">
                <div className="w-8 h-8 rounded-control bg-accent-bg border border-[rgba(96,165,250,0.2)] flex items-center justify-center shrink-0 mt-0.5">
                  <svg width="14" height="14" viewBox="0 0 20 20" fill="none" className="text-accent-ink">
                    <path d="M10 2L3 6v4c0 3.5 3 6.7 7 8 4-1.3 7-4.5 7-8V6l-7-4z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] font-medium text-ink">Caddy, dnsmasq &amp; SSL</p>
                  <p className="text-[11px] text-ink-3 mt-0.5 leading-relaxed">
                    Re-run setup to install missing dependencies, regenerate SSL certificates, or restart Caddy.
                  </p>
                  <button
                    onClick={() => setShowSetup(true)}
                    className="mt-2.5 px-3 py-1.5 text-[12px] font-medium bg-accent hover:opacity-90 text-white rounded-control transition-colors"
                  >
                    Open Setup Wizard
                  </button>
                </div>
              </div>
            )}
            {section === "cloudflare" && <CloudflareSection />}
            {section === "tailscale" && <TailscaleSection />}
          </div>
        </div>
      </div>
    </div>
  );
}
