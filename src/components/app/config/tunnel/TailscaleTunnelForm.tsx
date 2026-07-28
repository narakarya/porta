import SetupCard from "../../../shared/SetupCard";
import { RefreshIcon, Spinner } from "../../../ui";
import { useAppConfig } from "../AppConfigContext";

/** The Tailscale provider branch (shown only while not live): install / start /
 *  login setup steps, then a connected preview with the resulting URL and the
 *  Funnel (public exposure) toggle. */
export default function TailscaleTunnelForm() {
  const c = useAppConfig();

  if (c.tsLoading && c.tsStatus === null) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-1 border border-subtle text-[12px] text-ink-3">
        <Spinner size={11} />
        Checking Tailscale…
      </div>
    );
  }
  if (!c.tsStatus || !c.tsStatus.installed) {
    return (
      <SetupCard
        step={1}
        title="Install Tailscale"
        body="Porta couldn't find the tailscale CLI. Install it here, or grab the app from tailscale.com/download."
        cmd="brew install tailscale"
        copied={c.copiedCmd}
        onCopy={c.copyCmd}
        onRecheck={() => c.refreshTailscale(true)}
        recheckLabel="I've installed it"
        loading={c.tsLoading}
        runStep="install-tailscale"
        runLabel="Install with Homebrew"
        hint={c.tsRecheckedWithoutChange ? "Still not finding the CLI. Try restarting Porta after install, or verify `which tailscale` shows a path." : null}
      />
    );
  }
  if (!c.tsStatus.running || !c.tsStatus.logged_in) {
    const body = !c.tsStatus.running
      ? "The Tailscale daemon isn't running. Open the Tailscale app or run:"
      : "Open the Tailscale app and sign in, or run:";
    return (
      <SetupCard
        step={2}
        title={!c.tsStatus.running ? "Start Tailscale" : "Log in to Tailscale"}
        body={body}
        cmd={!c.tsStatus.running ? "open -a Tailscale" : "tailscale up"}
        copied={c.copiedCmd}
        onCopy={c.copyCmd}
        onRecheck={() => c.refreshTailscale(true)}
        recheckLabel={!c.tsStatus.running ? "I've started it" : "I've logged in"}
        loading={c.tsLoading}
        // The CLI talks to the daemon the GUI app hosts, so a stopped
        // daemon is fixed by launching the app — not by `tailscale up`,
        // which would just fail to connect.
        runStep={!c.tsStatus.running ? "start-tailscale-app" : "tailscale-up"}
        runLabel={!c.tsStatus.running ? "Open Tailscale app" : "Connect & sign in"}
        hint={c.tsRecheckedWithoutChange
          ? (!c.tsStatus.running
            ? "Daemon still stopped. Open the Tailscale app from your menu bar and wait for it to show 'Connected'."
            : "Still not showing as logged in. Make sure `tailscale up` opened a browser and you completed the auth flow.")
          : null}
      />
    );
  }
  const previewHost = c.tsStatus.host ?? "your-device.tail-xxxx.ts.net";
  const previewPort = parseInt(c.port, 10) || c.app.port;
  const previewUrl = previewPort === 443
    ? `https://${previewHost}`
    : `https://${previewHost}:${previewPort}`;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-ok-bg border border-[rgba(52,211,153,0.25)]">
        <div className="flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-ok" />
          <span className="text-[11px] text-ok">
            Tailscale connected as <span className="font-mono">{previewHost}</span>
          </span>
        </div>
        <button
          type="button"
          onClick={() => c.refreshTailscale()}
          className="text-[10px] text-ok hover:text-ok transition-colors"
        >
          <RefreshIcon /> Refresh
        </button>
      </div>
      <div className="px-3 py-2 rounded-lg bg-surface-1 border border-subtle">
        <p className="text-[10px] text-ink-3 mb-1">Your URL will be:</p>
        <p className="font-mono text-[12px] text-ink break-all">{previewUrl}</p>
        <p className="text-[10px] text-ink-3 mt-2 leading-relaxed">
          {c.tsFunnel
            ? "Funnel exposes this publicly to the internet. Anyone with the URL can access it."
            : "Only devices logged into your tailnet can reach this URL."}
        </p>
      </div>
      <label className="flex items-start gap-2 px-3 py-2 rounded-lg bg-surface-1 border border-subtle cursor-pointer select-none">
        <input
          type="checkbox"
          checked={c.tsFunnel}
          onChange={(e) => c.setTsFunnel(e.target.checked)}
          className="mt-0.5 rounded border-strong bg-surface-2 text-warn focus:ring-[rgba(251,191,36,0.3)] focus:ring-offset-0"
        />
        <div className="flex-1">
          <p className="text-[12px] text-ink">Expose publicly via Funnel</p>
          <p className="text-[10px] text-ink-3 mt-0.5 leading-relaxed">
            Share to the public internet instead of just your tailnet. Requires Funnel to be enabled in your Tailscale admin console.
          </p>
        </div>
      </label>
    </div>
  );
}
