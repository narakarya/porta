import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { usePortaStore } from "../../store";
import { checkPortAvailable, checkCloudflared, loadComposeYaml, parseComposeString, listCloudflareTunnels, setTunnelConfig, getTailscaleStatus, listTailscaleServes, checkTunnelReachable, getCfApiToken, listTunnelDns, openExternalUrl, type CloudflareTunnel, type PortCheckResult, type TailscaleStatus, type TunnelDnsRoute } from "../../lib/commands";
import { getCachedTailscaleStatus, setCachedTailscaleStatus } from "../../lib/tailscaleCache";
import { getCachedDnsRoutes, setCachedDnsRoutes } from "../../lib/tunnelCache";
import YamlEditor from "../shared/YamlEditor";
import SetupCard from "../shared/SetupCard";
import type { App, EnvProfile, HostAuthOverrideInput, PortBinding, Workspace } from "../../types";
import Field from "../shared/Field";
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

type TunnelPublicHost = { host: string; kind: "primary" | "extra" | "binding" };

function buildTunnelPublicHosts(
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

function TunnelPublicHostsPanel({ hosts, title = "This app will expose" }: { hosts: TunnelPublicHost[]; title?: string }) {
  if (hosts.length === 0) return null;

  return (
    <div className="mt-3 rounded-lg bg-orange-500/[0.04] border border-orange-500/[0.15] overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-orange-500/[0.10]">
        <p className="text-[10px] text-ink-2 font-medium">{title}</p>
        <span className="text-[9px] uppercase tracking-wider text-orange-300/80 leading-none">
          {hosts.length} {hosts.length === 1 ? "host" : "hosts"}
        </span>
      </div>
      <ul className="px-3 py-2 space-y-1">
        {hosts.map(({ host, kind }) => (
          <li key={host} className="flex items-center gap-2 font-mono text-[11px] text-orange-200/90 min-w-0">
            {/* Filled dot for the primary host, hollow for extras / port bindings. */}
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
}

// ── Small inline icons (token-styled via currentColor) ────────────────────
function IconEye() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M1 7c.8-2.3 3-4 6-4s5.2 1.7 6 4c-.8 2.3-3 4-6 4s-5.2-1.7-6-4Z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
      <circle cx="7" cy="7" r="1.9" stroke="currentColor" strokeWidth="1.2"/>
    </svg>
  );
}
function IconEyeOff() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M1 1l12 12" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
      <path d="M5.4 5.5a2 2 0 0 0 2.8 2.85M3.5 3.6C2.3 4.4 1.3 5.6 1 7c.8 2.3 3 4 6 4 1.2 0 2.3-.3 3.2-.8M9.9 9C11 8.3 11.7 7.3 12 7c-.8-2.3-3-4-6-4-.5 0-1 .05-1.4.15" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}
function IconCopy() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <rect x="4.5" y="4.5" width="7.5" height="7.5" rx="1.4" stroke="currentColor" strokeWidth="1.2"/>
      <path d="M9.5 4.5V3a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v5.5a1 1 0 0 0 1 1h1.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}
function IconCheck() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M2.5 7.5l3 3 6-6.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}
function IconExternal() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M5.5 2.5H3A1 1 0 0 0 2 3.5v7a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M8 2.5h3.5V6M11 3l-5 5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}
function IconRemove() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
    </svg>
  );
}
function IconPlus() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M6 2.5v7M2.5 6h7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
    </svg>
  );
}
function IconStar() {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
      <path d="M7 1.5l1.6 3.4 3.7.4-2.8 2.5.8 3.7L7 10.1 3.7 12l.8-3.7L1.7 5.8l3.7-.4L7 1.5Z"/>
    </svg>
  );
}
function IconFileImport() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M8 1.5H3.5A1 1 0 0 0 2.5 2.5v9a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5L8 1.5Z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"/>
      <path d="M8 1.5V5h3.5" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"/>
      <path d="M7 6.5V10M5.5 8.5L7 10l1.5-1.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
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

/** Vercel-style key/value env table for the active profile. Owns its own
 * reveal/copy/export view-state; the persisted data lives in `vars` (mapped
 * back to app.env_vars on Save by the parent — unchanged). The PORT row is
 * synthetic and read-only: Porta always manages the port, so it is never part
 * of the editable `vars` array. */
function EnvVarTable({
  vars,
  onChange,
  port,
  envFile,
  onImportFile,
  onClearFile,
}: {
  vars: { key: string; value: string }[];
  onChange: (vars: { key: string; value: string }[]) => void;
  port: number;
  envFile: string;
  onImportFile: () => void;
  onClearFile: () => void;
}) {
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [exported, setExported] = useState(false);

  const updateRow = (i: number, patch: Partial<{ key: string; value: string }>) =>
    onChange(vars.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const removeRow = (i: number) => onChange(vars.filter((_, idx) => idx !== i));
  const addRow = () => onChange([...vars, { key: "", value: "" }]);
  const toggleReveal = (i: number) =>
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  const copyValue = (i: number, value: string) => {
    navigator.clipboard.writeText(value).then(() => {
      setCopiedIdx(i);
      setTimeout(() => setCopiedIdx((cur) => (cur === i ? null : cur)), 1200);
    });
  };
  const exportEnv = () => {
    const text = vars
      .filter((v) => v.key.trim())
      .map((v) => `${v.key.trim()}=${v.value}`)
      .join("\n");
    navigator.clipboard.writeText(text).then(() => {
      setExported(true);
      setTimeout(() => setExported(false), 1500);
    });
  };

  return (
    <div className="flex flex-col">
      <div className="font-mono text-[12px]">
        {vars.map((row, i) => {
          const isRevealed = revealed.has(i);
          return (
            <div key={i} className="flex items-center gap-2 py-1.5 border-b border-subtle">
              <input
                spellCheck={false}
                value={row.key}
                onChange={(e) => updateRow(i, { key: e.target.value })}
                className="input-base w-[150px] shrink-0 font-mono text-[12px] uppercase"
                placeholder="KEY"
              />
              <input
                spellCheck={false}
                type={isRevealed ? "text" : "password"}
                value={row.value}
                onChange={(e) => updateRow(i, { value: e.target.value })}
                className="input-base flex-1 min-w-0 font-mono text-[12px]"
                placeholder="value"
              />
              <button
                type="button"
                onClick={() => toggleReveal(i)}
                aria-label={isRevealed ? "Hide value" : "Reveal value"}
                title={isRevealed ? "Hide value" : "Reveal value"}
                className="text-ink-3 hover:text-ink-2 transition-colors p-1 shrink-0"
              >
                {isRevealed ? <IconEyeOff /> : <IconEye />}
              </button>
              <button
                type="button"
                onClick={() => copyValue(i, row.value)}
                aria-label="Copy value"
                title="Copy value"
                className={`transition-colors p-1 shrink-0 ${copiedIdx === i ? "text-ok" : "text-ink-3 hover:text-ink-2"}`}
              >
                {copiedIdx === i ? <IconCheck /> : <IconCopy />}
              </button>
              <button
                type="button"
                onClick={() => removeRow(i)}
                aria-label="Remove variable"
                title="Remove variable"
                className="text-ink-3 hover:text-bad transition-colors p-1 shrink-0"
              >
                <IconRemove />
              </button>
            </div>
          );
        })}

        {/* Porta-managed PORT row — read-only, never part of env_vars. */}
        <div className="flex items-center gap-2 py-1.5 border-b border-subtle">
          <span className="w-[150px] shrink-0 text-ink-3 px-2.5">PORT</span>
          <span className="flex-1 min-w-0 text-ink-3 px-2.5 truncate">{port}</span>
          <span className="text-[10px] font-sans text-ink-3 shrink-0 pr-1">managed by Porta</span>
        </div>
      </div>

      {/* Inline add-variable row */}
      <button
        type="button"
        onClick={addRow}
        className="mt-2 self-start inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] text-ink-2 hover:text-ink border border-dashed border-strong rounded-control transition-colors"
      >
        <IconPlus /> Add variable
      </button>

      {/* Footer: import / export (mockup 20). Import reuses the existing
          env-file browse handler; Clear reuses the existing setter. */}
      <div className="flex items-center gap-3 mt-4 pt-3 border-t border-subtle text-[11px]">
        <button
          type="button"
          onClick={onImportFile}
          className="inline-flex items-center gap-1.5 text-ink-2 hover:text-ink transition-colors"
        >
          <IconFileImport /> Import .env
        </button>
        <button
          type="button"
          onClick={exportEnv}
          className={`inline-flex items-center gap-1.5 transition-colors ${exported ? "text-ok" : "text-ink-2 hover:text-ink"}`}
        >
          {exported ? <IconCheck /> : <IconCopy />} {exported ? "Copied" : "Export"}
        </button>
        {envFile && (
          <span className="ml-auto inline-flex items-center gap-1.5 min-w-0">
            <code className="font-mono text-ink-3 truncate max-w-[180px]" title={envFile}>{envFile}</code>
            <button type="button" onClick={onClearFile} className="text-ink-3 hover:text-ink-2 transition-colors shrink-0">
              Clear
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

export type Section = "general" | "domain" | "environment" | "tunneling" | "health" | "danger";

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
    dependsOn, envProfiles, activeProfileId,
    tunnelProvider, tunnelMode, tunnelName, tunnelHostname, tunnelAutoStart,
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
    { id: "danger",      label: "Danger" },
  ];

  return (
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

          {section === "general" && (
            <>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-widest text-ink-2">General</p>
                <p className="text-[12px] text-ink-3 mt-1">App identity and connection settings.</p>
              </div>

              <div className="flex flex-col gap-4 p-5 rounded-card bg-surface-1 border border-subtle">
                {isStatic && (
                  <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-accent-bg border border-[rgba(96,165,250,0.30)]">
                    <span className="text-[10px] font-semibold tracking-wider text-accent-ink mt-0.5">STATIC</span>
                    <p className="text-[11px] text-accent-ink">
                      Caddy serves files directly from the root directory — no process,
                      no port, no start command.
                    </p>
                  </div>
                )}
                {isDocker && (
                  <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-accent-bg border border-[rgba(96,165,250,0.30)]">
                    <span className="text-[10px] font-semibold tracking-wider text-accent-ink mt-0.5">DOCKER</span>
                    <p className="text-[11px] text-accent-ink">
                      Porta runs container <code className="font-mono">porta-{app.id.slice(0, 8)}…</code>.
                      Host port maps to the container port below.
                    </p>
                  </div>
                )}
                {isCompose && (
                  <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-accent-bg border border-[rgba(96,165,250,0.30)]">
                    <span className="text-[10px] font-semibold tracking-wider text-accent-ink mt-0.5">COMPOSE</span>
                    <p className="text-[11px] text-accent-ink">
                      Porta runs <code className="font-mono">docker compose up/down</code> in project <code className="font-mono">porta-{app.id.slice(0, 8)}…</code>. Port should match what compose publishes.
                    </p>
                  </div>
                )}
                {isProxy && (
                  <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-accent-bg border border-[rgba(96,165,250,0.30)]">
                    <span className="text-[10px] font-semibold tracking-wider text-accent-ink mt-0.5">PROXY</span>
                    <p className="text-[11px] text-accent-ink">
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
                      className={`input-base ${!portValid && port ? "border-[rgba(248,113,113,0.5)]" : ""}`}
                      placeholder="3000" type="number" min={1} max={65535} />
                    {portCheckResult && portValid && (
                      <p className={`text-[10px] mt-1 ${portCheckResult.available ? "text-ok" : "text-warn"}`}>
                        {portCheckResult.available
                          ? "✓ Port available"
                          : `⚠ Port in use by ${portCheckResult.process_name ?? "unknown"} (PID ${portCheckResult.pid ?? "?"})`}
                      </p>
                    )}
                  </Field>
                )}

                {isCompose && (
                  <Field label="Compose Source">
                    <div className="flex gap-1 bg-surface-1 border border-subtle rounded-lg p-1 mb-2">
                      {(["paste", "file"] as const).map((m) => (
                        <button
                          key={m}
                          type="button"
                          onClick={() => setComposeMode(m)}
                          className={`flex-1 px-3 py-1.5 text-[12px] font-medium rounded-md transition-colors ${
                            composeMode === m ? "bg-surface-2 text-ink" : "text-ink-3 hover:text-ink-2"
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
                        <p className="text-[10px] text-ink-3 mt-1">Relative to Root Directory, or absolute.</p>
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
                          <div className="mt-2 px-2.5 py-1.5 rounded-md bg-bad-bg border border-[rgba(248,113,113,0.3)] text-[11px] text-bad font-mono whitespace-pre-wrap break-words">
                            {composeError}
                          </div>
                        )}
                        <p className="text-[10px] text-ink-3 mt-1">
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
                      <p className="text-[10px] text-ink-3 mt-1">Internal port the container listens on.</p>
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
                              className="px-2.5 text-ink-3 hover:text-ink border border-subtle rounded-lg text-[11px] shrink-0"
                              title={`Fill with ${volumeTemplate(name)}`}
                            >
                              base
                            </button>
                            <button
                              type="button"
                              onClick={() => setDockerVolumes((prev) => prev.filter((_, j) => j !== i))}
                              className="px-2.5 text-ink-3 hover:text-bad border border-subtle rounded-lg text-[14px] shrink-0"
                              title="Remove"
                            >
                              ×
                            </button>
                          </div>
                        ))}
                        <button
                          type="button"
                          onClick={() => setDockerVolumes((prev) => [...prev, ""])}
                          className="self-start px-2.5 py-1 text-[11px] text-ink-2 hover:text-ink border border-dashed border-strong rounded-md"
                        >
                          + Add volume
                        </button>
                      </div>
                      <p className="text-[10px] text-ink-3 mt-1">
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
                      className="px-3 py-2 text-[12px] text-ink-2 bg-surface-2 border border-subtle rounded-lg hover:bg-white/[0.08] hover:text-ink transition-colors shrink-0"
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
                        className="mt-0.5 rounded border-strong bg-surface-2 text-accent focus:ring-[rgba(96,165,250,0.45)] focus:ring-offset-0"
                      />
                      <div className="flex flex-col gap-0.5">
                        <span className="text-[12px] text-ink">Join shared network</span>
                        <span className="text-[11px] text-ink-3">
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
                    <p className="text-[10px] text-ink-3 mt-1">
                      Leave blank to use port-only detection
                    </p>
                  </Field>
                )}
              </div>

              {/* Start After (dependencies) (from agent-a7a6ec3b) */}
              {siblingApps.length > 0 && (
                <div className="flex flex-col gap-3 p-5 rounded-card bg-surface-1 border border-subtle">
                  <div>
                    <p className="text-[12px] font-medium text-ink-2">Start After</p>
                    <p className="text-[11px] text-ink-3 mt-0.5 leading-relaxed">
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
                            className="rounded border-strong bg-surface-2 text-accent focus:ring-[rgba(96,165,250,0.45)] focus:ring-offset-0"
                          />
                          <span className="text-[13px] text-ink-2">{sibling.name}</span>
                          <span className="text-[11px] text-ink-3">:{sibling.port}</span>
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
                          className="mt-0.5 rounded border-strong bg-surface-2 text-orange-500 focus:ring-orange-500/30 focus:ring-offset-0"
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
  );
}
