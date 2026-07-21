import { setTunnelConfig } from "../../../lib/commands";
import SetupCard from "../../shared/SetupCard";
import Field from "../../shared/Field";
import TunnelStatusBadge from "../../shared/TunnelStatusBadge";
import CloudflareAccessPanel from "../CloudflareAccessPanel";
import psl from "psl";
import { useAppConfig, pickBestHostname, type TunnelPublicHost } from "./AppConfigContext";

function TunnelPublicHostsPanel({ hosts, title = "This app will expose" }: { hosts: TunnelPublicHost[]; title?: string }) {
  if (hosts.length === 0) return null;

  return (
    <div className="mt-3 rounded-lg bg-warn-bg border border-[rgba(251,191,36,0.15)] overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-[rgba(251,191,36,0.1)]">
        <p className="text-[10px] text-ink-2 font-medium">{title}</p>
        <span className="text-[9px] uppercase tracking-wider text-warn leading-none">
          {hosts.length} {hosts.length === 1 ? "host" : "hosts"}
        </span>
      </div>
      <ul className="px-3 py-2 space-y-1">
        {hosts.map(({ host, kind }) => (
          <li key={host} className="flex items-center gap-2 font-mono text-[11px] text-warn min-w-0">
            {/* Filled dot for the primary host, hollow for extras / port bindings. */}
            <span
              className={`shrink-0 w-1.5 h-1.5 rounded-full ${
                kind === "primary"
                  ? "bg-warn"
                  : "border border-[rgba(251,191,36,0.5)] bg-transparent"
              }`}
              aria-label={kind === "primary" ? "primary" : kind}
            />
            <span className="truncate" title={host}>{host}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function TunnelingSection() {
  const c = useAppConfig();

  return (
    <>
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-widest text-ink-2">Public tunnel</p>
        <p className="text-[12px] text-ink-3 mt-1">Expose this app to the internet via a secure tunnel.</p>
      </div>

      <div className="flex flex-col gap-5 p-5 rounded-card bg-surface-1 border border-subtle">
        <div className="flex items-center justify-between gap-4">
          <div className="flex flex-col gap-1.5 flex-1 min-w-0">
            <label className="text-[12px] font-medium text-ink-2">Provider</label>
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

          {/* Status badge — reflects the SELECTED provider, so the
              Tailscale tab reads "Disconnected" even while Cloudflare
              is live underneath (and vice versa). */}
          <TunnelStatusBadge
            tunnelActive={c.selectedIsLive}
            tunnelUrl={c.selectedIsLive ? c.app.tunnel_url : null}
            provider={c.tunnelProvider}
            className="mt-4"
          />
        </div>

        {c.selectedIsLive && !c.app.tunnel_url && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-warn-bg border border-[rgba(251,191,36,0.25)]">
            <svg className="animate-spin shrink-0 text-warn" width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M6 1.5A4.5 4.5 0 1 1 1.5 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
            <span className="text-[11px] text-warn">Establishing tunnel…</span>
          </div>
        )}

        {c.selectedIsLive && c.app.tunnel_url && (
          <>
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-ok-bg border border-[rgba(52,211,153,0.25)]">
              <svg width="12" height="12" viewBox="0 0 10 10" fill="none" className="text-ok shrink-0">
                <circle cx="5" cy="5" r="4" stroke="currentColor" strokeWidth="1.1"/>
                <ellipse cx="5" cy="5" rx="2" ry="4" stroke="currentColor" strokeWidth="1.1"/>
                <path d="M1 5h8" stroke="currentColor" strokeWidth="1.1"/>
              </svg>
              <span className="text-[11px] font-mono text-ok truncate flex-1">
                {c.app.tunnel_url}
              </span>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(c.app.tunnel_url!).then(() => {
                    c.setTunnelUrlCopied(true);
                    setTimeout(() => c.setTunnelUrlCopied(false), 1500);
                  });
                }}
                className={`text-[10px] font-medium shrink-0 transition-colors ${c.tunnelUrlCopied ? "text-ok" : ""}`}
              >
                {c.tunnelUrlCopied ? "Copied!" : "Copy"}
              </button>
            </div>
            <TunnelPublicHostsPanel hosts={c.liveTunnelHosts} title="Accessible hosts" />
            {c.tunnelReachable === false && (
              <div className="flex items-start gap-2 px-3 py-1.5 rounded-lg bg-warn-bg border border-[rgba(251,191,36,0.25)]">
                <span className="w-1.5 h-1.5 mt-1 rounded-full bg-warn shrink-0" />
                <span className="text-[11px] text-warn">
                  Tunnel endpoint not reachable — the tunnel itself looks down, not your app
                  (an app that's up but erroring would still respond).{" "}
                  {c.app.tunnel_provider === "cloudflare"
                    ? "Check the DNS route and that cloudflared is connected."
                    : "Check that the Tailscale serve/funnel is still up."}
                </span>
              </div>
            )}
            {c.tunnelReachable === true && (
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-ok-bg border border-[rgba(52,211,153,0.15)]">
                <span className="w-1.5 h-1.5 rounded-full bg-ok shrink-0" />
                <span className="text-[11px] text-ok">Reachable</span>
              </div>
            )}
          </>
        )}

        {!c.selectedIsLive && c.tunnelProvider === "cloudflare" && (
          <Field label="Mode">
            <div className="flex gap-1 bg-surface-1 border border-subtle rounded-lg p-1 mb-2">
              {(["quick", "named"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => c.setTunnelMode(m)}
                  className={`flex-1 px-3 py-1.5 text-[12px] font-medium rounded-md transition-colors ${
                    c.tunnelMode === m ? "bg-surface-2 text-ink" : "text-ink-3 hover:text-ink-2"
                  }`}
                >
                  {m === "quick" ? "Quick (random URL)" : "Named (custom domain)"}
                </button>
              ))}
            </div>

            {c.tunnelMode === "named" && (() => {
              const needsInstall = c.cloudflaredInstalled === false;
              const needsLogin =
                c.cloudflaredInstalled === true &&
                !!c.tunnelsError &&
                (c.tunnelsError.toLowerCase().includes("login") ||
                  c.tunnelsError.toLowerCase().includes("unauthorized") ||
                  c.tunnelsError.toLowerCase().includes("not logged in"));
              const needsCreateTunnel =
                c.cloudflaredInstalled === true &&
                !c.tunnelsError &&
                c.availableTunnels.length === 0 &&
                !c.tunnelsLoading;

              return (
                <div className="flex flex-col gap-3 mt-2">
                  {/* Step 1 — install cloudflared */}
                  {needsInstall && (
                    <SetupCard
                      step={1}
                      title="Install cloudflared"
                      body="Porta couldn't find the cloudflared CLI on your machine."
                      cmd="brew install cloudflare/cloudflare/cloudflared"
                      copied={c.copiedCmd}
                      onCopy={c.copyCmd}
                      onRecheck={c.refreshTunnels}
                      recheckLabel="I've installed it"
                      loading={c.tunnelsLoading}
                    />
                  )}

                  {/* Step 2 — login */}
                  {needsLogin && (
                    <SetupCard
                      step={2}
                      title="Log in to Cloudflare"
                      body="Run this once — opens your browser for the OAuth flow."
                      cmd="cloudflared login"
                      copied={c.copiedCmd}
                      onCopy={c.copyCmd}
                      onRecheck={c.refreshTunnels}
                      recheckLabel="I've logged in"
                      loading={c.tunnelsLoading}
                    />
                  )}

                  {/* Step 3 — create first tunnel */}
                  {needsCreateTunnel && (
                    <SetupCard
                      step={3}
                      title="Create your first tunnel"
                      body="Give it any name — you'll see it in the dropdown after."
                      cmd="cloudflared tunnel create porta"
                      copied={c.copiedCmd}
                      onCopy={c.copyCmd}
                      onRecheck={c.refreshTunnels}
                      recheckLabel="I've created it"
                      loading={c.tunnelsLoading}
                    />
                  )}

                  {/* Ready state — show form */}
                  {!needsInstall && !needsLogin && !needsCreateTunnel && (
                    <>
                      <div>
                        <div className="flex items-center gap-2 mb-1.5">
                          <span className="text-[11px] font-medium text-ink-2">Cloudflare Tunnel</span>
                          <button
                            type="button"
                            onClick={c.refreshTunnels}
                            disabled={c.tunnelsLoading}
                            className="text-[10px] text-ink-3 hover:text-ink transition-colors disabled:opacity-50"
                          >
                            {c.tunnelsLoading ? "Loading…" : "↻ Refresh"}
                          </button>
                        </div>
                        {c.tunnelsLoading && c.availableTunnels.length === 0 ? (
                          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-1 border border-subtle text-[12px] text-ink-3">
                            <svg className="animate-spin" width="11" height="11" viewBox="0 0 12 12" fill="none">
                              <path d="M6 1.5A4.5 4.5 0 1 1 1.5 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                            </svg>
                            Loading tunnels…
                          </div>
                        ) : c.availableTunnels.length > 0 ? (
                          <div className="relative">
                            <select
                              value={c.tunnelName}
                              onChange={(e) => {
                                const nextName = e.target.value;
                                c.setTunnelName(nextName);
                                // Auto-fill hostname from existing DNS routes pointing
                                // to the picked tunnel — only when the field is empty
                                // so we never overwrite a user-typed value. Picks the
                                // route whose subdomain best matches the app's identity.
                                if (!c.tunnelHostname.trim() && nextName) {
                                  const picked = c.availableTunnels.find((t) => t.name === nextName);
                                  if (picked) {
                                    const matched = c.dnsRoutes
                                      .filter((r) => r.tunnel_id === picked.id)
                                      .map((r) => r.hostname);
                                    const best = pickBestHostname(matched, c.app);
                                    if (best) c.setTunnelHostname(best);
                                  }
                                }
                              }}
                              className="w-full appearance-none bg-surface-input border border-subtle rounded-lg px-3 py-2 text-[13px] text-ink outline-none focus:border-accent transition-colors pr-8 cursor-pointer"
                            >
                              <option value="">Select a tunnel…</option>
                              {c.availableTunnels.map((t) => (
                                <option key={t.id} value={t.name}>
                                  {t.name}
                                </option>
                              ))}
                            </select>
                            <svg className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none" width="10" height="10" viewBox="0 0 10 10" fill="none">
                              <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                            </svg>
                          </div>
                        ) : (
                          <input
                            spellCheck={false}
                            value={c.tunnelName}
                            onChange={(e) => c.setTunnelName(e.target.value)}
                            className="input-base font-mono text-[12px]"
                            placeholder="my-tunnel-name"
                          />
                        )}
                        {c.tunnelsError && (
                          <p className="text-[10px] text-warn mt-1 font-mono whitespace-pre-wrap">{c.tunnelsError}</p>
                        )}
                      </div>

                      <div>
                        <span className="text-[11px] font-medium text-ink-2 block mb-1.5">Hostname</span>
                        {(() => {
                          // Infer the most common base domain (eTLD+1) from the
                          // routes already pointing at this tunnel. Powers two UX
                          // wins: a realistic placeholder and on-blur subdomain
                          // completion (`admin` → `admin.sidiq.sch.id`).
                          const picked = c.availableTunnels.find((t) => t.name === c.tunnelName);
                          const matched = picked ? c.dnsRoutes.filter((r) => r.tunnel_id === picked.id) : [];
                          const baseCounts = new Map<string, number>();
                          for (const r of matched) {
                            const p = psl.parse(r.hostname.toLowerCase());
                            if ("domain" in p && p.domain) {
                              baseCounts.set(p.domain, (baseCounts.get(p.domain) ?? 0) + 1);
                            }
                          }
                          // Tie-break alphabetically so the placeholder is stable
                          // across renders even when two domains have equal counts.
                          const dominantBase = [...baseCounts.entries()]
                            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
                          const placeholder = dominantBase ? `myapp.${dominantBase}` : "myapp.example.com";

                          function autocomplete() {
                            const v = c.tunnelHostname.trim();
                            if (!v || !dominantBase) return;
                            // Only fill the base when the user typed a bare
                            // subdomain. A trailing dot also means "I want the
                            // base appended" — e.g. "admin." → "admin.<base>".
                            if (!v.includes(".")) {
                              c.setTunnelHostname(`${v}.${dominantBase}`);
                            } else if (v.endsWith(".")) {
                              c.setTunnelHostname(`${v}${dominantBase}`);
                            }
                          }

                          return (
                            <>
                              <input
                                spellCheck={false}
                                // Suppress every flavor of browser autocomplete /
                                // autofill — Chrome ignores `off` for inputs that
                                // *look* address-like, but the random-name +
                                // data-1p-ignore combo defeats both Chrome's
                                // built-in dropdown and 1Password's overlay.
                                autoComplete="off"
                                autoCorrect="off"
                                autoCapitalize="off"
                                name={`tunnel-hostname-${c.app.id}`}
                                data-1p-ignore="true"
                                data-lpignore="true"
                                value={c.tunnelHostname}
                                onChange={(e) => c.setTunnelHostname(e.target.value)}
                                onBlur={autocomplete}
                                onKeyDown={(e) => {
                                  // Tab without modifiers expands to full hostname
                                  // before focus moves on — feels native, not magic.
                                  if (e.key === "Tab" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
                                    const v = c.tunnelHostname.trim();
                                    if (dominantBase && v && (!v.includes(".") || v.endsWith("."))) {
                                      e.preventDefault();
                                      autocomplete();
                                    }
                                  }
                                }}
                                className="input-base font-mono text-[12px]"
                                placeholder={placeholder}
                              />
                              <p className="text-[10px] text-ink-3 mt-1">
                                DNS route auto-created on Connect (domain must be in your Cloudflare zone).
                                {dominantBase && (
                                  <>
                                    {" "}Type a subdomain — Tab or click away to append <span className="font-mono text-ink-3">.{dominantBase}</span>.
                                  </>
                                )}
                              </p>
                            </>
                          );
                        })()}
                        <TunnelPublicHostsPanel hosts={c.configuredTunnelHosts} />
                      </div>

                      {/* Cloudflare Access (Zero Trust) — login wall in
                          front of the public hostname. Only meaningful
                          for named tunnels (the hostname must live in
                          the user's Cloudflare account). */}
                      <CloudflareAccessPanel
                        savedHostname={c.tunnelMode === "named" ? (c.app.tunnel_custom_hostname ?? "") : ""}
                        liveHostname={c.tunnelHostname}
                        cfToken={c.cfApiToken && c.cfApiToken.length > 0 ? c.cfApiToken : null}
                      />

                      {/* Public alias domain — wildcard hostname pattern
                          Caddy also routes to this app. With Host
                          rewrite ON the upstream sees its native
                          domain, so multi-tenant apps that key on
                          hostname keep working unchanged. */}
                      <div className="mt-4 pt-4 border-t border-subtle space-y-2">
                        <p className="text-[11px] font-medium text-ink-2">
                          Public alias domain
                          <span className="ml-2 text-[9px] uppercase tracking-wider text-ink-3">advanced</span>
                        </p>
                        <p className="text-[10px] text-ink-3 leading-relaxed">
                          Caddy also serves this app at the alias hostname pattern. Use a wildcard like <span className="font-mono text-ink-2">*.example.com</span> to expose every subdomain through the tunnel. Leave blank to disable.
                        </p>
                        <input
                          type="text"
                          value={c.tunnelAliasDomain}
                          onChange={(e) => c.setTunnelAliasDomain(e.target.value)}
                          placeholder="*.example.com"
                          spellCheck={false}
                          autoComplete="off"
                          className="input-base font-mono text-[12px]"
                        />
                        <label className="flex items-start gap-2 cursor-pointer pt-1">
                          <input
                            type="checkbox"
                            checked={c.tunnelAliasRewriteHost}
                            onChange={(e) => c.setTunnelAliasRewriteHost(e.target.checked)}
                            className="mt-0.5 accent-accent"
                          />
                          <span className="text-[11px] text-ink-2 leading-snug">
                            Rewrite <span className="font-mono">Host</span> header to local pattern.{" "}
                            <span className="text-ink-3">
                              Recommended on. Multi-tenant apps that match tenant by hostname will see their native domain.
                            </span>
                          </span>
                        </label>
                      </div>
                    </>
                  )}
                </div>
              );
            })()}
          </Field>
        )}

        {!c.selectedIsLive && c.tunnelProvider === "tailscale" && (() => {
          if (c.tsLoading && c.tsStatus === null) {
            return (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-1 border border-subtle text-[12px] text-ink-3">
                <svg className="animate-spin" width="11" height="11" viewBox="0 0 12 12" fill="none">
                  <path d="M6 1.5A4.5 4.5 0 1 1 1.5 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
                Checking Tailscale…
              </div>
            );
          }
          if (!c.tsStatus || !c.tsStatus.installed) {
            return (
              <SetupCard
                step={1}
                title="Install Tailscale"
                body="Porta couldn't find the tailscale CLI. Install Tailscale from tailscale.com/download, or via Homebrew."
                cmd="brew install tailscale"
                copied={c.copiedCmd}
                onCopy={c.copyCmd}
                onRecheck={() => c.refreshTailscale(true)}
                recheckLabel="I've installed it"
                loading={c.tsLoading}
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
                cmd="tailscale up"
                copied={c.copiedCmd}
                onCopy={c.copyCmd}
                onRecheck={() => c.refreshTailscale(true)}
                recheckLabel={!c.tsStatus.running ? "I've started it" : "I've logged in"}
                loading={c.tsLoading}
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
                  ↻ Refresh
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
        })()}

        {c.tunnelError && !c.selectedIsLive && (
          <div className="relative px-3 py-2 pr-14 rounded-lg bg-bad-bg border border-[rgba(248,113,113,0.3)] text-[11px] text-bad font-mono whitespace-pre-wrap break-words">
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
                c.tunnelErrorCopied ? "bg-ok-bg text-ok" : "bg-[rgba(248,113,113,0.22)] hover:bg-[rgba(248,113,113,0.32)] text-bad"
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
          <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-warn-bg border border-[rgba(251,191,36,0.25)]">
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
          ) : (
            <button
              onClick={c.handleConnect}
              disabled={
                c.tunnelBusy !== null ||
                (c.tunnelProvider === "cloudflare" && c.tunnelMode === "named" && (!c.tunnelName.trim() || !c.tunnelHostname.trim())) ||
                (c.tunnelProvider === "tailscale" && (!c.tsStatus || !c.tsStatus.installed || !c.tsStatus.running || !c.tsStatus.logged_in))
              }
              className="px-4 py-2 text-[13px] font-medium text-white bg-accent hover:brightness-110 border border-[rgba(96,165,250,0.30)] rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-2"
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
      </div>
    </>
  );
}
