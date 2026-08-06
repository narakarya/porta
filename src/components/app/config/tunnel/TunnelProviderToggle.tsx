import { useAppConfig } from "../AppConfigContext";

/** Provider segmented toggle (Cloudflare / Tailscale). Switching only changes
 *  the form selection — a live tunnel is never torn down here (see
 *  handleConnect).
 *
 *  The status badge that used to sit beside it is gone: TunnelStatusStrip is
 *  the section's one status surface, and a second badge next to the picker
 *  could contradict it while the user browsed the other provider's config. */
export default function TunnelProviderToggle() {
  const c = useAppConfig();

  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex flex-col gap-1.5 flex-1 min-w-0">
        <label className="text-[11px] font-medium text-ink-2">Provider</label>
        {(() => {
          // Status-dot color reflects "is this provider ready to
          // Connect right now?" — green when fully set up, amber
          // when the user has work to do (install / login),
          // zinc while we're still probing on first open.
          const cfReady = c.cloudflaredInstalled === true;
          const cfNeedsSetup = c.cloudflaredInstalled === false;
          const cfDot = cfReady ? "bg-ok" : cfNeedsSetup ? "bg-warn" : "bg-ink-3";
          const cfTip = cfReady
            ? "Ready"
            : cfNeedsSetup
              ? "cloudflared not installed"
              : "Checking…";
          const tsStatus = c.tsStatus;
          const tsReady = !!(tsStatus?.installed && tsStatus.running && tsStatus.logged_in);
          const tsKnown = !!tsStatus;
          const tsDot = tsReady ? "bg-ok" : tsKnown ? "bg-warn" : "bg-ink-3";
          const tsTip = !tsKnown
            ? "Checking…"
            : tsReady
              ? "Ready"
              : !tsStatus.installed
                ? "Tailscale not installed"
                : !tsStatus.running
                  ? "Tailscale not running"
                  : "Login required";
          const options = [
            { key: "cloudflare", label: "Cloudflare", dot: cfDot, tip: cfTip },
            { key: "tailscale", label: "Tailscale", dot: tsDot, tip: tsTip },
          ];
          return (
            <div
              role="radiogroup"
              aria-label="Tunnel provider"
              className="inline-flex p-0.5 rounded-lg bg-surface-0 border border-subtle w-fit"
            >
              {options.map((opt) => {
                const selected = c.tunnelProvider === opt.key;
                return (
                  <button
                    key={opt.key}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    title={opt.tip}
                    onClick={() => {
                      if (selected) return;
                      // Just switch the form selection — do NOT
                      // tear down a live tunnel here. Merely
                      // browsing the other provider's config
                      // shouldn't kill a working connection (and
                      // flip the badge to a lying "Disconnected").
                      // The old tunnel is stopped at Connect time,
                      // only if its provider differs (see
                      // handleConnect).
                      c.setTunnelProvider(opt.key);
                    }}
                    className={`px-4 py-1.5 rounded-md text-[12px] font-medium inline-flex items-center gap-2 transition-colors ${
                      selected
                        ? "bg-surface-2 text-ink shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]"
                        : "text-ink-2 hover:text-ink"
                    }`}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full ${opt.dot}`} />
                    {opt.label}
                  </button>
                );
              })}
            </div>
          );
        })()}
      </div>
    </div>
  );
}
