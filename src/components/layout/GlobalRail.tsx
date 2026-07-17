import { usePortaStore } from "../../store";

type Domain = "workspaces" | "hosts" | "activity" | "extensions";

interface Props {
  onOpenSettings: () => void;
  onSelectDomain: () => void;
  settingsActive: boolean;
}

const ICONS: Record<Domain, React.ReactNode> = {
  workspaces: (
    <svg width="17" height="17" viewBox="0 0 16 16" fill="none">
      <rect x="2" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <rect x="9" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <rect x="2" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <rect x="9" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  ),
  hosts: (
    <svg width="17" height="17" viewBox="0 0 16 16" fill="none">
      <rect x="2" y="3" width="12" height="8" rx="1.2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4.5 6l2 1.5-2 1.5M8 9h3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  activity: (
    <svg width="17" height="17" viewBox="0 0 16 16" fill="none">
      <path d="M1.5 8.5h3l2-5 3 9 2-4h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  extensions: (
    <svg width="17" height="17" viewBox="0 0 16 16" fill="none">
      <path d="M6 2.5a1.3 1.3 0 112.6 0V4h2.4a.6.6 0 01.6.6V7h1.4a1.3 1.3 0 110 2.6H11.6V13a.6.6 0 01-.6.6H8.6V12a1.3 1.3 0 10-2.6 0v1.6H3.4a.6.6 0 01-.6-.6V9.6H4a1.3 1.3 0 100-2.6H2.8V4.6A.6.6 0 013.4 4H6V2.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  ),
};

const DOMAINS: { id: Domain; label: string }[] = [
  { id: "workspaces", label: "Workspaces" },
  { id: "hosts", label: "Hosts" },
  { id: "activity", label: "Activity" },
  { id: "extensions", label: "Extensions" },
];

export default function GlobalRail({ onOpenSettings, onSelectDomain, settingsActive }: Props) {
  const activeDomain = usePortaStore((s) => s.activeDomain);
  const setActiveDomain = usePortaStore((s) => s.setActiveDomain);
  const updaterPhase = usePortaStore((s) => s.updaterPhase);
  const updateReady = updaterPhase === "available" || updaterPhase === "ready";

  return (
    <nav className="drag-region w-[54px] shrink-0 bg-[#151517] border-r border-white/[0.06] flex flex-col items-center pt-11 pb-3 z-20">
      <img src="/porta-logo.svg" alt="Porta" width={24} height={24} className="no-drag rounded-[6px] mt-1 mb-2.5" />
      <div className="no-drag flex flex-col items-center gap-1.5">
        {DOMAINS.map((d) => {
          const active = !settingsActive && activeDomain === d.id;
          return (
            <button
              key={d.id}
              onClick={() => { setActiveDomain(d.id); onSelectDomain(); }}
              title={d.label}
              aria-label={d.label}
              aria-current={active}
              className={`w-9 h-9 flex items-center justify-center rounded-[9px] transition-colors ${
                active ? "bg-accent-bg text-accent-ink" : "text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.05]"
              }`}
            >
              {ICONS[d.id]}
            </button>
          );
        })}
      </div>

      <div className="no-drag mt-auto flex flex-col items-center gap-2">
        <button
          onClick={onOpenSettings}
          title="Settings"
          aria-label="Settings"
          className={`w-9 h-9 flex items-center justify-center rounded-[9px] transition-colors ${
            settingsActive ? "bg-white/[0.10] text-zinc-100" : "text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.05]"
          }`}
        >
          <svg width="17" height="17" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="2.2" stroke="currentColor" strokeWidth="1.3" />
            <path d="M8 1.5v1.7M8 12.8v1.7M14.5 8h-1.7M3.2 8H1.5M12.6 3.4l-1.2 1.2M4.6 11.4l-1.2 1.2M12.6 12.6l-1.2-1.2M4.6 4.6L3.4 3.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </button>
        <button
          title="Account"
          aria-label="Account"
          className="relative w-7 h-7 rounded-full bg-white/[0.08] text-[11px] font-medium text-zinc-300 flex items-center justify-center hover:bg-white/[0.12] transition-colors"
        >
          NG
          {updateReady && (
            <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-blue-400 border border-[#151517]" title="Update available" />
          )}
        </button>
      </div>
    </nav>
  );
}
