import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { App } from "../../types";
import Tooltip from "../shared/Tooltip";
import TunnelStatusBadge from "../shared/TunnelStatusBadge";
import {
  listCloudflareTunnels,
  setTunnelConfig,
  type CloudflareTunnel,
} from "../../lib/commands";
import { getCachedTunnels, setCachedTunnels, hasTunnelCache } from "../../lib/tunnelCache";
import { useFloatingPosition, useMeasuredSize } from "../shared/useFloatingPosition";
import { usePortaStore } from "../../store";
import { useShallow } from "zustand/react/shallow";

interface TunnelQuickMenuProps {
  app: App;
  isActive: boolean;
  tunnelError: string | null;
  onStartTunnel: () => void;
  onStopTunnel: () => void;
  // Instance cards only ever run throwaway quick (trycloudflare) tunnels —
  // named/Tailscale/Porta Relay tunnels don't map to a per-instance identity.
  // When true, hide everything except the quick-tunnel start/stop control.
  quickOnly?: boolean;
}

export default function TunnelQuickMenu({ app, isActive, tunnelError, onStartTunnel, onStopTunnel, quickOnly }: TunnelQuickMenuProps) {
  const [tunnelMenuOpen, setTunnelMenuOpen] = useState(false);
  const [tunnelUrlCopied, setTunnelUrlCopied] = useState(false);
  // Cached saved-tunnels list — hydrates instantly from the in-memory cache
  // populated by TunnelsSection. Falls back to an IPC fetch on first menu
  // open if the cache is empty.
  const [savedTunnels, setSavedTunnels] = useState<CloudflareTunnel[]>(() => getCachedTunnels());
  const [savedLoading, setSavedLoading] = useState(false);
  const [savedFetchTried, setSavedFetchTried] = useState(false);
  const [savedError, setSavedError] = useState<string | null>(null);
  // Which saved tunnel row is showing its inline hostname form. Single value
  // so only one row is expanded at a time; click again to collapse.
  const [expandedTunnel, setExpandedTunnel] = useState<string | null>(null);
  const [hostnameDraft, setHostnameDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [busyError, setBusyError] = useState<string | null>(null);
  // Porta Relay (self-hosted VPS) expose form state.
  const {
    remoteHosts, loadRemoteHosts, startTunnel, openSettingsSection,
    remoteRoutes, loadRemoteRoutes, wgStatuses, loadWgStatus, connecting,
  } = usePortaStore(
    useShallow((s) => ({
      remoteHosts: s.remoteHosts,
      loadRemoteHosts: s.loadRemoteHosts,
      startTunnel: s.startTunnel,
      openSettingsSection: s.openSettingsSection,
      remoteRoutes: s.remoteRoutes,
      loadRemoteRoutes: s.loadRemoteRoutes,
      wgStatuses: s.wgStatuses,
      loadWgStatus: s.loadWgStatus,
      // Connect in flight for this app/instance — drives the pulsing icon and
      // blocks re-clicks that would restart the tunnel mid-connect.
      connecting: s.tunnelConnecting[app.id] ?? false,
    })),
  );
  // Post-connect toast: set on the connecting→connected edge, auto-clears
  // after a short linger so the icon stays visible long enough to notice
  // before dropping back to hover-only.
  const [justConnected, setJustConnected] = useState(false);
  const [relayHostId, setRelayHostId] = useState("");
  const [relaySub, setRelaySub] = useState("");
  const [relayDomain, setRelayDomain] = useState("");
  const [pickerProvider, setPickerProvider] = useState<"cloudflare" | "tailscale" | "remote">("cloudflare");
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelSize = useMeasuredSize(panelRef, tunnelMenuOpen);
  const coords = useFloatingPosition({
    triggerRef,
    panelSize,
    active: tunnelMenuOpen,
    side: "bottom",
    align: "end",
    gap: 4,
  });

  const connected = app.tunnel_active && !!app.tunnel_url;
  const connectingNow = connecting || (app.tunnel_active && !app.tunnel_url);

  const prevConnected = useRef(connected);
  useEffect(() => {
    if (connected && !prevConnected.current) {
      prevConnected.current = true;
      setJustConnected(true);
      const t = setTimeout(() => setJustConnected(false), 4000);
      return () => clearTimeout(t);
    }
    prevConnected.current = connected;
    if (!connected) setJustConnected(false);
  }, [connected]);

  function loadSaved() {
    setSavedLoading(true);
    setSavedError(null);
    listCloudflareTunnels()
      .then((list) => {
        setSavedTunnels(list);
        setCachedTunnels(list);
      })
      .catch((e) => {
        setSavedError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setSavedLoading(false));
  }

  // Lazy fetch on first menu open. Uses cloudflared CLI (not API token), so
  // failure usually means CLI missing or not logged in — surface that to the
  // user instead of silently empty.
  useEffect(() => {
    if (!tunnelMenuOpen) return;
    if (hasTunnelCache() || savedFetchTried) return;
    setSavedFetchTried(true);
    loadSaved();
  }, [tunnelMenuOpen, savedFetchTried]);

  // Reset transient form state every time the menu closes so reopening doesn't
  // show a stale draft from a previous attempt.
  useEffect(() => {
    if (tunnelMenuOpen) return;
    setExpandedTunnel(null);
    setHostnameDraft("");
    setBusyError(null);
  }, [tunnelMenuOpen]);

  // On open, refresh remote hosts and default the relay subdomain to the app's
  // slug so a one-click expose has a sensible hostname.
  useEffect(() => {
    if (!tunnelMenuOpen) return;
    void loadRemoteHosts();
    void loadRemoteRoutes();
    setRelaySub((prev) => prev || app.subdomain || app.name);
    const prov = app.tunnel_provider;
    setPickerProvider(prov === "tailscale" || prov === "remote" ? prov : "cloudflare");
  }, [tunnelMenuOpen, loadRemoteHosts, loadRemoteRoutes, app.subdomain, app.name, app.tunnel_provider]);

  // The host selected in the relay form, and the domains it serves.
  const relaySelHost = remoteHosts.find((h) => h.id === (relayHostId || remoteHosts[0]?.id));
  const relayDomains = relaySelHost ? [relaySelHost.base_domain, ...relaySelHost.extra_domains].filter(Boolean) : [];
  const effectiveRelayDomain = relayDomains.includes(relayDomain) ? relayDomain : relayDomains[0] ?? "";

  const myRoute = remoteRoutes.find((r) => r.app_id === app.id);
  const hostWg = myRoute ? wgStatuses[myRoute.host_id] : undefined;
  const relayPending = myRoute?.status === "pending";
  const relayDegraded =
    app.tunnel_provider === "remote" &&
    app.tunnel_active &&
    !!hostWg &&
    (!hostWg.up || (hostWg.handshake_age_secs ?? 0) >= 300);

  // Refresh this app's host handshake while the menu is open so the degraded
  // indicator is live.
  useEffect(() => {
    if (tunnelMenuOpen && myRoute?.host_id) void loadWgStatus(myRoute.host_id);
  }, [tunnelMenuOpen, myRoute?.host_id, loadWgStatus]);

  async function exposeRelay() {
    const hostId = relayHostId || remoteHosts[0]?.id;
    if (!hostId) return;
    const subdomain = (relaySub.trim() || app.subdomain || app.name).trim();
    setBusy(true);
    setBusyError(null);
    try {
      await startTunnel(app.id, "remote", undefined, { hostId, subdomain, domain: effectiveRelayDomain || null });
      setTunnelMenuOpen(false);
    } catch (e) {
      setBusyError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function retryRelay() {
    if (!myRoute) return;
    setBusy(true);
    setBusyError(null);
    try {
      await startTunnel(app.id, "remote", undefined, {
        hostId: myRoute.host_id,
        subdomain: myRoute.subdomain,
      });
      await loadRemoteRoutes();
    } catch (e) {
      setBusyError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!isActive && !app.tunnel_active && !tunnelError) return null;

  const provider = app.tunnel_provider;
  const isTailscale = provider === "tailscale";
  const connectedColor = "text-emerald-400 hover:bg-emerald-500/10";
  const connectedTooltip = isTailscale
    ? "Tailscale connected"
    : provider === "cloudflare"
    ? "Cloudflare tunnel connected"
    : provider === "remote"
    ? relayDegraded
      ? "Porta Relay connected · tunnel degraded"
      : "Porta Relay connected"
    : "Tunnel connected";

  async function startWithConfig(tunnelName: string | null, hostname: string | null) {
    // Ignore re-clicks while a connect is already in flight — starting again
    // mid-connect restarts the shared connector and can drop the attempt.
    if (busy || connecting) return;
    setBusy(true);
    setBusyError(null);
    try {
      // Persist first — Rust start_tunnel reads from DB, not from args.
      await setTunnelConfig(app.id, "cloudflare", tunnelName, hostname);
      onStartTunnel();
      setTunnelMenuOpen(false);
    } catch (e) {
      setBusyError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function handleExpand(name: string) {
    if (expandedTunnel === name) {
      setExpandedTunnel(null);
      return;
    }
    // Pre-fill hostname only when expanding the tunnel that's currently
    // configured on this app — otherwise start blank so the user doesn't
    // accidentally route a foreign hostname onto a different tunnel.
    setHostnameDraft(name === app.tunnel_name ? (app.tunnel_custom_hostname ?? "") : "");
    setExpandedTunnel(name);
    setBusyError(null);
  }

  // The card hides its icon row until hover; the tunnel icon opts out of that
  // whenever it has something to say — connect in flight, failure, the
  // post-connect linger, or an open menu (the panel is portaled, so the row's
  // focus-within can't keep it visible).
  const forceVisible = connectingNow || justConnected || !!tunnelError || tunnelMenuOpen;

  return (
    <div
      className={`relative transition-opacity ${forceVisible ? "" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100"}`}
      ref={containerRef}
    >
      <Tooltip
        label={tunnelError ? "Tunnel failed" : connectingNow ? "Connecting…" : connected ? connectedTooltip : app.tunnel_active ? "Connecting…" : "Tunnel options"}
      >
        <button
          ref={triggerRef}
          onClick={(e) => { e.stopPropagation(); setTunnelMenuOpen((v) => !v); }}
          className={`p-1 rounded-md transition-colors ${
            tunnelError
              ? "text-red-400 hover:bg-red-500/10"
              : connectingNow
              ? "text-amber-400 hover:bg-amber-500/10"
              : relayDegraded
              ? "text-amber-400 hover:bg-amber-500/10"
              : connected
              ? connectedColor
              : "text-zinc-600 hover:text-zinc-300 hover:bg-white/[0.06]"
          }`}
        >
          {connectingNow ? (
            // Pulsing wifi glyph while the connect is settling — a clear
            // "working on it" state the card previously lacked.
            <svg className="animate-pulse" width="13" height="13" viewBox="0 0 13 13" fill="none">
              <path d="M4 5.5a3.5 3.5 0 0 1 5 0" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
              <path d="M2.5 4a5.5 5.5 0 0 1 8 0" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
              <circle cx="6.5" cy="8" r="1" fill="currentColor"/>
              <path d="M6.5 9v2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
            </svg>
          ) : app.tunnel_active && isTailscale ? (
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
              <circle cx="3" cy="3" r="1" fill="currentColor"/>
              <circle cx="6.5" cy="3" r="1" fill="currentColor"/>
              <circle cx="10" cy="3" r="1" fill="currentColor"/>
              <circle cx="3" cy="6.5" r="1" fill="currentColor"/>
              <circle cx="6.5" cy="6.5" r="1" fill="currentColor"/>
              <circle cx="10" cy="6.5" r="1" fill="currentColor"/>
              <circle cx="3" cy="10" r="1" fill="currentColor"/>
              <circle cx="6.5" cy="10" r="1" fill="currentColor"/>
              <circle cx="10" cy="10" r="1" fill="currentColor"/>
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
              <path d="M4 5.5a3.5 3.5 0 0 1 5 0" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
              <path d="M2.5 4a5.5 5.5 0 0 1 8 0" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
              <circle cx="6.5" cy="8" r="1" fill="currentColor"/>
              <path d="M6.5 9v2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
            </svg>
          )}
        </button>
      </Tooltip>

      {/* Connected toast — brief pill under the icon confirming the tunnel
          came up, with the bare hostname for a quick sanity check. */}
      {justConnected && !tunnelMenuOpen && (
        <div className="absolute right-0 top-full mt-1.5 z-50 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-[#1c1c1e] border border-emerald-500/25 shadow-lg whitespace-nowrap">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 pulse-dot shrink-0" />
          <span className="text-[11px] font-medium text-emerald-300">Tunnel connected</span>
          {app.tunnel_url && (
            <span className="text-[10px] font-mono text-zinc-500 truncate max-w-[180px]">
              {app.tunnel_url.replace(/^https?:\/\//, "")}
            </span>
          )}
        </div>
      )}

      {tunnelMenuOpen && createPortal(
        <>
          <div className="fixed inset-0 z-[55]" onClick={() => setTunnelMenuOpen(false)} />
          <div
            ref={panelRef}
            className="fixed z-[60] w-[280px] bg-[#1c1c1e] border border-white/[0.10] rounded-lg shadow-xl overflow-hidden"
            style={coords ? { top: coords.top, left: coords.left } : { top: -9999, left: -9999, visibility: "hidden" }}
          >
            {relayPending && (
              <div className="px-3 py-2 border-b border-amber-500/20 bg-amber-500/[0.06]">
                <p className="text-[10.5px] text-amber-300 leading-snug">
                  Pending — the VPS didn't confirm this route.
                </p>
                <button
                  onClick={() => void retryRelay()}
                  disabled={busy}
                  className="mt-1.5 px-2.5 py-1 text-[11px] font-medium bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 rounded-md disabled:opacity-50 transition-colors"
                >
                  {busy ? "Retrying…" : "Retry expose"}
                </button>
              </div>
            )}
            {app.tunnel_active && app.tunnel_url ? (
              <>
                <div className="px-3 py-2 border-b border-white/[0.06]">
                  <p className="text-[10px] text-zinc-500 mb-1 flex items-center gap-1.5">
                    <span className={`w-1.5 h-1.5 rounded-full ${relayDegraded ? "bg-amber-400" : "bg-emerald-400"}`} />
                    {isTailscale ? "Tailnet URL" : provider === "remote" ? "Porta Relay URL" : "Tunnel URL"}
                    {app.basic_auth_enabled && (
                      <svg width="9" height="9" viewBox="0 0 11 11" fill="none" aria-label="Protected by basic auth">
                        <rect x="2" y="5" width="7" height="5" rx="1" stroke="currentColor" strokeWidth="1.1" />
                        <path d="M3.5 5V3.5a2 2 0 014 0V5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
                      </svg>
                    )}
                  </p>
                  <p className="text-[11px] font-mono truncate text-emerald-300">{app.tunnel_url}</p>
                  {relayDegraded && (
                    <p className="text-[10px] text-amber-400 mt-1">
                      Tunnel degraded — last WireGuard handshake is stale.
                    </p>
                  )}
                </div>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(app.tunnel_url!).then(() => {
                      setTunnelUrlCopied(true);
                      setTimeout(() => { setTunnelUrlCopied(false); setTunnelMenuOpen(false); }, 1000);
                    });
                  }}
                  className="flex items-center gap-2 w-full px-3 py-2 text-[12px] text-zinc-300 hover:bg-white/[0.07] transition-colors"
                >
                  <svg width="11" height="11" viewBox="0 0 11 11" fill="none"><rect x="1" y="3.5" width="6" height="7" rx="1" stroke="currentColor" strokeWidth="1.2"/><path d="M3.5 3.5V2a.5.5 0 01.5-.5h5a.5.5 0 01.5.5v5.5a.5.5 0 01-.5.5H7.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
                  {tunnelUrlCopied ? "Copied!" : "Copy URL"}
                </button>
                <a
                  href={app.tunnel_url}
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => setTunnelMenuOpen(false)}
                  className="flex items-center gap-2 w-full px-3 py-2 text-[12px] text-zinc-300 hover:bg-white/[0.07] transition-colors"
                >
                  <svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M4.5 2H3a.5.5 0 00-.5.5v6a.5.5 0 00.5.5h5a.5.5 0 00.5-.5V7M6.5 2H9M9 2v2.5M9 2L5.5 5.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  Open in browser
                </a>
                <div className="border-t border-white/[0.06]">
                  <button
                    onClick={() => { onStopTunnel(); setTunnelMenuOpen(false); }}
                    className="flex items-center gap-2 w-full px-3 py-2 text-[12px] text-red-400 hover:bg-red-500/10 transition-colors"
                  >
                    <svg width="11" height="11" viewBox="0 0 11 11" fill="none"><rect x="2" y="2" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1.2"/></svg>
                    Disconnect
                  </button>
                </div>
              </>
            ) : app.tunnel_active ? (
              <div className="px-3 py-3">
                <TunnelStatusBadge tunnelActive={app.tunnel_active} tunnelUrl={app.tunnel_url} provider={app.tunnel_provider} />
              </div>
            ) : (
              <>
                {tunnelError && (
                  <div className="px-3 py-2 border-b border-white/[0.06] bg-red-500/[0.05]">
                    <p className="text-[10px] text-red-400 font-medium mb-0.5">Tunnel failed</p>
                    <p className="text-[11px] text-red-300/70 leading-snug break-words">{tunnelError}</p>
                  </div>
                )}
                {/* Provider picker — pick which expose backend to use. Hidden
                    in quickOnly mode: instances only ever run throwaway
                    quick tunnels, so Tailscale/Porta Relay/named tunnels
                    don't apply. */}
                {!quickOnly && (
                  <div className="flex gap-1 p-1.5 border-b border-white/[0.06]">
                    {([["cloudflare", "Cloudflare"], ["tailscale", "Tailscale"], ["remote", "Porta Relay"]] as const).map(([p, label]) => (
                      <button
                        key={p}
                        onClick={() => setPickerProvider(p)}
                        className={`flex-1 text-[10.5px] px-2 py-1 rounded-md transition-colors ${pickerProvider === p ? "bg-white/[0.12] text-white" : "text-zinc-400 hover:bg-white/[0.05]"}`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}
                {quickOnly ? (
                  <>
                    {/* Instances route through the parent's named tunnel when it
                        has one (derived `<sub>.<domain>` host, direct to the
                        worktree port); otherwise a throwaway quick tunnel. */}
                    <div className="px-3 pt-2 pb-1">
                      <p className="text-[9px] font-semibold uppercase tracking-wider text-zinc-500">
                        {app.tunnel_name ? "Named" : "Quick"}
                      </p>
                    </div>
                    <button
                      onClick={() => startWithConfig(null, null)}
                      disabled={busy || connecting}
                      className="flex items-center gap-2 w-full px-3 py-2 text-[12px] text-orange-400 hover:bg-orange-500/10 transition-colors disabled:opacity-50"
                    >
                      <svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M5.5 1.5C5.5 1.5 7.5 2.5 8.5 4.5c.5 1 .5 2 0 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/><path d="M5.5 1.5C5.5 1.5 3.5 2.5 2.5 4.5c-.5 1-.5 2 0 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/><circle cx="5.5" cy="5.5" r="4" stroke="currentColor" strokeWidth="1.2"/><path d="M1.5 5.5h8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
                      <span className="flex-1 text-left">{app.tunnel_name ? "Named tunnel" : "Quick tunnel"}</span>
                      <span className="text-[9px] text-zinc-500">{app.tunnel_name ?? "trycloudflare"}</span>
                    </button>
                    {busyError && (
                      <p className="px-3 py-1.5 text-[10px] text-red-400 font-mono whitespace-pre-wrap break-words border-t border-white/[0.06]">
                        {busyError}
                      </p>
                    )}
                  </>
                ) : pickerProvider === "tailscale" ? (
                  <button
                    onClick={() => { if (connecting) return; void startTunnel(app.id, "tailscale"); setTunnelMenuOpen(false); }}
                    className="flex items-center gap-2 w-full px-3 py-2 text-[12px] text-emerald-400 hover:bg-emerald-500/10 transition-colors"
                  >
                <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                  <circle cx="2.5" cy="2.5" r="0.9" fill="currentColor"/>
                  <circle cx="5.5" cy="2.5" r="0.9" fill="currentColor"/>
                  <circle cx="8.5" cy="2.5" r="0.9" fill="currentColor"/>
                  <circle cx="2.5" cy="5.5" r="0.9" fill="currentColor"/>
                  <circle cx="5.5" cy="5.5" r="0.9" fill="currentColor"/>
                  <circle cx="8.5" cy="5.5" r="0.9" fill="currentColor"/>
                  <circle cx="2.5" cy="8.5" r="0.9" fill="currentColor"/>
                  <circle cx="5.5" cy="8.5" r="0.9" fill="currentColor"/>
                  <circle cx="8.5" cy="8.5" r="0.9" fill="currentColor"/>
                </svg>
                Start Tailscale Serve
                  </button>
                ) : pickerProvider === "remote" ? (
                  remoteHosts.length === 0 ? (
                    <button
                      onClick={() => { openSettingsSection("remote"); setTunnelMenuOpen(false); }}
                      className="flex items-center gap-2 w-full px-3 py-2 text-[11px] text-zinc-400 hover:bg-white/[0.05] transition-colors"
                    >
                      <span className="flex-1 text-left">No remote servers — set one up</span>
                      <span className="text-[9px] text-zinc-500">Settings →</span>
                    </button>
                  ) : (
                    <div className="px-3 py-2 flex flex-col gap-1.5">
                      <p className="text-[9px] font-semibold uppercase tracking-wider text-zinc-500 flex items-center gap-1">
                        Expose via your VPS
                        {app.basic_auth_enabled && (
                          <svg width="8" height="8" viewBox="0 0 11 11" fill="none" aria-label="Will be protected by basic auth">
                            <rect x="2" y="5" width="7" height="5" rx="1" stroke="currentColor" strokeWidth="1.1" />
                            <path d="M3.5 5V3.5a2 2 0 014 0V5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
                          </svg>
                        )}
                      </p>
                      <select
                        value={relayHostId || remoteHosts[0].id}
                        onChange={(e) => { setRelayHostId(e.target.value); setRelayDomain(""); }}
                        className="input-base w-full text-[11.5px] py-1.5"
                      >
                        {remoteHosts.map((h) => (
                          <option key={h.id} value={h.id}>{h.name}</option>
                        ))}
                      </select>
                      {relayDomains.length > 1 && (
                        <select
                          value={effectiveRelayDomain}
                          onChange={(e) => setRelayDomain(e.target.value)}
                          className="input-base w-full text-[11.5px] py-1.5"
                          title="Domain"
                        >
                          {relayDomains.map((d) => (
                            <option key={d} value={d}>.{d}</option>
                          ))}
                        </select>
                      )}
                      <div className="flex items-center gap-1.5">
                        <input
                          value={relaySub}
                          onChange={(e) => setRelaySub(e.target.value)}
                          placeholder="subdomain"
                          spellCheck={false}
                          className="input-base flex-1 min-w-0 font-mono text-[11.5px] py-1.5"
                          onKeyDown={(e) => { if (e.key === "Enter") void exposeRelay(); }}
                        />
                        <span className="text-[10px] text-zinc-500 font-mono truncate max-w-[120px]" title={`.${effectiveRelayDomain}`}>.{effectiveRelayDomain}</span>
                      </div>
                      <button
                        onClick={() => void exposeRelay()}
                        disabled={busy}
                        className="px-2.5 py-1 text-[11px] font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-md disabled:opacity-40 transition-colors"
                      >
                        {busy ? "Exposing…" : "Expose via Porta Relay"}
                      </button>
                      {busyError && (
                        <p className="text-[10px] text-red-400 font-mono whitespace-pre-wrap break-words">{busyError}</p>
                      )}
                    </div>
                  )
                ) : (
                  <>
                    {/* Quick tunnel — trycloudflare random URL, throwaway. */}
                <div className="px-3 pt-2 pb-1">
                  <p className="text-[9px] font-semibold uppercase tracking-wider text-zinc-500">Quick</p>
                </div>
                <button
                  onClick={() => startWithConfig(null, null)}
                  disabled={busy || connecting}
                  className="flex items-center gap-2 w-full px-3 py-2 text-[12px] text-orange-400 hover:bg-orange-500/10 transition-colors disabled:opacity-50"
                >
                  <svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M5.5 1.5C5.5 1.5 7.5 2.5 8.5 4.5c.5 1 .5 2 0 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/><path d="M5.5 1.5C5.5 1.5 3.5 2.5 2.5 4.5c-.5 1-.5 2 0 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/><circle cx="5.5" cy="5.5" r="4" stroke="currentColor" strokeWidth="1.2"/><path d="M1.5 5.5h8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
                  <span className="flex-1 text-left">Quick tunnel</span>
                  <span className="text-[9px] text-zinc-500">trycloudflare</span>
                </button>

                {/* Saved named tunnels — pulled from cloudflared CLI. Each row
                    expands inline to show a hostname input + Start button. */}
                <div className="border-t border-white/[0.06] mt-1">
                  <div className="px-3 pt-2 pb-1 flex items-center justify-between">
                    <p className="text-[9px] font-semibold uppercase tracking-wider text-zinc-500">Saved tunnel</p>
                    <button
                      onClick={loadSaved}
                      disabled={savedLoading}
                      className="text-[9px] text-zinc-500 hover:text-zinc-200 transition-colors disabled:opacity-50"
                      title="Refresh"
                    >
                      {savedLoading ? (
                        <svg className="animate-spin" width="9" height="9" viewBox="0 0 12 12" fill="none">
                          <path d="M6 1.5A4.5 4.5 0 1 1 1.5 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                        </svg>
                      ) : "↻"}
                    </button>
                  </div>

                  {savedError && (
                    <div className="mx-2 mb-1.5 px-2 py-1.5 rounded bg-red-500/10 border border-red-500/30 text-[10px] text-red-300 leading-snug break-words">
                      {savedError}
                    </div>
                  )}

                  {!savedError && savedTunnels.length === 0 && !savedLoading && (
                    <p className="px-3 py-1.5 text-[10.5px] text-zinc-500">
                      No saved tunnels — create one in Settings → Cloudflare → Tunnels.
                    </p>
                  )}

                  <div className="max-h-[240px] overflow-y-auto">
                    {savedTunnels.map((t) => {
                      const isCurrent = app.tunnel_name === t.name;
                      const isExpanded = expandedTunnel === t.name;
                      return (
                        <div key={t.id}>
                          <button
                            onClick={() => handleExpand(t.name)}
                            disabled={busy}
                            className={`flex items-center gap-2 w-full px-3 py-1.5 text-[11.5px] transition-colors disabled:opacity-50 ${
                              isExpanded
                                ? "bg-white/[0.05] text-zinc-100"
                                : isCurrent
                                ? "text-orange-300 hover:bg-orange-500/[0.08]"
                                : "text-zinc-300 hover:bg-white/[0.05]"
                            }`}
                          >
                            <span
                              className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                                t.connection_count > 0 ? "bg-emerald-400" : "bg-zinc-600"
                              }`}
                              title={t.connection_count > 0 ? "Active connections" : "Idle"}
                            />
                            <span className="flex-1 text-left font-mono truncate">{t.name}</span>
                            {isCurrent && !isExpanded && (
                              <svg width="10" height="10" viewBox="0 0 11 11" fill="none">
                                <path d="M2 5.5l2.5 2.5 4.5-4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                              </svg>
                            )}
                            <svg
                              width="9"
                              height="9"
                              viewBox="0 0 11 11"
                              fill="none"
                              className={`text-zinc-500 transition-transform ${isExpanded ? "rotate-90" : ""}`}
                            >
                              <path d="M3.5 2l3.5 3.5L3.5 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                            </svg>
                          </button>
                          {isExpanded && (
                            <div className="px-3 pb-2 pt-1 bg-black/20 border-y border-white/[0.04] flex flex-col gap-1.5">
                              <div>
                                <p className="text-[9px] font-semibold uppercase tracking-wider text-zinc-500 mb-1">Hostname</p>
                                <input
                                  autoFocus
                                  value={hostnameDraft}
                                  onChange={(e) => setHostnameDraft(e.target.value)}
                                  placeholder="sub.zone.tld"
                                  spellCheck={false}
                                  className="input-base w-full font-mono text-[11.5px] py-1.5"
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter" && hostnameDraft.trim())
                                      void startWithConfig(t.name, hostnameDraft.trim());
                                    if (e.key === "Escape") setExpandedTunnel(null);
                                  }}
                                />
                              </div>
                              <div className="flex gap-1.5">
                                <button
                                  onClick={() => void startWithConfig(t.name, hostnameDraft.trim())}
                                  disabled={!hostnameDraft.trim() || busy || connecting}
                                  className="flex-1 px-2.5 py-1 text-[11px] font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-md disabled:opacity-40 transition-colors"
                                >
                                  {busy || connecting ? "Starting…" : "Start tunnel"}
                                </button>
                                <button
                                  onClick={() => setExpandedTunnel(null)}
                                  className="px-2 py-1 text-[11px] text-zinc-400 hover:text-zinc-200 transition-colors"
                                >
                                  Cancel
                                </button>
                              </div>
                              {busyError && (
                                <p className="text-[10px] text-red-400 font-mono whitespace-pre-wrap break-words">{busyError}</p>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>

                {busyError && !expandedTunnel && (
                  <p className="px-3 py-1.5 text-[10px] text-red-400 font-mono whitespace-pre-wrap break-words border-t border-white/[0.06]">
                    {busyError}
                  </p>
                )}
                  </>
                )}
              </>
            )}
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}
