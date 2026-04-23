interface TunnelStatusBadgeProps {
  /** Whether the tunnel is active (started) */
  tunnelActive: boolean;
  /** The tunnel URL once connected, or null/undefined while connecting */
  tunnelUrl?: string | null;
  /** Which provider this tunnel uses — colors the badge accordingly. */
  provider?: string | null;
  /** Optional extra className to merge onto the badge wrapper */
  className?: string;
}

/**
 * Pill badge that shows tunnel status: Connected / Connecting... / Disconnected.
 * Colors adapt to provider: Cloudflare=orange, Tailscale=emerald (private Serve),
 * and connecting=amber regardless. Used in AppSettingsModal and TunnelQuickMenu.
 */
export default function TunnelStatusBadge({ tunnelActive, tunnelUrl, provider, className = "" }: TunnelStatusBadgeProps) {
  const connected = tunnelActive && !!tunnelUrl;
  const connecting = tunnelActive && !tunnelUrl;

  // Connected state uses provider-specific accents so users can tell at a
  // glance whether they're on tailnet (private) or public tunnel.
  const connectedAccent = provider === "tailscale"
    ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
    : "bg-orange-500/10 text-orange-400 border border-orange-500/20";
  const connectedDot = provider === "tailscale" ? "bg-emerald-400" : "bg-orange-400";

  const wrapperClass = connected
    ? connectedAccent
    : connecting
    ? "bg-amber-500/10 text-amber-400 border border-amber-500/20"
    : "bg-zinc-800 text-zinc-500 border border-white/[0.06]";

  const dotClass = connected
    ? `${connectedDot} pulse-dot`
    : connecting
    ? "bg-amber-400 pulse-dot"
    : "bg-zinc-600";

  const providerLabel = provider === "tailscale" ? " · Tailnet" : provider === "cloudflare" ? " · Cloudflare" : "";
  const label = connected ? `Connected${providerLabel}` : connecting ? "Connecting..." : "Disconnected";

  return (
    <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium ${wrapperClass} ${className}`}>
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotClass}`} />
      {label}
    </div>
  );
}
