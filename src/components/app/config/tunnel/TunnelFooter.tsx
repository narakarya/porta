import { useAppConfig } from "../AppConfigContext";

/** Action row at the bottom of the Settings disclosure (mockup 32).
 *
 * This is the **only** Reconnect in the section. The panel used to carry two —
 * one in a floating drift banner and one down here — so the same action showed
 * up twice with different styling depending on which one noticed the drift
 * first. The drift notice now lives in the status strip and points here; the
 * button sits next to the fields that need it.
 *
 * Disconnect is not here either: stopping what's running belongs to the status
 * strip, next to the thing it stops. The auto-start toggle and the error box
 * moved out too — to Advanced and to the section body respectively. */
export default function TunnelFooter() {
  const c = useAppConfig();

  const namedIncomplete =
    c.tunnelProvider === "cloudflare" &&
    c.tunnelMode === "named" &&
    (!c.tunnelName.trim() || !c.tunnelHostname.trim());

  return (
    <>
      {c.otherProviderLive && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-warn-bg border border-[var(--warning-border)]">
          <span className="w-1.5 h-1.5 mt-1.5 rounded-full bg-warn shrink-0" />
          <span className="text-[11px] text-warn">
            {c.otherProviderLive === "tailscale" ? "Tailscale" : "Cloudflare"} is still connected.
            Connecting {c.tunnelProvider === "tailscale" ? "Tailscale" : "Cloudflare"} here will
            disconnect it first.
          </span>
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        {c.selectedIsLive && c.tunnelBusy !== "connecting" ? (
          <>
            <button
              type="button"
              onClick={c.handleConnect}
              // Deliberately NOT gated on drift. Restarting a wedged connector
              // with the settings unchanged is a real use for this button, and
              // the mockup's disabled-when-settled state would have taken it
              // away. Drift only changes how loudly it asks to be pressed.
              disabled={c.tunnelBusy !== null || namedIncomplete}
              title={
                c.liveTunnelConfigDrifted
                  ? "Restart the tunnel with the settings above"
                  : "Restart the connector with the same settings"
              }
              className={`px-4 py-2 text-[13px] font-medium rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-2 ${
                c.liveTunnelConfigDrifted
                  ? "text-[#0a0a0c] bg-warn hover:brightness-110"
                  : "text-ink-2 bg-surface-2"
              }`}
            >
              Reconnect
            </button>
            {c.liveTunnelConfigDrifted ? (
              <>
                <button
                  type="button"
                  onClick={c.revertTunnelDraft}
                  disabled={c.tunnelBusy !== null}
                  className="px-3 py-2 text-[13px] font-medium text-ink-2 rounded-lg hover:bg-white/[0.06] disabled:opacity-50 transition-colors"
                >
                  Revert
                </button>
                <span className="text-[11px] text-ink-3">Reconnect drops the current URL.</span>
              </>
            ) : (
              <span className="text-[11px] text-ink-3">
                No pending changes — restarts the connector.
              </span>
            )}
          </>
        ) : (
          <button
            type="button"
            onClick={c.handleConnect}
            disabled={
              c.tunnelBusy !== null ||
              namedIncomplete ||
              (c.tunnelProvider === "tailscale" &&
                (!c.tsStatus || !c.tsStatus.installed || !c.tsStatus.running || !c.tsStatus.logged_in))
            }
            className="px-4 py-2 text-[13px] font-medium text-white bg-accent hover:brightness-110 border border-[var(--accent-border)] rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-2"
          >
            {c.tunnelBusy === "connecting" && (
              <span className="inline-block h-3 w-3 rounded-full border-2 border-white/40 border-t-white animate-spin" />
            )}
            {c.tunnelBusy === "connecting"
              ? "Connecting…"
              : c.tunnelProvider === "tailscale"
                ? "Connect"
                : c.tunnelMode === "named" ? "Connect" : "Quick Tunnel"}
          </button>
        )}
      </div>
    </>
  );
}
