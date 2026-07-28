import { useAppConfig } from "./AppConfigContext";
import TunnelProviderToggle from "./tunnel/TunnelProviderToggle";
import TunnelLiveStatus from "./tunnel/TunnelLiveStatus";
import CloudflareTunnelForm from "./tunnel/CloudflareTunnelForm";
import TailscaleTunnelForm from "./tunnel/TailscaleTunnelForm";
import TunnelFooter from "./tunnel/TunnelFooter";

/**
 * Public-tunnel settings panel. A thin composition over the per-concern pieces
 * in `./tunnel/` — each reads its own state off the `useAppConfig()` context, so
 * there's no prop drilling. The provider branches are gated here so the tree
 * mirrors what's on screen:
 *   - Cloudflare form: always when Cloudflare is the selected provider.
 *   - Tailscale form: only while not live (the live view is TunnelLiveStatus).
 */
export default function TunnelingSection() {
  const c = useAppConfig();

  return (
    <>
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-widest text-ink-2">Public tunnel</p>
        <p className="text-[12px] text-ink-3 mt-1">Expose this app to the internet via a secure tunnel.</p>
      </div>

      <div className="flex flex-col gap-5 p-5 rounded-card bg-surface-1 border border-subtle">
        <TunnelProviderToggle />
        <TunnelLiveStatus />

        {c.tunnelProvider === "cloudflare" && <CloudflareTunnelForm />}
        {c.tunnelProvider === "tailscale" && !c.selectedIsLive && <TailscaleTunnelForm />}

        <TunnelFooter />
      </div>
    </>
  );
}
