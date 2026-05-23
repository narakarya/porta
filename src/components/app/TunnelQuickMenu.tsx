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

interface TunnelQuickMenuProps {
  app: App;
  isActive: boolean;
  tunnelError: string | null;
  onStartTunnel: () => void;
  onStopTunnel: () => void;
}

export default function TunnelQuickMenu({ app, isActive, tunnelError, onStartTunnel, onStopTunnel }: TunnelQuickMenuProps) {
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

  if (!isActive && !app.tunnel_active && !tunnelError) return null;

  const provider = app.tunnel_provider;
  const isTailscale = provider === "tailscale";
  const connectedColor = isTailscale
    ? "text-emerald-400 hover:bg-emerald-500/10"
    : "text-orange-400 hover:bg-orange-500/10";
  const connectedTooltip = isTailscale
    ? "Tailscale connected"
    : provider === "cloudflare"
    ? "Cloudflare tunnel connected"
    : "Tunnel connected";

  async function startWithConfig(tunnelName: string | null, hostname: string | null) {
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

  return (
    <div className="relative" ref={containerRef}>
      <Tooltip
        label={tunnelError ? "Tunnel failed" : app.tunnel_active && app.tunnel_url ? connectedTooltip : app.tunnel_active ? "Connecting…" : "Tunnel options"}
      >
        <button
          ref={triggerRef}
          onClick={(e) => { e.stopPropagation(); setTunnelMenuOpen((v) => !v); }}
          className={`p-1 rounded-md transition-colors ${
            tunnelError
              ? "text-red-400 hover:bg-red-500/10"
              : app.tunnel_active && app.tunnel_url
              ? connectedColor
              : app.tunnel_active
              ? "text-amber-400 hover:bg-amber-500/10"
              : "text-zinc-600 hover:text-zinc-300 hover:bg-white/[0.06]"
          }`}
        >
          {app.tunnel_active && !app.tunnel_url ? (
            <svg className="animate-spin" width="13" height="13" viewBox="0 0 13 13" fill="none">
              <path d="M6.5 1.5A5 5 0 1 1 1.5 6.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
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

      {tunnelMenuOpen && createPortal(
        <>
          <div className="fixed inset-0 z-[55]" onClick={() => setTunnelMenuOpen(false)} />
          <div
            ref={panelRef}
            className="fixed z-[60] w-[280px] bg-[#1c1c1e] border border-white/[0.10] rounded-lg shadow-xl overflow-hidden"
            style={coords ? { top: coords.top, left: coords.left } : { top: -9999, left: -9999, visibility: "hidden" }}
          >
            {app.tunnel_active && app.tunnel_url ? (
              <>
                <div className="px-3 py-2 border-b border-white/[0.06]">
                  <p className="text-[10px] text-zinc-500 mb-1 flex items-center gap-1.5">
                    <span className={`w-1.5 h-1.5 rounded-full ${isTailscale ? "bg-emerald-400" : "bg-orange-400"}`} />
                    {isTailscale ? "Tailnet URL" : "Tunnel URL"}
                  </p>
                  <p className={`text-[11px] font-mono truncate ${isTailscale ? "text-emerald-300" : "text-orange-300"}`}>{app.tunnel_url}</p>
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
            ) : tunnelError ? (
              <>
                <div className="px-3 py-2 border-b border-white/[0.06]">
                  <p className="text-[10px] text-red-400 font-medium mb-0.5">Tunnel failed</p>
                  <p className="text-[11px] text-red-300/70 leading-snug break-words">{tunnelError}</p>
                </div>
                <button
                  onClick={() => { onStartTunnel(); setTunnelMenuOpen(false); }}
                  className="flex items-center gap-2 w-full px-3 py-2 text-[12px] text-sky-400 hover:bg-sky-500/10 transition-colors"
                >
                  <svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M2 5.5a3.5 3.5 0 0 1 7 0" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/><path d="M5.5 7v2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/><circle cx="5.5" cy="4" r="0.8" fill="currentColor"/></svg>
                  Retry tunnel
                </button>
              </>
            ) : isTailscale ? (
              <button
                onClick={() => { onStartTunnel(); setTunnelMenuOpen(false); }}
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
            ) : (
              <>
                {/* Quick tunnel — trycloudflare random URL, throwaway. */}
                <div className="px-3 pt-2 pb-1">
                  <p className="text-[9px] font-semibold uppercase tracking-wider text-zinc-500">Quick</p>
                </div>
                <button
                  onClick={() => startWithConfig(null, null)}
                  disabled={busy}
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
                                  disabled={!hostnameDraft.trim() || busy}
                                  className="flex-1 px-2.5 py-1 text-[11px] font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-md disabled:opacity-40 transition-colors"
                                >
                                  {busy ? "Starting…" : "Start tunnel"}
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
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}
