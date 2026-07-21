import { usePortaStore } from "../../store";
import { checkForUpdate } from "../../lib/updater";

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
        <VersionDot />
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
      </div>
    </nav>
  );
}

/**
 * Version indicator — the app's only version surface, sitting directly above
 * Settings. Replaces both the inert `v0.0.0` row in the Workspaces sidebar
 * footer (which could never be clicked) and the "NG" account initial the update
 * popover used to anchor to, which had nothing to do with versions.
 *
 * Dot colour carries setup health, the tooltip carries the version plus any
 * setup issues, and clicking runs a manual update check — which is what puts
 * the update popover on screen (UpdateToast renders on any non-idle phase).
 */
function VersionDot() {
  const setupStatus = usePortaStore((s) => s.setupStatus);
  const updaterPhase = usePortaStore((s) => s.updaterPhase);
  const updateReady = updaterPhase === "available" || updaterPhase === "ready";
  const checking = updaterPhase === "checking";

  const issues: string[] = [];
  if (setupStatus) {
    if (!setupStatus.caddy_installed) issues.push("Caddy not installed");
    else if (!setupStatus.caddy_running) issues.push("Caddy stopped");
    if (!setupStatus.dnsmasq_installed) issues.push("dnsmasq not installed");
    if (!setupStatus.mkcert_installed) issues.push("mkcert not installed");
    if (!setupStatus.certs_generated) issues.push("TLS certs not generated");
  }

  const tone: "unknown" | "ok" | "warn" | "bad" = !setupStatus
    ? "unknown"
    : !setupStatus.caddy_installed || !setupStatus.dnsmasq_installed || !setupStatus.mkcert_installed
      ? "bad"
      : issues.length > 0
        ? "warn"
        : "ok";

  // An available update outranks setup health on the dot — it's the only state
  // that asks the user to act on *this* control.
  const dotClass = updateReady
    ? "bg-accent pulse-dot"
    : checking
      ? "bg-accent pulse-dot"
      : tone === "ok"
        ? "bg-emerald-400"
        : tone === "warn"
          ? "bg-amber-400 pulse-dot"
          : tone === "bad"
            ? "bg-red-400 pulse-dot"
            : "bg-zinc-600";

  const tooltip = [
    `Porta v${__BUILD_TAG__}`,
    updateReady ? "Update available" : null,
    ...(tone === "ok" || tone === "unknown" ? [] : issues),
    "Click to check for updates",
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <button
      onClick={() => void checkForUpdate({ silent: false, source: "menu" })}
      title={tooltip}
      aria-label={`Porta v${__BUILD_TAG__} — check for updates`}
      className="w-9 h-9 flex items-center justify-center rounded-[9px] text-ink-3 hover:bg-white/[0.05] transition-colors"
    >
      <span className={`w-2 h-2 rounded-full shrink-0 transition-colors ${dotClass}`} />
    </button>
  );
}
