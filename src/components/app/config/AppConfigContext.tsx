import { createContext, useContext, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { usePortaStore } from "../../../store";
import {
  checkPortAvailable,
  checkCloudflared,
  loadComposeYaml,
  parseComposeString,
  listCloudflareTunnels,
  setTunnelConfig,
  getTailscaleStatus,
  listTailscaleServes,
  checkTunnelReachable,
  repairTunnelDns,
  getCfApiToken,
  listTunnelDns,
  openExternalUrl,
  type CloudflareTunnel,
  type PortCheckResult,
  type TailscaleStatus,
  type TunnelDnsRoute,
} from "../../../lib/commands";
import { getCachedTailscaleStatus, setCachedTailscaleStatus } from "../../../lib/tailscaleCache";
import { getCachedDnsRoutes, setCachedDnsRoutes } from "../../../lib/tunnelCache";
import type { App, EnvProfile, HostAuthOverrideInput, PortBinding, Workspace } from "../../../types";
import { yieldToFrame } from "../../../lib/ui";
import psl from "psl";
import { IconCopy, IconCheck, IconExternal } from "./icons";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
}

/** Score a hostname against the app: leftmost-label exact match wins, then
 * inclusion. Lets us auto-pick the most "obvious" route for the user instead
 * of just grabbing the first one. */
export function pickBestHostname(hostnames: string[], app: App): string | null {
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

export type TunnelPublicHost = { host: string; kind: "primary" | "extra" | "binding" };

export function buildTunnelPublicHosts(
  primaryHostname: string,
  extraSubdomains: string[],
  portBindings: PortBinding[],
): TunnelPublicHost[] {
  const primary = primaryHostname.trim();
  if (!primary) return [];

  const all: TunnelPublicHost[] = [{ host: primary, kind: "primary" }];
  const parsed = psl.parse(primary);
  const base = "domain" in parsed ? parsed.domain : null;
  if (!base) return all;

  const extras = extraSubdomains.map((s) => s.trim()).filter(Boolean);
  const bindingSubs = portBindings
    .map((b) => {
      const sub = (b.subdomain ?? "").trim();
      return sub || (b.label ?? "").toLowerCase().replace(/\s+/g, "-");
    })
    .filter(Boolean);

  return [
    ...all,
    ...extras.map((s) => ({ host: `${s}.${base}`, kind: "extra" as const })),
    ...bindingSubs.map((s) => ({ host: `${s}.${base}`, kind: "binding" as const })),
  ];
}

/** Canonical form of an env map for comparison. Plain `JSON.stringify` is not
 *  safe here: these come back from a Rust `HashMap`, whose serialization order
 *  is arbitrary and can differ between two reads of identical data — which
 *  would leave the form reporting unsaved changes forever after a save. */
function envKey(vars: Record<string, string> | null | undefined): string {
  return JSON.stringify(Object.entries(vars ?? {}).sort(([a], [b]) => a.localeCompare(b)));
}

/** Same idea for the profile list: fixed field order, canonical env maps. */
function profilesKey(list: EnvProfile[] | null | undefined): string {
  return JSON.stringify(
    (list ?? []).map((p) => [
      p.id,
      p.name,
      p.env_file ?? null,
      envKey(p.env_vars),
      p.start_command ?? null,
      p.build_command ?? null,
    ]),
  );
}

export type Section = "general" | "domain" | "environment" | "tunneling" | "health" | "danger";

export function useAppConfigDraft(
  app: App,
  workspace: Workspace | null,
  onClose: () => void,
  onSaved?: () => void,
  initialSection?: Section,
) {
  const { updateApp, deleteApp, apps, startTunnel, stopTunnel, setupStatus, appTunnelErrors, setAppAutoSleep, setAppMaxUploadBytes } = usePortaStore();
  const tunnelError = appTunnelErrors[app.id] ?? null;
  const [tunnelErrorCopied, setTunnelErrorCopied] = useState(false);
  const [section, setSection] = useState<Section>(initialSection ?? "general");
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

  // Auto-sleep: stop the app when idle, wake transparently on next request.
  // Persisted via its own command (set_app_auto_sleep), not the giant updateApp.
  const [autoSleepEnabled, setAutoSleepEnabled] = useState(app.auto_sleep_enabled ?? false);
  const [idleTimeoutMin, setIdleTimeoutMin] = useState(
    String(Math.max(1, Math.round((app.idle_timeout_secs ?? 1800) / 60)))
  );
  // Auto-sleep only makes sense for apps Porta runs as a process behind Caddy.
  const autoSleepSupported = app.kind !== "static" && app.kind !== "proxy";

  // Per-app max upload body size, persisted via its own command
  // (set_app_max_upload_bytes) which re-syncs Caddy. Empty input = inherit the
  // global default; "0" = unlimited. Stored/compared in bytes, edited in MB.
  const [maxUploadMb, setMaxUploadMb] = useState(
    app.max_upload_bytes == null
      ? ""
      : String(Math.round(app.max_upload_bytes / (1024 * 1024)))
  );
  const maxUploadBytesValue =
    maxUploadMb.trim() === ""
      ? null
      : Math.max(0, Math.round(Number(maxUploadMb) || 0)) * 1024 * 1024;

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
  // "Repair DNS route" state for the unreachable-tunnel hint.
  const [dnsRepairing, setDnsRepairing] = useState(false);
  const [dnsRepairError, setDnsRepairError] = useState<string | null>(null);

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
    // Cross-provider teardown is handled in the backend: start_tunnel /
    // start_tailscale_serve each stop the OTHER provider for this app first
    // (silently, so the dying connector can't clobber the new one's
    // active:true). We deliberately do NOT stop here — a non-silent frontend
    // stop would race that event. Same-provider reconnects are handled by
    // start_tunnel killing its own stale pid.
    if (configChanged) {
      try {
        await setTunnelConfig(app.id, tunnelProvider, newName, newHost, tunnelAutoStart);
      } catch (e) {
        usePortaStore.getState().notifyError("Failed to save tunnel config", e);
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

  // Re-create the DNS record for a connected-but-unreachable tunnel. The
  // backend retries across every Cloudflare cert it can find and verifies the
  // record at the zone's nameservers, so a plain "it worked" here is real.
  async function repairDns() {
    const url = app.tunnel_url;
    const name = app.tunnel_name;
    if (!url || !name) return;
    let hostname: string;
    try {
      hostname = new URL(url).hostname;
    } catch {
      return;
    }
    setDnsRepairing(true);
    setDnsRepairError(null);
    try {
      await repairTunnelDns(name, hostname);
      setTunnelReachable(await checkTunnelReachable(url));
    } catch (e) {
      setDnsRepairError(e instanceof Error ? e.message : String(e));
    } finally {
      setDnsRepairing(false);
    }
  }

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
  // Per-profile command overrides. Kept as their own display state (rather than
  // swapping the app-level Start Command field) so `app.start_command` always
  // remains the Default profile's value — the fallback the backend resolves to
  // when a profile leaves its override blank.
  const initialProfile = (app.env_profiles ?? []).find((p) => p.id === app.active_profile_id);
  const [profileStartCommand, setProfileStartCommand] = useState(initialProfile?.start_command ?? "");
  const [profileBuildCommand, setProfileBuildCommand] = useState(initialProfile?.build_command ?? "");
  const [showNewProfile, setShowNewProfile] = useState(false);
  const [newProfileName, setNewProfileName] = useState("");
  const [deleteProfileConfirm, setDeleteProfileConfirm] = useState<string | null>(null);
  // Inline rename of a named profile — writes straight into envProfiles (the
  // same array Save persists as env_profiles), so no new saved field.
  const [renamingProfileId, setRenamingProfileId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const commitRename = useCallback(() => {
    const id = renamingProfileId;
    const nm = renameValue.trim();
    if (id && nm) {
      setEnvProfiles((prev) => prev.map((p) => (p.id === id ? { ...p, name: nm } : p)));
    }
    setRenamingProfileId(null);
    setRenameValue("");
  }, [renamingProfileId, renameValue]);

  // ── Domain "Reachable at" list view-state ─────────────────────────────────
  const [showAddDomain, setShowAddDomain] = useState(false);
  const [showAdvancedDomain, setShowAdvancedDomain] = useState(false);
  const [copiedHost, setCopiedHost] = useState<string | null>(null);
  const copyHost = useCallback((url: string) => {
    navigator.clipboard.writeText(url).then(() => {
      setCopiedHost(url);
      setTimeout(() => setCopiedHost((cur) => (cur === url ? null : cur)), 1200);
    });
  }, []);
  const openHost = useCallback((url: string) => {
    if (isTauri) void openExternalUrl(url);
    else window.open(url, "_blank");
  }, []);
  // Copy + open action pair for a reachable-host row. Plain factory (not a
  // nested component) so it doesn't remount inputs on each render.
  const copyOpen = (url: string) => (
    <div className="ml-auto flex items-center gap-0.5 shrink-0">
      <button
        type="button"
        onClick={() => copyHost(url)}
        title="Copy URL"
        aria-label="Copy URL"
        className={`p-1.5 rounded transition-colors ${copiedHost === url ? "text-ok" : "text-ink-3 hover:text-ink-2"}`}
      >
        {copiedHost === url ? <IconCheck /> : <IconCopy />}
      </button>
      <button
        type="button"
        onClick={() => openHost(url)}
        title="Open URL"
        aria-label="Open URL"
        className="p-1.5 rounded text-ink-3 hover:text-ink-2 transition-colors"
      >
        <IconExternal />
      </button>
    </div>
  );

  const selectProfile = useCallback((profileId: string | null) => {
    if (activeProfileId) {
      const obj: Record<string, string> = {};
      for (const { key, value } of envVars) { if (key.trim()) obj[key.trim()] = value; }
      setEnvProfiles((prev) => prev.map((p) => p.id === activeProfileId ? {
        ...p,
        env_file: envFile.trim() || null,
        env_vars: obj,
        start_command: profileStartCommand.trim() || null,
        build_command: profileBuildCommand.trim() || null,
      } : p));
    }
    setActiveProfileId(profileId);
    if (profileId) {
      const profile = envProfiles.find((p) => p.id === profileId);
      if (profile) {
        setEnvFile(profile.env_file ?? ""); setEnvVars(Object.entries(profile.env_vars ?? {}).map(([key, value]) => ({ key, value })));
        setProfileStartCommand(profile.start_command ?? ""); setProfileBuildCommand(profile.build_command ?? "");
      }
    } else {
      setEnvFile(app.env_file ?? ""); setEnvVars(Object.entries(app.env_vars ?? {}).map(([key, value]) => ({ key, value })));
      setProfileStartCommand(""); setProfileBuildCommand("");
    }
  }, [activeProfileId, envVars, envFile, envProfiles, profileStartCommand, profileBuildCommand, app.env_file, app.env_vars]);

  const createProfile = useCallback(() => {
    if (!newProfileName.trim()) return;
    const obj: Record<string, string> = {};
    for (const { key, value } of envVars) { if (key.trim()) obj[key.trim()] = value; }
    const np: EnvProfile = {
      id: `prof-${Date.now().toString(36)}`,
      name: newProfileName.trim(),
      env_file: envFile.trim() || null,
      env_vars: { ...obj },
      // A fresh profile inherits the app's command until told otherwise, so it
      // starts out behaving exactly like Default plus whatever env it carries.
      start_command: null,
      build_command: null,
    };
    setEnvProfiles((prev) => [...prev, np]);
    setActiveProfileId(np.id);
    setProfileStartCommand(""); setProfileBuildCommand("");
    setNewProfileName(""); setShowNewProfile(false);
  }, [newProfileName, envVars, envFile]);

  const deleteProfile = useCallback((profileId: string) => {
    setEnvProfiles((prev) => prev.filter((p) => p.id !== profileId));
    if (activeProfileId === profileId) {
      setActiveProfileId(null); setEnvFile(app.env_file ?? ""); setEnvVars(Object.entries(app.env_vars ?? {}).map(([key, value]) => ({ key, value })));
      setProfileStartCommand(""); setProfileBuildCommand("");
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
    // The env editor shows the ACTIVE profile's values, so that profile — not
    // the app's own (Default) env — is what they must be compared against.
    // Comparing against the app's while a profile was selected made the form
    // permanently "dirty": saving writes the edits into the profile and leaves
    // app.env_* untouched, so the mismatch could never resolve.
    const storedProfile = activeProfileId
      ? (app.env_profiles ?? []).find((p) => p.id === activeProfileId)
      : undefined;
    const baseEnvFile = activeProfileId ? (storedProfile?.env_file ?? null) : (app.env_file ?? null);
    const baseEnvVars = activeProfileId ? (storedProfile?.env_vars ?? {}) : (app.env_vars ?? {});
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
      (envFile.trim() || null) !== baseEnvFile ||
      autoStart !== app.auto_start ||
      envKey(envVarsObj) !== envKey(baseEnvVars) ||
      restartPolicy !== (app.restart_policy ?? "on-failure") ||
      (parseInt(maxRetries, 10) || 3) !== (app.max_retries ?? 3) ||
      (healthCheckPath.trim() || null) !== (app.health_check_path ?? null) ||
      JSON.stringify(dependsOn) !== JSON.stringify(app.depends_on ?? []) ||
      profilesKey(envProfiles) !== profilesKey(app.env_profiles ?? []) ||
      activeProfileId !== (app.active_profile_id ?? null) ||
      // The active profile's command overrides live in their own display state
      // until save, so compare them against what's stored on that profile.
      (!!activeProfileId && (() => {
        const stored = (app.env_profiles ?? []).find((p) => p.id === activeProfileId);
        return (profileStartCommand.trim() || null) !== (stored?.start_command ?? null)
          || (profileBuildCommand.trim() || null) !== (stored?.build_command ?? null);
      })()) ||
      (tunnelMode === "named" ? (tunnelName.trim() || null) : null) !== (app.tunnel_name ?? null) ||
      (tunnelMode === "named" ? (tunnelHostname.trim() || null) : null) !== (app.tunnel_custom_hostname ?? null) ||
      (tunnelAliasDomain.trim() || null) !== (app.tunnel_alias_domain ?? null) ||
      tunnelAliasRewriteHost !== (app.tunnel_alias_rewrite_host ?? true) ||
      autoSleepEnabled !== (app.auto_sleep_enabled ?? false) ||
      ((parseInt(idleTimeoutMin, 10) || 30) * 60) !== (app.idle_timeout_secs ?? 1800) ||
      maxUploadBytesValue !== (app.max_upload_bytes ?? null)
    );
  }, [
    app, name, rootDir, portNum, subdomain, extraSubdomains, portBindings, customDomain,
    basicAuthEnabled, basicAuthUsername, basicAuthPassword, hostAuth, startCommand,
    dockerImage, dockerContainerPort, dockerArgs, dockerVolumes,
    composeMode, composeFile, composeYaml, composeYamlInitial, networkShare,
    envFile, autoStart, envVars, restartPolicy, maxRetries, healthCheckPath,
    dependsOn, envProfiles, activeProfileId, profileStartCommand, profileBuildCommand,
    tunnelMode, tunnelName, tunnelHostname,
    tunnelAliasDomain, tunnelAliasRewriteHost,
    autoSleepEnabled, idleTimeoutMin, maxUploadBytesValue,
  ]);

  function requestClose() {
    if (saving) return;
    if (isDirty) {
      const ok = window.confirm("Discard unsaved changes?");
      if (!ok) return;
    }
    onClose();
  }
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
  // Local (.test) base domain for the "Reachable at" list — always the
  // workspace domain, independent of the custom-domain override (custom shows
  // as its own row). The `.test`-style TLD drives the "local" badge label.
  const localDomain = workspace?.domain || "narakarya.test";
  const localTld = localDomain.includes(".") ? localDomain.slice(localDomain.lastIndexOf(".")) : ".test";
  const primaryHost = effectiveSub === "*" ? `*.${localDomain}` : `${effectiveSub}.${localDomain}`;
  const primaryUrl = `${scheme}://${primaryHost}`;

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

  // "＋ Add domain": a bare label → new extra subdomain (`{label}.test`); a full
  // host (contains a dot) → sets custom_domain. Writes to the SAME state the old
  // scattered fields used, so Save persists identically.
  const addDomainInputValid = !extraSubdomainInput
    || (extraSubdomainInput.includes(".") ? DOMAIN_RE.test(extraSubdomainInput.trim().toLowerCase()) : SUBDOMAIN_RE.test(extraSubdomainInput.trim().toLowerCase()));
  const addDomain = useCallback(() => {
    const val = extraSubdomainInput.trim().toLowerCase();
    if (!val) return;
    if (val.includes(".")) {
      if (!DOMAIN_RE.test(val)) return;
      setCustomDomain(val);
    } else {
      if (!SUBDOMAIN_RE.test(val) || extraSubdomains.includes(val)) return;
      setExtraSubdomains((prev) => [...prev, val]);
    }
    setExtraSubdomainInput("");
    setShowAddDomain(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  const configuredTunnelHosts = useMemo(
    () => buildTunnelPublicHosts(tunnelHostname, app.extra_subdomains ?? [], app.port_bindings ?? []),
    [tunnelHostname, app.extra_subdomains, app.port_bindings],
  );
  const liveTunnelHosts = useMemo(() => {
    if (!selectedIsLive || tunnelProvider !== "cloudflare" || tunnelMode !== "named") return [];
    const liveHostname = tunnelHostname.trim() || app.tunnel_custom_hostname?.trim() || "";
    return buildTunnelPublicHosts(liveHostname, app.extra_subdomains ?? [], app.port_bindings ?? []);
  }, [
    selectedIsLive,
    tunnelProvider,
    tunnelMode,
    app.tunnel_custom_hostname,
    tunnelHostname,
    app.extra_subdomains,
    app.port_bindings,
  ]);

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
            ? {
                ...p,
                env_file: envFile.trim() || null,
                env_vars: { ...env_vars },
                start_command: profileStartCommand.trim() || null,
                build_command: profileBuildCommand.trim() || null,
              }
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
      // Auto-sleep persists via its own command (config-only, no restart).
      if (autoSleepSupported) {
        const idleSecs = (parseInt(idleTimeoutMin, 10) || 30) * 60;
        await setAppAutoSleep(app.id, autoSleepEnabled, idleSecs);
      }
      // Max upload size persists via its own command (re-syncs Caddy).
      if (maxUploadBytesValue !== (app.max_upload_bytes ?? null)) {
        await setAppMaxUploadBytes(app.id, maxUploadBytesValue);
      }
      // Notify the parent (e.g. for a global toast) but DON'T close the modal —
      // the user often wants to keep tweaking settings after a save. Letting
      // the parent decide via `onSaved` would re-introduce the close, so we
      // intentionally bypass it for the close concern and just signal success.
      // The active profile's edits live in the env/command display state until
      // save merges them into `finalProfiles`. Without adopting that merged list
      // here, local state stays one step behind what was just persisted and the
      // form reports unsaved changes immediately after saving.
      setEnvProfiles(finalProfiles);
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

  return {
    app,
    workspace,
    tunnelError, tunnelErrorCopied, setTunnelErrorCopied,
    section, setSection,
    tunnelUrlCopied, setTunnelUrlCopied,
    name, setName, rootDir, setRootDir, port, setPort,
    subdomain, setSubdomain, extraSubdomains, setExtraSubdomains,
    extraSubdomainInput, setExtraSubdomainInput,
    portBindings, setPortBindings, customDomain, setCustomDomain,
    basicAuthEnabled, setBasicAuthEnabled,
    basicAuthUsername, setBasicAuthUsername,
    basicAuthPassword, setBasicAuthPassword,
    basicAuthShowPassword, setBasicAuthShowPassword,
    hostAuth, setHostAuth, hostAuthDraft, setHostAuthFor,
    startCommand, setStartCommand,
    dockerImage, setDockerImage,
    dockerContainerPort, setDockerContainerPort,
    dockerArgs, setDockerArgs,
    dockerVolumes, setDockerVolumes,
    composeFile, setComposeFile, isManagedPath,
    composeMode, setComposeMode,
    composeYaml, setComposeYaml,
    composeError, setComposeError,
    composeErrorLine, setComposeErrorLine,
    networkShare, setNetworkShare,
    composeYamlInitial, setComposeYamlInitial,
    healthCheckPath, setHealthCheckPath,
    dependsOn, setDependsOn,
    envFile, setEnvFile, autoStart, setAutoStart,
    envVars, setEnvVars,
    restartPolicy, setRestartPolicy,
    maxRetries, setMaxRetries,
    autoSleepEnabled, setAutoSleepEnabled,
    idleTimeoutMin, setIdleTimeoutMin,
    autoSleepSupported,
    maxUploadMb, setMaxUploadMb, maxUploadBytesValue,
    siblingApps,
    tunnelProvider, setTunnelProvider,
    tunnelMode, setTunnelMode,
    tunnelName, setTunnelName,
    tunnelHostname, setTunnelHostname,
    tunnelAliasDomain, setTunnelAliasDomain,
    tunnelAliasRewriteHost, setTunnelAliasRewriteHost,
    availableTunnels, setAvailableTunnels,
    tunnelsError, setTunnelsError,
    tunnelsLoading, setTunnelsLoading,
    dnsRoutes, setDnsRoutes,
    cfApiToken, setCfApiTokenState,
    cloudflaredInstalled, setCloudflaredInstalled,
    copiedCmd, setCopiedCmd,
    tsStatus, setTsStatus,
    tsLoading, setTsLoading,
    tsRecheckedWithoutChange, setTsRecheckedWithoutChange,
    tsFunnel, setTsFunnel,
    tunnelAutoStart, setTunnelAutoStart,
    tunnelReachable, setTunnelReachable,
    tunnelBusy, setTunnelBusy,
    dnsRepairing, dnsRepairError, repairDns,
    copyCmd, handleConnect, handleDisconnect, refreshTailscale, refreshTunnels,
    saving, setSaving, saveError, setSaveError, savedAt, setSavedAt,
    portNum, portValid, SUBDOMAIN_RE, DOMAIN_RE,
    subdomainValid, customDomainValid, portBindingsValid,
    rootDirOk, basicAuthValid, canSave,
    envProfiles, setEnvProfiles,
    activeProfileId, setActiveProfileId,
    profileStartCommand, setProfileStartCommand,
    profileBuildCommand, setProfileBuildCommand,
    showNewProfile, setShowNewProfile,
    newProfileName, setNewProfileName,
    deleteProfileConfirm, setDeleteProfileConfirm,
    renamingProfileId, setRenamingProfileId,
    renameValue, setRenameValue,
    commitRename,
    showAddDomain, setShowAddDomain,
    showAdvancedDomain, setShowAdvancedDomain,
    copiedHost, setCopiedHost,
    copyHost, openHost, copyOpen,
    selectProfile, createProfile, deleteProfile,
    isDirty, requestClose,
    portCheckResult, setPortCheckResult,
    scheme, effectiveSub, localDomain, localTld, primaryHost, primaryUrl,
    authHosts, buildHostAuthOverrides,
    addDomainInputValid, addDomain,
    activeTunnelProvider, selectedIsLive, otherProviderLive,
    configuredTunnelHosts, liveTunnelHosts,
    handleSave, browseRootDir, browseEnvFile, handleDelete,
    isStatic, isDocker, isCompose, isProxy,
  };
}

export type AppConfigDraft = ReturnType<typeof useAppConfigDraft>;

const Ctx = createContext<AppConfigDraft | null>(null);

export function AppConfigProvider({ value, children }: { value: AppConfigDraft; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAppConfig(): AppConfigDraft {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAppConfig must be used within AppConfigProvider");
  return v;
}
