import { useRef, useState, useCallback } from "react";
import { usePortaStore } from "../store";
import type { App, Workspace } from "../types";
import Field from "./shared/Field";
import EnvVarEditor from "./shared/EnvVarEditor";
import TunnelStatusBadge from "./shared/TunnelStatusBadge";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

type Section = "general" | "domain" | "environment" | "tunneling" | "danger";

interface Props {
  app: App;
  workspace: Workspace | null;
  onClose: () => void;
}

export default function AppSettingsModal({ app, workspace, onClose }: Props) {
  const { updateApp, deleteApp, apps, startTunnel, stopTunnel, setupStatus } = usePortaStore();
  const [section, setSection] = useState<Section>("general");
  const [tunnelUrlCopied, setTunnelUrlCopied] = useState(false);

  const [name, setName] = useState(app.name);
  const [port, setPort] = useState(String(app.port));
  const [subdomain, setSubdomain] = useState(app.subdomain ?? "");
  const [extraSubdomains, setExtraSubdomains] = useState<string[]>(app.extra_subdomains ?? []);
  const [extraSubdomainInput, setExtraSubdomainInput] = useState("");
  const [startCommand, setStartCommand] = useState(app.start_command);
  // Health check (from agent-a7a6ec3b)
  const [healthCheckPath, setHealthCheckPath] = useState(app.health_check_path ?? "");
  // Dependencies (from agent-a7a6ec3b)
  const [dependsOn, setDependsOn] = useState<string[]>(app.depends_on ?? []);

  const [envFile, setEnvFile] = useState(app.env_file ?? "");
  const [autoStart, setAutoStart] = useState(app.auto_start);
  // Inline env vars: stored as array of [key, value] pairs for easy editing
  const [envVars, setEnvVars] = useState<{ key: string; value: string }[]>(
    Object.entries(app.env_vars ?? {}).map(([key, value]) => ({ key, value }))
  );
  const [restartPolicy, setRestartPolicy] = useState<"never" | "always" | "on-failure">(
    app.restart_policy ?? "on-failure"
  );
  const [maxRetries, setMaxRetries] = useState(String(app.max_retries ?? 3));

  // Other apps in same workspace for dependency selection
  const siblingApps = apps.filter(
    (a) => a.id !== app.id && a.workspace_id === app.workspace_id
  );

  // Tunneling state (from agent-a02c9388)
  const [tunnelProvider, setTunnelProvider] = useState(app.tunnel_provider ?? "cloudflare");
  const [tunnelHostname, setTunnelHostname] = useState("");

  const [deleteTyped, setDeleteTyped] = useState("");
  const deleteInputRef = useRef<HTMLInputElement>(null);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const portNum = parseInt(port, 10);
  const portValid = !isNaN(portNum) && portNum > 0 && portNum < 65536;
  const SUBDOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$|^\*$/;
  const subdomainValid = !subdomain || SUBDOMAIN_RE.test(subdomain);
  const extraSubdomainInputValid = !extraSubdomainInput || SUBDOMAIN_RE.test(extraSubdomainInput);
  const canSave = name.trim() && portValid && subdomainValid;

  // Live URL preview
  const scheme = setupStatus?.certs_generated ? "https" : "http";
  const domain = workspace?.domain ?? "narakarya.test";
  const effectiveSub = subdomain.trim() || name.trim() || "…";
  const previewPrimary = effectiveSub === "*"
    ? `${scheme}://*.${domain}`
    : `${scheme}://${effectiveSub}.${domain}`;
  const previewExtras = extraSubdomains.map((s) => `${scheme}://${s}.${domain}`);

  const addExtraSubdomain = useCallback(() => {
    const val = extraSubdomainInput.trim().toLowerCase();
    if (!val || !SUBDOMAIN_RE.test(val) || extraSubdomains.includes(val)) return;
    setExtraSubdomains((prev) => [...prev, val]);
    setExtraSubdomainInput("");
  }, [extraSubdomainInput, extraSubdomains]);

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    setSaveError(null);
    try {
      // Convert env vars array back to Record, skipping empty keys
      const env_vars: Record<string, string> = {};
      for (const { key, value } of envVars) {
        if (key.trim()) env_vars[key.trim()] = value;
      }
      await updateApp({
        id: app.id,
        name: name.trim(),
        port: portNum,
        subdomain: subdomain.trim() || null,
        start_command: startCommand.trim(),
        env_file: envFile.trim() || null,
        auto_start: autoStart,
        env_vars,
        restart_policy: restartPolicy,
        max_retries: parseInt(maxRetries, 10) || 3,
        health_check_path: healthCheckPath.trim() || null,
        depends_on: dependsOn,
        extra_subdomains: extraSubdomains,
      });
      onClose();
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function browseEnvFile() {
    let selected: string | null = null;
    if (isTauri) {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      selected = await openDialog({
        multiple: false,
        filters: [{ name: "Env files", extensions: ["env", "txt", "*"] }],
      }).catch(() => null) as string | null;
    } else {
      selected = window.prompt("Enter .env file path:", ".env");
    }
    if (typeof selected === "string" && selected) setEnvFile(selected);
  }

  async function handleDelete() {
    if (deleteTyped !== app.name) return;
    await deleteApp(app.id);
    onClose();
  }

  const NAV: { id: Section; label: string }[] = [
    { id: "general",     label: "General" },
    { id: "domain",      label: "Domain" },
    { id: "environment", label: "Environment" },
    { id: "tunneling",   label: "Tunneling" },
    { id: "danger",      label: "Danger Zone" },
  ];

  return (
    <div className="fixed inset-0 bg-[#111113] text-zinc-100 font-sans flex h-screen overflow-hidden z-50">
      {/* Drag region */}
      <div className="drag-region fixed top-0 left-0 right-0 h-8 z-10 pointer-events-none" />

      {/* Sidebar */}
      <aside className="w-[200px] bg-[#1a1a1c] border-r border-white/[0.06] flex flex-col pt-8 pb-3 shrink-0">
        <div className="px-4 mb-4">
          <button
            onClick={onClose}
            className="flex items-center gap-1.5 text-[12px] text-zinc-500 hover:text-zinc-200 transition-colors"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M7.5 2L3.5 6l4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            Back
          </button>
        </div>

        <div className="px-4 mb-1">
          <p className="text-[11px] font-semibold text-zinc-500 uppercase tracking-widest truncate">
            {app.name}
          </p>
        </div>
        <div className="px-4 mb-3">
          <p className="text-[11px] text-zinc-600 truncate">
            {workspace?.domain ?? "standalone"} · :{app.port}
          </p>
        </div>

        <nav className="flex-1 flex flex-col gap-0.5 px-2 overflow-auto no-drag">
          {NAV.map(({ id, label }) => {
            const active = section === id;
            return (
              <button
                key={id}
                onClick={() => setSection(id)}
                className={`flex items-center px-2 py-1.5 rounded-[6px] text-[13px] w-full text-left transition-all duration-100 ${
                  active
                    ? id === "danger" ? "bg-red-500/10 text-red-400" : "bg-white/10 text-zinc-100"
                    : id === "danger"
                    ? "text-red-500/60 hover:bg-red-500/[0.07] hover:text-red-400"
                    : "text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-200"
                }`}
              >
                {label}
              </button>
            );
          })}
        </nav>
      </aside>

      {/* Content */}
      <main className="flex-1 overflow-auto pt-10 px-8 pb-8 no-drag flex flex-col">
        <div className="w-full flex flex-col gap-6">

          {section === "general" && (
            <>
              <div>
                <h1 className="text-[16px] font-semibold text-zinc-100">General</h1>
                <p className="text-[12px] text-zinc-500 mt-1">App identity and connection settings.</p>
              </div>

              <div className="flex flex-col gap-4 p-5 rounded-xl bg-white/[0.03] border border-white/[0.07]">
                <Field label="Name">
                  <input spellCheck={false} value={name} onChange={(e) => setName(e.target.value)}
                    className="input-base" placeholder="My App" />
                </Field>

                <Field label="Port" hint={!portValid && port ? "Must be 1-65535" : undefined}>
                  <input spellCheck={false} value={port} onChange={(e) => setPort(e.target.value)}
                    className={`input-base ${!portValid && port ? "border-red-500/50" : ""}`}
                    placeholder="3000" type="number" min={1} max={65535} />
                </Field>

                <Field label="Start Command">
                  <input spellCheck={false} value={startCommand} onChange={(e) => setStartCommand(e.target.value)}
                    className="input-base font-mono text-[12px]" placeholder="mix phx.server" />
                </Field>

                <Field label="Root Directory">
                  <p className="text-[12px] text-zinc-400 font-mono truncate bg-white/[0.03] border border-white/[0.06] rounded-lg px-3 py-2">
                    {app.root_dir}
                  </p>
                </Field>

                {/* Health check path (from agent-a7a6ec3b) */}
                <Field label="Health Check Path">
                  <input spellCheck={false} value={healthCheckPath} onChange={(e) => setHealthCheckPath(e.target.value)}
                    className="input-base" placeholder="/health" />
                  <p className="text-[10px] text-zinc-600 mt-1">
                    Leave blank to use port-only detection
                  </p>
                </Field>
              </div>

              {/* Start After (dependencies) (from agent-a7a6ec3b) */}
              {siblingApps.length > 0 && (
                <div className="flex flex-col gap-3 p-5 rounded-xl bg-white/[0.03] border border-white/[0.07]">
                  <div>
                    <p className="text-[12px] font-medium text-zinc-300">Start After</p>
                    <p className="text-[11px] text-zinc-500 mt-0.5 leading-relaxed">
                      Select apps that must be running before this app starts.
                    </p>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {siblingApps.map((sibling) => {
                      const checked = dependsOn.includes(sibling.id);
                      return (
                        <label
                          key={sibling.id}
                          className="flex items-center gap-2.5 px-2 py-1.5 rounded-lg hover:bg-white/[0.04] transition-colors cursor-pointer"
                        >
                          <input spellCheck={false}
                            type="checkbox"
                            checked={checked}
                            onChange={() =>
                              setDependsOn((prev) =>
                                checked
                                  ? prev.filter((id) => id !== sibling.id)
                                  : [...prev, sibling.id]
                              )
                            }
                            className="rounded border-white/[0.15] bg-white/[0.05] text-blue-500 focus:ring-blue-500/30 focus:ring-offset-0"
                          />
                          <span className="text-[13px] text-zinc-300">{sibling.name}</span>
                          <span className="text-[11px] text-zinc-600">:{sibling.port}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="flex items-center gap-2">
                {saveError && <p className="text-[11px] text-red-400 flex-1">{saveError}</p>}
                <div className="flex gap-2 ml-auto">
                  <button onClick={onClose} className="px-4 py-2 text-[13px] text-zinc-500 hover:text-zinc-200 rounded-lg transition-colors">
                    Cancel
                  </button>
                  <button
                    onClick={handleSave}
                    disabled={!canSave || saving}
                    className="px-4 py-2 text-[13px] font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg disabled:opacity-40 transition-colors"
                  >
                    {saving ? "Saving..." : "Save Changes"}
                  </button>
                </div>
              </div>
            </>
          )}

          {section === "domain" && (
            <>
              <div>
                <h1 className="text-[16px] font-semibold text-zinc-100">Domain</h1>
                <p className="text-[12px] text-zinc-500 mt-1">Subdomains and local HTTPS URLs for this app.</p>
              </div>

              <div className="flex flex-col gap-4 p-5 rounded-xl bg-white/[0.03] border border-white/[0.07]">
                <Field label="Subdomain" hint={subdomain && !subdomainValid ? "Lowercase letters, numbers, hyphens, or *" : undefined}>
                  <input spellCheck={false} value={subdomain} onChange={(e) => setSubdomain(e.target.value)}
                    className={`input-base ${subdomain && !subdomainValid ? "border-red-500/50" : ""}`}
                    placeholder={app.name} />
                  <p className="text-[10px] text-zinc-600 mt-1">
                    Use <code className="text-zinc-500">*</code> for wildcard (any subdomain)
                  </p>
                </Field>

                <Field label="Extra Subdomains" hint={extraSubdomainInput && !extraSubdomainInputValid ? "Lowercase letters, numbers, hyphens only" : undefined}>
                  {/* Tag list */}
                  {extraSubdomains.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mb-2">
                      {extraSubdomains.map((sub) => (
                        <span key={sub} className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-white/[0.07] border border-white/[0.10] text-[11px] font-mono text-zinc-300">
                          {sub}
                          <button
                            type="button"
                            onClick={() => setExtraSubdomains((prev) => prev.filter((s) => s !== sub))}
                            className="text-zinc-600 hover:text-red-400 transition-colors ml-0.5"
                          >
                            <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
                              <path d="M1 1l6 6M7 1L1 7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                            </svg>
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  {/* Add input */}
                  <div className="flex gap-2">
                    <input spellCheck={false}
                      value={extraSubdomainInput}
                      onChange={(e) => setExtraSubdomainInput(e.target.value.toLowerCase())}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addExtraSubdomain(); } }}
                      className={`input-base flex-1 font-mono text-[12px] ${extraSubdomainInput && !extraSubdomainInputValid ? "border-red-500/50" : ""}`}
                      placeholder="admin, platform, ..."
                    />
                    <button
                      type="button"
                      onClick={addExtraSubdomain}
                      disabled={!extraSubdomainInput || !extraSubdomainInputValid}
                      className="px-3 py-2 text-[12px] text-zinc-400 bg-white/[0.05] border border-white/[0.08] rounded-lg hover:bg-white/[0.08] hover:text-zinc-200 transition-colors disabled:opacity-30 disabled:pointer-events-none shrink-0"
                    >
                      Add
                    </button>
                  </div>
                  <p className="text-[10px] text-zinc-600 mt-1">
                    Each subdomain routes to the same port. Press <kbd className="text-zinc-500 font-sans">Enter</kbd> or comma to add.
                  </p>
                </Field>

                {/* URL Preview */}
                <div className="flex flex-col gap-1.5 pt-1">
                  <p className="text-[12px] font-medium text-zinc-400">URL Preview</p>
                  <div className="flex flex-col gap-1 px-3 py-2.5 rounded-lg bg-white/[0.03] border border-white/[0.06]">
                    <div className="flex items-center gap-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500/60 shrink-0" />
                      <span className="text-[12px] font-mono text-zinc-300 truncate">{previewPrimary}</span>
                      <span className="text-[10px] text-zinc-600 shrink-0">primary</span>
                    </div>
                    {previewExtras.map((url) => (
                      <div key={url} className="flex items-center gap-2">
                        <span className="w-1.5 h-1.5 rounded-full bg-zinc-600 shrink-0" />
                        <span className="text-[12px] font-mono text-zinc-500 truncate">{url}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2">
                {saveError && <p className="text-[11px] text-red-400 flex-1">{saveError}</p>}
                <div className="flex gap-2 ml-auto">
                  <button onClick={onClose} className="px-4 py-2 text-[13px] text-zinc-500 hover:text-zinc-200 rounded-lg transition-colors">
                    Cancel
                  </button>
                  <button
                    onClick={handleSave}
                    disabled={!canSave || saving}
                    className="px-4 py-2 text-[13px] font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg disabled:opacity-40 transition-colors"
                  >
                    {saving ? "Saving..." : "Save Changes"}
                  </button>
                </div>
              </div>
            </>
          )}

          {section === "environment" && (
            <>
              <div>
                <h1 className="text-[16px] font-semibold text-zinc-100">Environment</h1>
                <p className="text-[12px] text-zinc-500 mt-1">Environment variables and startup behavior.</p>
              </div>

              <div className="flex flex-col gap-5 p-5 rounded-xl bg-white/[0.03] border border-white/[0.07]">
                <div className="flex flex-col gap-2">
                  <p className="text-[12px] font-medium text-zinc-300">.env File</p>
                  <p className="text-[11px] text-zinc-500 leading-relaxed">
                    Variables from this file are injected when the app starts.
                    Relative paths (e.g. <code className="text-zinc-400">.env</code>) resolve from the app's root directory.
                    <code className="text-zinc-400 ml-1">PORT</code> is always overridden by Porta's assigned port.
                  </p>
                  <div className="flex gap-2">
                    <input spellCheck={false}
                      value={envFile}
                      onChange={(e) => setEnvFile(e.target.value)}
                      className="input-base flex-1 font-mono text-[12px]"
                      placeholder=".env"
                    />
                    <button
                      onClick={browseEnvFile}
                      className="px-3 py-2 text-[12px] text-zinc-400 bg-white/[0.05] border border-white/[0.08] rounded-lg hover:bg-white/[0.08] hover:text-zinc-200 transition-colors shrink-0"
                    >
                      Browse
                    </button>
                  </div>
                  {envFile && (
                    <button onClick={() => setEnvFile("")} className="self-start text-[10px] text-zinc-600 hover:text-zinc-400 transition-colors">
                      Clear
                    </button>
                  )}
                </div>

                <div className="h-px bg-white/[0.05]" />

                {/* Inline env vars editor */}
                <EnvVarEditor vars={envVars} onChange={setEnvVars} />

                <div className="h-px bg-white/[0.05]" />

                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-[13px] font-medium text-zinc-200">Auto-start on launch</p>
                    <p className="text-[11px] text-zinc-500 mt-0.5 leading-relaxed">
                      Automatically start this app when Porta opens.
                    </p>
                  </div>
                  <button
                    onClick={() => setAutoStart((v) => !v)}
                    className={`relative w-9 h-5 rounded-full transition-colors shrink-0 mt-0.5 ${
                      autoStart ? "bg-blue-600" : "bg-zinc-700"
                    }`}
                  >
                    <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all ${
                      autoStart ? "left-[18px]" : "left-0.5"
                    }`} />
                  </button>
                </div>

                <div className="h-px bg-white/[0.05]" />

                {/* Restart policy */}
                <div className="flex flex-col gap-3">
                  <div>
                    <p className="text-[12px] font-medium text-zinc-300">Restart Policy</p>
                    <p className="text-[11px] text-zinc-500 mt-0.5 leading-relaxed">
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
                            ? "bg-blue-600/30 text-blue-300 border border-blue-500/30"
                            : "bg-white/[0.04] text-zinc-400 border border-white/[0.07] hover:bg-white/[0.07]"
                        }`}
                      >
                        {policy === "never" ? "Never" : policy === "on-failure" ? "On Failure" : "Always"}
                      </button>
                    ))}
                  </div>
                  {restartPolicy !== "never" && (
                    <div className="flex items-center gap-3">
                      <label className="text-[12px] text-zinc-400 flex-1">Max retries</label>
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
              </div>

              <div className="flex items-center gap-2">
                {saveError && <p className="text-[11px] text-red-400 flex-1">{saveError}</p>}
                <div className="flex gap-2 ml-auto">
                  <button onClick={onClose} className="px-4 py-2 text-[13px] text-zinc-500 hover:text-zinc-200 rounded-lg transition-colors">
                    Cancel
                  </button>
                  <button
                    onClick={handleSave}
                    disabled={!canSave || saving}
                    className="px-4 py-2 text-[13px] font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg disabled:opacity-40 transition-colors"
                  >
                    {saving ? "Saving..." : "Save Changes"}
                  </button>
                </div>
              </div>
            </>
          )}

          {/* Tunneling section (from agent-a02c9388) */}
          {section === "tunneling" && (
            <>
              <div>
                <h1 className="text-[16px] font-semibold text-zinc-100">Tunneling</h1>
                <p className="text-[12px] text-zinc-500 mt-1">Expose this app to the internet via a secure tunnel.</p>
              </div>

              <div className="flex flex-col gap-5 p-5 rounded-xl bg-white/[0.03] border border-white/[0.07]">
                <div className="flex items-center justify-between">
                  <div className="flex flex-col gap-1 flex-1">
                    <label className="text-[12px] font-medium text-zinc-400">Provider</label>
                    <div className="relative w-[180px]">
                      <select
                        value={tunnelProvider}
                        onChange={(e) => setTunnelProvider(e.target.value)}
                        className="w-full appearance-none bg-[#111113] border border-white/[0.08] rounded-lg px-3 py-2 text-[13px] text-zinc-100 outline-none focus:border-blue-500/50 transition-colors pr-8 cursor-pointer"
                      >
                        <option value="cloudflare">Cloudflare</option>
                      </select>
                      <svg className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none" width="10" height="10" viewBox="0 0 10 10" fill="none">
                        <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    </div>
                  </div>

                  {/* Status badge */}
                  <TunnelStatusBadge
                    tunnelActive={app.tunnel_active}
                    tunnelUrl={app.tunnel_url}
                    className="mt-4"
                  />
                </div>

                {app.tunnel_active && !app.tunnel_url && (
                  <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20">
                    <svg className="animate-spin shrink-0 text-amber-400" width="12" height="12" viewBox="0 0 12 12" fill="none">
                      <path d="M6 1.5A4.5 4.5 0 1 1 1.5 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                    </svg>
                    <span className="text-[11px] text-amber-400">Establishing tunnel…</span>
                  </div>
                )}

                {app.tunnel_active && app.tunnel_url && (
                  <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-purple-500/10 border border-purple-500/20">
                    <svg width="12" height="12" viewBox="0 0 10 10" fill="none" className="text-purple-400 shrink-0">
                      <circle cx="5" cy="5" r="4" stroke="currentColor" strokeWidth="1.1"/>
                      <ellipse cx="5" cy="5" rx="2" ry="4" stroke="currentColor" strokeWidth="1.1"/>
                      <path d="M1 5h8" stroke="currentColor" strokeWidth="1.1"/>
                    </svg>
                    <span className="text-[11px] font-mono text-purple-300 truncate flex-1">
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
                )}

                {!app.tunnel_active && (
                  <Field label="Public Hostname (optional)">
                    <input spellCheck={false}
                      value={tunnelHostname}
                      onChange={(e) => setTunnelHostname(e.target.value)}
                      className="input-base font-mono text-[12px]"
                      placeholder="myapp.example.com"
                    />
                    <p className="text-[10px] text-zinc-600 mt-1">
                      Leave empty for a random <code className="text-zinc-500">*.trycloudflare.com</code> URL.
                    </p>
                  </Field>
                )}

                <div className="flex gap-2">
                  {app.tunnel_active ? (
                    <button
                      onClick={() => stopTunnel(app.id)}
                      className="px-4 py-2 text-[13px] font-medium text-zinc-300 bg-white/[0.07] hover:bg-white/[0.12] rounded-lg transition-colors"
                    >
                      Disconnect
                    </button>
                  ) : (
                    <button
                      onClick={() => startTunnel(app.id)}
                      className="px-4 py-2 text-[13px] font-medium text-purple-400 bg-purple-500/10 hover:bg-purple-500/20 rounded-lg transition-colors"
                    >
                      Quick Tunnel
                    </button>
                  )}
                </div>
              </div>
            </>
          )}

          {section === "danger" && (
            <>
              <div>
                <h1 className="text-[16px] font-semibold text-zinc-100">Danger Zone</h1>
                <p className="text-[12px] text-zinc-500 mt-1">Irreversible actions — proceed carefully.</p>
              </div>

              <div className="flex flex-col gap-3 p-5 rounded-xl bg-red-500/[0.04] border border-red-500/20">
                <div>
                  <p className="text-[13px] font-semibold text-red-400">Delete this app</p>
                  <p className="text-[12px] text-zinc-500 mt-1 leading-relaxed">
                    Removes the app from Porta. The files on disk won't be deleted.
                  </p>
                </div>
                <label className="flex flex-col gap-1.5">
                  <span className="text-[11px] text-zinc-500">
                    Type <span className="text-zinc-300 font-mono">{app.name}</span> to confirm
                  </span>
                  <input spellCheck={false}
                    ref={deleteInputRef}
                    value={deleteTyped}
                    onChange={(e) => setDeleteTyped(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleDelete()}
                    placeholder={app.name}
                    className="input-base focus:border-red-500/60"
                    autoComplete="off"
                  />
                </label>
                <button
                  onClick={handleDelete}
                  disabled={deleteTyped !== app.name}
                  className="self-start px-4 py-2 text-[13px] font-medium bg-red-600 hover:bg-red-500 text-white rounded-lg disabled:opacity-40 transition-colors"
                >
                  Delete App
                </button>
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

