import { setTunnelConfig } from "../../../../lib/commands";
import { useAppConfig } from "../AppConfigContext";
import TunnelDisclosure from "./TunnelDisclosure";
import PublicAliasDomainField from "./PublicAliasDomainField";

/** The three settings that are rarely touched — auto-start, public alias
 *  domain, Host-header rewrite — folded behind one disclosure (mockup 32).
 *
 *  The summary line names any non-default so folding never hides something the
 *  user turned on. */
export default function TunnelAdvanced() {
  const c = useAppConfig();

  const bits: string[] = [];
  bits.push(c.tunnelAutoStart ? "auto-start on" : "auto-start off");
  if (c.tunnelAliasDomain.trim()) bits.push(`alias ${c.tunnelAliasDomain.trim()}`);
  else bits.push("no alias");
  // Rewrite defaults ON, so only its absence is worth a word.
  if (!c.tunnelAliasRewriteHost) bits.push("no host rewrite");

  return (
    <TunnelDisclosure
      open={c.tunnelAdvancedOpen}
      onToggle={() => c.setTunnelAdvancedOpen(!c.tunnelAdvancedOpen)}
      label="Advanced"
      summary={bits.join(" · ")}
    >
      <label className="flex items-start gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={c.tunnelAutoStart}
          onChange={async (e) => {
            const next = e.target.checked;
            c.setTunnelAutoStart(next);
            // Persist immediately so a subsequent "app start" picks up the new
            // value without requiring a Connect click.
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
            When this app starts, the tunnel connects automatically using these settings.
          </p>
        </div>
      </label>

      {c.tunnelProvider === "cloudflare" && (
        <div className="pt-3 border-t border-subtle">
          <PublicAliasDomainField />
        </div>
      )}
    </TunnelDisclosure>
  );
}
