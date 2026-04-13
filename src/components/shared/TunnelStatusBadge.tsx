interface TunnelStatusBadgeProps {
  /** Whether the tunnel is active (started) */
  tunnelActive: boolean;
  /** The tunnel URL once connected, or null/undefined while connecting */
  tunnelUrl?: string | null;
  /** Optional extra className to merge onto the badge wrapper */
  className?: string;
}

/**
 * Pill badge that shows tunnel status: Connected / Connecting... / Disconnected.
 * Used in AppSettingsModal tunneling section (and anywhere else a status pill is needed).
 */
export default function TunnelStatusBadge({ tunnelActive, tunnelUrl, className = "" }: TunnelStatusBadgeProps) {
  const connected = tunnelActive && !!tunnelUrl;
  const connecting = tunnelActive && !tunnelUrl;

  const wrapperClass = connected
    ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
    : connecting
    ? "bg-amber-500/10 text-amber-400 border border-amber-500/20"
    : "bg-zinc-800 text-zinc-500 border border-white/[0.06]";

  const dotClass = connected
    ? "bg-emerald-400 pulse-dot"
    : connecting
    ? "bg-amber-400 pulse-dot"
    : "bg-zinc-600";

  const label = connected ? "Connected" : connecting ? "Connecting..." : "Disconnected";

  return (
    <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium ${wrapperClass} ${className}`}>
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotClass}`} />
      {label}
    </div>
  );
}
