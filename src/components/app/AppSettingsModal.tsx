import { useEffect, useRef } from "react";
import { setTunnelConfig } from "../../lib/commands";
import SetupCard from "../shared/SetupCard";
import type { App, PortBinding, Workspace } from "../../types";
import psl from "psl";
import Field from "../shared/Field";
import TunnelStatusBadge from "../shared/TunnelStatusBadge";
import CloudflareAccessPanel from "./CloudflareAccessPanel";
import HealthSection from "./HealthSection";
import DangerSection from "./sections/DangerSection";
import GeneralSection from "./config/GeneralSection";
import { IconRemove, IconPlus, IconStar } from "./config/icons";
import EnvVarTable from "./config/EnvVarTable";
import {
  useAppConfigDraft,
  AppConfigProvider,
  pickBestHostname,
  type Section,
  type TunnelPublicHost,
} from "./config/AppConfigContext";

export type { Section };


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

interface Props {
  app: App;
  workspace: Workspace | null;
  onClose: () => void;
  // Called instead of onClose when the modal closes via a successful save.
  // Lets the parent show a confirmation toast without us threading a result
  // back through onClose's signature. Optional — falls back to onClose.
  onSaved?: () => void;
  // Rendered inline as the workbench "Config" tab (mockup 20) instead of a
  // full-screen modal: no fixed/backdrop/drag-region, fills the tab area. The
  // sidebar sub-nav (General/Domain/Environment/…) is kept — it already
  // matches the mockup. `onClose` then just switches back to another tab.
  embedded?: boolean;
  // Deep-link the sub-nav to a section on open (e.g. Publish tab → Tunneling).
  initialSection?: Section;
}
export default function AppSettingsModal({ app, workspace, onClose, onSaved, embedded = false, initialSection }: Props) {
  const draft = useAppConfigDraft(app, workspace, onClose, onSaved, initialSection);
  const {
    tunnelError, tunnelErrorCopied, setTunnelErrorCopied,
    section, setSection,
    tunnelUrlCopied, setTunnelUrlCopied,
    port,
    subdomain, setSubdomain, extraSubdomains, setExtraSubdomains,
    extraSubdomainInput, setExtraSubdomainInput,
    portBindings, setPortBindings, customDomain, setCustomDomain,
    basicAuthEnabled, setBasicAuthEnabled,
    basicAuthUsername, setBasicAuthUsername,
    basicAuthPassword, setBasicAuthPassword,
    basicAuthShowPassword, setBasicAuthShowPassword,
    hostAuthDraft, setHostAuthFor,
    envFile, setEnvFile, autoStart, setAutoStart,
    envVars, setEnvVars,
    restartPolicy, setRestartPolicy,
    maxRetries, setMaxRetries,
    autoSleepEnabled, setAutoSleepEnabled,
    idleTimeoutMin, setIdleTimeoutMin,
    autoSleepSupported,
    maxUploadMb, setMaxUploadMb,
    tunnelProvider, setTunnelProvider,
    tunnelMode, setTunnelMode,
    tunnelName, setTunnelName,
    tunnelHostname, setTunnelHostname,
    tunnelAliasDomain, setTunnelAliasDomain,
    tunnelAliasRewriteHost, setTunnelAliasRewriteHost,
    availableTunnels,
    tunnelsError,
    tunnelsLoading,
    dnsRoutes,
    cfApiToken,
    cloudflaredInstalled,
    copiedCmd,
    tsStatus,
    tsLoading,
    tsRecheckedWithoutChange,
    tsFunnel, setTsFunnel,
    tunnelAutoStart, setTunnelAutoStart,
    tunnelReachable,
    tunnelBusy,
    copyCmd, handleConnect, handleDisconnect, refreshTailscale, refreshTunnels,
    saving, saveError, savedAt,
    portNum, SUBDOMAIN_RE, DOMAIN_RE,
    subdomainValid, customDomainValid,
    canSave,
    envProfiles,
    activeProfileId,
    showNewProfile, setShowNewProfile,
    newProfileName, setNewProfileName,
    deleteProfileConfirm, setDeleteProfileConfirm,
    renamingProfileId, setRenamingProfileId,
    renameValue, setRenameValue,
    commitRename,
    showAddDomain, setShowAddDomain,
    showAdvancedDomain, setShowAdvancedDomain,
    copyOpen,
    selectProfile, createProfile, deleteProfile,
    isDirty, requestClose,
    scheme, localDomain, localTld, primaryUrl,
    authHosts,
    addDomainInputValid, addDomain,
    selectedIsLive, otherProviderLive,
    configuredTunnelHosts, liveTunnelHosts,
    handleSave, browseEnvFile, handleDelete,
    isStatic, isProxy,
  } = draft;

  // Refs let the keyboard effect call the latest closures without re-binding
  // the listener on every render (handleSave/requestClose change every render
  // because their deps include all form state).
  const handleSaveRef = useRef<() => void>(() => {});
  const requestCloseRef = useRef<() => void>(() => {});
  handleSaveRef.current = handleSave;
  requestCloseRef.current = requestClose;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        requestCloseRef.current();
        return;
      }
      // Cmd+S / Ctrl+S → save without firing the browser's native save dialog
      if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        handleSaveRef.current();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const NAV: { id: Section; label: string }[] = [
    { id: "general",     label: "General" },
    { id: "domain",      label: "Domain" },
    ...((isStatic || isProxy) ? [] : [{ id: "environment" as Section, label: "Environment" }]),
    { id: "tunneling"   as Section, label: "Tunneling" },
    ...((isStatic || isProxy) ? [] : [{ id: "health" as Section, label: "Health" }]),
    { id: "danger",      label: "Danger" },
  ];

  return (
    <AppConfigProvider value={draft}>
    <div
      className={
        embedded
          ? "h-full w-full bg-surface-0 text-ink font-sans flex overflow-hidden"
          : "fixed inset-0 bg-surface-input text-ink font-sans flex h-screen overflow-hidden z-50"
      }
    >
      {/* Drag region — Back button in the sidebar handles dismissal; Esc still
          works via the global key handler. No top-right ✕ to avoid duplicating.
          Omitted when embedded — the workbench chrome owns the title bar. */}
      {!embedded && (
        <div className="drag-region fixed top-0 left-0 right-0 h-8 z-10 pointer-events-none" />
      )}

      {/* Sidebar */}
      <aside className={`w-[120px] bg-surface-2 border-r border-subtle flex flex-col pb-3 shrink-0 ${embedded ? "pt-3" : "pt-8"}`}>
        {!embedded && (
          <div className="px-4 mb-4">
            <button
              onClick={requestClose}
              className="flex items-center gap-1.5 text-[12px] text-ink-3 hover:text-ink transition-colors"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M7.5 2L3.5 6l4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              Back
            </button>
          </div>
        )}

        <div className="px-4 mb-1">
          <p className="text-[11px] font-semibold text-ink-3 uppercase tracking-widest truncate">
            {app.name}
          </p>
        </div>
        <div className="px-4 mb-3">
          <p className="text-[11px] text-ink-3 truncate">
            {workspace?.domain ?? "standalone"} · {app.kind === "static" ? "static" : `:${app.port}`}
          </p>
        </div>

        <nav className="flex-1 flex flex-col gap-0.5 px-2 overflow-auto no-drag">
          {NAV.map(({ id, label }) => {
            const active = section === id;
            return (
              <button
                key={id}
                onClick={() => setSection(id)}
                className={`flex items-center px-2 py-[5px] rounded-control text-[13px] w-full text-left transition-all duration-100 ${
                  active
                    ? id === "danger" ? "bg-bad-bg text-bad" : "bg-accent-bg text-accent-ink"
                    : id === "danger"
                    ? "text-bad hover:bg-bad-bg"
                    : "text-ink-2 hover:bg-white/[0.05] hover:text-ink"
                }`}
              >
                {label}
              </button>
            );
          })}
        </nav>
      </aside>

      {/* Content */}
      <main className="flex-1 flex flex-col no-drag overflow-hidden">
      <div className={`flex-1 overflow-auto px-8 pb-4 ${embedded ? "pt-5" : "pt-10"}`}>
        <div className="w-full flex flex-col gap-5">

          {section === "general" && <GeneralSection />}

          {section === "domain" && (
            <>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-widest text-ink-2">Domain</p>
                <p className="text-[12px] text-ink-3 mt-1">Subdomains and local HTTPS URLs for this app.</p>
              </div>

              {/* Reachable at — one row per public URL. Add/remove wires to the
                  same subdomain / extra_subdomains / custom_domain state the old
                  scattered fields wrote, so Save persists identically. */}
              <div className="flex flex-col gap-3 p-5 rounded-card bg-surface-1 border border-subtle">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[12px] font-medium text-ink-2">Reachable at</p>
                  <button
                    type="button"
                    onClick={() => setShowAddDomain((v) => !v)}
                    className="inline-flex items-center gap-1 text-[11px] text-accent hover:brightness-110 transition shrink-0"
                  >
                    <IconPlus /> Add domain
                  </button>
                </div>

                {showAddDomain && (
                  <div className="flex flex-col gap-1">
                    <div className="flex gap-2">
                      <input
                        spellCheck={false}
                        autoFocus
                        value={extraSubdomainInput}
                        onChange={(e) => setExtraSubdomainInput(e.target.value.toLowerCase())}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { e.preventDefault(); addDomain(); }
                          if (e.key === "Escape") { setShowAddDomain(false); setExtraSubdomainInput(""); }
                        }}
                        className={`input-base flex-1 font-mono text-[12px] ${extraSubdomainInput && !addDomainInputValid ? "border-[rgba(248,113,113,0.5)]" : ""}`}
                        placeholder="admin  ·  or  app.dev"
                      />
                      <button
                        type="button"
                        onClick={addDomain}
                        disabled={!extraSubdomainInput || !addDomainInputValid}
                        className="px-3 py-2 text-[12px] text-ink-2 bg-surface-2 border border-subtle rounded-lg hover:bg-white/[0.08] hover:text-ink transition-colors disabled:opacity-30 disabled:pointer-events-none shrink-0"
                      >
                        Add
                      </button>
                    </div>
                    <p className="text-[10px] text-ink-3">
                      A bare label adds <code className="text-ink-3 font-mono">{`{label}${localTld}`}</code>; a full host with a dot sets a custom domain.
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
                        value={subdomain}
                        onChange={(e) => setSubdomain(e.target.value)}
                        placeholder={app.name}
                        title="Primary subdomain"
                        style={{ width: `${Math.max((subdomain || app.name || "app").length, 3)}ch` }}
                        className={`bg-transparent outline-none focus:text-accent-ink text-right ${subdomain && !subdomainValid ? "text-bad" : "text-ink"}`}
                      />
                      <span className="text-ink-3">.{localDomain}</span>
                    </span>
                    <DomainBadge text={`local · ${localTld}`} tone="local" />
                    {copyOpen(primaryUrl)}
                  </div>

                  {/* Extra subdomains */}
                  {extraSubdomains.map((sub) => {
                    const url = `${scheme}://${sub}.${localDomain}`;
                    return (
                      <div key={sub} className="flex items-center gap-2 px-3 py-2 border-b border-subtle last:border-b-0">
                        <span className="w-3 shrink-0" />
                        <span className="font-mono text-[12px] text-ink-2 truncate">{sub}.{localDomain}</span>
                        <DomainBadge text={`local · ${localTld}`} tone="local" />
                        {copyOpen(url)}
                        <button
                          type="button"
                          onClick={() => setExtraSubdomains((prev) => prev.filter((s) => s !== sub))}
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
                  {customDomain.trim() && (
                    <div className="flex items-center gap-2 px-3 py-2 border-b border-subtle last:border-b-0">
                      <span className="w-3 shrink-0" />
                      <span className={`font-mono text-[12px] truncate ${customDomainValid ? "text-ink-2" : "text-bad"}`}>{customDomain.trim()}</span>
                      <DomainBadge text="custom" tone="custom" />
                      {customDomainValid && copyOpen(`${scheme}://${customDomain.trim()}`)}
                      <button
                        type="button"
                        onClick={() => setCustomDomain("")}
                        title="Remove custom domain"
                        aria-label="Remove custom domain"
                        className={`p-1.5 rounded text-ink-3 hover:text-bad transition-colors shrink-0 ${customDomainValid ? "" : "ml-auto"}`}
                      >
                        <IconRemove />
                      </button>
                    </div>
                  )}

                  {/* Public tunnel URL — read-only (managed on the Publish/Tunneling tab). */}
                  {app.tunnel_active && app.tunnel_url && (
                    <div className="flex items-center gap-2 px-3 py-2 border-b border-subtle last:border-b-0">
                      <span className="w-3 shrink-0" />
                      <span className="font-mono text-[12px] text-ink-2 truncate">{app.tunnel_url.replace(/^https?:\/\//, "")}</span>
                      <DomainBadge text="tunnel · public" tone="tunnel" />
                      {copyOpen(app.tunnel_url)}
                    </div>
                  )}
                </div>

                {!customDomainValid && customDomain.trim() && (
                  <p className="text-[10px] text-bad">Custom domain must be a valid host (e.g. myapp.dev). Remove or fix it to save.</p>
                )}
              </div>

              {/* Advanced — port bindings + host auth, collapsed by default. */}
              <button
                type="button"
                onClick={() => setShowAdvancedDomain((v) => !v)}
                className="self-start inline-flex items-center gap-1.5 text-[12px] text-ink-2 hover:text-ink transition-colors"
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" className={`transition-transform ${showAdvancedDomain ? "rotate-90" : ""}`}>
                  <path d="M4.5 2.5L8 6l-3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                Advanced
              </button>

              {showAdvancedDomain && (
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
                      setPortBindings((prev) => [
                        ...prev,
                        { id: crypto.randomUUID(), label: "", port: 0, subdomain: null, custom_domain: null },
                      ])
                    }
                    className="px-3 py-1.5 text-[12px] text-ink-2 bg-surface-2 border border-subtle rounded-lg hover:bg-white/[0.08] hover:text-ink transition-colors shrink-0"
                  >
                    + Add
                  </button>
                </div>

                {portBindings.map((binding, idx) => {
                  const bPortNum = binding.port;
                  const bPortOk = bPortNum === 0 || (!isNaN(bPortNum) && bPortNum > 0 && bPortNum < 65536);
                  const bSubOk = !binding.subdomain || SUBDOMAIN_RE.test(binding.subdomain);
                  const bDomOk = !binding.custom_domain || DOMAIN_RE.test(binding.custom_domain);

                  const updateBinding = (patch: Partial<PortBinding>) =>
                    setPortBindings((prev) => prev.map((b, i) => (i === idx ? { ...b, ...patch } : b)));

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
                        placeholder={workspace?.domain ?? "domain"}
                        title="Custom Domain"
                      />
                      <button
                        type="button"
                        onClick={() => setPortBindings((prev) => prev.filter((_, i) => i !== idx))}
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

                {portBindings.length === 0 && (
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
                      {authHosts.length > 1 ? " Override individual hosts below." : ""} Best paired with HTTPS.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setBasicAuthEnabled((v) => !v)}
                    className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${
                      basicAuthEnabled ? "bg-accent" : "bg-surface-2"
                    }`}
                    aria-label="Toggle basic auth"
                  >
                    <span
                      className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform ${
                        basicAuthEnabled ? "translate-x-4" : ""
                      }`}
                    />
                  </button>
                </div>

                {basicAuthEnabled && (
                  <div className="flex flex-col gap-3 pt-1">
                    <Field label="Username">
                      <input spellCheck={false}
                        value={basicAuthUsername}
                        onChange={(e) => setBasicAuthUsername(e.target.value)}
                        className="input-base font-mono text-[12px]"
                        placeholder="admin"
                        autoComplete="off"
                      />
                    </Field>

                    <Field label="Password" hint={app.basic_auth_password_set ? "A password is set. Leave blank to keep it." : undefined}>
                      <div className="flex gap-2">
                        <input
                          spellCheck={false}
                          type={basicAuthShowPassword ? "text" : "password"}
                          value={basicAuthPassword}
                          onChange={(e) => setBasicAuthPassword(e.target.value)}
                          className="input-base flex-1 font-mono text-[12px]"
                          placeholder={app.basic_auth_password_set ? "••••••••" : "Enter a password"}
                          autoComplete="new-password"
                        />
                        <button
                          type="button"
                          onClick={() => setBasicAuthShowPassword((v) => !v)}
                          className="px-3 py-2 text-[11px] text-ink-2 bg-surface-2 border border-subtle rounded-lg hover:bg-white/[0.08] hover:text-ink transition-colors shrink-0"
                        >
                          {basicAuthShowPassword ? "Hide" : "Show"}
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
                {authHosts.length > 1 && (
                  <div className="flex flex-col gap-2 pt-3 border-t border-subtle">
                    <p className="text-[11px] font-medium text-ink-2">Per-host overrides</p>
                    {authHosts.map(({ host, label }) => {
                      const d = hostAuthDraft(host);
                      const defaultProtected = basicAuthEnabled;
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
                                  onClick={() => setHostAuthFor(host, { mode: opt.key })}
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
                                onChange={(e) => setHostAuthFor(host, { username: e.target.value })}
                                className="input-base font-mono text-[11px]"
                                placeholder="username"
                                autoComplete="off"
                              />
                              <input
                                spellCheck={false}
                                type="password"
                                value={d.password}
                                onChange={(e) => setHostAuthFor(host, { password: e.target.value })}
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
          )}

          {section === "environment" && (
            <>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-widest text-ink-2">Environment</p>
                <p className="text-[12px] text-ink-3 mt-1">Environment variables and startup behavior.</p>
              </div>

              {/* Profile tab bar (mockup 20) — pills for Default + named
                  profiles. Switch (click), rename (double-click), delete and
                  add all reuse the existing profile state + handlers. */}
              <div className="flex flex-col gap-3 p-5 rounded-card bg-surface-1 border border-subtle">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <button
                    type="button"
                    onClick={() => selectProfile(null)}
                    className={`px-3 py-1 rounded-control text-[12px] font-medium transition-colors ${activeProfileId === null ? "bg-accent-bg text-accent-ink" : "text-ink-2 hover:bg-white/[0.05] hover:text-ink"}`}
                  >
                    Default
                  </button>
                  {envProfiles.map((p) => {
                    const active = p.id === activeProfileId;
                    if (renamingProfileId === p.id) {
                      return (
                        <input
                          key={p.id}
                          spellCheck={false}
                          autoFocus
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onBlur={commitRename}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") { e.preventDefault(); commitRename(); }
                            if (e.key === "Escape") { setRenamingProfileId(null); setRenameValue(""); }
                          }}
                          className="input-base text-[12px] w-28 py-1"
                        />
                      );
                    }
                    return (
                      <span
                        key={p.id}
                        className={`inline-flex items-center rounded-control text-[12px] font-medium transition-colors ${active ? "bg-accent-bg text-accent-ink" : "text-ink-2 hover:bg-white/[0.05] hover:text-ink"}`}
                      >
                        <button
                          type="button"
                          onClick={() => selectProfile(p.id)}
                          onDoubleClick={() => { setRenamingProfileId(p.id); setRenameValue(p.name); }}
                          title="Click to switch · double-click to rename"
                          className={`pl-3 py-1 ${active ? "pr-1" : "pr-3"}`}
                        >
                          {p.name}
                        </button>
                        {active && (
                          deleteProfileConfirm === p.id ? (
                            <span className="inline-flex items-center gap-1 pr-1.5">
                              <button type="button" onClick={() => deleteProfile(p.id)} className="px-1.5 py-0.5 text-[10px] font-medium text-bad bg-bad-bg rounded hover:brightness-110 transition">Delete</button>
                              <button type="button" onClick={() => setDeleteProfileConfirm(null)} className="text-[10px] text-ink-3 hover:text-ink-2 transition-colors">Cancel</button>
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setDeleteProfileConfirm(p.id)}
                              title="Delete profile"
                              aria-label={`Delete ${p.name}`}
                              className="pr-2 pl-0.5 py-1 text-accent-ink hover:text-bad transition-colors"
                            >
                              <IconRemove />
                            </button>
                          )
                        )}
                      </span>
                    );
                  })}
                  {showNewProfile ? (
                    <span className="inline-flex items-center gap-1.5">
                      <input spellCheck={false} value={newProfileName} onChange={(e) => setNewProfileName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") createProfile(); if (e.key === "Escape") { setShowNewProfile(false); setNewProfileName(""); } }}
                        className="input-base text-[12px] w-32 py-1" placeholder="staging" autoFocus />
                      <button type="button" onClick={createProfile} disabled={!newProfileName.trim()} className="px-2.5 py-1 text-[12px] font-medium bg-accent hover:brightness-110 text-white rounded-control disabled:opacity-40 transition-colors shrink-0">Add</button>
                      <button type="button" onClick={() => { setShowNewProfile(false); setNewProfileName(""); }} className="text-[12px] text-ink-3 hover:text-ink transition-colors shrink-0">Cancel</button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setShowNewProfile(true)}
                      title="Add profile"
                      aria-label="Add profile"
                      className="inline-flex items-center justify-center w-6 h-6 rounded-control text-ink-3 hover:bg-white/[0.05] hover:text-ink transition-colors"
                    >
                      <IconPlus />
                    </button>
                  )}
                  {/* Top-right action: append a blank inline env var row. */}
                  <button
                    type="button"
                    onClick={() => setEnvVars((prev) => [...prev, { key: "", value: "" }])}
                    className="ml-auto inline-flex items-center gap-1 text-[11px] text-accent hover:brightness-110 transition shrink-0"
                  >
                    <IconPlus /> Add variable
                  </button>
                </div>
                {activeProfileId && (
                  <p className="text-[10px] text-accent-ink">Active profile will be used when starting the app.</p>
                )}
              </div>

              {/* Key/value table for the active profile (mockup 20). */}
              <div className="flex flex-col gap-3 p-5 rounded-card bg-surface-1 border border-subtle">
                <EnvVarTable
                  vars={envVars}
                  onChange={setEnvVars}
                  port={portNum || app.port}
                  envFile={envFile}
                  onImportFile={browseEnvFile}
                  onClearFile={() => setEnvFile("")}
                />
              </div>

              {/* Startup behavior */}
              <div className="flex flex-col gap-5 p-5 rounded-card bg-surface-1 border border-subtle">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-[13px] font-medium text-ink">Auto-start on launch</p>
                    <p className="text-[11px] text-ink-3 mt-0.5 leading-relaxed">
                      Automatically start this app when Porta opens.
                    </p>
                  </div>
                  <button
                    onClick={() => setAutoStart((v) => !v)}
                    className={`relative w-9 h-5 rounded-full transition-colors shrink-0 mt-0.5 ${
                      autoStart ? "bg-accent" : "bg-surface-2"
                    }`}
                  >
                    <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all ${
                      autoStart ? "left-[18px]" : "left-0.5"
                    }`} />
                  </button>
                </div>

                <div className="h-px bg-surface-2" />

                {/* Restart policy */}
                <div className="flex flex-col gap-3">
                  <div>
                    <p className="text-[12px] font-medium text-ink-2">Restart Policy</p>
                    <p className="text-[11px] text-ink-3 mt-0.5 leading-relaxed">
                      What to do when this app exits unexpectedly.
                    </p>
                  </div>
                  <div className="flex gap-2">
                    {(["never", "on-failure", "always"] as const).map((policy) => (
                      <button
                        key={policy}
                        onClick={() => setRestartPolicy(policy)}
                        className={`flex-1 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors ${
                          restartPolicy === policy
                            ? "bg-accent-bg text-accent-ink border border-[rgba(96,165,250,0.30)]"
                            : "bg-surface-1 text-ink-2 border border-subtle hover:bg-white/[0.07]"
                        }`}
                      >
                        {policy === "never" ? "Never" : policy === "on-failure" ? "On Failure" : "Always"}
                      </button>
                    ))}
                  </div>
                  {restartPolicy !== "never" && (
                    <div className="flex items-center gap-3">
                      <label className="text-[12px] text-ink-2 flex-1">Max retries</label>
                      <input spellCheck={false}
                        type="number"
                        min={1}
                        max={10}
                        value={maxRetries}
                        onChange={(e) => setMaxRetries(e.target.value)}
                        className="input-base w-20 text-center"
                      />
                    </div>
                  )}
                </div>

                {autoSleepSupported && (
                  <>
                    <div className="h-px bg-surface-2" />

                    {/* Auto-sleep: stop when idle, wake transparently on next request */}
                    <div className="flex flex-col gap-3">
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <p className="text-[13px] font-medium text-ink">Auto-sleep when idle</p>
                          <p className="text-[11px] text-ink-3 mt-0.5 leading-relaxed">
                            Stop this app after a period with no HTTP requests to free RAM.
                            It wakes automatically the next time its domain is opened.
                          </p>
                        </div>
                        <button
                          onClick={() => setAutoSleepEnabled((v) => !v)}
                          className={`relative w-9 h-5 rounded-full transition-colors shrink-0 mt-0.5 ${
                            autoSleepEnabled ? "bg-accent" : "bg-surface-2"
                          }`}
                        >
                          <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all ${
                            autoSleepEnabled ? "left-[18px]" : "left-0.5"
                          }`} />
                        </button>
                      </div>
                      {autoSleepEnabled && (
                        <div className="flex items-center gap-3">
                          <label className="text-[12px] text-ink-2 flex-1">Idle timeout (minutes)</label>
                          <input spellCheck={false}
                            type="number"
                            min={1}
                            max={1440}
                            value={idleTimeoutMin}
                            onChange={(e) => setIdleTimeoutMin(e.target.value)}
                            className="input-base w-20 text-center"
                          />
                        </div>
                      )}
                    </div>
                  </>
                )}

                <div className="h-px bg-surface-2" />

                {/* Max upload size — per-app override of the proxy body limit */}
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-[13px] font-medium text-ink">Max upload size</p>
                    <p className="text-[11px] text-ink-3 mt-0.5 leading-relaxed">
                      Largest request body the proxy accepts for this app. Leave blank to
                      use the global default; set <span className="text-ink-2">0</span> for
                      unlimited. Larger uploads get a 413.
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0 mt-0.5">
                    <input spellCheck={false}
                      type="number"
                      min={0}
                      placeholder="default"
                      value={maxUploadMb}
                      onChange={(e) => setMaxUploadMb(e.target.value)}
                      className="input-base w-24 text-center"
                    />
                    <span className="text-[12px] text-ink-3">MB</span>
                  </div>
                </div>
              </div>

            </>
          )}

          {/* Tunneling section (from agent-a02c9388) */}
          {section === "tunneling" && (
            <>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-widest text-ink-2">Tunneling</p>
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
                      const cfReady = cloudflaredInstalled === true;
                      const cfNeedsSetup = cloudflaredInstalled === false;
                      const cfDot = cfReady ? "bg-ok" : cfNeedsSetup ? "bg-warn" : "bg-ink-3";
                      const cfTip = cfReady
                        ? "Ready"
                        : cfNeedsSetup
                          ? "cloudflared not installed"
                          : "Checking…";
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
                            const selected = tunnelProvider === opt.key;
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
                                  setTunnelProvider(opt.key);
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
                    tunnelActive={selectedIsLive}
                    tunnelUrl={selectedIsLive ? app.tunnel_url : null}
                    provider={tunnelProvider}
                    className="mt-4"
                  />
                </div>

                {selectedIsLive && !app.tunnel_url && (
                  <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-warn-bg border border-[rgba(251,191,36,0.25)]">
                    <svg className="animate-spin shrink-0 text-warn" width="12" height="12" viewBox="0 0 12 12" fill="none">
                      <path d="M6 1.5A4.5 4.5 0 1 1 1.5 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                    </svg>
                    <span className="text-[11px] text-warn">Establishing tunnel…</span>
                  </div>
                )}

                {selectedIsLive && app.tunnel_url && (
                  <>
                    <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-ok-bg border border-[rgba(52,211,153,0.25)]">
                      <svg width="12" height="12" viewBox="0 0 10 10" fill="none" className="text-ok shrink-0">
                        <circle cx="5" cy="5" r="4" stroke="currentColor" strokeWidth="1.1"/>
                        <ellipse cx="5" cy="5" rx="2" ry="4" stroke="currentColor" strokeWidth="1.1"/>
                        <path d="M1 5h8" stroke="currentColor" strokeWidth="1.1"/>
                      </svg>
                      <span className="text-[11px] font-mono text-ok truncate flex-1">
                        {app.tunnel_url}
                      </span>
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(app.tunnel_url!).then(() => {
                            setTunnelUrlCopied(true);
                            setTimeout(() => setTunnelUrlCopied(false), 1500);
                          });
                        }}
                        className="text-[10px] font-medium shrink-0 transition-colors"
                        style={{ color: tunnelUrlCopied ? "#a3e635" : undefined }}
                      >
                        {tunnelUrlCopied ? "Copied!" : "Copy"}
                      </button>
                    </div>
                    <TunnelPublicHostsPanel hosts={liveTunnelHosts} title="Accessible hosts" />
                    {tunnelReachable === false && (
                      <div className="flex items-start gap-2 px-3 py-1.5 rounded-lg bg-warn-bg border border-[rgba(251,191,36,0.25)]">
                        <span className="w-1.5 h-1.5 mt-1 rounded-full bg-warn shrink-0" />
                        <span className="text-[11px] text-warn">
                          Tunnel endpoint not reachable — the tunnel itself looks down, not your app
                          (an app that's up but erroring would still respond).{" "}
                          {app.tunnel_provider === "cloudflare"
                            ? "Check the DNS route and that cloudflared is connected."
                            : "Check that the Tailscale serve/funnel is still up."}
                        </span>
                      </div>
                    )}
                    {tunnelReachable === true && (
                      <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-ok-bg border border-[rgba(52,211,153,0.15)]">
                        <span className="w-1.5 h-1.5 rounded-full bg-ok shrink-0" />
                        <span className="text-[11px] text-ok">Reachable</span>
                      </div>
                    )}
                  </>
                )}

                {!selectedIsLive && tunnelProvider === "cloudflare" && (
                  <Field label="Mode">
                    <div className="flex gap-1 bg-surface-1 border border-subtle rounded-lg p-1 mb-2">
                      {(["quick", "named"] as const).map((m) => (
                        <button
                          key={m}
                          type="button"
                          onClick={() => setTunnelMode(m)}
                          className={`flex-1 px-3 py-1.5 text-[12px] font-medium rounded-md transition-colors ${
                            tunnelMode === m ? "bg-surface-2 text-ink" : "text-ink-3 hover:text-ink-2"
                          }`}
                        >
                          {m === "quick" ? "Quick (random URL)" : "Named (custom domain)"}
                        </button>
                      ))}
                    </div>

                    {tunnelMode === "named" && (() => {
                      const needsInstall = cloudflaredInstalled === false;
                      const needsLogin =
                        cloudflaredInstalled === true &&
                        !!tunnelsError &&
                        (tunnelsError.toLowerCase().includes("login") ||
                          tunnelsError.toLowerCase().includes("unauthorized") ||
                          tunnelsError.toLowerCase().includes("not logged in"));
                      const needsCreateTunnel =
                        cloudflaredInstalled === true &&
                        !tunnelsError &&
                        availableTunnels.length === 0 &&
                        !tunnelsLoading;

                      return (
                        <div className="flex flex-col gap-3 mt-2">
                          {/* Step 1 — install cloudflared */}
                          {needsInstall && (
                            <SetupCard
                              step={1}
                              title="Install cloudflared"
                              body="Porta couldn't find the cloudflared CLI on your machine."
                              cmd="brew install cloudflare/cloudflare/cloudflared"
                              copied={copiedCmd}
                              onCopy={copyCmd}
                              onRecheck={refreshTunnels}
                              recheckLabel="I've installed it"
                              loading={tunnelsLoading}
                            />
                          )}

                          {/* Step 2 — login */}
                          {needsLogin && (
                            <SetupCard
                              step={2}
                              title="Log in to Cloudflare"
                              body="Run this once — opens your browser for the OAuth flow."
                              cmd="cloudflared login"
                              copied={copiedCmd}
                              onCopy={copyCmd}
                              onRecheck={refreshTunnels}
                              recheckLabel="I've logged in"
                              loading={tunnelsLoading}
                            />
                          )}

                          {/* Step 3 — create first tunnel */}
                          {needsCreateTunnel && (
                            <SetupCard
                              step={3}
                              title="Create your first tunnel"
                              body="Give it any name — you'll see it in the dropdown after."
                              cmd="cloudflared tunnel create porta"
                              copied={copiedCmd}
                              onCopy={copyCmd}
                              onRecheck={refreshTunnels}
                              recheckLabel="I've created it"
                              loading={tunnelsLoading}
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
                                    onClick={refreshTunnels}
                                    disabled={tunnelsLoading}
                                    className="text-[10px] text-ink-3 hover:text-ink transition-colors disabled:opacity-50"
                                  >
                                    {tunnelsLoading ? "Loading…" : "↻ Refresh"}
                                  </button>
                                </div>
                                {tunnelsLoading && availableTunnels.length === 0 ? (
                                  <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-1 border border-subtle text-[12px] text-ink-3">
                                    <svg className="animate-spin" width="11" height="11" viewBox="0 0 12 12" fill="none">
                                      <path d="M6 1.5A4.5 4.5 0 1 1 1.5 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                                    </svg>
                                    Loading tunnels…
                                  </div>
                                ) : availableTunnels.length > 0 ? (
                                  <div className="relative">
                                    <select
                                      value={tunnelName}
                                      onChange={(e) => {
                                        const nextName = e.target.value;
                                        setTunnelName(nextName);
                                        // Auto-fill hostname from existing DNS routes pointing
                                        // to the picked tunnel — only when the field is empty
                                        // so we never overwrite a user-typed value. Picks the
                                        // route whose subdomain best matches the app's identity.
                                        if (!tunnelHostname.trim() && nextName) {
                                          const picked = availableTunnels.find((t) => t.name === nextName);
                                          if (picked) {
                                            const matched = dnsRoutes
                                              .filter((r) => r.tunnel_id === picked.id)
                                              .map((r) => r.hostname);
                                            const best = pickBestHostname(matched, app);
                                            if (best) setTunnelHostname(best);
                                          }
                                        }
                                      }}
                                      className="w-full appearance-none bg-surface-input border border-subtle rounded-lg px-3 py-2 text-[13px] text-ink outline-none focus:border-accent transition-colors pr-8 cursor-pointer"
                                    >
                                      <option value="">Select a tunnel…</option>
                                      {availableTunnels.map((t) => (
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
                                    value={tunnelName}
                                    onChange={(e) => setTunnelName(e.target.value)}
                                    className="input-base font-mono text-[12px]"
                                    placeholder="my-tunnel-name"
                                  />
                                )}
                                {tunnelsError && (
                                  <p className="text-[10px] text-warn mt-1 font-mono whitespace-pre-wrap">{tunnelsError}</p>
                                )}
                              </div>

                              <div>
                                <span className="text-[11px] font-medium text-ink-2 block mb-1.5">Hostname</span>
                                {(() => {
                                  // Infer the most common base domain (eTLD+1) from the
                                  // routes already pointing at this tunnel. Powers two UX
                                  // wins: a realistic placeholder and on-blur subdomain
                                  // completion (`admin` → `admin.sidiq.sch.id`).
                                  const picked = availableTunnels.find((t) => t.name === tunnelName);
                                  const matched = picked ? dnsRoutes.filter((r) => r.tunnel_id === picked.id) : [];
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
                                    const v = tunnelHostname.trim();
                                    if (!v || !dominantBase) return;
                                    // Only fill the base when the user typed a bare
                                    // subdomain. A trailing dot also means "I want the
                                    // base appended" — e.g. "admin." → "admin.<base>".
                                    if (!v.includes(".")) {
                                      setTunnelHostname(`${v}.${dominantBase}`);
                                    } else if (v.endsWith(".")) {
                                      setTunnelHostname(`${v}${dominantBase}`);
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
                                        name={`tunnel-hostname-${app.id}`}
                                        data-1p-ignore="true"
                                        data-lpignore="true"
                                        value={tunnelHostname}
                                        onChange={(e) => setTunnelHostname(e.target.value)}
                                        onBlur={autocomplete}
                                        onKeyDown={(e) => {
                                          // Tab without modifiers expands to full hostname
                                          // before focus moves on — feels native, not magic.
                                          if (e.key === "Tab" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
                                            const v = tunnelHostname.trim();
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
                                <TunnelPublicHostsPanel hosts={configuredTunnelHosts} />
                              </div>

                              {/* Cloudflare Access (Zero Trust) — login wall in
                                  front of the public hostname. Only meaningful
                                  for named tunnels (the hostname must live in
                                  the user's Cloudflare account). */}
                              <CloudflareAccessPanel
                                savedHostname={tunnelMode === "named" ? (app.tunnel_custom_hostname ?? "") : ""}
                                liveHostname={tunnelHostname}
                                cfToken={cfApiToken && cfApiToken.length > 0 ? cfApiToken : null}
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
                                  value={tunnelAliasDomain}
                                  onChange={(e) => setTunnelAliasDomain(e.target.value)}
                                  placeholder="*.example.com"
                                  spellCheck={false}
                                  autoComplete="off"
                                  className="input-base font-mono text-[12px]"
                                />
                                <label className="flex items-start gap-2 cursor-pointer pt-1">
                                  <input
                                    type="checkbox"
                                    checked={tunnelAliasRewriteHost}
                                    onChange={(e) => setTunnelAliasRewriteHost(e.target.checked)}
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

                {!selectedIsLive && tunnelProvider === "tailscale" && (() => {
                  if (tsLoading && tsStatus === null) {
                    return (
                      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-1 border border-subtle text-[12px] text-ink-3">
                        <svg className="animate-spin" width="11" height="11" viewBox="0 0 12 12" fill="none">
                          <path d="M6 1.5A4.5 4.5 0 1 1 1.5 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                        </svg>
                        Checking Tailscale…
                      </div>
                    );
                  }
                  if (!tsStatus || !tsStatus.installed) {
                    return (
                      <SetupCard
                        step={1}
                        title="Install Tailscale"
                        body="Porta couldn't find the tailscale CLI. Install Tailscale from tailscale.com/download, or via Homebrew."
                        cmd="brew install tailscale"
                        copied={copiedCmd}
                        onCopy={copyCmd}
                        onRecheck={() => refreshTailscale(true)}
                        recheckLabel="I've installed it"
                        loading={tsLoading}
                        hint={tsRecheckedWithoutChange ? "Still not finding the CLI. Try restarting Porta after install, or verify `which tailscale` shows a path." : null}
                      />
                    );
                  }
                  if (!tsStatus.running || !tsStatus.logged_in) {
                    const body = !tsStatus.running
                      ? "The Tailscale daemon isn't running. Open the Tailscale app or run:"
                      : "Open the Tailscale app and sign in, or run:";
                    return (
                      <SetupCard
                        step={2}
                        title={!tsStatus.running ? "Start Tailscale" : "Log in to Tailscale"}
                        body={body}
                        cmd="tailscale up"
                        copied={copiedCmd}
                        onCopy={copyCmd}
                        onRecheck={() => refreshTailscale(true)}
                        recheckLabel={!tsStatus.running ? "I've started it" : "I've logged in"}
                        loading={tsLoading}
                        hint={tsRecheckedWithoutChange
                          ? (!tsStatus.running
                            ? "Daemon still stopped. Open the Tailscale app from your menu bar and wait for it to show 'Connected'."
                            : "Still not showing as logged in. Make sure `tailscale up` opened a browser and you completed the auth flow.")
                          : null}
                      />
                    );
                  }
                  const previewHost = tsStatus.host ?? "your-device.tail-xxxx.ts.net";
                  const previewPort = parseInt(port, 10) || app.port;
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
                          onClick={() => refreshTailscale()}
                          className="text-[10px] text-ok hover:text-ok transition-colors"
                        >
                          ↻ Refresh
                        </button>
                      </div>
                      <div className="px-3 py-2 rounded-lg bg-surface-1 border border-subtle">
                        <p className="text-[10px] text-ink-3 mb-1">Your URL will be:</p>
                        <p className="font-mono text-[12px] text-ink break-all">{previewUrl}</p>
                        <p className="text-[10px] text-ink-3 mt-2 leading-relaxed">
                          {tsFunnel
                            ? "Funnel exposes this publicly to the internet. Anyone with the URL can access it."
                            : "Only devices logged into your tailnet can reach this URL."}
                        </p>
                      </div>
                      <label className="flex items-start gap-2 px-3 py-2 rounded-lg bg-surface-1 border border-subtle cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={tsFunnel}
                          onChange={(e) => setTsFunnel(e.target.checked)}
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

                {tunnelError && !selectedIsLive && (
                  <div className="relative px-3 py-2 pr-14 rounded-lg bg-bad-bg border border-[rgba(248,113,113,0.3)] text-[11px] text-bad font-mono whitespace-pre-wrap break-words">
                    {tunnelError}
                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard.writeText(tunnelError).then(() => {
                          setTunnelErrorCopied(true);
                          setTimeout(() => setTunnelErrorCopied(false), 1500);
                        });
                      }}
                      className="absolute top-1.5 right-1.5 px-2 py-0.5 text-[10px] font-sans font-medium rounded bg-[rgba(248,113,113,0.22)] hover:bg-[rgba(248,113,113,0.32)] text-bad transition-colors"
                      style={{ color: tunnelErrorCopied ? "#a3e635" : undefined }}
                    >
                      {tunnelErrorCopied ? "Copied!" : "Copy"}
                    </button>
                  </div>
                )}

                {/* Auto-start toggle: persists along with provider config. Only
                    meaningful when a provider is set — hide otherwise to reduce
                    noise on apps that aren't using tunnels. */}
                <label className="flex items-start gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={tunnelAutoStart}
                    onChange={async (e) => {
                      const next = e.target.checked;
                      setTunnelAutoStart(next);
                      // Persist immediately so a subsequent "app start" picks
                      // up the new value without requiring a Connect click.
                      try {
                        await setTunnelConfig(
                          app.id,
                          tunnelProvider,
                          tunnelMode === "named" ? (tunnelName.trim() || null) : null,
                          tunnelMode === "named" ? (tunnelHostname.trim() || null) : null,
                          next,
                        );
                      } catch {
                        // Revert on failure — config didn't actually persist.
                        setTunnelAutoStart(!next);
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

                {otherProviderLive && (
                  <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-warn-bg border border-[rgba(251,191,36,0.25)]">
                    <span className="w-1.5 h-1.5 mt-1.5 rounded-full bg-warn shrink-0" />
                    <span className="text-[11px] text-warn">
                      {otherProviderLive === "tailscale" ? "Tailscale" : "Cloudflare"} is still connected.
                      Connecting {tunnelProvider === "tailscale" ? "Tailscale" : "Cloudflare"} here will
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
                  {selectedIsLive && tunnelBusy !== "connecting" ? (
                    <button
                      onClick={handleDisconnect}
                      disabled={tunnelBusy !== null}
                      className="px-4 py-2 text-[13px] font-medium text-ink-2 bg-surface-2 hover:bg-white/[0.12] rounded-lg transition-colors disabled:opacity-60 disabled:cursor-not-allowed inline-flex items-center gap-2"
                    >
                      {tunnelBusy === "disconnecting" && (
                        <span className="inline-block h-3 w-3 rounded-full border-2 border-strong border-t-ink animate-spin" />
                      )}
                      {tunnelBusy === "disconnecting" ? "Disconnecting…" : "Disconnect"}
                    </button>
                  ) : (
                    <button
                      onClick={handleConnect}
                      disabled={
                        tunnelBusy !== null ||
                        (tunnelProvider === "cloudflare" && tunnelMode === "named" && (!tunnelName.trim() || !tunnelHostname.trim())) ||
                        (tunnelProvider === "tailscale" && (!tsStatus || !tsStatus.installed || !tsStatus.running || !tsStatus.logged_in))
                      }
                      className="px-4 py-2 text-[13px] font-medium text-white bg-accent hover:brightness-110 border border-[rgba(96,165,250,0.30)] rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-2"
                    >
                      {tunnelBusy === "connecting" && (
                        <span className="inline-block h-3 w-3 rounded-full border-2 border-white/40 border-t-white animate-spin" />
                      )}
                      {tunnelBusy === "connecting"
                        ? "Connecting…"
                        : tunnelProvider === "tailscale"
                          ? "Connect"
                          : tunnelMode === "named" ? "Connect" : "Quick Tunnel"}
                    </button>
                  )}
                </div>
              </div>
            </>
          )}

          {section === "health" && (
            <HealthSection
              appId={app.id}
              appPort={app.port}
              defaultPath={app.health_check_path ?? null}
            />
          )}

          {section === "danger" && (
            <DangerSection appName={app.name} onConfirmDelete={handleDelete} />
          )}
        </div>
      </div>

      {/* Sticky footer — replaces the per-section Save/Cancel rows. Hidden on
          Danger Zone since deletion has its own dedicated confirm flow. */}
      {section !== "danger" && section !== "health" && (
        <footer className="shrink-0 border-t border-subtle bg-surface-input px-8 py-3 flex items-center gap-2">
          {saveError && <p className="text-[11px] text-bad flex-1 truncate" title={saveError}>{saveError}</p>}
          {!saveError && isDirty && (
            <p className="text-[11px] text-warn flex-1">Unsaved changes</p>
          )}
          {!saveError && !isDirty && savedAt !== null && (
            <p className="text-[11px] text-ok flex-1 flex items-center gap-1.5">
              <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                <path d="M2.5 5.5l2.5 2.5L8.5 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Saved
            </p>
          )}
          <div className="flex gap-2 ml-auto">
            <button
              onClick={requestClose}
              className="px-4 py-2 text-[13px] text-ink-3 hover:text-ink rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={!canSave || saving || !isDirty}
              title={!isDirty ? "No changes to save" : undefined}
              className="px-4 py-2 text-[13px] font-medium bg-accent hover:brightness-110 text-white rounded-lg disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5"
            >
              {saving && (
                <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 16 16" fill="none">
                  <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.3" />
                  <path d="M14 8a6 6 0 00-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              )}
              {saving ? "Saving..." : "Save Changes"}
            </button>
          </div>
        </footer>
      )}
      </main>
    </div>
    </AppConfigProvider>
  );
}
