import { useState } from "react";
import { openExternalUrl } from "../../../../lib/commands";
import { Spinner } from "../../../ui";
import { useAppConfig } from "../AppConfigContext";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function CopyIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.6" stroke="currentColor" strokeWidth="1.3" />
      <path d="M10.5 3.5H3.8A1.3 1.3 0 0 0 2.5 4.8v6.7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function OpenIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <path d="M9 3h4v4M13 3 7.5 8.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 10v2.5a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1H6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" className="shrink-0 mt-px">
      <path d="M8 5.5V9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="8" cy="11.3" r=".9" fill="currentColor" />
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

const iconBtn =
  "inline-flex items-center justify-center w-6 h-6 rounded-[6px] text-ink-3 hover:text-ink hover:bg-white/[0.06] transition-colors shrink-0 disabled:opacity-40";

/**
 * The tunnel section's **single** status surface (mockup 32).
 *
 * It replaced four stacked boxes — a Connected badge, the URL row, an amber
 * "Accessible hosts" list and a green "Reachable" bar — that each reported a
 * slice of the same fact and, between them, could disagree. Everything about
 * what is running now lives here and nowhere else: provider, public URL,
 * reachability, local→public routing, the tunnel it rides on, the extra hosts
 * it serves, and the two conditions that need the user (drifted config,
 * unreachable endpoint).
 *
 * The configuration form deliberately does NOT appear here — see
 * TunnelDisclosure in TunnelingSection.
 */
export default function TunnelStatusStrip() {
  const c = useAppConfig();
  const [hostsOpen, setHostsOpen] = useState(false);

  const live = c.selectedIsLive;
  const busy = c.tunnelBusy;
  const drifted = c.liveTunnelConfigDrifted;
  const unreachable = live && c.tunnelReachable === false;
  const needsAttention = drifted || unreachable;

  // Extra hosts beyond the URL already on screen. A single-host tunnel needs no
  // list at all — the URL row is the list.
  const extraHosts = c.liveTunnelHosts.filter((h) => h.kind !== "primary");

  const tone = needsAttention
    ? "border-[var(--warning-border)] bg-warn-bg/40"
    : live
      ? "border-[rgba(74,222,128,.28)] bg-[rgba(74,222,128,.05)]"
      : "border-subtle bg-surface-2";

  const providerLabel = c.tunnelProvider === "tailscale" ? "Tailscale" : "Cloudflare";

  return (
    <div className={`rounded-lg border overflow-hidden ${tone}`}>
      {/* ── status line ── */}
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-0.5 flex-wrap">
        {busy ? (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10.5px] font-semibold tracking-wide bg-white/[0.06] text-ink-3">
            <Spinner size={10} />
            {busy === "connecting" ? "CONNECTING" : "DISCONNECTING"}
          </span>
        ) : live ? (
          <span
            className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10.5px] font-semibold tracking-wide ${
              unreachable ? "bg-warn-bg text-warn" : "bg-ok-bg text-ok"
            }`}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-current" />
            {unreachable ? "LIVE · UNREACHABLE" : "LIVE"}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10.5px] font-semibold tracking-wide bg-white/[0.06] text-ink-3">
            <span className="w-1.5 h-1.5 rounded-full bg-current" />
            NOT PUBLISHED
          </span>
        )}

        <span className="text-[11px] text-ink-3 min-w-0 truncate">
          {busy
            ? `${providerLabel} · ${busy === "connecting" ? "starting connector…" : "shutting down…"}`
            : live
              ? `${providerLabel}${c.tunnelReachable === true ? " · reachable" : ""}`
              : `localhost:${c.app.port} is only reachable on this machine`}
        </span>

        <span className="ml-auto shrink-0">
          {live ? (
            <button
              type="button"
              onClick={c.handleDisconnect}
              disabled={busy !== null}
              className="px-2.5 py-1 rounded-[7px] text-[11px] font-medium text-ink-2 border border-subtle hover:bg-white/[0.06] disabled:opacity-50 transition-colors"
            >
              {busy === "disconnecting" ? "Disconnecting…" : "Disconnect"}
            </button>
          ) : !busy && !c.tunnelSettingsOpen ? (
            <button
              type="button"
              onClick={() => c.setTunnelSettingsOpen(true)}
              className="px-2.5 py-1 rounded-[7px] text-[11px] font-medium text-white bg-accent border border-[var(--accent-border)] hover:brightness-110 transition-colors"
            >
              Publish…
            </button>
          ) : null}
        </span>
      </div>

      {/* ── public URL ── */}
      {(live || busy === "connecting") && (
        <div className="flex items-center gap-2 px-3 pt-1.5">
          <span
            className={`flex-1 min-w-0 truncate font-mono text-[13px] ${
              c.app.tunnel_url ? "text-ink" : "text-ink-3"
            }`}
            title={c.app.tunnel_url ?? undefined}
          >
            {c.app.tunnel_url ?? c.tunnelHostname.trim()}
          </span>
          {c.app.tunnel_url && (
            <>
              <button
                type="button"
                title={c.tunnelUrlCopied ? "Copied!" : "Copy"}
                onClick={() => {
                  navigator.clipboard.writeText(c.app.tunnel_url!).then(() => {
                    c.setTunnelUrlCopied(true);
                    setTimeout(() => c.setTunnelUrlCopied(false), 1500);
                  });
                }}
                className={`${iconBtn} ${c.tunnelUrlCopied ? "text-ok" : ""}`}
              >
                <CopyIcon />
              </button>
              <button
                type="button"
                title="Open in browser"
                disabled={!isTauri}
                onClick={() => { if (isTauri) void openExternalUrl(c.app.tunnel_url!); }}
                className={iconBtn}
              >
                <OpenIcon />
              </button>
            </>
          )}
        </div>
      )}

      {/* ── routing + the tunnel it rides on ── */}
      {(live || busy === "connecting") && (
        <div className="flex items-center gap-1.5 flex-wrap px-3 pt-1 pb-2.5 text-[11px] text-ink-3">
          <span className="font-mono text-ink-2">localhost:{c.app.port}</span>
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" className="opacity-55">
            <path d="M3 8h9M9 5l3 3-3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="font-mono text-ink-2">public</span>
          {c.app.tunnel_name && (
            <>
              <span className="opacity-40">·</span>
              <span>
                tunnel <span className="font-mono text-ink-2">{c.app.tunnel_name}</span>
              </span>
            </>
          )}
        </div>
      )}

      {/* ── extra live hosts, folded ── */}
      {live && extraHosts.length > 0 && (
        <div className="border-t border-subtle px-3 py-2">
          <button
            type="button"
            onClick={() => setHostsOpen((v) => !v)}
            aria-expanded={hostsOpen}
            className="flex items-center gap-2 w-full text-[11.5px] text-ink-2"
          >
            <svg
              width="11"
              height="11"
              viewBox="0 0 16 16"
              fill="none"
              className={`text-ink-3 transition-transform duration-150 ${hostsOpen ? "rotate-90" : ""}`}
            >
              <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Also serving
            <span className="ml-auto text-[10px] font-mono text-ink-3">
              {c.liveTunnelHosts.length} hosts
            </span>
          </button>
          {hostsOpen && (
            <ul className="mt-1.5 space-y-1">
              {extraHosts.map(({ host, kind }) => (
                <li key={host} className="flex items-center gap-2 font-mono text-[11.5px] text-ink-2 min-w-0">
                  <span className="w-1.5 h-1.5 rounded-full bg-ok shrink-0" />
                  <span className="truncate" title={host}>{host}</span>
                  <span className="ml-auto shrink-0 font-sans text-[10px] text-ink-3">
                    {kind === "binding" ? "port binding" : "extra subdomain"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* ── the two things that need the user ──
          Drift states the fact and points at Settings, where the single
          Reconnect lives. It does not offer a second one. */}
      {drifted && (
        <div className="flex items-start gap-2 px-3 py-2 border-t border-[var(--warning-border)] bg-[rgba(251,191,36,0.07)] text-[11.5px] text-warn">
          <AlertIcon />
          <span className="flex-1 leading-relaxed">
            Running with the previous settings — your edits aren't applied yet.
          </span>
          {!c.tunnelSettingsOpen && (
            <button
              type="button"
              onClick={() => c.setTunnelSettingsOpen(true)}
              className="shrink-0 px-2 py-0.5 rounded-[6px] text-[11px] font-medium border border-[var(--warning-border)] hover:bg-[rgba(251,191,36,0.16)] transition-colors"
            >
              Review
            </button>
          )}
        </div>
      )}

      {unreachable && (
        <div className="flex items-start gap-2 px-3 py-2 border-t border-[var(--warning-border)] bg-[rgba(251,191,36,0.07)] text-[11.5px] text-warn">
          <AlertIcon />
          <span className="flex-1 leading-relaxed">
            The tunnel endpoint doesn't answer — that's the tunnel, not your app (an app that's up
            but erroring would still respond).{" "}
            {c.app.tunnel_provider === "cloudflare"
              ? "Usually the DNS record for this hostname is missing."
              : "Check that the Tailscale serve/funnel is still up."}
            {c.dnsRepairError && (
              <span className="block mt-1 font-mono text-[10px] text-bad">{c.dnsRepairError}</span>
            )}
          </span>
          {c.app.tunnel_provider === "cloudflare" && c.app.tunnel_name && (
            <button
              type="button"
              disabled={c.dnsRepairing}
              onClick={() => c.repairDns()}
              className="shrink-0 px-2 py-0.5 rounded-[6px] text-[11px] font-medium border border-[var(--warning-border)] hover:bg-[rgba(251,191,36,0.16)] disabled:opacity-50 transition-colors"
            >
              {c.dnsRepairing ? "Repairing…" : "Repair DNS"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
