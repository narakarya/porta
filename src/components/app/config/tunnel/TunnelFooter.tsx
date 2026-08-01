import { setTunnelConfig } from "../../../../lib/commands";
import { useAppConfig } from "../AppConfigContext";

/** Shared footer for both providers: the tunnel error box, the auto-start
 *  toggle (persists immediately), the "other provider still connected" warning,
 *  and the Connect / Disconnect / Reconnect button row. */
export default function TunnelFooter() {
  const c = useAppConfig();

  return (
    <>
      {c.tunnelError && !c.selectedIsLive && (
        <div className="relative px-3 py-2 pr-14 rounded-lg bg-bad-bg border border-[var(--danger-border)] text-[11px] text-bad font-mono whitespace-pre-wrap break-words">
          {c.tunnelError}
          <button
            type="button"
            onClick={() => {
              navigator.clipboard.writeText(c.tunnelError!).then(() => {
                c.setTunnelErrorCopied(true);
                setTimeout(() => c.setTunnelErrorCopied(false), 1500);
              });
            }}
            className={`absolute top-1.5 right-1.5 px-2 py-0.5 text-[10px] font-sans font-medium rounded transition-colors ${
              c.tunnelErrorCopied ? "bg-ok-bg text-ok" : "bg-[var(--danger-border)] hover:bg-[rgba(248,113,113,0.32)] text-bad"
            }`}
          >
            {c.tunnelErrorCopied ? "Copied!" : "Copy"}
          </button>
        </div>
      )}

      {/* Auto-start toggle: persists along with provider config. Only
          meaningful when a provider is set — hide otherwise to reduce
          noise on apps that aren't using tunnels. */}
      <label className="flex items-start gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={c.tunnelAutoStart}
          onChange={async (e) => {
            const next = e.target.checked;
            c.setTunnelAutoStart(next);
            // Persist immediately so a subsequent "app start" picks
            // up the new value without requiring a Connect click.
            try {
              await setTunnelConfig(
                c.app.id,
                c.tunnelProvider,
                c.tunnelMode === "named" ? (c.tunnelName.trim() || null) : null,
                c.tunnelMode === "named" ? (c.tunnelHostname.trim() || null) : null,
                next,
              );
            } catch {
              // Revert on failure — config didn't actually persist.
              c.setTunnelAutoStart(!next);
            }
          }}
          className="mt-0.5 rounded border-strong bg-surface-2 text-accent focus:ring-[rgba(96,165,250,0.45)] focus:ring-offset-0"
        />
        <div>
          <p className="text-[12px] text-ink-2">Auto-start with app</p>
          <p className="text-[10px] text-ink-3 mt-0.5">
            When this app starts, the tunnel connects automatically using the settings above.
          </p>
        </div>
      </label>

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

      <div className="flex gap-2">
        {/* Render Connect when busy connecting OR not yet active.
            Render Disconnect only when truly active and not in the
            middle of a connecting flow — keeps the spinner+label
            visible during the whole connect, even after the
            backend's optimistic event briefly arrives. */}
        {c.selectedIsLive && c.tunnelBusy !== "connecting" ? (
          <>
            <button
              onClick={c.handleDisconnect}
              disabled={c.tunnelBusy !== null}
              className="px-4 py-2 text-[13px] font-medium text-ink-2 bg-surface-2 hover:bg-white/[0.12] rounded-lg transition-colors disabled:opacity-60 disabled:cursor-not-allowed inline-flex items-center gap-2"
            >
              {c.tunnelBusy === "disconnecting" && (
                <span className="inline-block h-3 w-3 rounded-full border-2 border-strong border-t-ink animate-spin" />
              )}
              {c.tunnelBusy === "disconnecting" ? "Disconnecting…" : "Disconnect"}
            </button>
            {/* Reconnect without the disconnect-then-remember-to-reconnect
                dance. The backend already tears its own connector down, so
                this is one click, not two. */}
            <button
              onClick={c.handleConnect}
              disabled={
                c.tunnelBusy !== null ||
                (c.tunnelProvider === "cloudflare" && c.tunnelMode === "named" && (!c.tunnelName.trim() || !c.tunnelHostname.trim()))
              }
              title="Restart the tunnel with the settings above"
              className={`px-4 py-2 text-[13px] font-medium rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-2 ${
                c.liveTunnelConfigDrifted
                  ? "text-white bg-accent hover:brightness-110 border border-[var(--accent-border)]"
                  : "text-ink-2 bg-surface-2 hover:bg-white/[0.12]"
              }`}
            >
              Reconnect
            </button>
          </>
        ) : (
          <button
            onClick={c.handleConnect}
            disabled={
              c.tunnelBusy !== null ||
              (c.tunnelProvider === "cloudflare" && c.tunnelMode === "named" && (!c.tunnelName.trim() || !c.tunnelHostname.trim())) ||
              (c.tunnelProvider === "tailscale" && (!c.tsStatus || !c.tsStatus.installed || !c.tsStatus.running || !c.tsStatus.logged_in))
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
