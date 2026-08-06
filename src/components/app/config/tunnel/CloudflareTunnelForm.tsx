import psl from "psl";
import SetupCard from "../../../shared/SetupCard";
import CreateTunnelCard from "../../../shared/CreateTunnelCard";
import CloudflareAccessPanel from "../../CloudflareAccessPanel";
import { RefreshIcon, Spinner } from "../../../ui";
import { useAppConfig, pickBestHostname } from "../AppConfigContext";
import TunnelPublicHostsPanel from "./TunnelPublicHostsPanel";

/** The Cloudflare provider branch: Quick/Named mode choice, the named-tunnel
 *  setup steps (install / login / create), the tunnel picker + hostname field,
 *  and Cloudflare Access.
 *
 *  The public alias domain moved out to the Advanced disclosure (mockup 32) —
 *  it is a wildcard-routing edge case and was sitting between the hostname and
 *  the connect button at full weight. */
export default function CloudflareTunnelForm() {
  const c = useAppConfig();

  const MODES = [
    { key: "quick" as const, title: "Quick", desc: "Ephemeral trycloudflare.com URL. Zero setup." },
    { key: "named" as const, title: "Named", desc: "Persistent, your own domain + DNS." },
  ];

  return (
    <div className="flex flex-col gap-3">
      {/* Mode as two described cards, not a bare segmented control: "Quick" vs
          "Named" is a real fork (throwaway URL vs your own DNS) and the labels
          alone never said which one costs setup. */}
      <div>
        <span className="text-[11px] font-medium text-ink-2 block mb-1.5">Mode</span>
        <div className="grid grid-cols-2 gap-2">
          {MODES.map((m) => {
            const on = c.tunnelMode === m.key;
            return (
              <button
                key={m.key}
                type="button"
                onClick={() => c.setTunnelMode(m.key)}
                className={`text-left px-3 py-2 rounded-lg border transition-colors ${
                  on
                    ? "border-accent bg-accent-bg"
                    : "border-subtle bg-surface-1 hover:bg-white/[0.04]"
                }`}
              >
                <span className={`flex items-center gap-1.5 text-[12px] ${on ? "text-accent" : "text-ink-2"}`}>
                  {m.title}
                  {on && (
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                      <path d="M3.5 8.5l3 3 6-6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </span>
                <span className="block text-[10.5px] text-ink-3 mt-0.5 leading-snug">{m.desc}</span>
              </button>
            );
          })}
        </div>
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
          <div className="flex flex-col gap-3">
            {/* Step 1 — install cloudflared */}
            {needsInstall && (
              <SetupCard
                step={1}
                title="Install cloudflared"
                body="Porta couldn't find the cloudflared CLI on your machine."
                cmd="brew install cloudflared"
                copied={c.copiedCmd}
                onCopy={c.copyCmd}
                onRecheck={() => c.refreshTunnels(true)}
                recheckLabel="I've installed it"
                loading={c.tunnelsLoading}
                runStep="install-cloudflared"
                runLabel="Install with Homebrew"
              />
            )}

            {/* Step 2 — login */}
            {needsLogin && (
              <SetupCard
                step={2}
                title="Log in to Cloudflare"
                body="Runs once and opens your browser for the OAuth flow."
                cmd="cloudflared tunnel login"
                copied={c.copiedCmd}
                onCopy={c.copyCmd}
                onRecheck={() => c.refreshTunnels(true)}
                recheckLabel="I've logged in"
                loading={c.tunnelsLoading}
                runStep="cloudflared-login"
                runLabel="Log in to Cloudflare"
              />
            )}

            {/* Step 3 — create first tunnel */}
            {needsCreateTunnel && (
              <CreateTunnelCard
                step={3}
                onCreated={() => c.refreshTunnels(true)}
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
                      onClick={() => c.refreshTunnels(true)}
                      disabled={c.tunnelsLoading}
                      className="text-[10px] text-ink-3 hover:text-ink transition-colors disabled:opacity-50"
                    >
                      {c.tunnelsLoading ? "Loading…" : <><RefreshIcon /> Refresh</>}
                    </button>
                  </div>
                  {c.tunnelsLoading && c.availableTunnels.length === 0 ? (
                    <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-1 border border-subtle text-[12px] text-ink-3">
                      <Spinner size={11} />
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
                          className={`input-base font-mono text-[12px] ${
                            c.liveTunnelConfigDrifted ? "border-[var(--warning-border)]" : ""
                          }`}
                          placeholder={placeholder}
                        />
                        {/* Say the change out loud. The drift banner used to
                            report only that *something* diverged, while the
                            field showed the new value and the live URL showed
                            the old one — leaving the user to work out which
                            was which. */}
                        {c.liveTunnelConfigDrifted && c.app.tunnel_custom_hostname && (
                          <p className="text-[10.5px] font-mono mt-1.5 leading-relaxed">
                            <span className="text-ink-3">running </span>
                            <span className="text-ink-3 line-through">{c.app.tunnel_custom_hostname}</span>
                            <span className="text-ink-3"> → on reconnect </span>
                            <span className="text-warn">{c.tunnelHostname.trim()}</span>
                          </p>
                        )}
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
                  <TunnelPublicHostsPanel
                    hosts={c.configuredTunnelHosts}
                    drifted={c.liveTunnelConfigDrifted}
                  />
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
              </>
            )}
          </div>
        );
      })()}
    </div>
  );
}
