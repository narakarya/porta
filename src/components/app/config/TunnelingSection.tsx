import { useAppConfig } from "./AppConfigContext";
import TunnelStatusStrip from "./tunnel/TunnelStatusStrip";
import TunnelErrorBox from "./tunnel/TunnelErrorBox";
import TunnelDisclosure from "./tunnel/TunnelDisclosure";
import TunnelProviderToggle from "./tunnel/TunnelProviderToggle";
import CloudflareTunnelForm from "./tunnel/CloudflareTunnelForm";
import TailscaleTunnelForm from "./tunnel/TailscaleTunnelForm";
import TunnelAdvanced from "./tunnel/TunnelAdvanced";
import TunnelFooter from "./tunnel/TunnelFooter";

/**
 * Public-tunnel settings panel, restructured per mockup 32 (supersedes 09/11).
 *
 * Two blocks, not thirteen:
 *
 *   1. **Status** — one strip that owns everything about what is running, or
 *      the failure that stopped it from running. Never both.
 *   2. **Settings** — the entire configuration form, folded away while a tunnel
 *      is live. A working tunnel's resting state is four lines; the form
 *      unfolds when the user goes looking for it, and opens by default on an
 *      app that has nothing published (configuring is the only thing to do
 *      there) or after a failed Connect (the fix is nearly always in it).
 *
 * Nothing was removed. Auto-start and the public alias domain moved into
 * Advanced, Disconnect moved into the strip, and the second Reconnect — the one
 * that used to live in a floating drift banner — is gone, with the strip's
 * drift notice pointing at the one in the Settings footer instead.
 */
export default function TunnelingSection() {
  const c = useAppConfig();

  // The failure replaces the strip rather than stacking beneath it: when a
  // Connect has failed there is nothing live to describe.
  const showError = !!c.tunnelError && !c.selectedIsLive;

  // Folded summary — a disclosure that hides what it contains is worse than no
  // disclosure at all.
  const settingsSummary = (() => {
    if (c.liveTunnelConfigDrifted) return "1 unapplied change";
    const provider = c.tunnelProvider === "tailscale" ? "tailscale" : "cloudflare";
    if (c.tunnelProvider === "tailscale") return provider;
    const mode = c.tunnelMode === "named" ? "named" : "quick";
    const hosts = c.selectedIsLive ? c.liveTunnelHosts.length : c.configuredTunnelHosts.length;
    return hosts > 0 ? `${mode} · ${hosts} host${hosts > 1 ? "s" : ""}` : mode;
  })();

  return (
    <>
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-widest text-ink-2">Public tunnel</p>
        <p className="text-[12px] text-ink-3 mt-1">Expose this app to the internet via a secure tunnel.</p>
      </div>

      <div className="flex flex-col gap-3 p-5 rounded-card bg-surface-1 border border-subtle">
        {showError ? <TunnelErrorBox /> : <TunnelStatusStrip />}

        <TunnelDisclosure
          open={c.tunnelSettingsOpen}
          onToggle={() => c.setTunnelSettingsOpen(!c.tunnelSettingsOpen)}
          label="Settings"
          summary={settingsSummary}
          tone={c.liveTunnelConfigDrifted ? "warn" : "default"}
        >
          <TunnelProviderToggle />

          {c.tunnelProvider === "cloudflare" && <CloudflareTunnelForm />}
          {c.tunnelProvider === "tailscale" && !c.selectedIsLive && <TailscaleTunnelForm />}

          <TunnelAdvanced />
          <TunnelFooter />
        </TunnelDisclosure>
      </div>
    </>
  );
}
