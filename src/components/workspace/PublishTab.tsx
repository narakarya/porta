import { useEffect, useState, type ReactElement } from "react";
import { useShallow } from "zustand/react/shallow";
import QRCode from "qrcode";
import { usePortaStore } from "../../store";
import { Badge, Popover, Spinner } from "../ui";
import type { App } from "../../types";

const PROVIDER_LABEL: Record<string, string> = {
  cloudflare: "Cloudflare",
  tailscale: "Tailscale Funnel",
  remote: "VPS relay",
};

type Access = "public" | "password" | "cfaccess";

/* ── inline icons (16px stroke set, matches the rest of the app) ───────── */
const Globe = ({ className = "" }: { className?: string }) => (
  <svg width="17" height="17" viewBox="0 0 16 16" fill="none" className={className}>
    <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.2" />
    <path d="M1.8 8h12.4M8 1.8c1.7 1.7 2.6 3.9 2.6 6.2S9.7 12.5 8 14.2C6.3 12.5 5.4 10.3 5.4 8S6.3 3.5 8 1.8z" stroke="currentColor" strokeWidth="1.2" />
  </svg>
);
const ArrowRight = () => (
  <svg width="18" height="12" viewBox="0 0 20 12" fill="none"><path d="M2 6h15M12 1.5L17.5 6 12 10.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
);
const CopyIcon = () => (
  <svg width="16" height="16" viewBox="0 0 14 14" fill="none"><rect x="4.5" y="4.5" width="7" height="7" rx="1.2" stroke="currentColor" strokeWidth="1.2" /><path d="M9.5 4.5V3.2A1.2 1.2 0 008.3 2H3.2A1.2 1.2 0 002 3.2v5.1A1.2 1.2 0 003.2 9.5h1.3" stroke="currentColor" strokeWidth="1.2" /></svg>
);
const ExternalIcon = () => (
  <svg width="16" height="16" viewBox="0 0 14 14" fill="none"><path d="M5.5 3h5.5v5.5M11 3L6 8M9 9v2.5H3V5.5h2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
);
const QrIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1.5" y="1.5" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.1" /><rect x="9.5" y="1.5" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.1" /><rect x="1.5" y="9.5" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.1" /><path d="M9.5 9.5h2m3 0h-1m-4 3v2m0-5v1m3-1v5m2-5v2m0 2v1" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" /></svg>
);
const Star = ({ className = "" }: { className?: string }) => (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="currentColor" className={className}><path d="M7 1.5l1.6 3.4 3.6.4-2.7 2.5.8 3.6L7 9.9l-3.3 2 .8-3.6L1.8 5.7l3.6-.4L7 1.5z" /></svg>
);
const Plus = () => (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M7 2.5v9M2.5 7h9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
);
const Check = () => (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M2.5 7.5L5.5 10.5 11.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
);
const Lock = () => (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><rect x="2.75" y="6" width="8.5" height="6" rx="1.3" stroke="currentColor" strokeWidth="1.2" /><path d="M4.5 6V4.3a2.5 2.5 0 015 0V6" stroke="currentColor" strokeWidth="1.2" /></svg>
);
const Shield = () => (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M7 1.6l4.4 1.6v3.3c0 2.7-1.8 4.6-4.4 5.9C4.4 11.1 2.6 9.2 2.6 6.5V3.2L7 1.6z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /></svg>
);

/**
 * Publish tab — the roomy, content-forward counterpart to the card's tunnel
 * quick-menu (mockup 11_porta_tunnel_publish_v2). One unified panel: header +
 * tunnel toggle, a local→public routing hero, a quick/named mode switch, the
 * public hostname list, and access control. Reuses the real tunnel state +
 * start/stopTunnel actions; provider config still lives in app settings.
 */
export default function PublishTab({
  app,
  onOpenConfig,
}: {
  app: App;
  // Deep-link into the workbench Config tab (mockup 20). Falls back to the
  // standalone settings modal when rendered outside the workbench.
  onOpenConfig?: (section?: import("../app/AppSettingsModal").Section) => void;
}) {
  const { startTunnel, stopTunnel, openAppSettings, connecting, error } = usePortaStore(
    useShallow((s) => ({
      startTunnel: s.startTunnel,
      stopTunnel: s.stopTunnel,
      openAppSettings: s.openAppSettings,
      connecting: s.tunnelConnecting[app.id] ?? false,
      error: s.appTunnelErrors[app.id] ?? null,
    }))
  );
  // Prefer the inline Config tab; fall back to the modal.
  const openConfig = (section?: import("../app/AppSettingsModal").Section) =>
    onOpenConfig ? onOpenConfig(section) : openAppSettings(app.id);
  const [busy, setBusy] = useState(false);

  const active = app.tunnel_active && !!app.tunnel_url;
  const provider = PROVIDER_LABEL[app.tunnel_provider ?? "cloudflare"] ?? app.tunnel_provider ?? "Cloudflare";
  const primaryHost = app.custom_domain || (app.subdomain ? `${app.subdomain}.test` : null);
  const publicHost = active ? app.tunnel_url!.replace(/^https?:\/\//, "") : primaryHost;

  // Named vs quick tunnel — inferred from app fields (presentational selection).
  const isNamed = !!app.tunnel_name || !!app.custom_domain;
  const [mode, setMode] = useState<"quick" | "named">(isNamed ? "named" : "quick");

  // Access control — reflects basic_auth. CF Access is not a local state; the
  // segment deep-links into tunneling config instead of faking an access mode.
  const [access, setAccess] = useState<Access>(app.basic_auth_enabled ? "password" : "public");

  const busyToggle = busy || connecting;

  // Shareable URL for the QR code: live tunnel URL → primary public host →
  // local URL. There is always something to encode (localhost fallback).
  const shareUrl = active
    ? app.tunnel_url!
    : primaryHost
      ? `https://${primaryHost}`
      : `http://localhost:${app.port}`;

  const [qrOpen, setQrOpen] = useState(false);
  const [qrSrc, setQrSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!qrOpen || !shareUrl) return;
    let cancelled = false;
    QRCode.toDataURL(shareUrl, { margin: 1, width: 180 })
      .then((url) => !cancelled && setQrSrc(url))
      .catch(() => !cancelled && setQrSrc(null));
    return () => {
      cancelled = true;
    };
  }, [qrOpen, shareUrl]);

  async function toggle() {
    if (busyToggle) return;
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

  const fmtHost = (s: string) => (s.includes(".") ? s : `${s}.test`);

  const segments: { id: Access; label: string; icon: ReactElement }[] = [
    { id: "public", label: "Public", icon: <Globe /> },
    { id: "password", label: "Password", icon: <Lock /> },
    { id: "cfaccess", label: "CF Access", icon: <Shield /> },
  ];
  const accessHelp: Record<Access, string> = {
    public: "Anyone with the link can reach it.",
    password: "Basic auth — visitors need the password.",
    cfaccess: "Cloudflare Access gates every request.",
  };
  const accessLink = access === "public" ? "Configure" : "Set credentials";

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-xl">
        <div className="rounded-[12px] border border-subtle bg-surface-2 overflow-hidden">
          {/* ── header ─────────────────────────────────────────────── */}
          <div className="flex items-center gap-2.5 px-4 py-[11px] border-b border-subtle">
            <Globe className={active ? "text-ok shrink-0" : "text-ink-3 shrink-0"} />
            <span className="text-[14px] font-medium text-ink">Publish</span>
            {active && (
              <Badge tone="ok">
                <span className="pulse-dot text-[8px] leading-none">●</span>
                live · {provider}
              </Badge>
            )}
            <div className="ml-auto flex items-center gap-1.5">
              <span className="text-[12px] text-ink-2">{connecting ? "Connecting…" : "Tunnel"}</span>
              <button
                role="switch"
                aria-checked={active}
                aria-label={active ? "Stop tunnel" : "Start tunnel"}
                onClick={toggle}
                disabled={busyToggle}
                className={`relative inline-block w-8 h-[18px] rounded-full transition-colors duration-base disabled:opacity-60 disabled:cursor-wait ${
                  active ? "bg-ok" : "border border-strong"
                }`}
              >
                <span
                  className={`absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white transition-all duration-base ${
                    active ? "right-0.5" : "left-0.5"
                  }`}
                />
              </button>
            </div>
          </div>

          {/* ── body ───────────────────────────────────────────────── */}
          <div className="px-4 py-3.5 flex flex-col gap-3.5">
            {/* local → public routing hero */}
            <div className="flex items-center gap-3 rounded-[10px] border border-subtle px-3.5 py-3">
              <div className="flex flex-col gap-0.5 min-w-0">
                <span className="text-[10px] text-ink-3">LOCAL</span>
                <span className="font-mono text-[13px] text-ink">localhost:{app.port}</span>
              </div>
              <div className="flex flex-col items-center text-ok shrink-0">
                <ArrowRight />
                <span className="text-[9px] text-ink-3">tunnel</span>
              </div>
              <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                <span className="text-[10px] text-accent">PUBLIC</span>
                <span className="font-mono text-[13px] text-ink truncate">{publicHost ?? "—"}</span>
              </div>
              <div className="flex items-center gap-3 text-ink-3 shrink-0">
                {active && (
                  <>
                    <button title="Copy URL" onClick={() => navigator.clipboard.writeText(app.tunnel_url!)} className="hover:text-ink transition-colors"><CopyIcon /></button>
                    <button title="Open" onClick={() => window.open(app.tunnel_url!, "_blank")} className="hover:text-ink transition-colors"><ExternalIcon /></button>
                  </>
                )}
                <Popover
                  open={qrOpen}
                  onClose={() => setQrOpen(false)}
                  align="right"
                  width="w-auto"
                  anchor={
                    <button
                      title="QR code"
                      aria-label="Show QR code"
                      aria-expanded={qrOpen}
                      onClick={() => setQrOpen((o) => !o)}
                      className={`transition-colors ${qrOpen ? "text-ink" : "hover:text-ink"}`}
                    >
                      <QrIcon />
                    </button>
                  }
                >
                  <div className="flex flex-col items-center gap-2 p-2 w-[196px]">
                    {qrSrc ? (
                      <img src={qrSrc} width={180} height={180} alt={`QR code for ${shareUrl}`} className="rounded-[6px] bg-white p-1" />
                    ) : (
                      <div className="flex h-[188px] w-[188px] items-center justify-center"><Spinner /></div>
                    )}
                    <div className="flex w-full items-center gap-1.5">
                      <span className="flex-1 truncate font-mono text-[11px] text-ink-2" title={shareUrl}>{shareUrl}</span>
                      <button title="Copy URL" onClick={() => navigator.clipboard.writeText(shareUrl)} className="shrink-0 text-ink-3 hover:text-ink transition-colors"><CopyIcon /></button>
                    </div>
                  </div>
                </Popover>
              </div>
            </div>

            {/* mode switch — quick vs named tunnel */}
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setMode("quick")}
                className={`text-left rounded-[8px] px-[11px] py-[9px] transition-colors ${mode === "quick" ? "border-[1.5px] border-accent" : "border border-subtle"}`}
              >
                <div className={`text-[12px] flex items-center gap-1.5 ${mode === "quick" ? "text-accent" : "text-ink-2"}`}>
                  Quick tunnel {mode === "quick" && <Check />}
                </div>
                <div className="text-[11px] text-ink-3 mt-px">Ephemeral <span className="font-mono">*.trycloudflare.com</span>. Zero setup.</div>
              </button>
              <button
                onClick={() => setMode("named")}
                className={`text-left rounded-[8px] px-[11px] py-[9px] transition-colors ${mode === "named" ? "border-[1.5px] border-accent" : "border border-subtle"}`}
              >
                <div className={`text-[12px] flex items-center gap-1.5 ${mode === "named" ? "text-accent" : "text-ink-2"}`}>
                  Named tunnel {mode === "named" && <Check />}
                </div>
                <div className="text-[11px] text-ink-3 mt-px">Persistent, your own domain + DNS.</div>
              </button>
            </div>

            {/* public hostnames */}
            <div>
              <div className="flex items-center mb-1.5">
                <span className="text-[11px] uppercase tracking-[0.04em] text-ink-3">Public hostnames</span>
                <button onClick={() => openConfig("domain")} className="ml-auto text-[11px] text-accent inline-flex items-center gap-1 hover:brightness-110 transition">
                  <Plus />Add
                </button>
              </div>
              <div className="flex items-center gap-2 py-[5px] text-[12px] font-mono">
                <Star className="text-warn shrink-0" />
                <span className="truncate">{primaryHost ?? "—"}</span>
                <span className="ml-auto text-[10px] font-sans text-ok shrink-0">{active ? "primary · active" : "primary"}</span>
              </div>
              {app.extra_subdomains.map((sub) => (
                <div key={sub} className="flex items-center gap-2 py-[5px] text-[12px] font-mono">
                  <span className="w-[13px] shrink-0" aria-hidden />
                  <span className="truncate">{fmtHost(sub)}</span>
                  <span className="ml-auto text-[10px] font-sans text-ink-2 shrink-0">alias</span>
                </div>
              ))}
            </div>

            {/* access control */}
            <div className="border-t border-subtle pt-3">
              <div className="text-[11px] uppercase tracking-[0.04em] text-ink-3 mb-[7px]">Who can reach it</div>
              <div className="inline-flex border border-subtle rounded-[8px] overflow-hidden text-[12px]">
                {segments.map((seg, i) => (
                  <button
                    key={seg.id}
                    // CF Access isn't a local toggle — route to where it's
                    // actually configured instead of faking an access state.
                    onClick={() => (seg.id === "cfaccess" ? openConfig("tunneling") : setAccess(seg.id))}
                    className={`inline-flex items-center gap-1.5 px-3 py-[5px] transition-colors ${i > 0 ? "border-l border-subtle" : ""} ${
                      access === seg.id ? "bg-surface-1 text-ink" : "text-ink-2 hover:text-ink"
                    }`}
                  >
                    {seg.icon}
                    {seg.label}
                  </button>
                ))}
              </div>
              <div className="text-[11px] text-ink-3 mt-[7px]">
                {accessHelp[access]}{" "}
                <button onClick={() => openConfig("tunneling")} className="text-accent hover:brightness-110 transition">{accessLink}</button>
              </div>
            </div>

            {error && (
              <pre className="text-[11px] font-mono text-bad whitespace-pre-wrap break-words max-h-28 overflow-y-auto rounded bg-surface-1 p-2">{error}</pre>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
