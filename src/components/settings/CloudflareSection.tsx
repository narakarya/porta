import { useEffect, useState } from "react";
import { getCfApiToken } from "../../lib/commands";
import CloudflareTokenBar from "./CloudflareTokenBar";
import TunnelsSection from "./TunnelsSection";
import DnsSection from "./DnsSection";
import CloudflareAccessSection from "./CloudflareAccessSection";
import CloudflareCertificatesSection from "./CloudflareCertificatesSection";
import CloudflareZoneSection from "./CloudflareZoneSection";
import CloudflareEmailSection from "./CloudflareEmailSection";

type Tab = "tunnels" | "dns" | "access" | "zone" | "email" | "certs";

const TABS: { id: Tab; label: string }[] = [
  { id: "tunnels", label: "Tunnels" },
  { id: "dns", label: "DNS Records" },
  { id: "access", label: "Access" },
  { id: "zone", label: "Zone" },
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

  useEffect(() => {
    getCfApiToken().then((t) => setToken(t || "")).catch(() => setToken(""));
  }, []);

  useEffect(() => {
    setVisited((prev) => prev.has(tab) ? prev : new Set([...prev, tab]));
  }, [tab]);

  function handleTokenChange(next: string) {
    setToken(next);
    setTokenVersion((v) => v + 1);
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-[16px] font-semibold text-zinc-100">Cloudflare</h1>
        <p className="text-[12px] text-zinc-500 mt-0.5">
          Tunnels, DNS records, Access protection, and origin certs — everything tied to your Cloudflare account.
        </p>
      </div>

      <CloudflareTokenBar token={token} onChange={handleTokenChange} />

      <div className="flex border-b border-white/[0.06] gap-1">
        {TABS.map((t) => {
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`relative px-4 py-2 text-[12.5px] font-medium transition-colors ${
                active ? "text-zinc-100" : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {t.label}
              {active && (
                <span className="absolute left-0 right-0 bottom-[-1px] h-[2px] bg-blue-400 rounded-t" />
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
            <DnsSection tokenVersion={tokenVersion} />
          </div>
        )}
        {visited.has("access") && (
          <div hidden={tab !== "access"}>
            <CloudflareAccessSection tokenVersion={tokenVersion} />
          </div>
        )}
        {visited.has("zone") && (
          <div hidden={tab !== "zone"}>
            <CloudflareZoneSection tokenVersion={tokenVersion} />
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
