import { useAppConfig } from "../AppConfigContext";
import { Spinner } from "../../../ui";
import TunnelPublicHostsPanel from "./TunnelPublicHostsPanel";

/** Everything that reflects a LIVE tunnel: the "establishing…" spinner, the
 *  public URL + Copy row, accessible-hosts list, reachability + DNS repair, and
 *  the config-drift "Reconnect to apply" banner. Renders nothing when the
 *  selected provider isn't live. */
export default function TunnelLiveStatus() {
  const c = useAppConfig();

  return (
    <>
      {c.selectedIsLive && !c.app.tunnel_url && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-warn-bg border border-[rgba(251,191,36,0.25)]">
          <Spinner size={12} className="shrink-0 text-warn" />
          <span className="text-[11px] text-warn">Establishing tunnel…</span>
        </div>
      )}

      {c.selectedIsLive && c.app.tunnel_url && (
        <>
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-ok-bg border border-[rgba(52,211,153,0.25)]">
            <svg width="12" height="12" viewBox="0 0 10 10" fill="none" className="text-ok shrink-0">
              <circle cx="5" cy="5" r="4" stroke="currentColor" strokeWidth="1.1"/>
              <ellipse cx="5" cy="5" rx="2" ry="4" stroke="currentColor" strokeWidth="1.1"/>
              <path d="M1 5h8" stroke="currentColor" strokeWidth="1.1"/>
            </svg>
            <span className="text-[11px] font-mono text-ok truncate flex-1">
              {c.app.tunnel_url}
            </span>
            <button
              onClick={() => {
                navigator.clipboard.writeText(c.app.tunnel_url!).then(() => {
                  c.setTunnelUrlCopied(true);
                  setTimeout(() => c.setTunnelUrlCopied(false), 1500);
                });
              }}
              className={`text-[10px] font-medium shrink-0 transition-colors ${c.tunnelUrlCopied ? "text-ok" : ""}`}
            >
              {c.tunnelUrlCopied ? "Copied!" : "Copy"}
            </button>
          </div>
          <TunnelPublicHostsPanel hosts={c.liveTunnelHosts} title="Accessible hosts" />
          {c.tunnelReachable === false && (
            <div className="flex flex-col gap-2 px-3 py-1.5 rounded-lg bg-warn-bg border border-[rgba(251,191,36,0.25)]">
              <div className="flex items-start gap-2">
                <span className="w-1.5 h-1.5 mt-1 rounded-full bg-warn shrink-0" />
                <span className="text-[11px] text-warn">
                  Tunnel endpoint not reachable — the tunnel itself looks down, not your app
                  (an app that's up but erroring would still respond).{" "}
                  {c.app.tunnel_provider === "cloudflare"
                    ? "Usually the DNS record for this hostname is missing — repairing re-creates it."
                    : "Check that the Tailscale serve/funnel is still up."}
                </span>
              </div>
              {/* Cloudflare only: Tailscale serve has no DNS record to fix. */}
              {c.app.tunnel_provider === "cloudflare" && c.app.tunnel_name && (
                <div className="flex items-center gap-2 pl-3.5">
                  <button
                    type="button"
                    disabled={c.dnsRepairing}
                    onClick={() => c.repairDns()}
                    className="px-3 py-1 text-[11px] text-ink-2 bg-surface-2 border border-subtle rounded-lg hover:bg-white/[0.08] hover:text-ink disabled:opacity-50 transition-colors shrink-0"
                  >
                    {c.dnsRepairing ? "Repairing…" : "Repair DNS route"}
                  </button>
                  {c.dnsRepairError && (
                    <span className="text-[10px] text-bad truncate">{c.dnsRepairError}</span>
                  )}
                </div>
              )}
            </div>
          )}
          {c.tunnelReachable === true && (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-ok-bg border border-[rgba(52,211,153,0.15)]">
              <span className="w-1.5 h-1.5 rounded-full bg-ok shrink-0" />
              <span className="text-[11px] text-ok">Reachable</span>
            </div>
          )}
        </>
      )}

      {/* The configuration below stays on screen and editable while a tunnel
          is live. It used to be gated behind `!selectedIsLive`, so changing
          the named tunnel, the hostname, or the Cloudflare Access policy
          meant first tearing down a working tunnel — for settings you might
          only be there to *read*. Nothing here applies mid-flight, so when
          the draft diverges from what's running we say so, and offer the
          reconnect right where the change was made. */}
      {c.selectedIsLive && c.liveTunnelConfigDrifted && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-warn-bg border border-[rgba(251,191,36,0.25)]">
          <span className="w-1.5 h-1.5 rounded-full bg-warn shrink-0" />
          <span className="text-[11px] text-warn flex-1">
            The tunnel is running with the previous settings. Reconnect to apply these.
          </span>
          <button
            type="button"
            onClick={c.handleConnect}
            disabled={c.tunnelBusy !== null || !c.tunnelName.trim() || !c.tunnelHostname.trim()}
            className="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium text-warn bg-[rgba(251,191,36,0.14)] hover:bg-[rgba(251,191,36,0.24)] disabled:opacity-50 rounded-control transition-colors"
          >
            {c.tunnelBusy === "connecting" && (
              <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-warn/40 border-t-warn animate-spin" />
            )}
            Reconnect
          </button>
        </div>
      )}
    </>
  );
}
