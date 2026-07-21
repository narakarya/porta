import type { PortBinding } from "../../../types";
import Field from "../../shared/Field";
import { IconRemove, IconPlus, IconStar } from "./icons";
import { useAppConfig } from "./AppConfigContext";

/** Colored pill for a reachable host's origin. Uses explicit token utilities
 * (never opacity modifiers on a token color). */
function DomainBadge({ text, tone }: { text: string; tone: "local" | "custom" | "tunnel" }) {
  const cls =
    tone === "local"
      ? "bg-ok-bg text-ok"
      : tone === "custom"
        ? "bg-accent-bg text-accent-ink"
        : "bg-warn-bg text-warn";
  return (
    <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded uppercase tracking-wide shrink-0 ${cls}`}>
      {text}
    </span>
  );
}

export default function DomainSection() {
  const c = useAppConfig();

  return (
    <>
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-widest text-ink-2">Local routes</p>
        <p className="text-[12px] text-ink-3 mt-1">Subdomains, port bindings, and local HTTPS access for this app.</p>
      </div>

      {/* Reachable at — one row per public URL. Add/remove wires to the
          same subdomain / extra_subdomains / custom_domain state the old
          scattered fields wrote, so Save persists identically. */}
      <div className="flex flex-col gap-3 p-5 rounded-card bg-surface-1 border border-subtle">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[12px] font-medium text-ink-2">Reachable at</p>
          <button
            type="button"
            onClick={() => c.setShowAddDomain((v) => !v)}
            className="inline-flex items-center gap-1 text-[11px] text-accent hover:brightness-110 transition shrink-0"
          >
            <IconPlus /> Add domain
          </button>
        </div>

        {c.showAddDomain && (
          <div className="flex flex-col gap-1">
            <div className="flex gap-2">
              <input
                spellCheck={false}
                autoFocus
                value={c.extraSubdomainInput}
                onChange={(e) => c.setExtraSubdomainInput(e.target.value.toLowerCase())}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); c.addDomain(); }
                  if (e.key === "Escape") { c.setShowAddDomain(false); c.setExtraSubdomainInput(""); }
                }}
                className={`input-base flex-1 font-mono text-[12px] ${c.extraSubdomainInput && !c.addDomainInputValid ? "border-[rgba(248,113,113,0.5)]" : ""}`}
                placeholder="admin  ·  or  app.dev"
              />
              <button
                type="button"
                onClick={c.addDomain}
                disabled={!c.extraSubdomainInput || !c.addDomainInputValid}
                className="px-3 py-2 text-[12px] text-ink-2 bg-surface-2 border border-subtle rounded-lg hover:bg-white/[0.08] hover:text-ink transition-colors disabled:opacity-30 disabled:pointer-events-none shrink-0"
              >
                Add
              </button>
            </div>
            <p className="text-[10px] text-ink-3">
              A bare label adds <code className="text-ink-3 font-mono">{`{label}${c.localTld}`}</code>; a full host with a dot sets a custom domain.
            </p>
          </div>
        )}

        <div className="flex flex-col rounded-lg border border-subtle overflow-hidden">
          {/* Primary — subdomain stays inline-editable so setSubdomain
              (and its validation) is preserved. */}
          <div className="flex items-center gap-2 px-3 py-2 border-b border-subtle last:border-b-0">
            <span className="text-warn shrink-0" title="Primary"><IconStar /></span>
            <span className="flex items-center min-w-0 font-mono text-[12px]">
              <input
                spellCheck={false}
                value={c.subdomain}
                onChange={(e) => c.setSubdomain(e.target.value)}
                placeholder={c.app.name}
                title="Primary subdomain"
                style={{ width: `${Math.max((c.subdomain || c.app.name || "app").length, 3)}ch` }}
                className={`bg-transparent outline-none focus:text-accent-ink text-right ${c.subdomain && !c.subdomainValid ? "text-bad" : "text-ink"}`}
              />
              <span className="text-ink-3">.{c.localDomain}</span>
            </span>
            <DomainBadge text={`local · ${c.localTld}`} tone="local" />
            {c.copyOpen(c.primaryUrl)}
          </div>

          {/* Extra subdomains */}
          {c.extraSubdomains.map((sub) => {
            const url = `${c.scheme}://${sub}.${c.localDomain}`;
            return (
              <div key={sub} className="flex items-center gap-2 px-3 py-2 border-b border-subtle last:border-b-0">
                <span className="w-3 shrink-0" />
                <span className="font-mono text-[12px] text-ink-2 truncate">{sub}.{c.localDomain}</span>
                <DomainBadge text={`local · ${c.localTld}`} tone="local" />
                {c.copyOpen(url)}
                <button
                  type="button"
                  onClick={() => c.setExtraSubdomains((prev) => prev.filter((s) => s !== sub))}
                  title="Remove"
                  aria-label={`Remove ${sub}`}
                  className="p-1.5 rounded text-ink-3 hover:text-bad transition-colors shrink-0"
                >
                  <IconRemove />
                </button>
              </div>
            );
          })}

          {/* Custom domain */}
          {c.customDomain.trim() && (
            <div className="flex items-center gap-2 px-3 py-2 border-b border-subtle last:border-b-0">
              <span className="w-3 shrink-0" />
              <span className={`font-mono text-[12px] truncate ${c.customDomainValid ? "text-ink-2" : "text-bad"}`}>{c.customDomain.trim()}</span>
              <DomainBadge text="custom" tone="custom" />
              {c.customDomainValid && c.copyOpen(`${c.scheme}://${c.customDomain.trim()}`)}
              <button
                type="button"
                onClick={() => c.setCustomDomain("")}
                title="Remove custom domain"
                aria-label="Remove custom domain"
                className={`p-1.5 rounded text-ink-3 hover:text-bad transition-colors shrink-0 ${c.customDomainValid ? "" : "ml-auto"}`}
              >
                <IconRemove />
              </button>
            </div>
          )}

          {/* Public tunnel URL — read-only (managed on the Publish/Tunneling tab). */}
          {c.app.tunnel_active && c.app.tunnel_url && (
            <div className="flex items-center gap-2 px-3 py-2 border-b border-subtle last:border-b-0">
              <span className="w-3 shrink-0" />
              <span className="font-mono text-[12px] text-ink-2 truncate">{c.app.tunnel_url.replace(/^https?:\/\//, "")}</span>
              <DomainBadge text="tunnel · public" tone="tunnel" />
              {c.copyOpen(c.app.tunnel_url)}
            </div>
          )}
        </div>

        {!c.customDomainValid && c.customDomain.trim() && (
          <p className="text-[10px] text-bad">Custom domain must be a valid host (e.g. myapp.dev). Remove or fix it to save.</p>
        )}
      </div>

      {/* Advanced — port bindings + host auth, collapsed by default. */}
      <button
        type="button"
        onClick={() => c.setShowAdvancedDomain((v) => !v)}
        className="self-start inline-flex items-center gap-1.5 text-[12px] text-ink-2 hover:text-ink transition-colors"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" className={`transition-transform ${c.showAdvancedDomain ? "rotate-90" : ""}`}>
          <path d="M4.5 2.5L8 6l-3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        Advanced
      </button>

      {c.showAdvancedDomain && (
        <>
      {/* Port Bindings */}
      <div className="flex flex-col gap-4 p-5 rounded-card bg-surface-1 border border-subtle">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[12px] font-medium text-ink-2">Port Bindings</p>
            <p className="text-[11px] text-ink-3 mt-0.5 leading-relaxed">
              Map additional ports to their own subdomains (e.g. API server, WebSocket).
            </p>
          </div>
          <button
            type="button"
            onClick={() =>
              c.setPortBindings((prev) => [
                ...prev,
                { id: crypto.randomUUID(), label: "", port: 0, subdomain: null, custom_domain: null },
              ])
            }
            className="px-3 py-1.5 text-[12px] text-ink-2 bg-surface-2 border border-subtle rounded-lg hover:bg-white/[0.08] hover:text-ink transition-colors shrink-0"
          >
            + Add
          </button>
        </div>

        {c.portBindings.map((binding, idx) => {
          const bPortNum = binding.port;
          const bPortOk = bPortNum === 0 || (!isNaN(bPortNum) && bPortNum > 0 && bPortNum < 65536);
          const bSubOk = !binding.subdomain || c.SUBDOMAIN_RE.test(binding.subdomain);
          const bDomOk = !binding.custom_domain || c.DOMAIN_RE.test(binding.custom_domain);

          const updateBinding = (patch: Partial<PortBinding>) =>
            c.setPortBindings((prev) => prev.map((b, i) => (i === idx ? { ...b, ...patch } : b)));

          return (
            <div key={binding.id} className="flex items-center gap-2 p-3 rounded-lg bg-surface-1 border border-subtle">
              <input
                spellCheck={false}
                value={binding.label}
                onChange={(e) => updateBinding({ label: e.target.value })}
                className={`input-base flex-[2] min-w-0 ${!binding.label.trim() && binding.port ? "border-[rgba(248,113,113,0.5)]" : ""}`}
                placeholder="Label"
                title="Label"
              />
              <input
                spellCheck={false}
                type="number"
                min={1}
                max={65535}
                value={binding.port || ""}
                onChange={(e) => updateBinding({ port: parseInt(e.target.value, 10) || 0 })}
                className={`input-base w-20 ${binding.port && !bPortOk ? "border-[rgba(248,113,113,0.5)]" : ""}`}
                placeholder="Port"
                title="Port"
              />
              <input
                spellCheck={false}
                value={binding.subdomain ?? ""}
                onChange={(e) => updateBinding({ subdomain: e.target.value.toLowerCase() || null })}
                className={`input-base flex-[2] min-w-0 font-mono text-[12px] ${binding.subdomain && !bSubOk ? "border-[rgba(248,113,113,0.5)]" : ""}`}
                placeholder={binding.label.trim().toLowerCase().replace(/\s+/g, "-") || "subdomain"}
                title="Subdomain"
              />
              <input
                spellCheck={false}
                value={binding.custom_domain ?? ""}
                onChange={(e) => updateBinding({ custom_domain: e.target.value.toLowerCase() || null })}
                className={`input-base flex-[2] min-w-0 font-mono text-[12px] ${binding.custom_domain && !bDomOk ? "border-[rgba(248,113,113,0.5)]" : ""}`}
                placeholder={c.workspace?.domain ?? "domain"}
                title="Custom Domain"
              />
              <button
                type="button"
                onClick={() => c.setPortBindings((prev) => prev.filter((_, i) => i !== idx))}
                className="p-1.5 rounded-lg text-ink-3 hover:text-bad hover:bg-bad-bg transition-colors shrink-0"
                title="Remove"
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path d="M2 3h8M4.5 3V2a1 1 0 011-1h1a1 1 0 011 1v1M9 3v6.5a1 1 0 01-1 1H4a1 1 0 01-1-1V3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
            </div>
          );
        })}

        {c.portBindings.length === 0 && (
          <p className="text-[11px] text-ink-3 text-center py-2">
            No extra port bindings. Click "+ Add" to map additional ports.
          </p>
        )}
      </div>

      {/* Basic Auth */}
      <div className="flex flex-col gap-4 p-5 rounded-card bg-surface-1 border border-subtle">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[12px] font-medium text-ink-2">Basic Auth</p>
            <p className="text-[11px] text-ink-3 mt-0.5 leading-relaxed">
              Default browser username/password prompt for this app's hosts.
              {c.authHosts.length > 1 ? " Override individual hosts below." : ""} Best paired with HTTPS.
            </p>
          </div>
          <button
            type="button"
            onClick={() => c.setBasicAuthEnabled((v) => !v)}
            className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${
              c.basicAuthEnabled ? "bg-accent" : "bg-surface-2"
            }`}
            aria-label="Toggle basic auth"
          >
            <span
              className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform ${
                c.basicAuthEnabled ? "translate-x-4" : ""
              }`}
            />
          </button>
        </div>

        {c.basicAuthEnabled && (
          <div className="flex flex-col gap-3 pt-1">
            <Field label="Username">
              <input spellCheck={false}
                value={c.basicAuthUsername}
                onChange={(e) => c.setBasicAuthUsername(e.target.value)}
                className="input-base font-mono text-[12px]"
                placeholder="admin"
                autoComplete="off"
              />
            </Field>

            <Field label="Password" hint={c.app.basic_auth_password_set ? "A password is set. Leave blank to keep it." : undefined}>
              <div className="flex gap-2">
                <input
                  spellCheck={false}
                  type={c.basicAuthShowPassword ? "text" : "password"}
                  value={c.basicAuthPassword}
                  onChange={(e) => c.setBasicAuthPassword(e.target.value)}
                  className="input-base flex-1 font-mono text-[12px]"
                  placeholder={c.app.basic_auth_password_set ? "••••••••" : "Enter a password"}
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  onClick={() => c.setBasicAuthShowPassword((v) => !v)}
                  className="px-3 py-2 text-[11px] text-ink-2 bg-surface-2 border border-subtle rounded-lg hover:bg-white/[0.08] hover:text-ink transition-colors shrink-0"
                >
                  {c.basicAuthShowPassword ? "Hide" : "Show"}
                </button>
              </div>
              <p className="text-[10px] text-ink-3 mt-1">
                Stored as a bcrypt hash — Porta never persists the plaintext.
              </p>
            </Field>
          </div>
        )}

        {/* Per-host overrides — only meaningful when the app exposes
            more than one host. Each host can inherit the default,
            stay public, or use its own credentials. */}
        {c.authHosts.length > 1 && (
          <div className="flex flex-col gap-2 pt-3 border-t border-subtle">
            <p className="text-[11px] font-medium text-ink-2">Per-host overrides</p>
            {c.authHosts.map(({ host, label }) => {
              const d = c.hostAuthDraft(host);
              const defaultProtected = c.basicAuthEnabled;
              return (
                <div key={host} className="flex flex-col gap-2 p-2.5 rounded-lg bg-surface-1 border border-subtle">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-[11px] font-mono text-ink-2 truncate">{host}</p>
                      <p className="text-[9px] uppercase tracking-wide text-ink-3">{label}</p>
                    </div>
                    <div className="inline-flex p-0.5 rounded-md bg-surface-0 border border-subtle shrink-0">
                      {([
                        { key: "default", text: defaultProtected ? "Default 🔒" : "Default" },
                        { key: "off", text: "Public" },
                        { key: "custom", text: "Custom" },
                      ] as const).map((opt) => (
                        <button
                          key={opt.key}
                          type="button"
                          onClick={() => c.setHostAuthFor(host, { mode: opt.key })}
                          className={`px-2 py-1 rounded text-[10px] font-medium transition-colors ${
                            d.mode === opt.key ? "bg-surface-2 text-ink" : "text-ink-3 hover:text-ink-2"
                          }`}
                        >
                          {opt.text}
                        </button>
                      ))}
                    </div>
                  </div>
                  {d.mode === "custom" && (
                    <div className="flex flex-col gap-2 pt-1">
                      <input
                        spellCheck={false}
                        value={d.username}
                        onChange={(e) => c.setHostAuthFor(host, { username: e.target.value })}
                        className="input-base font-mono text-[11px]"
                        placeholder="username"
                        autoComplete="off"
                      />
                      <input
                        spellCheck={false}
                        type="password"
                        value={d.password}
                        onChange={(e) => c.setHostAuthFor(host, { password: e.target.value })}
                        className="input-base font-mono text-[11px]"
                        placeholder={d.passwordSet ? "•••••••• (leave blank to keep)" : "password"}
                        autoComplete="new-password"
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
        </>
      )}
    </>
  );
}
