import { useEffect, useState } from "react";
import { getCfApiToken, cfDnsListZones } from "../../lib/commands";
import CloudflareTokenBar from "./CloudflareTokenBar";
import TunnelsSection from "./TunnelsSection";
import DnsSection from "./DnsSection";
import CloudflareAccessSection from "./CloudflareAccessSection";
import CloudflareCertificatesSection from "./CloudflareCertificatesSection";
import CloudflareZoneSection from "./CloudflareZoneSection";
import CloudflareEmailSection from "./CloudflareEmailSection";

type Tab = "tunnels" | "dns" | "access" | "email" | "certs";

const TABS: { id: Tab; label: string }[] = [
  { id: "tunnels", label: "Tunnels" },
  { id: "dns", label: "DNS & Zones" },
  { id: "access", label: "Access" },
  { id: "email", label: "Email" },
  { id: "certs", label: "Certificates" },
];

/** Wrapper that groups every Cloudflare-related setting under one sidebar
 * item. Sub-tabs swap the inner panel — keeps the sidebar from exploding
 * as we add more CF features. Token lives at the top because every tab
 * depends on it. */
export default function CloudflareSection() {
  const [tab, setTab] = useState<Tab>("tunnels");
  // Tabs that have ever been visited. We render those even when inactive
  // (just hidden via CSS) so switching back is instant — fixes the lag the
  // user hit when first clicking Tunnels and on each subsequent tab change.
  const [visited, setVisited] = useState<Set<Tab>>(() => new Set<Tab>(["tunnels"]));
  const [token, setToken] = useState<string | null>(null);
  // Bumped on every save so child tabs that already hydrated their token
  // (via getCfApiToken) can re-fetch and pick up the change without a
  // manual refresh.
  const [tokenVersion, setTokenVersion] = useState(0);
  // Zone count derived purely from cfDnsListZones — a successful, non-empty
  // response proves the token is valid, and the array length is the zone
  // count. null = not yet resolved (avoids flashing "not connected" on load).
  const [zoneCount, setZoneCount] = useState<number | null>(null);

  useEffect(() => {
    getCfApiToken().then((t) => setToken(t || "")).catch(() => setToken(""));
  }, []);

  // Refetch zones whenever the token changes (edit/save updates `token`, which
  // also bumps tokenVersion). A throw or empty array both read as "not
  // connected"; in a plain browser the wrapper resolves to [] → not connected.
  useEffect(() => {
    if (!token) {
      setZoneCount(null);
      return;
    }
    let cancelled = false;
    cfDnsListZones(token)
      .then((zones) => {
        if (!cancelled) setZoneCount(zones.length);
      })
      .catch(() => {
        if (!cancelled) setZoneCount(0);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const connected = Boolean(token) && (zoneCount ?? 0) > 0;

  useEffect(() => {
    setVisited((prev) => prev.has(tab) ? prev : new Set([...prev, tab]));
  }, [tab]);

  function handleTokenChange(next: string) {
    setToken(next);
    setTokenVersion((v) => v + 1);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <svg
          className="w-[17px] h-[17px] text-accent"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
        </svg>
        <span className="text-[15px] font-medium text-ink">Cloudflare</span>
        {token ? (
          <span className="text-[11px] text-ok bg-ok-bg px-2 py-[1px] rounded-full">
            connected
          </span>
        ) : null}
      </div>

      <div className="flex items-center gap-1.5 text-[12px] text-ink-2 -mt-2">
        {connected ? (
          <>
            <span className="w-1.5 h-1.5 rounded-full bg-ok" aria-hidden="true" />
            <span>
              Connected · {zoneCount} {zoneCount === 1 ? "zone" : "zones"}
            </span>
          </>
        ) : (
          <span>Not connected — add an API token</span>
        )}
      </div>

      <CloudflareTokenBar token={token} onChange={handleTokenChange} />

      <div className="flex border-b border-subtle gap-1">
        {TABS.map((t) => {
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`relative px-2.5 py-1 text-[12px] font-medium transition-colors ${
                active ? "text-ink" : "text-ink-2 hover:text-ink"
              }`}
            >
              {t.label}
              {active && (
                <span className="absolute left-0 right-0 bottom-[-1px] h-[1.5px] bg-accent-ink rounded-t" />
              )}
            </button>
          );
        })}
      </div>

      {/* Render every tab that's been visited, hide the inactive ones with
          `hidden`. First click pays the mount cost, subsequent clicks are
          instant. Tabs that haven't been opened yet stay un-mounted so we
          don't fire off API calls the user didn't ask for. */}
      <div className="min-h-[200px]">
        {visited.has("tunnels") && (
          <div hidden={tab !== "tunnels"}>
            <TunnelsSection tokenVersion={tokenVersion} />
          </div>
        )}
        {visited.has("dns") && (
          <div hidden={tab !== "dns"}>
            <CloudflareZoneSection tokenVersion={tokenVersion} />
            <div className="mt-6 border-t border-subtle pt-6">
              <DnsSection tokenVersion={tokenVersion} />
            </div>
          </div>
        )}
        {visited.has("access") && (
          <div hidden={tab !== "access"}>
            <CloudflareAccessSection tokenVersion={tokenVersion} />
          </div>
        )}
        {visited.has("email") && (
          <div hidden={tab !== "email"}>
            <CloudflareEmailSection tokenVersion={tokenVersion} />
          </div>
        )}
        {visited.has("certs") && (
          <div hidden={tab !== "certs"}>
            <CloudflareCertificatesSection />
          </div>
        )}
      </div>
    </div>
  );
}
