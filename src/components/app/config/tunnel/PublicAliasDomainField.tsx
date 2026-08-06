import { useAppConfig } from "../AppConfigContext";

/** "Public alias domain": a wildcard hostname pattern Caddy also routes to this
 *  app, plus the Host-header rewrite toggle. With rewrite ON the upstream sees
 *  its native domain, so multi-tenant apps that key on hostname keep working
 *  unchanged. Persisted with the rest of the config on Save.
 *
 *  Lives inside the Advanced disclosure (mockup 32) — it used to sit at full
 *  weight between the hostname field and the connect button, putting a
 *  wildcard-routing edge case in the path of every routine visit. The
 *  "advanced" tag it used to carry is now the section it's in. */
export default function PublicAliasDomainField() {
  const c = useAppConfig();

  return (
    <div className="space-y-2">
      <p className="text-[11px] font-medium text-ink-2">Public alias domain</p>
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
  );
}
