import { usePortaStore } from "../../store";

type Domain = "workspaces" | "hosts" | "services" | "activity" | "extensions";

interface Props {
  onOpenSettings: () => void;
  onSelectDomain: () => void;
  settingsActive: boolean;
}

const ICONS: Record<Domain, React.ReactNode> = {
  workspaces: (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
      <rect x="2" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <rect x="9" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <rect x="2" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <rect x="9" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  ),
  hosts: (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
      <rect x="2" y="3" width="12" height="8" rx="1.2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4.5 6l2 1.5-2 1.5M8 9h3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  services: (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
      <ellipse cx="8" cy="3.6" rx="5" ry="2.1" stroke="currentColor" strokeWidth="1.3" />
      <path d="M3 3.6v4.4c0 1.16 2.24 2.1 5 2.1s5-.94 5-2.1V3.6M3 8v4.4c0 1.16 2.24 2.1 5 2.1s5-.94 5-2.1V8" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  ),
  activity: (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
      <path d="M1.5 8.5h3l2-5 3 9 2-4h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  extensions: (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
      <path d="M6 2.5a1.3 1.3 0 112.6 0V4h2.4a.6.6 0 01.6.6V7h1.4a1.3 1.3 0 110 2.6H11.6V13a.6.6 0 01-.6.6H8.6V12a1.3 1.3 0 10-2.6 0v1.6H3.4a.6.6 0 01-.6-.6V9.6H4a1.3 1.3 0 100-2.6H2.8V4.6A.6.6 0 013.4 4H6V2.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  ),
};

const DOMAINS: { id: Domain; label: string }[] = [
  { id: "workspaces", label: "Workspaces" },
  { id: "hosts", label: "Hosts" },
  { id: "services", label: "Services" },
  { id: "activity", label: "Activity" },
  { id: "extensions", label: "Extensions" },
];

export default function GlobalRail({ onOpenSettings, onSelectDomain, settingsActive }: Props) {
  const activeDomain = usePortaStore((s) => s.activeDomain);
  const setActiveDomain = usePortaStore((s) => s.setActiveDomain);
  const updaterPhase = usePortaStore((s) => s.updaterPhase);
  const updateReady = updaterPhase === "available" || updaterPhase === "ready";

  return (
    <nav className="drag-region w-[54px] shrink-0 bg-[#151517] border-r border-white/[0.06] flex flex-col items-center pt-3 pb-3 z-20">
      {/* Porta logo + domain nav as one tight top cluster. */}
      <div className="no-drag flex flex-col items-center gap-1">
        <img src="/porta-logo.svg" alt="Porta" width={22} height={22} className="rounded-[6px] mb-1" />
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
                active ? "text-accent" : "text-ink-3 hover:text-ink-2 hover:bg-white/[0.05]"
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
            settingsActive ? "bg-white/[0.10] text-zinc-100" : "text-ink-3 hover:text-ink-2 hover:bg-white/[0.05]"
          }`}
        >
          {/* A proper cog (rounded teeth) so it reads as Settings, not a
              sun/theme toggle. */}
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 13a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
        <button
          title="Account"
          aria-label="Account"
          className="relative w-[26px] h-[26px] rounded-full bg-accent-bg text-[11px] font-medium text-accent-ink flex items-center justify-center transition-colors"
        >
          NG
          {updateReady && (
            <span className="absolute -top-px -right-px w-[9px] h-[9px] rounded-full bg-accent border-[1.5px] border-surface-1" title="Update available" />
          )}
        </button>
      </div>
    </nav>
  );
}
