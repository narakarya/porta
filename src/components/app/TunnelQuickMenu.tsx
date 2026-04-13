import { useState } from "react";
import type { App } from "../../types";
import Tooltip from "../shared/Tooltip";
import TunnelStatusBadge from "../shared/TunnelStatusBadge";

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

  if (!isActive && !app.tunnel_active && !tunnelError) return null;

  return (
    <div className="relative">
      <Tooltip
        label={tunnelError ? "Tunnel failed" : app.tunnel_active && app.tunnel_url ? "Tunnel connected" : app.tunnel_active ? "Connecting…" : "Quick Tunnel"}
      >
        <button
          onClick={(e) => { e.stopPropagation(); setTunnelMenuOpen((v) => !v); }}
          className={`p-1 rounded-md transition-colors ${
            tunnelError
              ? "text-red-400 hover:bg-red-500/10"
              : app.tunnel_active && app.tunnel_url
              ? "text-sky-400 hover:bg-sky-500/10"
              : app.tunnel_active
              ? "text-amber-400 hover:bg-amber-500/10"
              : "text-zinc-600 hover:text-zinc-300 hover:bg-white/[0.06]"
          }`}
        >
          {app.tunnel_active && !app.tunnel_url ? (
            <svg className="animate-spin" width="13" height="13" viewBox="0 0 13 13" fill="none">
              <path d="M6.5 1.5A5 5 0 1 1 1.5 6.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
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

      {tunnelMenuOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setTunnelMenuOpen(false)} />
          <div className="absolute right-0 top-full mt-1 z-50 w-[220px] bg-[#1c1c1e] border border-white/[0.10] rounded-lg shadow-xl overflow-hidden">
            {app.tunnel_active && app.tunnel_url ? (
              <>
                <div className="px-3 py-2 border-b border-white/[0.06]">
                  <p className="text-[10px] text-zinc-500 mb-1">Tunnel URL</p>
                  <p className="text-[11px] font-mono text-sky-300 truncate">{app.tunnel_url}</p>
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
                <TunnelStatusBadge tunnelActive={app.tunnel_active} tunnelUrl={app.tunnel_url} />
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
                  Retry Tunnel
                </button>
              </>
            ) : (
              <button
                onClick={() => { onStartTunnel(); setTunnelMenuOpen(false); }}
                className="flex items-center gap-2 w-full px-3 py-2 text-[12px] text-sky-400 hover:bg-sky-500/10 transition-colors"
              >
                <svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M5.5 1.5C5.5 1.5 7.5 2.5 8.5 4.5c.5 1 .5 2 0 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/><path d="M5.5 1.5C5.5 1.5 3.5 2.5 2.5 4.5c-.5 1-.5 2 0 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/><circle cx="5.5" cy="5.5" r="4" stroke="currentColor" strokeWidth="1.2"/><path d="M1.5 5.5h8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
                Start Quick Tunnel
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
