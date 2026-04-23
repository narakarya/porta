import { useEffect, useRef, useState, useCallback } from "react";
import { usePortaStore } from "../../store";
import { checkPortAvailable, checkCloudflared, loadComposeYaml, parseComposeString, listCloudflareTunnels, setTunnelConfig, getTailscaleStatus, listTailscaleServes, type CloudflareTunnel, type PortCheckResult, type TailscaleStatus } from "../../lib/commands";
import YamlEditor from "../shared/YamlEditor";
import SetupCard from "../shared/SetupCard";
import type { App, EnvProfile, PortBinding, Workspace } from "../../types";
import Field from "../shared/Field";
import EnvVarEditor from "../shared/EnvVarEditor";
import TunnelStatusBadge from "../shared/TunnelStatusBadge";
import { yieldToFrame } from "../../lib/ui";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function volumeTemplate(appName: string): string {
  const slug = appName.toLowerCase().trim().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "") || "app";
  return `~/projects/docker/volumes/${slug}/data:/data`;
}

type Section = "general" | "domain" | "environment" | "tunneling" | "danger";

interface Props {
  app: App;
  workspace: Workspace | null;
  onClose: () => void;
}

export default function AppSettingsModal({ app, workspace, onClose }: Props) {
  const { updateApp, deleteApp, apps, startTunnel, stopTunnel, setupStatus, appTunnelErrors } = usePortaStore();
  const tunnelError = appTunnelErrors[app.id] ?? null;
  const [tunnelErrorCopied, setTunnelErrorCopied] = useState(false);
  const [section, setSection] = useState<Section>("general");
  const [tunnelUrlCopied, setTunnelUrlCopied] = useState(false);

  const [name, setName] = useState(app.name);
  const [rootDir, setRootDir] = useState(app.root_dir);
  const [port, setPort] = useState(String(app.port));
  const [subdomain, setSubdomain] = useState(app.subdomain ?? "");
  const [extraSubdomains, setExtraSubdomains] = useState<string[]>(app.extra_subdomains ?? []);
  const [extraSubdomainInput, setExtraSubdomainInput] = useState("");
  const [portBindings, setPortBindings] = useState<PortBinding[]>(app.port_bindings ?? []);
  const [customDomain, setCustomDomain] = useState(app.custom_domain ?? "");

  const [startCommand, setStartCommand] = useState(app.start_command);
  const [dockerImage, setDockerImage] = useState(app.docker_image ?? "");
  const [dockerContainerPort, setDockerContainerPort] = useState(String(app.docker_container_port ?? 80));
  const [dockerArgs, setDockerArgs] = useState(app.docker_args ?? "");
  const [dockerVolumes, setDockerVolumes] = useState<string[]>(app.docker_volumes ?? []);
  const [composeFile, setComposeFile] = useState(app.compose_file ?? "");
  // Detect if the current compose_file is inside Porta's managed dir — if so,
  // default the mode to "paste" and load the existing yaml content for edit.
  const isManagedPath = !!app.compose_file && /\/\.porta(-dev)?\/compose\//.test(app.compose_file);
  const [composeMode, setComposeMode] = useState<"file" | "paste">(isManagedPath ? "paste" : "file");
  const [composeYaml, setComposeYaml] = useState("");
  const [composeError, setComposeError] = useState<string | null>(null);
  const [composeErrorLine, setComposeErrorLine] = useState<number | undefined>(undefined);
  const [networkShare, setNetworkShare] = useState(app.network_share);

  useEffect(() => {
    if (app.kind !== "compose" || !isManagedPath || !app.compose_file) return;
    let cancelled = false;
    loadComposeYaml(app.compose_file).then((c) => {
      if (!cancelled) setComposeYaml(c);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [app.kind, app.compose_file, isManagedPath]);

  // Validate pasted YAML on edit.
  useEffect(() => {
    if (app.kind !== "compose" || composeMode !== "paste" || !composeYaml.trim()) {
      setComposeError(null);
      return;
    }
    const handle = setTimeout(() => {
      parseComposeString(composeYaml)
        .then(() => { setComposeError(null); setComposeErrorLine(undefined); })
        .catch((e) => {
          const msg = e instanceof Error ? e.message : String(e);
          setComposeError(msg);
          const m = msg.match(/line (\d+)/i);
          setComposeErrorLine(m ? parseInt(m[1], 10) : undefined);
        });
    }, 300);
    return () => clearTimeout(handle);
  }, [composeYaml, composeMode, app.kind]);
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
  const [tunnelMode, setTunnelMode] = useState<"quick" | "named">(app.tunnel_name ? "named" : "quick");
  const [tunnelName, setTunnelName] = useState(app.tunnel_name ?? "");
  const [tunnelHostname, setTunnelHostname] = useState(app.tunnel_custom_hostname ?? "");
  const [availableTunnels, setAvailableTunnels] = useState<CloudflareTunnel[]>([]);
  const [tunnelsError, setTunnelsError] = useState<string | null>(null);
  const [tunnelsLoading, setTunnelsLoading] = useState(false);
  const [cloudflaredInstalled, setCloudflaredInstalled] = useState<boolean | null>(null);
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);
  const [tsStatus, setTsStatus] = useState<TailscaleStatus | null>(null);
  const [tsLoading, setTsLoading] = useState(false);
  const [tsFunnel, setTsFunnel] = useState(false);

  function copyCmd(cmd: string) {
    navigator.clipboard.writeText(cmd).then(() => {
      setCopiedCmd(cmd);
      setTimeout(() => setCopiedCmd(null), 1500);
    });
  }

  async function handleConnect() {
    // Persist provider + tunnel config first so start_tunnel/start_tailscale_serve
    // sees the latest values — avoids the "you have to Save before Connect" gotcha.
    const newName = tunnelProvider === "cloudflare" && tunnelMode === "named"
      ? (tunnelName.trim() || null)
      : null;
    const newHost = tunnelProvider === "cloudflare" && tunnelMode === "named"
      ? (tunnelHostname.trim() || null)
      : null;
    const currentProvider = app.tunnel_provider ?? null;
    const currentName = app.tunnel_name ?? null;
    const currentHost = app.tunnel_custom_hostname ?? null;
    if (tunnelProvider !== currentProvider || newName !== currentName || newHost !== currentHost) {
      try {
        await setTunnelConfig(app.id, tunnelProvider, newName, newHost);
      } catch (e) {
        window.alert(`Failed to save tunnel config: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
    }
    startTunnel(app.id, tunnelProvider, tunnelProvider === "tailscale" ? tsFunnel : undefined);
  }

  async function refreshTailscale() {
    setTsLoading(true);
    try {
      const status = await getTailscaleStatus();
      setTsStatus(status);
      // Reconcile: if tailscaled already has a serve entry for this app's port,
      // mark the tunnel active so the UI reflects reality after a Porta restart.
      if (status.installed && status.running && status.logged_in && status.host) {
        try {
          const serves = await listTailscaleServes();
          const match = serves.find((s) => s.port === app.port);
          if (match) {
            const url = match.port === 443 ? `https://${status.host}` : `https://${status.host}:${match.port}`;
            usePortaStore.setState((s) => ({
              apps: s.apps.map((a) =>
                a.id === app.id ? { ...a, tunnel_active: true, tunnel_url: url, tunnel_provider: "tailscale" } : a
              ),
            }));
          }
        } catch {
          // Non-fatal — reconcile is best-effort.
        }
      }
    } catch (e) {
      setTsStatus({
        installed: false, running: false, logged_in: false, host: null,
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setTsLoading(false);
    }
  }

  async function refreshTunnels() {
    setTunnelsLoading(true);
    setTunnelsError(null);
    try {
      const installed = await checkCloudflared();
      setCloudflaredInstalled(installed);
      if (!installed) {
        setAvailableTunnels([]);
        return;
      }
      const list = await listCloudflareTunnels();
      setAvailableTunnels(list);
    } catch (e) {
      setTunnelsError(e instanceof Error ? e.message : String(e));
      setAvailableTunnels([]);
    } finally {
      setTunnelsLoading(false);
    }
  }

  // Lazy-load tunnels only when the user actually opens the Tunneling section
  // in Named mode. Pre-loading on mount was spamming `cloudflared tunnel list`
  // and made the modal feel slow for non-tunnel use.
  useEffect(() => {
    if (section === "tunneling" && tunnelProvider === "cloudflare" && tunnelMode === "named" && cloudflaredInstalled === null) {
      refreshTunnels();
    }
    if (section === "tunneling" && tunnelProvider === "tailscale" && tsStatus === null) {
      refreshTailscale();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, tunnelMode, tunnelProvider]);

  const [deleteTyped, setDeleteTyped] = useState("");
  const deleteInputRef = useRef<HTMLInputElement>(null);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const portNum = parseInt(port, 10);
  const portValid = !isNaN(portNum) && portNum > 0 && portNum < 65536;
  const SUBDOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$|^\*$/;
  const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
  const subdomainValid = !subdomain || SUBDOMAIN_RE.test(subdomain);
  const extraSubdomainInputValid = !extraSubdomainInput || SUBDOMAIN_RE.test(extraSubdomainInput);
  const customDomainValid = !customDomain || DOMAIN_RE.test(customDomain);
  // Port bindings validation
  const portBindingsValid = portBindings.every((b) => {
    const bPortNum = b.port;
    const bPortOk = !isNaN(bPortNum) && bPortNum > 0 && bPortNum < 65536;
    const bSubOk = !b.subdomain || SUBDOMAIN_RE.test(b.subdomain);
    const bDomOk = !b.custom_domain || DOMAIN_RE.test(b.custom_domain);
    return b.label.trim() && bPortOk && bSubOk && bDomOk;
  });
  const rootDirOk = (app.kind === "docker" || app.kind === "compose") ? true : !!rootDir.trim();
  const canSave = name.trim() && rootDirOk && portValid && subdomainValid && customDomainValid && portBindingsValid;

  // Environment profiles
  const [envProfiles, setEnvProfiles] = useState<EnvProfile[]>(app.env_profiles ?? []);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(app.active_profile_id ?? null);
  const [showNewProfile, setShowNewProfile] = useState(false);
  const [newProfileName, setNewProfileName] = useState("");
  const [deleteProfileConfirm, setDeleteProfileConfirm] = useState<string | null>(null);

  const selectProfile = useCallback((profileId: string | null) => {
    if (activeProfileId) {
      const obj: Record<string, string> = {};
      for (const { key, value } of envVars) { if (key.trim()) obj[key.trim()] = value; }
      setEnvProfiles((prev) => prev.map((p) => p.id === activeProfileId ? { ...p, env_file: envFile.trim() || null, env_vars: obj } : p));
    }
    setActiveProfileId(profileId);
    if (profileId) {
      const profile = envProfiles.find((p) => p.id === profileId);
      if (profile) { setEnvFile(profile.env_file ?? ""); setEnvVars(Object.entries(profile.env_vars ?? {}).map(([key, value]) => ({ key, value }))); }
    } else {
      setEnvFile(app.env_file ?? ""); setEnvVars(Object.entries(app.env_vars ?? {}).map(([key, value]) => ({ key, value })));
    }
  }, [activeProfileId, envVars, envFile, envProfiles, app.env_file, app.env_vars]);

  const createProfile = useCallback(() => {
    if (!newProfileName.trim()) return;
    const obj: Record<string, string> = {};
    for (const { key, value } of envVars) { if (key.trim()) obj[key.trim()] = value; }
    const np: EnvProfile = { id: `prof-${Date.now().toString(36)}`, name: newProfileName.trim(), env_file: envFile.trim() || null, env_vars: { ...obj } };
    setEnvProfiles((prev) => [...prev, np]);
    setActiveProfileId(np.id);
    setNewProfileName(""); setShowNewProfile(false);
  }, [newProfileName, envVars, envFile]);

  const deleteProfile = useCallback((profileId: string) => {
    setEnvProfiles((prev) => prev.filter((p) => p.id !== profileId));
    if (activeProfileId === profileId) {
      setActiveProfileId(null); setEnvFile(app.env_file ?? ""); setEnvVars(Object.entries(app.env_vars ?? {}).map(([key, value]) => ({ key, value })));
    }
    setDeleteProfileConfirm(null);
  }, [activeProfileId, app.env_file, app.env_vars]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Port availability check (debounced) — skip if port unchanged from the app's current port
  const [portCheckResult, setPortCheckResult] = useState<PortCheckResult | null>(null);
  useEffect(() => {
    if (!portValid) { setPortCheckResult(null); return; }
    if (portNum === app.port) { setPortCheckResult(null); return; }
    const timer = setTimeout(() => { checkPortAvailable(portNum).then(setPortCheckResult).catch(() => {}); }, 500);
    return () => clearTimeout(timer);
  }, [port, portValid, portNum, app.port]);

  // Live URL preview
  const scheme = setupStatus?.certs_generated ? "https" : "http";
  const domain = customDomain.trim() || workspace?.domain || "narakarya.test";
  const effectiveSub = subdomain.trim() || name.trim() || "…";
  const previewPrimary = effectiveSub === "*"
    ? `${scheme}://*.${domain}`
    : `${scheme}://${effectiveSub}.${domain}`;
  const previewExtras = extraSubdomains.map((s) => `${scheme}://${s}.${domain}`);
  const previewBindings = portBindings.map((b) => {
    const bDomain = b.custom_domain?.trim() || domain;
    const bSub = b.subdomain?.trim() || b.label.trim().toLowerCase().replace(/\s+/g, "-") || "binding";
    return { label: b.label, url: `${scheme}://${bSub}.${bDomain}`, port: b.port };
  });

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
    await yieldToFrame();
    try {
      // Convert env vars array back to Record, skipping empty keys
      const env_vars: Record<string, string> = {};
      for (const { key, value } of envVars) {
        if (key.trim()) env_vars[key.trim()] = value;
      }

      // Sync the currently-displayed env values back into the active profile
      let finalProfiles = [...envProfiles];
      let finalEnvFile: string | null = envFile.trim() || null;
      let finalEnvVars = env_vars;

      if (activeProfileId) {
        finalProfiles = finalProfiles.map((p) =>
          p.id === activeProfileId
            ? { ...p, env_file: envFile.trim() || null, env_vars: { ...env_vars } }
            : p
        );
        finalEnvFile = app.env_file ?? null;
        finalEnvVars = app.env_vars ?? {};
      }

      await updateApp({
        id: app.id,
        name: name.trim(),
        root_dir: rootDir.trim() !== app.root_dir ? rootDir.trim() : undefined,
        port: portNum,
        subdomain: subdomain.trim() || null,
        start_command: startCommand.trim(),
        env_file: finalEnvFile,
        auto_start: autoStart,
        env_vars: finalEnvVars,
        restart_policy: restartPolicy,
        max_retries: parseInt(maxRetries, 10) || 3,
        health_check_path: healthCheckPath.trim() || null,
        depends_on: dependsOn,
        extra_subdomains: extraSubdomains,
        custom_domain: customDomain.trim() || null,
        port_bindings: portBindings,
        env_profiles: finalProfiles,
        active_profile_id: activeProfileId,
        docker_image: app.kind === "docker" ? (dockerImage.trim() || null) : null,
        docker_container_port: app.kind === "docker" ? (parseInt(dockerContainerPort, 10) || null) : null,
        docker_args: app.kind === "docker" ? (dockerArgs.trim() || null) : null,
        docker_volumes: app.kind === "docker" ? dockerVolumes.filter((v) => v.trim()) : [],
        compose_file: app.kind === "compose" && composeMode === "file" ? (composeFile.trim() || null) : null,
        compose_yaml: app.kind === "compose" && composeMode === "paste" ? composeYaml : null,
        network_share: (app.kind === "docker" || app.kind === "compose") ? networkShare : false,
        tunnel_name: tunnelMode === "named" ? (tunnelName.trim() || null) : null,
        tunnel_custom_hostname: tunnelMode === "named" ? (tunnelHostname.trim() || null) : null,
      });
      onClose();
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function browseRootDir() {
    let selected: string | null = null;
    if (isTauri) {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      selected = await openDialog({ directory: true, multiple: false }).catch(() => null) as string | null;
    } else {
      selected = window.prompt("Enter project folder path:", rootDir);
    }
    if (typeof selected === "string" && selected) setRootDir(selected);
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

  const isStatic = app.kind === "static";
  const isDocker = app.kind === "docker";
  const isCompose = app.kind === "compose";
  // Env vars only apply to processes. Tunneling works for static too — Porta
  // routes cloudflared through Caddy for those.
  const NAV: { id: Section; label: string }[] = [
    { id: "general",     label: "General" },
    { id: "domain",      label: "Domain" },
    ...(isStatic ? [] : [{ id: "environment" as Section, label: "Environment" }]),
    { id: "tunneling"   as Section, label: "Tunneling" },
    { id: "danger",      label: "Danger Zone" },
  ];

  return (
    <div className="fixed inset-0 bg-[#111113] text-zinc-100 font-sans flex h-screen overflow-hidden z-50">
      {/* Drag region */}
      <div className="drag-region fixed top-0 left-0 right-0 h-8 z-10 pointer-events-none" />
      {/* Close button */}
      <button
        onClick={onClose}
        className="fixed top-2 right-3 z-20 p-1.5 rounded-lg text-zinc-600 hover:text-zinc-300 hover:bg-white/[0.07] transition-colors no-drag"
        title="Close (Esc)"
      >
        <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
          <path d="M2 2l9 9M11 2L2 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
      </button>

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
                {isStatic && (
                  <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-blue-500/10 border border-blue-500/20">
                    <span className="text-[10px] font-semibold tracking-wider text-blue-300 mt-0.5">STATIC</span>
                    <p className="text-[11px] text-blue-200/80">
                      Caddy serves files directly from the root directory — no process,
                      no port, no start command.
                    </p>
                  </div>
                )}
                {isDocker && (
                  <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-sky-500/10 border border-sky-500/20">
                    <span className="text-[10px] font-semibold tracking-wider text-sky-300 mt-0.5">DOCKER</span>
                    <p className="text-[11px] text-sky-200/80">
                      Porta runs container <code className="font-mono">porta-{app.id.slice(0, 8)}…</code>.
                      Host port maps to the container port below.
                    </p>
                  </div>
                )}
                {isCompose && (
                  <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-teal-500/10 border border-teal-500/20">
                    <span className="text-[10px] font-semibold tracking-wider text-teal-300 mt-0.5">COMPOSE</span>
                    <p className="text-[11px] text-teal-200/80">
                      Porta runs <code className="font-mono">docker compose up/down</code> in project <code className="font-mono">porta-{app.id.slice(0, 8)}…</code>. Port should match what compose publishes.
                    </p>
                  </div>
                )}
                <Field label="Name">
                  <input spellCheck={false} value={name} onChange={(e) => setName(e.target.value)}
                    className="input-base" placeholder="My App" />
                </Field>

                {!isStatic && (
                  <Field label={isDocker ? "Host Port" : isCompose ? "Proxy Port" : "Port"} hint={!portValid && port ? "Must be 1-65535" : undefined}>
                    <input spellCheck={false} value={port} onChange={(e) => setPort(e.target.value)}
                      className={`input-base ${!portValid && port ? "border-red-500/50" : ""}`}
                      placeholder="3000" type="number" min={1} max={65535} />
                    {portCheckResult && portValid && (
                      <p className={`text-[10px] mt-1 ${portCheckResult.available ? "text-emerald-400" : "text-amber-400"}`}>
                        {portCheckResult.available
                          ? "✓ Port available"
                          : `⚠ Port in use by ${portCheckResult.process_name ?? "unknown"} (PID ${portCheckResult.pid ?? "?"})`}
                      </p>
                    )}
                  </Field>
                )}

                {isCompose && (
                  <Field label="Compose Source">
                    <div className="flex gap-1 bg-white/[0.03] border border-white/[0.08] rounded-lg p-1 mb-2">
                      {(["paste", "file"] as const).map((m) => (
                        <button
                          key={m}
                          type="button"
                          onClick={() => setComposeMode(m)}
                          className={`flex-1 px-3 py-1.5 text-[12px] font-medium rounded-md transition-colors ${
                            composeMode === m ? "bg-white/[0.08] text-zinc-100" : "text-zinc-500 hover:text-zinc-300"
                          }`}
                        >
                          {m === "paste" ? "Paste YAML" : "File on disk"}
                        </button>
                      ))}
                    </div>
                    {composeMode === "file" ? (
                      <>
                        <input spellCheck={false} value={composeFile} onChange={(e) => setComposeFile(e.target.value)}
                          className="input-base font-mono text-[12px]" placeholder="docker-compose.yml" />
                        <p className="text-[10px] text-zinc-600 mt-1">Relative to Root Directory, or absolute.</p>
                      </>
                    ) : (
                      <>
                        <YamlEditor
                          value={composeYaml}
                          onChange={setComposeYaml}
                          placeholder={`services:\n  app:\n    image: postgres:16\n    ports:\n      - "5432:5432"`}
                          rows={20}
                          errorLine={composeErrorLine}
                          errorMessage={composeError ?? undefined}
                        />
                        {composeError && (
                          <div className="mt-2 px-2.5 py-1.5 rounded-md bg-red-500/10 border border-red-500/30 text-[11px] text-red-300 font-mono whitespace-pre-wrap break-words">
                            {composeError}
                          </div>
                        )}
                        <p className="text-[10px] text-zinc-600 mt-1">
                          Porta manages <code className="font-mono">~/.porta/compose/&lt;id&gt;/docker-compose.yml</code>. Restart app after edits.
                        </p>
                      </>
                    )}
                  </Field>
                )}

                {isDocker && (
                  <>
                    <Field label="Image">
                      <input spellCheck={false} value={dockerImage} onChange={(e) => setDockerImage(e.target.value)}
                        className="input-base font-mono text-[12px]" placeholder="e.g. postgres:16" />
                    </Field>
                    <Field label="Container Port">
                      <input spellCheck={false} value={dockerContainerPort} onChange={(e) => setDockerContainerPort(e.target.value)}
                        className="input-base" placeholder="80" type="number" min={1} max={65535} />
                      <p className="text-[10px] text-zinc-600 mt-1">Internal port the container listens on.</p>
                    </Field>
                    <Field label="Volumes">
                      <div className="flex flex-col gap-1.5">
                        {dockerVolumes.map((v, i) => (
                          <div key={i} className="flex gap-2">
                            <input
                              spellCheck={false}
                              value={v}
                              onChange={(e) => setDockerVolumes((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))}
                              placeholder="./data:/var/lib/data"
                              className="input-base flex-1 font-mono text-[12px]"
                            />
                            <button
                              type="button"
                              onClick={() => setDockerVolumes((prev) => prev.map((x, j) => (j === i ? volumeTemplate(name) : x)))}
                              className="px-2.5 text-zinc-500 hover:text-zinc-200 border border-white/[0.08] rounded-lg text-[11px] shrink-0"
                              title={`Fill with ${volumeTemplate(name)}`}
                            >
                              base
                            </button>
                            <button
                              type="button"
                              onClick={() => setDockerVolumes((prev) => prev.filter((_, j) => j !== i))}
                              className="px-2.5 text-zinc-500 hover:text-red-400 border border-white/[0.08] rounded-lg text-[14px] shrink-0"
                              title="Remove"
                            >
                              ×
                            </button>
                          </div>
                        ))}
                        <button
                          type="button"
                          onClick={() => setDockerVolumes((prev) => [...prev, ""])}
                          className="self-start px-2.5 py-1 text-[11px] text-zinc-400 hover:text-zinc-200 border border-dashed border-white/[0.12] rounded-md"
                        >
                          + Add volume
                        </button>
                      </div>
                      <p className="text-[10px] text-zinc-600 mt-1">
                        <code className="font-mono">source:target</code> — relative sources resolve against Root Directory.
                      </p>
                    </Field>
                    <Field label="Extra Args">
                      <input spellCheck={false} value={dockerArgs} onChange={(e) => setDockerArgs(e.target.value)}
                        className="input-base font-mono text-[12px]" placeholder="-e DEBUG=true --network my-net" />
                    </Field>
                  </>
                )}

                {!isStatic && !isDocker && !isCompose && (
                  <Field label="Start Command">
                    <input spellCheck={false} value={startCommand} onChange={(e) => setStartCommand(e.target.value)}
                      className="input-base font-mono text-[12px]" placeholder="mix phx.server" />
                  </Field>
                )}

                <Field label={isDocker ? "Root Directory (optional)" : isCompose ? "Compose Project Folder" : "Root Directory"}>
                  <div className="flex gap-2">
                    <input
                      spellCheck={false}
                      value={rootDir}
                      onChange={(e) => setRootDir(e.target.value)}
                      className="input-base flex-1 font-mono text-[12px]"
                      placeholder={isDocker ? "Base for relative volume paths" : isCompose ? "Folder containing compose file" : "/path/to/project"}
                    />
                    <button
                      type="button"
                      onClick={browseRootDir}
                      className="px-3 py-2 text-[12px] text-zinc-400 bg-white/[0.05] border border-white/[0.08] rounded-lg hover:bg-white/[0.08] hover:text-zinc-200 transition-colors shrink-0"
                    >
                      Browse
                    </button>
                  </div>
                </Field>

                {(isDocker || isCompose) && (
                  <Field label="Workspace Network">
                    <label className="flex items-start gap-2.5 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={networkShare}
                        onChange={(e) => setNetworkShare(e.target.checked)}
                        className="mt-0.5 rounded border-white/[0.15] bg-white/[0.05] text-blue-500 focus:ring-blue-500/30 focus:ring-offset-0"
                      />
                      <div className="flex flex-col gap-0.5">
                        <span className="text-[12px] text-zinc-200">Join shared network</span>
                        <span className="text-[11px] text-zinc-500">
                          Network <code className="font-mono">{app.workspace_id ? `porta-ws-${app.workspace_id.slice(0, 8)}…` : "porta-standalone"}</code>.
                          Restart app to apply.
                        </span>
                      </div>
                    </label>
                  </Field>
                )}

                {!isStatic && (
                  <Field label="Health Check Path">
                    <input spellCheck={false} value={healthCheckPath} onChange={(e) => setHealthCheckPath(e.target.value)}
                      className="input-base" placeholder="/health" />
                    <p className="text-[10px] text-zinc-600 mt-1">
                      Leave blank to use port-only detection
                    </p>
                  </Field>
                )}
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
                    className="px-4 py-2 text-[13px] font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg disabled:opacity-40 transition-colors flex items-center gap-1.5"
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
                <Field label="Custom Domain" hint={customDomain && !customDomainValid ? "Must be a valid domain (e.g. myapp.dev)" : undefined}>
                  <input spellCheck={false} value={customDomain} onChange={(e) => setCustomDomain(e.target.value.toLowerCase())}
                    className={`input-base font-mono text-[12px] ${customDomain && !customDomainValid ? "border-red-500/50" : ""}`}
                    placeholder={workspace?.domain ?? "narakarya.test"} />
                  <p className="text-[10px] text-zinc-600 mt-1">
                    Override the workspace domain for this app. Leave empty to use <code className="text-zinc-500">{workspace?.domain ?? "narakarya.test"}</code>
                  </p>
                </Field>

                <div className="h-px bg-white/[0.05]" />

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
                    {previewBindings.map((b) => (
                      <div key={b.url} className="flex items-center gap-2">
                        <span className="w-1.5 h-1.5 rounded-full bg-blue-500/60 shrink-0" />
                        <span className="text-[12px] font-mono text-zinc-400 truncate">{b.url}</span>
                        <span className="text-[10px] text-zinc-600 shrink-0">:{b.port}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Port Bindings */}
              <div className="flex flex-col gap-4 p-5 rounded-xl bg-white/[0.03] border border-white/[0.07]">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-[12px] font-medium text-zinc-300">Port Bindings</p>
                    <p className="text-[11px] text-zinc-500 mt-0.5 leading-relaxed">
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
                    className="px-3 py-1.5 text-[12px] text-zinc-400 bg-white/[0.05] border border-white/[0.08] rounded-lg hover:bg-white/[0.08] hover:text-zinc-200 transition-colors shrink-0"
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
                    <div key={binding.id} className="flex items-center gap-2 p-3 rounded-lg bg-white/[0.02] border border-white/[0.06]">
                      <input
                        spellCheck={false}
                        value={binding.label}
                        onChange={(e) => updateBinding({ label: e.target.value })}
                        className={`input-base flex-[2] min-w-0 ${!binding.label.trim() && binding.port ? "border-red-500/50" : ""}`}
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
                        className={`input-base w-20 ${binding.port && !bPortOk ? "border-red-500/50" : ""}`}
                        placeholder="Port"
                        title="Port"
                      />
                      <input
                        spellCheck={false}
                        value={binding.subdomain ?? ""}
                        onChange={(e) => updateBinding({ subdomain: e.target.value.toLowerCase() || null })}
                        className={`input-base flex-[2] min-w-0 font-mono text-[12px] ${binding.subdomain && !bSubOk ? "border-red-500/50" : ""}`}
                        placeholder={binding.label.trim().toLowerCase().replace(/\s+/g, "-") || "subdomain"}
                        title="Subdomain"
                      />
                      <input
                        spellCheck={false}
                        value={binding.custom_domain ?? ""}
                        onChange={(e) => updateBinding({ custom_domain: e.target.value.toLowerCase() || null })}
                        className={`input-base flex-[2] min-w-0 font-mono text-[12px] ${binding.custom_domain && !bDomOk ? "border-red-500/50" : ""}`}
                        placeholder={workspace?.domain ?? "domain"}
                        title="Custom Domain"
                      />
                      <button
                        type="button"
                        onClick={() => setPortBindings((prev) => prev.filter((_, i) => i !== idx))}
                        className="p-1.5 rounded-lg text-zinc-600 hover:text-red-400 hover:bg-red-500/10 transition-colors shrink-0"
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
                  <p className="text-[11px] text-zinc-600 text-center py-2">
                    No extra port bindings. Click "+ Add" to map additional ports.
                  </p>
                )}
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
                    className="px-4 py-2 text-[13px] font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg disabled:opacity-40 transition-colors flex items-center gap-1.5"
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
              </div>
            </>
          )}

          {section === "environment" && (
            <>
              <div>
                <h1 className="text-[16px] font-semibold text-zinc-100">Environment</h1>
                <p className="text-[12px] text-zinc-500 mt-1">Environment variables and startup behavior.</p>
              </div>

              {/* Profile selector */}
              <div className="flex flex-col gap-3 p-5 rounded-xl bg-white/[0.03] border border-white/[0.07]">
                <div className="flex items-center justify-between">
                  <p className="text-[12px] font-medium text-zinc-300">Profile</p>
                  <button onClick={() => setShowNewProfile(true)} className="text-[11px] text-blue-400 hover:text-blue-300 transition-colors">+ New Profile</button>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => selectProfile(null)}
                    className={`px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors ${
                      activeProfileId === null
                        ? "bg-blue-600/30 text-blue-300 border border-blue-500/30"
                        : "bg-white/[0.04] text-zinc-400 border border-white/[0.07] hover:bg-white/[0.07]"
                    }`}
                  >Default</button>
                  {envProfiles.map((profile) => (
                    <div key={profile.id} className="flex items-center gap-0">
                      <button
                        onClick={() => selectProfile(profile.id)}
                        className={`px-3 py-1.5 rounded-l-lg text-[12px] font-medium transition-colors ${
                          activeProfileId === profile.id
                            ? "bg-blue-600/30 text-blue-300 border border-blue-500/30"
                            : "bg-white/[0.04] text-zinc-400 border border-white/[0.07] hover:bg-white/[0.07]"
                        }`}
                      >{profile.name}</button>
                      {deleteProfileConfirm === profile.id ? (
                        <div className="flex items-center gap-1 ml-1">
                          <button onClick={() => deleteProfile(profile.id)} className="px-1.5 py-1.5 text-[10px] font-medium text-red-400 bg-red-500/10 border border-red-500/20 rounded transition-colors hover:bg-red-500/20">Delete</button>
                          <button onClick={() => setDeleteProfileConfirm(null)} className="px-1.5 py-1.5 text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors">Cancel</button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setDeleteProfileConfirm(profile.id)}
                          className={`px-1.5 py-1.5 rounded-r-lg text-zinc-600 hover:text-red-400 transition-colors border-y border-r ${
                            activeProfileId === profile.id ? "border-blue-500/30 bg-blue-600/30" : "border-white/[0.07] bg-white/[0.04] hover:bg-white/[0.07]"
                          }`}
                          title={`Delete ${profile.name}`}
                        >
                          <svg width="8" height="8" viewBox="0 0 8 8" fill="none"><path d="M1 1l6 6M7 1L1 7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                {activeProfileId && (
                  <p className="text-[10px] text-blue-400/60">Active profile will be used when starting the app.</p>
                )}
                {showNewProfile && (
                  <div className="flex gap-2 items-center">
                    <input spellCheck={false} value={newProfileName} onChange={(e) => setNewProfileName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") createProfile(); if (e.key === "Escape") { setShowNewProfile(false); setNewProfileName(""); } }}
                      className="input-base flex-1 text-[12px]" placeholder="Profile name (e.g. staging)" autoFocus />
                    <button onClick={createProfile} disabled={!newProfileName.trim()} className="px-3 py-2 text-[12px] font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg disabled:opacity-40 transition-colors shrink-0">Create</button>
                    <button onClick={() => { setShowNewProfile(false); setNewProfileName(""); }} className="px-2 py-2 text-[12px] text-zinc-500 hover:text-zinc-200 transition-colors shrink-0">Cancel</button>
                  </div>
                )}
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
                    className="px-4 py-2 text-[13px] font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg disabled:opacity-40 transition-colors flex items-center gap-1.5"
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
                        disabled={app.tunnel_active}
                        className="w-full appearance-none bg-[#111113] border border-white/[0.08] rounded-lg px-3 py-2 text-[13px] text-zinc-100 outline-none focus:border-blue-500/50 transition-colors pr-8 cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
                      >
                        <option value="cloudflare">Cloudflare</option>
                        <option value="tailscale">Tailscale</option>
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
                    provider={app.tunnel_provider}
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

                {!app.tunnel_active && tunnelProvider === "cloudflare" && (
                  <Field label="Mode">
                    <div className="flex gap-1 bg-white/[0.03] border border-white/[0.08] rounded-lg p-1 mb-2">
                      {(["quick", "named"] as const).map((m) => (
                        <button
                          key={m}
                          type="button"
                          onClick={() => setTunnelMode(m)}
                          className={`flex-1 px-3 py-1.5 text-[12px] font-medium rounded-md transition-colors ${
                            tunnelMode === m ? "bg-white/[0.08] text-zinc-100" : "text-zinc-500 hover:text-zinc-300"
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
                            />
                          )}

                          {/* Ready state — show form */}
                          {!needsInstall && !needsLogin && !needsCreateTunnel && (
                            <>
                              <div>
                                <div className="flex items-center gap-2 mb-1.5">
                                  <span className="text-[11px] font-medium text-zinc-400">Cloudflare Tunnel</span>
                                  <button
                                    type="button"
                                    onClick={refreshTunnels}
                                    disabled={tunnelsLoading}
                                    className="text-[10px] text-zinc-500 hover:text-zinc-200 transition-colors disabled:opacity-50"
                                  >
                                    {tunnelsLoading ? "Loading…" : "↻ Refresh"}
                                  </button>
                                </div>
                                {tunnelsLoading && availableTunnels.length === 0 ? (
                                  <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/[0.03] border border-white/[0.08] text-[12px] text-zinc-500">
                                    <svg className="animate-spin" width="11" height="11" viewBox="0 0 12 12" fill="none">
                                      <path d="M6 1.5A4.5 4.5 0 1 1 1.5 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                                    </svg>
                                    Loading tunnels…
                                  </div>
                                ) : availableTunnels.length > 0 ? (
                                  <div className="relative">
                                    <select
                                      value={tunnelName}
                                      onChange={(e) => setTunnelName(e.target.value)}
                                      className="w-full appearance-none bg-[#111113] border border-white/[0.08] rounded-lg px-3 py-2 text-[13px] text-zinc-100 outline-none focus:border-blue-500/50 transition-colors pr-8 cursor-pointer"
                                    >
                                      <option value="">Select a tunnel…</option>
                                      {availableTunnels.map((t) => (
                                        <option key={t.id} value={t.name}>
                                          {t.name}
                                        </option>
                                      ))}
                                    </select>
                                    <svg className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none" width="10" height="10" viewBox="0 0 10 10" fill="none">
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
                                  <p className="text-[10px] text-amber-400 mt-1 font-mono whitespace-pre-wrap">{tunnelsError}</p>
                                )}
                              </div>

                              <div>
                                <span className="text-[11px] font-medium text-zinc-400 block mb-1.5">Hostname</span>
                                <input
                                  spellCheck={false}
                                  value={tunnelHostname}
                                  onChange={(e) => setTunnelHostname(e.target.value)}
                                  className="input-base font-mono text-[12px]"
                                  placeholder="myapp.example.com"
                                />
                                <p className="text-[10px] text-zinc-600 mt-1">
                                  DNS route auto-created on Connect (domain must be in your Cloudflare zone).
                                </p>
                              </div>
                            </>
                          )}
                        </div>
                      );
                    })()}
                  </Field>
                )}

                {!app.tunnel_active && tunnelProvider === "tailscale" && (() => {
                  if (tsLoading && tsStatus === null) {
                    return (
                      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/[0.03] border border-white/[0.08] text-[12px] text-zinc-500">
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
                        onRecheck={refreshTailscale}
                        recheckLabel="I've installed it"
                      />
                    );
                  }
                  if (!tsStatus.running || !tsStatus.logged_in) {
                    return (
                      <SetupCard
                        step={2}
                        title="Start and log in to Tailscale"
                        body="Open the Tailscale app and sign in, or run:"
                        cmd="tailscale up"
                        copied={copiedCmd}
                        onCopy={copyCmd}
                        onRecheck={refreshTailscale}
                        recheckLabel="I've logged in"
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
                      <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                        <div className="flex items-center gap-2">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                          <span className="text-[11px] text-emerald-300">
                            Tailscale connected as <span className="font-mono">{previewHost}</span>
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={refreshTailscale}
                          className="text-[10px] text-emerald-400/70 hover:text-emerald-300 transition-colors"
                        >
                          ↻ Refresh
                        </button>
                      </div>
                      <div className="px-3 py-2 rounded-lg bg-white/[0.03] border border-white/[0.08]">
                        <p className="text-[10px] text-zinc-500 mb-1">Your URL will be:</p>
                        <p className="font-mono text-[12px] text-zinc-200 break-all">{previewUrl}</p>
                        <p className="text-[10px] text-zinc-600 mt-2 leading-relaxed">
                          {tsFunnel
                            ? "Funnel exposes this publicly to the internet. Anyone with the URL can access it."
                            : "Only devices logged into your tailnet can reach this URL."}
                        </p>
                      </div>
                      <label className="flex items-start gap-2 px-3 py-2 rounded-lg bg-white/[0.03] border border-white/[0.08] cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={tsFunnel}
                          onChange={(e) => setTsFunnel(e.target.checked)}
                          className="mt-0.5 rounded border-white/[0.15] bg-white/[0.05] text-orange-500 focus:ring-orange-500/30 focus:ring-offset-0"
                        />
                        <div className="flex-1">
                          <p className="text-[12px] text-zinc-200">Expose publicly via Funnel</p>
                          <p className="text-[10px] text-zinc-500 mt-0.5 leading-relaxed">
                            Share to the public internet instead of just your tailnet. Requires Funnel to be enabled in your Tailscale admin console.
                          </p>
                        </div>
                      </label>
                    </div>
                  );
                })()}

                {tunnelError && !app.tunnel_active && (
                  <div className="relative px-3 py-2 pr-14 rounded-lg bg-red-500/10 border border-red-500/30 text-[11px] text-red-300 font-mono whitespace-pre-wrap break-words">
                    {tunnelError}
                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard.writeText(tunnelError).then(() => {
                          setTunnelErrorCopied(true);
                          setTimeout(() => setTunnelErrorCopied(false), 1500);
                        });
                      }}
                      className="absolute top-1.5 right-1.5 px-2 py-0.5 text-[10px] font-sans font-medium rounded bg-red-500/20 hover:bg-red-500/30 text-red-200 transition-colors"
                      style={{ color: tunnelErrorCopied ? "#a3e635" : undefined }}
                    >
                      {tunnelErrorCopied ? "Copied!" : "Copy"}
                    </button>
                  </div>
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
                      onClick={handleConnect}
                      disabled={
                        (tunnelProvider === "cloudflare" && tunnelMode === "named" && (!tunnelName.trim() || !tunnelHostname.trim())) ||
                        (tunnelProvider === "tailscale" && (!tsStatus || !tsStatus.installed || !tsStatus.running || !tsStatus.logged_in))
                      }
                      className="px-4 py-2 text-[13px] font-medium text-purple-400 bg-purple-500/10 hover:bg-purple-500/20 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {tunnelProvider === "tailscale"
                        ? "Connect"
                        : tunnelMode === "named" ? "Connect" : "Quick Tunnel"}
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

