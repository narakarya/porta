import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { usePortaStore } from "../../store";
import { checkPortAvailable, checkCloudflared, loadComposeYaml, parseComposeString, listCloudflareTunnels, setTunnelConfig, getTailscaleStatus, listTailscaleServes, checkTunnelReachable, getCfApiToken, listTunnelDns, type CloudflareTunnel, type PortCheckResult, type TailscaleStatus, type TunnelDnsRoute } from "../../lib/commands";
import { getCachedTailscaleStatus, setCachedTailscaleStatus } from "../../lib/tailscaleCache";
import { getCachedDnsRoutes, setCachedDnsRoutes } from "../../lib/tunnelCache";
import YamlEditor from "../shared/YamlEditor";
import SetupCard from "../shared/SetupCard";
import type { App, EnvProfile, HostAuthOverrideInput, PortBinding, Workspace } from "../../types";
import Field from "../shared/Field";
import EnvVarEditor from "../shared/EnvVarEditor";
import TunnelStatusBadge from "../shared/TunnelStatusBadge";
import CloudflareAccessPanel from "./CloudflareAccessPanel";
import HealthSection from "./HealthSection";
import DangerSection from "./sections/DangerSection";
import { yieldToFrame } from "../../lib/ui";
import psl from "psl";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function volumeTemplate(appName: string): string {
  const slug = appName.toLowerCase().trim().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "") || "app";
  return `~/projects/docker/volumes/${slug}/data:/data`;
}

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
}

/** Score a hostname against the app: leftmost-label exact match wins, then
 * inclusion. Lets us auto-pick the most "obvious" route for the user instead
 * of just grabbing the first one. */
function pickBestHostname(hostnames: string[], app: App): string | null {
  if (hostnames.length === 0) return null;
  if (hostnames.length === 1) return hostnames[0];
  const candidates = [
    app.subdomain?.trim().toLowerCase(),
    slugify(app.name),
    ...(app.extra_subdomains ?? []).map((s) => s.trim().toLowerCase()),
  ].filter((s): s is string => !!s);
  for (const cand of candidates) {
    const exact = hostnames.find((h) => h.split(".")[0].toLowerCase() === cand);
    if (exact) return exact;
  }
  for (const cand of candidates) {
    const partial = hostnames.find((h) => h.toLowerCase().includes(cand));
    if (partial) return partial;
  }
  return hostnames[0];
}

type Section = "general" | "domain" | "environment" | "tunneling" | "health" | "danger";

interface Props {
  app: App;
  workspace: Workspace | null;
  onClose: () => void;
  // Called instead of onClose when the modal closes via a successful save.
  // Lets the parent show a confirmation toast without us threading a result
  // back through onClose's signature. Optional — falls back to onClose.
  onSaved?: () => void;
}

export default function AppSettingsModal({ app, workspace, onClose, onSaved }: Props) {
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

  // Basic Auth (per-app, opt-in). Plaintext password stays in state — only sent
  // to the backend when actually changed; otherwise null preserves the stored
  // bcrypt hash.
  const [basicAuthEnabled, setBasicAuthEnabled] = useState(app.basic_auth_enabled ?? false);
  const [basicAuthUsername, setBasicAuthUsername] = useState(app.basic_auth_username ?? "");
  const [basicAuthPassword, setBasicAuthPassword] = useState("");
  const [basicAuthShowPassword, setBasicAuthShowPassword] = useState(false);

  // Per-host auth overrides, keyed by resolved host. Absent host ⇒ inherits the
  // app default. `password` is plaintext kept only in-memory; `passwordSet`
  // mirrors the stored hash so we can show "leave blank to keep".
  type HostAuthDraft = { mode: "default" | "off" | "custom"; username: string; password: string; passwordSet: boolean };
  const [hostAuth, setHostAuth] = useState<Record<string, HostAuthDraft>>(() => {
    const m: Record<string, HostAuthDraft> = {};
    for (const o of app.host_auth_overrides ?? []) {
      m[o.host] = {
        mode: o.mode === "off" || o.mode === "custom" ? o.mode : "default",
        username: o.username ?? "",
        password: "",
        passwordSet: o.password_set,
      };
    }
    return m;
  });
  const hostAuthDraft = useCallback(
    (host: string): HostAuthDraft => hostAuth[host] ?? { mode: "default", username: "", password: "", passwordSet: false },
    [hostAuth],
  );
  const setHostAuthFor = useCallback((host: string, patch: Partial<HostAuthDraft>) => {
    setHostAuth((prev) => {
      const cur = prev[host] ?? { mode: "default", username: "", password: "", passwordSet: false };
      return { ...prev, [host]: { ...cur, ...patch } };
    });
  }, []);

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

  // Snapshot of the on-disk YAML so the dirty check can tell "user edited"
  // apart from "we just loaded it" (composeYaml starts empty before the read
  // completes; without a baseline it would falsely register as dirty).
  const [composeYamlInitial, setComposeYamlInitial] = useState("");
  useEffect(() => {
    if (app.kind !== "compose" || !isManagedPath || !app.compose_file) return;
    let cancelled = false;
    loadComposeYaml(app.compose_file).then((c) => {
      if (!cancelled) {
        setComposeYaml(c);
        setComposeYamlInitial(c);
      }
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
  const [tunnelAliasDomain, setTunnelAliasDomain] = useState(app.tunnel_alias_domain ?? "");
  const [tunnelAliasRewriteHost, setTunnelAliasRewriteHost] = useState(app.tunnel_alias_rewrite_host ?? true);
  const [availableTunnels, setAvailableTunnels] = useState<CloudflareTunnel[]>([]);
  const [tunnelsError, setTunnelsError] = useState<string | null>(null);
  const [tunnelsLoading, setTunnelsLoading] = useState(false);
  // DNS routes (CNAME → tunnel UUID) hydrated from the cache that App.tsx
  // pre-warms on launch. Powers hostname auto-fill for the selected tunnel.
  const [dnsRoutes, setDnsRoutes] = useState<TunnelDnsRoute[]>(() => getCachedDnsRoutes());
  // Cloudflare API token for the Access panel. Lives outside refreshTunnels
  // so the panel renders even if the user never opens the named-tunnel
  // dropdown. Null = not loaded yet, "" = unset.
  const [cfApiToken, setCfApiTokenState] = useState<string | null>(null);
  const [cloudflaredInstalled, setCloudflaredInstalled] = useState<boolean | null>(null);
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);
  // Hydrate from cache so opening the modal with provider=tailscale doesn't
  // flash the "Checking Tailscale…" skeleton when we already have status.
  const [tsStatus, setTsStatus] = useState<TailscaleStatus | null>(() => getCachedTailscaleStatus());
  const [tsLoading, setTsLoading] = useState(false);
  // Tracks whether the user explicitly clicked "I've logged in" / "I've installed
  // it" — lets us show a "still not ready" hint only after the first recheck,
  // not the initial auto-fetch on open.
  const [tsRecheckedWithoutChange, setTsRecheckedWithoutChange] = useState(false);
  const [tsFunnel, setTsFunnel] = useState(false);
  const [tunnelAutoStart, setTunnelAutoStart] = useState(app.tunnel_auto_start ?? false);
  // null = not checked yet, true = 2xx/3xx HEAD, false = timeout/error. Only
  // polled while the Tunneling tab is open and tunnel_url exists.
  const [tunnelReachable, setTunnelReachable] = useState<boolean | null>(null);
  // Tracks the in-flight Connect/Disconnect call so the button can show a
  // spinner instead of relying on the macOS busy cursor.
  const [tunnelBusy, setTunnelBusy] = useState<"connecting" | "disconnecting" | null>(null);

  function copyCmd(cmd: string) {
    navigator.clipboard.writeText(cmd).then(() => {
      setCopiedCmd(cmd);
      setTimeout(() => setCopiedCmd(null), 1500);
    });
  }

  async function handleConnect() {
    if (tunnelBusy) return;
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
    const currentAutoStart = app.tunnel_auto_start ?? false;
    const configChanged = tunnelProvider !== currentProvider || newName !== currentName || newHost !== currentHost || tunnelAutoStart !== currentAutoStart;
    setTunnelBusy("connecting");
    // If a tunnel is live under a *different* provider, tear it down first —
    // otherwise the old one lingers and Connect under the new provider can
    // collide on the same port. Same-provider reconnects skip this; startTunnel
    // handles those. (We deliberately don't stop on the provider-tab click so
    // browsing config doesn't kill a working tunnel.)
    if (app.tunnel_active && currentProvider && currentProvider !== tunnelProvider) {
      try {
        await stopTunnel(app.id);
      } catch {
        // Best-effort; startTunnel below still proceeds.
      }
    }
    if (configChanged) {
      try {
        await setTunnelConfig(app.id, tunnelProvider, newName, newHost, tunnelAutoStart);
      } catch (e) {
        window.alert(`Failed to save tunnel config: ${e instanceof Error ? e.message : String(e)}`);
        setTunnelBusy(null);
        return;
      }
    }
    try {
      await startTunnel(app.id, tunnelProvider, tunnelProvider === "tailscale" ? tsFunnel : undefined);
    } catch {
      // Error is surfaced via appTunnelErrors; the watcher effect releases
      // the busy state once it sees either the error or a successful URL.
    }
    // Note: do NOT clear `tunnelBusy` here. For Cloudflare, `await
    // startTunnel` resolves as soon as the cloudflared child is spawned —
    // the URL only arrives later via the `app:tunnel:{id}` event. The
    // effect below clears busy when the connection truly settles (URL set,
    // error received, or timeout).
  }

  async function handleDisconnect() {
    if (tunnelBusy) return;
    setTunnelBusy("disconnecting");
    try {
      await stopTunnel(app.id);
    } catch {
      setTunnelBusy(null);
    }
  }

  // Drive `tunnelBusy` off the actual tunnel signals so the spinner/label
  // matches reality across both providers:
  //   • connecting → done when URL arrives or an error is reported
  //   • disconnecting → done when active flips off
  // Falls back to a 30s timeout so a silent cloudflared failure can't pin
  // the button in "Connecting…" forever.
  useEffect(() => {
    if (!tunnelBusy) return;
    if (tunnelBusy === "connecting") {
      if (app.tunnel_active && app.tunnel_url) { setTunnelBusy(null); return; }
      if (tunnelError) { setTunnelBusy(null); return; }
    } else if (tunnelBusy === "disconnecting") {
      if (!app.tunnel_active) { setTunnelBusy(null); return; }
    }
    const t = window.setTimeout(() => setTunnelBusy(null), 30_000);
    return () => window.clearTimeout(t);
  }, [tunnelBusy, app.tunnel_active, app.tunnel_url, tunnelError]);

  async function refreshTailscale(userTriggered = false) {
    const prevStatus = tsStatus;
    setTsLoading(true);
    try {
      const status = await getTailscaleStatus();
      setTsStatus(status);
      setCachedTailscaleStatus(status);
      // Signal "nothing changed since last check" only when the user clicked
      // a recheck button — avoids flashing a hint on passive refreshes.
      if (userTriggered && prevStatus) {
        const same = prevStatus.installed === status.installed
          && prevStatus.running === status.running
          && prevStatus.logged_in === status.logged_in;
        setTsRecheckedWithoutChange(same);
      } else {
        setTsRecheckedWithoutChange(false);
      }
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
      // Refresh DNS routes in the background so the hostname field can
      // auto-fill from the routes already pointing at the selected tunnel.
      // Best-effort — no token / API error just leaves the cache as-is.
      getCfApiToken()
        .then((token) => {
          if (!token) return;
          return listTunnelDns(token).then((routes) => {
            setDnsRoutes(routes);
            setCachedDnsRoutes(routes);
          });
        })
        .catch(() => {});
    } catch (e) {
      setTunnelsError(e instanceof Error ? e.message : String(e));
      setAvailableTunnels([]);
    } finally {
      setTunnelsLoading(false);
    }
  }

  // Health check: HEAD the tunnel URL while the tab is open. Skip first check
  // by 3s to give just-connected tunnels time to provision certs before
  // flagging them unreachable.
  useEffect(() => {
    if (section !== "tunneling" || !app.tunnel_active || !app.tunnel_url) {
      setTunnelReachable(null);
      return;
    }
    const url = app.tunnel_url;
    let cancelled = false;
    const run = () => {
      checkTunnelReachable(url).then((ok) => {
        if (!cancelled) setTunnelReachable(ok);
      }).catch(() => { if (!cancelled) setTunnelReachable(false); });
    };
    const initial = window.setTimeout(run, 3_000);
    const interval = window.setInterval(run, 45_000);
    return () => {
      cancelled = true;
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, [section, app.tunnel_active, app.tunnel_url]);

  // Auto-fill hostname when DNS routes arrive after the modal opens. Covers
  // the case where the user opened Tunneling with a tunnel already saved but
  // the routes cache was empty — once `refreshTunnels` finishes the API
  // round-trip, fill in a sensible default for an empty hostname field.
  useEffect(() => {
    if (tunnelHostname.trim() || !tunnelName.trim() || dnsRoutes.length === 0) return;
    const picked = availableTunnels.find((t) => t.name === tunnelName);
    if (!picked) return;
    const matched = dnsRoutes.filter((r) => r.tunnel_id === picked.id).map((r) => r.hostname);
    const best = pickBestHostname(matched, app);
    if (best) setTunnelHostname(best);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dnsRoutes, tunnelName, availableTunnels]);

  // When entering the Tunneling section, probe both providers cheaply so the
  // segmented-control status dots reflect reality regardless of which pill is
  // currently selected. Heavy operations (`cloudflared tunnel list`) still
  // gate on actually being in named mode.
  useEffect(() => {
    if (section !== "tunneling") return;
    if (cloudflaredInstalled === null) {
      checkCloudflared().then(setCloudflaredInstalled).catch(() => {});
    }
    // Tailscale status powers both the Connect-button gating and the dot.
    refreshTailscale();
    if (tunnelProvider === "cloudflare" && tunnelMode === "named") {
      refreshTunnels();
    }
    if (cfApiToken === null) {
      getCfApiToken().then((t) => setCfApiTokenState(t || "")).catch(() => setCfApiTokenState(""));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, tunnelMode, tunnelProvider]);

  // Delete-confirm state (typed app name + ref) moved into DangerSection.

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Brief "✓ Saved" confirmation in the footer. Cleared on next dirty-edit
  // (the indicator already hides when isDirty flips true) or after 2s.
  const [savedAt, setSavedAt] = useState<number | null>(null);
  useEffect(() => {
    if (savedAt === null) return;
    const t = setTimeout(() => setSavedAt(null), 2000);
    return () => clearTimeout(t);
  }, [savedAt]);

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
  const rootDirOk = (app.kind === "docker" || app.kind === "compose" || app.kind === "proxy") ? true : !!rootDir.trim();
  // Auth must have a username, plus a password (either typed now, or already
  // stored). Without that the Caddy handler would 401 every request.
  const basicAuthValid = !basicAuthEnabled
    || (basicAuthUsername.trim() !== "" && (basicAuthPassword !== "" || app.basic_auth_password_set));
  const canSave = name.trim() && rootDirOk && portValid && subdomainValid && customDomainValid && portBindingsValid && basicAuthValid;

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

  // ── Dirty detection ──────────────────────────────────────────────────────
  // Compares current form state against the persisted app values so we can:
  //   1. Disable Save when there's nothing to commit, and
  //   2. Warn before discarding unsaved edits on close.
  // Mode toggles (tunnelMode/composeMode) feed the comparison via the fields
  // they ultimately save — e.g. flipping tunnelMode to "quick" effectively
  // clears tunnel_name in the payload, so we mirror that branching here.
  // Memoized so unrelated re-renders (tunnel busy state, port check results,
  // copy-feedback timers, etc.) don't re-stringify the long-form arrays on
  // every paint.
  const isDirty = useMemo(() => {
    const envVarsObj: Record<string, string> = {};
    for (const { key, value } of envVars) { if (key.trim()) envVarsObj[key.trim()] = value; }
    // Per-host auth: dirty if any host's mode/username changed, or a new
    // custom password was typed.
    const storedOverrides = new Map((app.host_auth_overrides ?? []).map((o) => [o.host, o]));
    const overrideHosts = new Set<string>([...storedOverrides.keys(), ...Object.keys(hostAuth)]);
    let hostAuthChanged = false;
    for (const h of overrideHosts) {
      const d = hostAuth[h];
      const s = storedOverrides.get(h);
      const dMode = d?.mode ?? "default";
      const sMode = (s?.mode === "off" || s?.mode === "custom") ? s.mode : "default";
      if (dMode !== sMode) { hostAuthChanged = true; break; }
      if (dMode === "custom" && ((d?.username ?? "") !== (s?.username ?? "") || (d?.password ?? "") !== "")) {
        hostAuthChanged = true; break;
      }
    }
    return (
      hostAuthChanged ||
      name.trim() !== app.name ||
      rootDir.trim() !== app.root_dir ||
      portNum !== app.port ||
      (subdomain.trim() || null) !== (app.subdomain ?? null) ||
      JSON.stringify(extraSubdomains) !== JSON.stringify(app.extra_subdomains ?? []) ||
      JSON.stringify(portBindings) !== JSON.stringify(app.port_bindings ?? []) ||
      (customDomain.trim() || null) !== (app.custom_domain ?? null) ||
      basicAuthEnabled !== (app.basic_auth_enabled ?? false) ||
      basicAuthUsername.trim() !== (app.basic_auth_username ?? "") ||
      basicAuthPassword !== "" ||
      startCommand !== (app.start_command ?? "") ||
      (app.kind === "docker" && (
        (dockerImage.trim() || null) !== (app.docker_image ?? null) ||
        (parseInt(dockerContainerPort, 10) || null) !== (app.docker_container_port ?? null) ||
        (dockerArgs.trim() || null) !== (app.docker_args ?? null) ||
        JSON.stringify(dockerVolumes.filter((v) => v.trim())) !== JSON.stringify(app.docker_volumes ?? [])
      )) ||
      (app.kind === "compose" && (
        (composeMode === "file" ? (composeFile.trim() || null) : null) !== (app.compose_file ?? null) ||
        (composeMode === "paste" && composeYaml !== composeYamlInitial)
      )) ||
      ((app.kind === "docker" || app.kind === "compose") && networkShare !== app.network_share) ||
      (envFile.trim() || null) !== (app.env_file ?? null) ||
      autoStart !== app.auto_start ||
      JSON.stringify(envVarsObj) !== JSON.stringify(app.env_vars ?? {}) ||
      restartPolicy !== (app.restart_policy ?? "on-failure") ||
      (parseInt(maxRetries, 10) || 3) !== (app.max_retries ?? 3) ||
      (healthCheckPath.trim() || null) !== (app.health_check_path ?? null) ||
      JSON.stringify(dependsOn) !== JSON.stringify(app.depends_on ?? []) ||
      JSON.stringify(envProfiles) !== JSON.stringify(app.env_profiles ?? []) ||
      activeProfileId !== (app.active_profile_id ?? null) ||
      tunnelProvider !== (app.tunnel_provider ?? "cloudflare") ||
      (tunnelMode === "named" ? (tunnelName.trim() || null) : null) !== (app.tunnel_name ?? null) ||
      (tunnelMode === "named" ? (tunnelHostname.trim() || null) : null) !== (app.tunnel_custom_hostname ?? null) ||
      tunnelAutoStart !== (app.tunnel_auto_start ?? false) ||
      (tunnelAliasDomain.trim() || null) !== (app.tunnel_alias_domain ?? null) ||
      tunnelAliasRewriteHost !== (app.tunnel_alias_rewrite_host ?? true)
    );
  }, [
    app, name, rootDir, portNum, subdomain, extraSubdomains, portBindings, customDomain,
    basicAuthEnabled, basicAuthUsername, basicAuthPassword, hostAuth, startCommand,
    dockerImage, dockerContainerPort, dockerArgs, dockerVolumes,
    composeMode, composeFile, composeYaml, composeYamlInitial, networkShare,
    envFile, autoStart, envVars, restartPolicy, maxRetries, healthCheckPath,
    dependsOn, envProfiles, activeProfileId,
    tunnelProvider, tunnelMode, tunnelName, tunnelHostname, tunnelAutoStart,
    tunnelAliasDomain, tunnelAliasRewriteHost,
  ]);

  function requestClose() {
    if (saving) return;
    if (isDirty) {
      const ok = window.confirm("Discard unsaved changes?");
      if (!ok) return;
    }
    onClose();
  }

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

  // Resolved hosts this app exposes — drives the per-host auth override editor.
  // Mirrors the Rust `all_routes` host resolution so override keys line up with
  // the routes Caddy actually builds. Deduped, preserving first-seen order.
  const authHosts = useMemo(() => {
    const list: { host: string; label: string }[] = [];
    const seen = new Set<string>();
    const push = (host: string, label: string) => {
      if (!host || host.endsWith(".…") || host.startsWith("….") || seen.has(host)) return;
      seen.add(host);
      list.push({ host, label });
    };
    push(effectiveSub === "*" ? `*.${domain}` : `${effectiveSub}.${domain}`, "primary");
    for (const s of extraSubdomains) push(`${s}.${domain}`, "subdomain");
    for (const b of portBindings) {
      const bDomain = b.custom_domain?.trim() || domain;
      const bSub = b.subdomain?.trim() || b.label.trim().toLowerCase().replace(/\s+/g, "-") || "binding";
      push(`${bSub}.${bDomain}`, b.label || "binding");
    }
    return list;
  }, [effectiveSub, domain, extraSubdomains, portBindings]);

  // Build the authoritative override payload: only currently-exposed hosts with
  // a non-default mode. Custom hosts send plaintext password (blank = keep hash).
  const buildHostAuthOverrides = useCallback((): HostAuthOverrideInput[] => {
    const out: HostAuthOverrideInput[] = [];
    for (const { host } of authHosts) {
      const d = hostAuth[host];
      if (!d || d.mode === "default") continue;
      if (d.mode === "off") {
        out.push({ host, mode: "off" });
      } else {
        out.push({ host, mode: "custom", username: d.username.trim() || null, password: d.password || null });
      }
    }
    return out;
  }, [authHosts, hostAuth]);

  const addExtraSubdomain = useCallback(() => {
    const val = extraSubdomainInput.trim().toLowerCase();
    if (!val || !SUBDOMAIN_RE.test(val) || extraSubdomains.includes(val)) return;
    setExtraSubdomains((prev) => [...prev, val]);
    setExtraSubdomainInput("");
  }, [extraSubdomainInput, extraSubdomains]);

  // The tunnel panel reflects the SELECTED provider tab, not whichever tunnel
  // happens to be live. So when Cloudflare is connected but the user clicks the
  // Tailscale tab, they see Tailscale's Connect view — connecting there switches
  // providers (handleConnect tears the old one down first). `selectedIsLive` =
  // the live tunnel belongs to the currently-selected provider.
  const activeTunnelProvider = app.tunnel_active ? (app.tunnel_provider ?? "cloudflare") : null;
  const selectedIsLive = activeTunnelProvider === tunnelProvider;
  // Another provider is connected while we're viewing a different (not-yet-live)
  // tab — used to warn that Connect will switch providers.
  const otherProviderLive = app.tunnel_active && !selectedIsLive ? activeTunnelProvider : null;

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
        basic_auth_enabled: basicAuthEnabled,
        basic_auth_username: basicAuthEnabled ? (basicAuthUsername.trim() || null) : null,
        // Empty string keeps the existing hash (the user didn't retype it).
        // Non-empty plaintext gets bcrypt-hashed on the Rust side.
        basic_auth_password: basicAuthPassword ? basicAuthPassword : null,
        host_auth_overrides: buildHostAuthOverrides(),
        tunnel_alias_domain: tunnelAliasDomain.trim() || null,
        tunnel_alias_rewrite_host: tunnelAliasRewriteHost,
      });
      // Notify the parent (e.g. for a global toast) but DON'T close the modal —
      // the user often wants to keep tweaking settings after a save. Letting
      // the parent decide via `onSaved` would re-introduce the close, so we
      // intentionally bypass it for the close concern and just signal success.
      onSaved?.();
      setSavedAt(Date.now());
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
    // DangerSection enforces the "type the app name" gate before calling
    // this — accepting the call here means the user confirmed.
    await deleteApp(app.id);
    onClose();
  }

  const isStatic = app.kind === "static";
  const isDocker = app.kind === "docker";
  const isCompose = app.kind === "compose";
  const isProxy = app.kind === "proxy";
  // Env vars only apply to apps Porta spawns. Tunneling works for static and
  // proxy too — Porta routes cloudflared through Caddy for those.
  const NAV: { id: Section; label: string }[] = [
    { id: "general",     label: "General" },
    { id: "domain",      label: "Domain" },
    ...((isStatic || isProxy) ? [] : [{ id: "environment" as Section, label: "Environment" }]),
    { id: "tunneling"   as Section, label: "Tunneling" },
    ...((isStatic || isProxy) ? [] : [{ id: "health" as Section, label: "Health" }]),
    { id: "danger",      label: "Danger Zone" },
  ];

  return (
    <div className="fixed inset-0 bg-[#111113] text-zinc-100 font-sans flex h-screen overflow-hidden z-50">
      {/* Drag region — Back button in the sidebar handles dismissal; Esc still
          works via the global key handler. No top-right ✕ to avoid duplicating. */}
      <div className="drag-region fixed top-0 left-0 right-0 h-8 z-10 pointer-events-none" />

      {/* Sidebar */}
      <aside className="w-[200px] bg-[#1a1a1c] border-r border-white/[0.06] flex flex-col pt-8 pb-3 shrink-0">
        <div className="px-4 mb-4">
          <button
            onClick={requestClose}
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
      <main className="flex-1 flex flex-col no-drag overflow-hidden">
      <div className="flex-1 overflow-auto pt-10 px-8 pb-4">
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
                {isProxy && (
                  <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-violet-500/10 border border-violet-500/20">
                    <span className="text-[10px] font-semibold tracking-wider text-violet-300 mt-0.5">PROXY</span>
                    <p className="text-[11px] text-violet-200/80">
                      Caddy reverse-proxies the domain to an existing local port. You run the upstream yourself — no folder, no command.
                    </p>
                  </div>
                )}
                <Field label="Name">
                  <input spellCheck={false} value={name} onChange={(e) => setName(e.target.value)}
                    className="input-base" placeholder="My App" />
                </Field>

                {!isStatic && (
                  <Field label={isDocker ? "Host Port" : isCompose ? "Proxy Port" : isProxy ? "Upstream Port" : "Port"} hint={!portValid && port ? "Must be 1-65535" : undefined}>
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

                {!isStatic && !isDocker && !isCompose && !isProxy && (
                  <Field label="Start Command">
                    <input spellCheck={false} value={startCommand} onChange={(e) => setStartCommand(e.target.value)}
                      className="input-base font-mono text-[12px]" placeholder="mix phx.server" />
                  </Field>
                )}

                {!isProxy && (
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
                )}

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

              {/* Basic Auth */}
              <div className="flex flex-col gap-4 p-5 rounded-xl bg-white/[0.03] border border-white/[0.07]">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-[12px] font-medium text-zinc-300">Basic Auth</p>
                    <p className="text-[11px] text-zinc-500 mt-0.5 leading-relaxed">
                      Default browser username/password prompt for this app's hosts.
                      {authHosts.length > 1 ? " Override individual hosts below." : ""} Best paired with HTTPS.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setBasicAuthEnabled((v) => !v)}
                    className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${
                      basicAuthEnabled ? "bg-blue-600" : "bg-white/[0.08]"
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
                          className="px-3 py-2 text-[11px] text-zinc-400 bg-white/[0.05] border border-white/[0.08] rounded-lg hover:bg-white/[0.08] hover:text-zinc-200 transition-colors shrink-0"
                        >
                          {basicAuthShowPassword ? "Hide" : "Show"}
                        </button>
                      </div>
                      <p className="text-[10px] text-zinc-600 mt-1">
                        Stored as a bcrypt hash — Porta never persists the plaintext.
                      </p>
                    </Field>
                  </div>
                )}

                {/* Per-host overrides — only meaningful when the app exposes
                    more than one host. Each host can inherit the default,
                    stay public, or use its own credentials. */}
                {authHosts.length > 1 && (
                  <div className="flex flex-col gap-2 pt-3 border-t border-white/[0.06]">
                    <p className="text-[11px] font-medium text-zinc-400">Per-host overrides</p>
                    {authHosts.map(({ host, label }) => {
                      const d = hostAuthDraft(host);
                      const defaultProtected = basicAuthEnabled;
                      return (
                        <div key={host} className="flex flex-col gap-2 p-2.5 rounded-lg bg-white/[0.02] border border-white/[0.05]">
                          <div className="flex items-center justify-between gap-2">
                            <div className="min-w-0">
                              <p className="text-[11px] font-mono text-zinc-300 truncate">{host}</p>
                              <p className="text-[9px] uppercase tracking-wide text-zinc-600">{label}</p>
                            </div>
                            <div className="inline-flex p-0.5 rounded-md bg-[#0c0c0e] border border-white/[0.08] shrink-0">
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
                                    d.mode === opt.key ? "bg-white/[0.10] text-zinc-100" : "text-zinc-500 hover:text-zinc-300"
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
                <div className="flex items-center justify-between gap-4">
                  <div className="flex flex-col gap-1.5 flex-1 min-w-0">
                    <label className="text-[12px] font-medium text-zinc-400">Provider</label>
                    {(() => {
                      // Status-dot color reflects "is this provider ready to
                      // Connect right now?" — green when fully set up, amber
                      // when the user has work to do (install / login),
                      // zinc while we're still probing on first open.
                      const cfReady = cloudflaredInstalled === true;
                      const cfNeedsSetup = cloudflaredInstalled === false;
                      const cfDot = cfReady ? "bg-emerald-400" : cfNeedsSetup ? "bg-amber-400" : "bg-zinc-600";
                      const cfTip = cfReady
                        ? "Ready"
                        : cfNeedsSetup
                          ? "cloudflared not installed"
                          : "Checking…";
                      const tsReady = !!(tsStatus?.installed && tsStatus.running && tsStatus.logged_in);
                      const tsKnown = !!tsStatus;
                      const tsDot = tsReady ? "bg-emerald-400" : tsKnown ? "bg-amber-400" : "bg-zinc-600";
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
                          className="inline-flex p-0.5 rounded-lg bg-[#0c0c0e] border border-white/[0.08] w-fit"
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
                                    ? "bg-white/[0.08] text-zinc-100 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]"
                                    : "text-zinc-400 hover:text-zinc-200"
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
                  <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20">
                    <svg className="animate-spin shrink-0 text-amber-400" width="12" height="12" viewBox="0 0 12 12" fill="none">
                      <path d="M6 1.5A4.5 4.5 0 1 1 1.5 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                    </svg>
                    <span className="text-[11px] text-amber-400">Establishing tunnel…</span>
                  </div>
                )}

                {selectedIsLive && app.tunnel_url && (
                  <>
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
                    {tunnelReachable === false && (
                      <div className="flex items-start gap-2 px-3 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/20">
                        <span className="w-1.5 h-1.5 mt-1 rounded-full bg-amber-400 shrink-0" />
                        <span className="text-[11px] text-amber-300">
                          Tunnel endpoint not reachable — the tunnel itself looks down, not your app
                          (an app that's up but erroring would still respond).{" "}
                          {app.tunnel_provider === "cloudflare"
                            ? "Check the DNS route and that cloudflared is connected."
                            : "Check that the Tailscale serve/funnel is still up."}
                        </span>
                      </div>
                    )}
                    {tunnelReachable === true && (
                      <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-emerald-500/5 border border-emerald-500/10">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
                        <span className="text-[11px] text-emerald-400/80">Reachable</span>
                      </div>
                    )}
                  </>
                )}

                {!selectedIsLive && tunnelProvider === "cloudflare" && (
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
                                      <p className="text-[10px] text-zinc-600 mt-1">
                                        DNS route auto-created on Connect (domain must be in your Cloudflare zone).
                                        {dominantBase && (
                                          <>
                                            {" "}Type a subdomain — Tab or click away to append <span className="font-mono text-zinc-500">.{dominantBase}</span>.
                                          </>
                                        )}
                                      </p>
                                    </>
                                  );
                                })()}
                                {(() => {
                                  // Preview every public hostname this tunnel will expose.
                                  // Mirrors the backend's `tunnel_public_hostnames`: primary
                                  // + extras + port_bindings, all projected onto the
                                  // registrable domain (eTLD+1) of the primary host. PSL is
                                  // required so apex inputs like `sidiq.sch.id` don't strip
                                  // down to the public suffix `sch.id`.
                                  const primary = tunnelHostname.trim();
                                  if (!primary) return null;
                                  const parsed = psl.parse(primary);
                                  const base = "domain" in parsed ? parsed.domain : null;
                                  const extras = (app.extra_subdomains ?? [])
                                    .map((s) => s.trim())
                                    .filter(Boolean);
                                  const bindingSubs = (app.port_bindings ?? [])
                                    .map((b) => {
                                      const sub = (b.subdomain ?? "").trim();
                                      return sub || (b.label ?? "").toLowerCase().replace(/ /g, "-");
                                    })
                                    .filter(Boolean);
                                  if (!base || (extras.length === 0 && bindingSubs.length === 0)) return null;
                                  const all = [
                                    { host: primary, kind: "primary" as const },
                                    ...extras.map((s) => ({ host: `${s}.${base}`, kind: "extra" as const })),
                                    ...bindingSubs.map((s) => ({ host: `${s}.${base}`, kind: "binding" as const })),
                                  ];
                                  return (
                                    <div className="mt-3 rounded-lg bg-orange-500/[0.04] border border-orange-500/[0.15] overflow-hidden">
                                      <div className="flex items-center justify-between px-3 py-1.5 border-b border-orange-500/[0.10]">
                                        <p className="text-[10px] text-zinc-400 font-medium">This app will expose</p>
                                        <span className="text-[9px] uppercase tracking-wider text-orange-300/80 leading-none">
                                          {all.length} {all.length === 1 ? "host" : "hosts"}
                                        </span>
                                      </div>
                                      <ul className="px-3 py-2 space-y-1">
                                        {all.map(({ host, kind }) => (
                                          <li key={host} className="flex items-center gap-2 font-mono text-[11px] text-orange-200/90 min-w-0">
                                            {/* Filled dot for the primary host, hollow for
                                                extras / port_bindings — keeps the rank cue
                                                visual instead of the inline "PRIMARY" label
                                                that overflowed the row width. */}
                                            <span
                                              className={`shrink-0 w-1.5 h-1.5 rounded-full ${
                                                kind === "primary"
                                                  ? "bg-orange-400"
                                                  : "border border-orange-400/50 bg-transparent"
                                              }`}
                                              aria-label={kind === "primary" ? "primary" : kind}
                                            />
                                            <span className="truncate" title={host}>{host}</span>
                                          </li>
                                        ))}
                                      </ul>
                                    </div>
                                  );
                                })()}
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
                              <div className="mt-4 pt-4 border-t border-white/[0.06] space-y-2">
                                <p className="text-[11px] font-medium text-zinc-300">
                                  Public alias domain
                                  <span className="ml-2 text-[9px] uppercase tracking-wider text-zinc-600">advanced</span>
                                </p>
                                <p className="text-[10px] text-zinc-500 leading-relaxed">
                                  Caddy also serves this app at the alias hostname pattern. Use a wildcard like <span className="font-mono text-zinc-400">*.example.com</span> to expose every subdomain through the tunnel. Leave blank to disable.
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
                                    className="mt-0.5 accent-blue-500"
                                  />
                                  <span className="text-[11px] text-zinc-400 leading-snug">
                                    Rewrite <span className="font-mono">Host</span> header to local pattern.{" "}
                                    <span className="text-zinc-600">
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
                      <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                        <div className="flex items-center gap-2">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                          <span className="text-[11px] text-emerald-300">
                            Tailscale connected as <span className="font-mono">{previewHost}</span>
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => refreshTailscale()}
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

                {tunnelError && !selectedIsLive && (
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
                    className="mt-0.5 rounded border-white/[0.15] bg-white/[0.05] text-blue-500 focus:ring-blue-500/30 focus:ring-offset-0"
                  />
                  <div>
                    <p className="text-[12px] text-zinc-300">Auto-start with app</p>
                    <p className="text-[10px] text-zinc-500 mt-0.5">
                      When this app starts, the tunnel connects automatically using the settings above.
                    </p>
                  </div>
                </label>

                {otherProviderLive && (
                  <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20">
                    <span className="w-1.5 h-1.5 mt-1.5 rounded-full bg-amber-400 shrink-0" />
                    <span className="text-[11px] text-amber-300">
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
                      className="px-4 py-2 text-[13px] font-medium text-zinc-300 bg-white/[0.07] hover:bg-white/[0.12] rounded-lg transition-colors disabled:opacity-60 disabled:cursor-not-allowed inline-flex items-center gap-2"
                    >
                      {tunnelBusy === "disconnecting" && (
                        <span className="inline-block h-3 w-3 rounded-full border-2 border-zinc-400/40 border-t-zinc-200 animate-spin" />
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
                      className="px-4 py-2 text-[13px] font-medium text-purple-100 bg-purple-500/25 hover:bg-purple-500/35 border border-purple-500/40 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-2"
                    >
                      {tunnelBusy === "connecting" && (
                        <span className="inline-block h-3 w-3 rounded-full border-2 border-purple-400/30 border-t-purple-300 animate-spin" />
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
        <footer className="shrink-0 border-t border-white/[0.06] bg-[#111113] px-8 py-3 flex items-center gap-2">
          {saveError && <p className="text-[11px] text-red-400 flex-1 truncate" title={saveError}>{saveError}</p>}
          {!saveError && isDirty && (
            <p className="text-[11px] text-amber-400/70 flex-1">Unsaved changes</p>
          )}
          {!saveError && !isDirty && savedAt !== null && (
            <p className="text-[11px] text-emerald-400/80 flex-1 flex items-center gap-1.5">
              <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                <path d="M2.5 5.5l2.5 2.5L8.5 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Saved
            </p>
          )}
          <div className="flex gap-2 ml-auto">
            <button
              onClick={requestClose}
              className="px-4 py-2 text-[13px] text-zinc-500 hover:text-zinc-200 rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={!canSave || saving || !isDirty}
              title={!isDirty ? "No changes to save" : undefined}
              className="px-4 py-2 text-[13px] font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5"
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
  );
}

