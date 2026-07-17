import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { usePortaStore } from "../../store";
import { Button, Card, Badge } from "../ui";
import type { App } from "../../types";

const PROVIDER_LABEL: Record<string, string> = {
  cloudflare: "Cloudflare",
  tailscale: "Tailscale Funnel",
  remote: "VPS relay",
};

/**
 * Publish tab — the roomy, content-forward counterpart to the card's tunnel
 * quick-menu (mockup 11). Reuses the real tunnel state + start/stopTunnel
 * actions; provider-specific config (named hostnames, access control) stays in
 * the app settings, linked from here.
 */
export default function PublishTab({ app }: { app: App }) {
  const { startTunnel, stopTunnel, openAppSettings, connecting, error } = usePortaStore(
    useShallow((s) => ({
      startTunnel: s.startTunnel,
      stopTunnel: s.stopTunnel,
      openAppSettings: s.openAppSettings,
      connecting: s.tunnelConnecting[app.id] ?? false,
      error: s.appTunnelErrors[app.id] ?? null,
    }))
  );
  const [busy, setBusy] = useState(false);

  const active = app.tunnel_active && !!app.tunnel_url;
  const publicHost = active
    ? app.tunnel_url!.replace(/^https?:\/\//, "")
    : app.custom_domain || (app.subdomain ? `${app.subdomain}.test` : null);
  const provider = PROVIDER_LABEL[app.tunnel_provider ?? "cloudflare"] ?? app.tunnel_provider ?? "Cloudflare";

  async function toggle() {
    setBusy(true);
    try {
      if (active) await stopTunnel(app.id);
      else await startTunnel(app.id);
    } catch {
      /* surfaced via appTunnelErrors */
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-xl space-y-4">
        <Card>
          <div className="flex items-center gap-2 mb-3">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" className="text-accent shrink-0">
              <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.2" />
              <path d="M1.8 8h12.4M8 1.8c1.7 1.7 2.6 3.9 2.6 6.2S9.7 12.5 8 14.2C6.3 12.5 5.4 10.3 5.4 8S6.3 3.5 8 1.8z" stroke="currentColor" strokeWidth="1.2" />
            </svg>
            <span className="text-[14px] font-medium text-ink">Publish</span>
            {active ? (
              <Badge tone="ok">live · {provider}</Badge>
            ) : connecting ? (
              <Badge tone="warn">connecting…</Badge>
            ) : (
              <Badge tone="neutral">not published</Badge>
            )}
            <div className="ml-auto">
              <Button
                variant={active ? "secondary" : "primary"}
                onClick={toggle}
                disabled={busy || connecting}
              >
                {busy || connecting ? "…" : active ? "Unpublish" : "Publish"}
              </Button>
            </div>
          </div>

          {/* local → public routing hero */}
          <div className="flex items-center gap-3 rounded-control bg-surface-2 px-3.5 py-3 font-mono text-[13px]">
            <div>
              <div className="text-[9px] uppercase tracking-wide text-ink-3">Local</div>
              <div className="text-ink">localhost:{app.port}</div>
            </div>
            <svg width="18" height="12" viewBox="0 0 20 12" fill="none" className="text-ok shrink-0"><path d="M2 6h15M12 1.5L17.5 6 12 10.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
            <div className="min-w-0">
              <div className="text-[9px] uppercase tracking-wide text-ink-3">Public</div>
              {publicHost ? (
                <div className="text-accent-ink truncate">{publicHost}</div>
              ) : (
                <div className="text-ink-3">—</div>
              )}
            </div>
            {active && (
              <div className="ml-auto flex gap-2 shrink-0 text-ink-3">
                <button onClick={() => navigator.clipboard.writeText(app.tunnel_url!)} title="Copy URL" className="hover:text-ink transition-colors">
                  <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><rect x="4.5" y="4.5" width="7" height="7" rx="1.2" stroke="currentColor" strokeWidth="1.2" /><path d="M9.5 4.5V3.2A1.2 1.2 0 008.3 2H3.2A1.2 1.2 0 002 3.2v5.1A1.2 1.2 0 003.2 9.5h1.3" stroke="currentColor" strokeWidth="1.2" /></svg>
                </button>
                <button onClick={() => window.open(app.tunnel_url!, "_blank")} title="Open" className="hover:text-ink transition-colors">
                  <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M5.5 3h5.5v5.5M11 3L6 8M9 9v2.5H3V5.5h2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
              </div>
            )}
          </div>

          {error && (
            <pre className="mt-3 text-[11px] font-mono text-bad whitespace-pre-wrap break-words max-h-28 overflow-y-auto rounded bg-surface-2 p-2">{error}</pre>
          )}
        </Card>

        {/* Config lives in app settings — named hostnames, access control, provider */}
        <Card>
          <div className="text-[12px] text-ink-2 mb-2">Configuration</div>
          <p className="text-[12px] text-ink-3 leading-relaxed mb-3">
            Provider ({provider}), named tunnels &amp; custom domains, and access control
            (public / password / Cloudflare Access) are configured in the app's settings.
          </p>
          <Button onClick={() => openAppSettings(app.id)}>Tunnel settings…</Button>
        </Card>
      </div>
    </div>
  );
}
