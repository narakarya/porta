import { useEffect, useState } from "react";
import SetupWizard from "../setup/SetupWizard";
import TunnelsSection from "./TunnelsSection";
import TailscaleSection from "./TailscaleSection";

interface Props {
  onClose: () => void;
}

type Section = "setup" | "tunnels" | "tailscale";

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
    { id: "tunnels", label: "Cloudflare" },
    { id: "tailscale", label: "Tailscale" },
  ];

  return (
    <div
      className="fixed inset-0 bg-[#111113]/90 backdrop-blur-sm flex items-center justify-center z-50"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-[#1c1c1e] border border-white/[0.08] rounded-2xl w-[720px] max-h-[85vh] shadow-2xl flex overflow-hidden">
        {/* Sidebar */}
        <aside className="w-[160px] shrink-0 bg-[#1a1a1c] border-r border-white/[0.06] flex flex-col py-4 px-2">
          <p className="px-3 mb-2 text-[10px] font-medium text-zinc-600 uppercase tracking-widest">Settings</p>
          {NAV.map((n) => (
            <button
              key={n.id}
              onClick={() => setSection(n.id)}
              className={`text-left px-3 py-1.5 text-[12px] rounded-md transition-colors ${
                section === n.id ? "bg-white/[0.08] text-zinc-100" : "text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04]"
              }`}
            >
              {n.label}
            </button>
          ))}
        </aside>

        {/* Main */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.06]">
            <h2 className="text-[14px] font-semibold text-zinc-100 capitalize">{section}</h2>
            <button onClick={onClose} className="text-zinc-600 hover:text-zinc-300 transition-colors">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-5 py-5">
            {section === "setup" && (
              <div className="flex items-start gap-3 px-3 py-3 rounded-xl bg-white/[0.03] border border-white/[0.06]">
                <div className="w-8 h-8 rounded-lg bg-blue-500/10 border border-blue-500/20 flex items-center justify-center shrink-0 mt-0.5">
                  <svg width="14" height="14" viewBox="0 0 20 20" fill="none" className="text-blue-400">
                    <path d="M10 2L3 6v4c0 3.5 3 6.7 7 8 4-1.3 7-4.5 7-8V6l-7-4z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] font-medium text-zinc-200">Caddy, dnsmasq &amp; SSL</p>
                  <p className="text-[11px] text-zinc-500 mt-0.5 leading-relaxed">
                    Re-run setup to install missing dependencies, regenerate SSL certificates, or restart Caddy.
                  </p>
                  <button
                    onClick={() => setShowSetup(true)}
                    className="mt-2.5 px-3 py-1.5 text-[12px] font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors"
                  >
                    Open Setup Wizard
                  </button>
                </div>
              </div>
            )}
            {section === "tunnels" && <TunnelsSection />}
            {section === "tailscale" && <TailscaleSection />}
          </div>
        </div>
      </div>
    </div>
  );
}
