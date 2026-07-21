import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  ArrowSquareOut,
  CaretDown,
  CaretRight,
  Copy,
  Globe,
  House,
  Lock,
  ShieldCheck,
  SlidersHorizontal,
  TerminalWindow,
  Trash,
} from "@phosphor-icons/react";
import psl from "psl";
import { useShallow } from "zustand/react/shallow";
import type { App } from "../../types";
import { openExternalUrl, setTunnelConfig } from "../../lib/commands";
import { usePortaStore } from "../../store";
import { Popover } from "../ui";
import PublishLog from "./PublishLog";

export type LocalDestination = {
  host: string;
  url: string;
  kind: "default" | "alias" | "binding";
};

type TunnelMode = "quick" | "named";
type AccessMode = "public" | "password" | "cfaccess";

const EMPTY_LOGS: string[] = [];

interface Props {
  app: App;
  destinations: LocalDestination[];
  primaryUrl: string;
  onOpenAccessSettings?: (section?: "domain" | "tunneling") => void;
  quickOnly?: boolean;
  externalBusy?: boolean;
  onToggleExternalTunnel?: () => Promise<void>;
  /** App isn't serving yet — Open would land on a connection error and a tunnel
   *  would publish a dead origin, so both actions go inert. */
  offline?: boolean;
}

const PROVIDER_LABEL: Record<string, string> = {
  cloudflare: "Cloudflare",
  tailscale: "Tailscale",
  remote: "Porta Relay",
};

function dedupe<T extends { host: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.host)) return false;
    seen.add(item.host);
    return true;
  });
}

function namedPublicHosts(app: App): { host: string; kind: "primary" | "alias" | "binding" }[] {
  const primary = app.tunnel_custom_hostname?.trim();
  if (!primary) return [];

  const parsed = psl.parse(primary);
  const base = "domain" in parsed ? parsed.domain : null;
  if (!base) return [{ host: primary, kind: "primary" }];

  return dedupe([
    { host: primary, kind: "primary" as const },
    ...app.extra_subdomains
      .map((sub) => sub.trim())
      .filter(Boolean)
      .map((sub) => ({ host: `${sub}.${base}`, kind: "alias" as const })),
    ...app.port_bindings.map((binding) => {
      const sub =
        binding.subdomain?.trim() ||
        binding.label.trim().toLowerCase().replace(/\s+/g, "-");
      return { host: `${sub}.${base}`, kind: "binding" as const };
    }),
  ]);
}

function DestinationActions({ url, label, offline = false }: { url: string; label: string; offline?: boolean }) {
  return (
    <span className="ml-auto flex shrink-0 items-center gap-2 text-ink-3">
      <button
        type="button"
        onClick={() => void navigator.clipboard.writeText(url)}
        title={`Copy ${url}`}
        aria-label={`Copy ${label}`}
        className="rounded p-1 transition-colors hover:bg-white/[0.04] hover:text-ink"
      >
        <Copy size={15} weight="regular" />
      </button>
      <button
        type="button"
        onClick={() => void openExternalUrl(url)}
        disabled={offline}
        title={offline ? "App is not running" : `Open ${url}`}
        aria-label={`Open ${label}`}
        className="rounded p-1 transition-colors hover:bg-white/[0.04] hover:text-ink disabled:pointer-events-none disabled:opacity-40"
      >
        <ArrowSquareOut size={15} weight="regular" />
      </button>
    </span>
  );
}

function ModePill({ children, tone = "neutral" }: { children: string; tone?: "neutral" | "accent" }) {
  return (
    <span
      className={`rounded-[5px] border px-1.5 py-px text-[9px] leading-4 ${
        tone === "accent"
          ? "border-[rgba(96,165,250,0.20)] bg-accent-bg text-accent-ink"
          : "border-subtle bg-white/[0.03] text-ink-3"
      }`}
    >
      {children}
    </span>
  );
}

export default function AppAccessPopover({
  app,
  destinations,
  primaryUrl,
  onOpenAccessSettings,
  quickOnly = false,
  externalBusy = false,
  onToggleExternalTunnel,
  offline = false,
}: Props) {
  const [open, setOpen] = useState(false);
  const configuredMode: TunnelMode =
    app.tunnel_name?.trim() && app.tunnel_custom_hostname?.trim() ? "named" : "quick";
  const [mode, setMode] = useState<TunnelMode>(configuredMode);
  const [access, setAccess] = useState<AccessMode>(
    app.basic_auth_enabled ? "password" : "public",
  );
  const [outputOpen, setOutputOpen] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const {
    startTunnel,
    stopTunnel,
    refreshApp,
    connecting,
    tunnelError,
    tunnelLogs,
    clearTunnelLog,
  } = usePortaStore(
    useShallow((state) => ({
      startTunnel: state.startTunnel,
      stopTunnel: state.stopTunnel,
      refreshApp: state.refreshApp,
      connecting: state.tunnelConnecting[app.id] ?? false,
      tunnelError: state.appTunnelErrors[app.id] ?? null,
      tunnelLogs: state.appTunnelLogs[app.id] ?? EMPTY_LOGS,
      clearTunnelLog: state.clearTunnelLog,
    })),
  );

  const tunnelHasUrl = app.tunnel_active && !!app.tunnel_url;
  const connectingNow = externalBusy || connecting || (app.tunnel_active && !app.tunnel_url);
  const liveMode: TunnelMode = configuredMode;
  const visibleMode = tunnelHasUrl ? liveMode : mode;
  const provider = app.tunnel_provider ?? "cloudflare";
  const providerIsCloudflare = provider === "cloudflare";
  const modeLocked = tunnelHasUrl || connectingNow || quickOnly;
  // A live tunnel must stay disconnectable even if the origin died, so only
  // *connecting* is blocked while the app is down.
  const tunnelToggleDisabled = connectingNow || (offline && !tunnelHasUrl);
  const namedConfigured = !!(app.tunnel_name?.trim() && app.tunnel_custom_hostname?.trim());

  useEffect(() => {
    if (!open || tunnelHasUrl || connectingNow) return;
    setMode(configuredMode);
  }, [configuredMode, connectingNow, open, tunnelHasUrl]);

  useEffect(() => {
    setAccess(app.basic_auth_enabled ? "password" : "public");
  }, [app.basic_auth_enabled, app.id]);

  const namedHosts = useMemo(() => namedPublicHosts(app), [app]);

  const publicDestinations = useMemo(() => {
    if (!providerIsCloudflare && tunnelHasUrl && app.tunnel_url) {
      return [{
        host: app.tunnel_url.replace(/^https?:\/\//, ""),
        url: app.tunnel_url,
        kind: PROVIDER_LABEL[provider] ?? provider,
        live: true,
      }];
    }
    if (visibleMode === "quick") {
      if (!tunnelHasUrl || !app.tunnel_url) return [];
      return [{
        host: app.tunnel_url.replace(/^https?:\/\//, ""),
        url: app.tunnel_url,
        kind: "quick",
        live: true,
      }];
    }
    return namedHosts.map(({ host, kind }) => ({
      host,
      url: `https://${host}`,
      kind,
      live: tunnelHasUrl,
    }));
  }, [app.tunnel_url, namedHosts, provider, providerIsCloudflare, tunnelHasUrl, visibleMode]);

  function openTunnelSettings() {
    setOpen(false);
    onOpenAccessSettings?.("tunneling");
  }

  function openDomainSettings() {
    setOpen(false);
    onOpenAccessSettings?.("domain");
  }

  async function toggleTunnel() {
    if (tunnelToggleDisabled) return;
    setConfigError(null);

    if (quickOnly) {
      await onToggleExternalTunnel?.();
      return;
    }

    if (tunnelHasUrl) {
      await stopTunnel(app.id);
      return;
    }

    if (mode === "named" && !namedConfigured) {
      openTunnelSettings();
      return;
    }

    try {
      await setTunnelConfig(
        app.id,
        "cloudflare",
        mode === "named" ? app.tunnel_name : null,
        mode === "named" ? app.tunnel_custom_hostname : null,
        app.tunnel_auto_start,
      );
      await refreshApp(app.id);
      await startTunnel(app.id, "cloudflare");
    } catch (error) {
      setConfigError(error instanceof Error ? error.message : String(error));
    }
  }

  const statusText = connectingNow
    ? "Connecting…"
    : tunnelHasUrl
      ? "Tunnel on"
      : "Tunnel off";

  const accessDetail: Record<
    AccessMode,
    { text: string; action?: string; onAction?: () => void }
  > = {
    public: app.basic_auth_enabled
      ? {
          text: "Password protection is currently enabled.",
          action: "Disable it in Domain",
          onAction: openDomainSettings,
        }
      : { text: "Anyone with the link." },
    password: {
      text: app.basic_auth_enabled
        ? "Visitors must enter the configured username and password."
        : "Protect local and tunneled routes with basic authentication.",
      action: app.basic_auth_enabled ? "Edit credentials" : "Set credentials",
      onAction: openDomainSettings,
    },
    cfaccess: {
      text:
        visibleMode === "named"
          ? "Require an identity check before requests reach Porta."
          : "Cloudflare Access requires a Named Tunnel hostname.",
      action: visibleMode === "named" ? "Configure CF Access" : "Set up Named Tunnel",
      onAction: openTunnelSettings,
    },
  };

  return (
    <Popover
      open={open}
      onClose={() => setOpen(false)}
      align="right"
      width="w-[680px] max-w-[calc(100vw-2rem)]"
      panelClassName="!max-h-[calc(100vh-6rem)] !overflow-y-auto !p-0"
      anchor={
        <span className={`inline-flex self-center overflow-hidden rounded-control border border-[rgba(96,165,250,0.30)] ${offline ? "opacity-50" : ""}`}>
          <button
            type="button"
            onClick={() => void openExternalUrl(primaryUrl)}
            disabled={offline}
            title={offline ? "App is not running" : `Open ${primaryUrl}`}
            className="inline-flex items-center gap-1.5 bg-accent-bg px-2.5 py-[5px] text-[12px] font-medium text-accent-ink transition-colors duration-fast hover:bg-[rgba(96,165,250,0.24)] disabled:pointer-events-none"
          >
            <ArrowSquareOut size={14} weight="regular" />
            Open
          </button>
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            title="Open app access"
            aria-label="Open app access"
            aria-haspopup="menu"
            aria-expanded={open}
            className="inline-flex items-center gap-1.5 border-l border-[rgba(96,165,250,0.30)] bg-accent-bg px-2 py-[5px] text-[11px] font-medium text-accent-ink transition-colors duration-fast hover:bg-[rgba(96,165,250,0.24)]"
          >
            <Globe size={14} weight="regular" />
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                connectingNow ? "animate-pulse bg-warn" : tunnelHasUrl ? "bg-ok" : "bg-ink-3"
              }`}
              aria-hidden
            />
            {statusText}
          </button>
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            title="App access options"
            aria-label="App access options"
            aria-haspopup="menu"
            aria-expanded={open}
            className="inline-flex items-center border-l border-[rgba(96,165,250,0.30)] bg-accent-bg px-[7px] text-accent-ink transition-colors duration-fast hover:bg-[rgba(96,165,250,0.24)]"
          >
            <CaretDown size={13} weight="bold" />
          </button>
        </span>
      }
    >
      <div className="grid min-h-[390px] grid-cols-[minmax(0,1.05fr)_minmax(260px,0.95fr)] max-[760px]:grid-cols-1">
        <section className="min-w-0 border-r border-subtle px-4 py-4 max-[760px]:border-b max-[760px]:border-r-0">
          <h2 className="text-[10px] uppercase tracking-[0.09em] text-ink-3">Open in browser</h2>

          <div className="mt-4">
            <div className="mb-1.5 text-[10px] uppercase tracking-[0.08em] text-ink-3">Local</div>
            <div className="divide-y divide-[var(--border-subtle)]">
              {destinations.map((destination) => (
                <div key={destination.url} className="flex min-w-0 items-center gap-2.5 py-2.5">
                  <House size={17} weight="regular" className="shrink-0 text-ink-2" />
                  <span className="min-w-0 truncate font-mono text-[12px] text-ink">
                    {destination.host}
                  </span>
                  <ModePill tone={destination.kind === "default" ? "accent" : "neutral"}>
                    {destination.kind}
                  </ModePill>
                  <DestinationActions url={destination.url} label={`${destination.host} URL`} offline={offline} />
                </div>
              ))}
            </div>
          </div>

          <div className="mt-3 border-t border-subtle pt-3">
            <div className="mb-1.5 text-[10px] uppercase tracking-[0.08em] text-ink-3">Public</div>
            {publicDestinations.length > 0 ? (
              <div className="divide-y divide-[var(--border-subtle)]">
                {publicDestinations.map((destination) => (
                  <div key={destination.url} className="flex min-w-0 items-center gap-2.5 py-2.5">
                    <Globe size={17} weight="regular" className="shrink-0 text-ink-2" />
                    <span className="min-w-0 truncate font-mono text-[11px] text-ink">
                      {destination.host}
                    </span>
                    <ModePill>{destination.kind}</ModePill>
                    {destination.live && (
                      <span className="inline-flex shrink-0 items-center gap-1 text-[10px] text-ok">
                        <span className="h-1.5 w-1.5 rounded-full bg-ok" aria-hidden />
                        Live
                      </span>
                    )}
                    <DestinationActions url={destination.url} label={`${destination.host} URL`} />
                  </div>
                ))}
              </div>
            ) : (
              <p className="py-2 text-[11px] leading-5 text-ink-3">
                {visibleMode === "quick"
                  ? "Connect Quick to generate a public URL."
                  : namedConfigured
                    ? "Connect Named to publish the configured hostnames."
                    : "Set up a named tunnel and hostname first."}
              </p>
            )}
          </div>
        </section>

        <section className="min-w-0 px-4 py-4">
          <div className="flex items-center gap-2">
            <h2 className="text-[10px] uppercase tracking-[0.09em] text-ink-3">Tunnel</h2>
            <span
              className={`ml-1 h-1.5 w-1.5 rounded-full ${
                connectingNow ? "animate-pulse bg-warn" : tunnelHasUrl ? "bg-ok" : "bg-ink-3"
              }`}
              aria-hidden
            />
            <span className={`text-[11px] ${tunnelHasUrl ? "text-ok" : connectingNow ? "text-warn" : "text-ink-3"}`}>
              {connectingNow ? "Connecting…" : tunnelHasUrl ? "Tunnel live" : "Disconnected"}
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={tunnelHasUrl}
              aria-label={tunnelHasUrl ? "Disconnect tunnel" : `Connect ${mode} tunnel`}
              disabled={tunnelToggleDisabled}
              title={offline && !tunnelHasUrl ? "Start the app before connecting a tunnel" : undefined}
              onClick={() => void toggleTunnel()}
              className={`relative ml-auto h-[18px] w-8 rounded-full transition-colors disabled:opacity-60 ${
                connectingNow ? "disabled:cursor-wait" : "disabled:cursor-not-allowed"
              } ${
                tunnelHasUrl ? "bg-accent" : "border border-strong bg-surface-1"
              }`}
            >
              <span
                className={`absolute top-[2px] h-3.5 w-3.5 rounded-full bg-white transition-all ${
                  tunnelHasUrl ? "right-[2px]" : "left-[2px]"
                }`}
              />
            </button>
          </div>

          {!quickOnly && (
            <div className="mt-5">
              <div className="mb-1.5 text-[10px] uppercase tracking-[0.08em] text-ink-3">Mode</div>
              <div className="grid grid-cols-2 overflow-hidden rounded-[7px] border border-subtle">
                {(["quick", "named"] as const).map((item, index) => (
                  <button
                    key={item}
                    type="button"
                    disabled={modeLocked}
                    onClick={() => {
                      setMode(item);
                      setConfigError(null);
                    }}
                    className={`px-3 py-2 text-[11px] font-medium capitalize transition-colors disabled:cursor-not-allowed ${
                      index > 0 ? "border-l border-subtle" : ""
                    } ${
                      visibleMode === item
                        ? "bg-accent-bg text-accent-ink shadow-[inset_0_0_0_1px_rgba(96,165,250,0.28)]"
                        : "text-ink-2 hover:bg-white/[0.03] hover:text-ink"
                    }`}
                  >
                    {item}
                  </button>
                ))}
              </div>
              {tunnelHasUrl && (
                <p className="mt-1.5 text-[10px] text-ink-3">Disconnect to change tunnel mode.</p>
              )}
            </div>
          )}

          <div className="mt-4 rounded-[8px] border border-subtle bg-surface-1 px-3 py-2.5">
            <div className="flex min-w-0 items-center gap-2 font-mono text-[11px] text-ink-2">
              <span className="truncate">localhost:{app.port}</span>
              <ArrowRight size={15} weight="regular" className="shrink-0 text-ok" />
              <span className="truncate">
                {visibleMode === "quick"
                  ? "trycloudflare.com"
                  : app.tunnel_custom_hostname ?? "custom domain"}
              </span>
            </div>
          </div>

          {visibleMode === "quick" ? (
            <div className="mt-4 space-y-1.5 text-[11px] leading-5 text-ink-3">
              <p>No domain required.</p>
              <p>A new public URL is generated when reconnected.</p>
              {!quickOnly && onOpenAccessSettings && (
                <button
                  type="button"
                  onClick={openTunnelSettings}
                  className="pt-1 text-accent transition hover:brightness-110"
                >
                  Named uses your own domain
                </button>
              )}
            </div>
          ) : namedConfigured ? (
            <div className="mt-4 space-y-1.5 text-[11px] leading-5 text-ink-3">
              <p>
                Tunnel <span className="font-mono text-ink-2">{app.tunnel_name}</span>
              </p>
              <p>{namedHosts.length} configured public {namedHosts.length === 1 ? "hostname" : "hostnames"}.</p>
              {onOpenAccessSettings && (
                <button type="button" onClick={openTunnelSettings} className="pt-1 text-accent transition hover:brightness-110">
                  Edit named tunnel
                </button>
              )}
            </div>
          ) : (
            <div className="mt-4">
              <p className="text-[11px] leading-5 text-ink-3">
                Named mode needs a saved Cloudflare tunnel and a hostname.
              </p>
              {onOpenAccessSettings && (
                <button
                  type="button"
                  onClick={openTunnelSettings}
                  className="mt-3 rounded-control border border-subtle px-3 py-1.5 text-[11px] text-ink-2 transition-colors hover:border-strong hover:bg-white/[0.03] hover:text-ink"
                >
                  Set up named tunnel…
                </button>
              )}
            </div>
          )}

          {!providerIsCloudflare && tunnelHasUrl && (
            <p className="mt-4 rounded-[7px] border border-[rgba(251,191,36,0.20)] bg-warn-bg px-2.5 py-2 text-[10px] leading-4 text-warn">
              {PROVIDER_LABEL[provider] ?? provider} is currently live. Disconnect it before switching to Quick or Named.
            </p>
          )}

          {(configError || tunnelError) && (
            <p className="mt-4 max-h-20 overflow-y-auto whitespace-pre-wrap break-words rounded-[7px] bg-bad-bg px-2.5 py-2 font-mono text-[10px] leading-4 text-bad">
              {configError ?? tunnelError}
            </p>
          )}

          {!quickOnly && onOpenAccessSettings && (
            <div className="mt-4 border-t border-subtle pt-4">
              <div className="mb-2 text-[10px] uppercase tracking-[0.08em] text-ink-3">
                Who can reach it
              </div>
              <div className="grid grid-cols-3 overflow-hidden rounded-[7px] border border-subtle">
                {([
                  { id: "public" as const, label: "Public", icon: Globe },
                  { id: "password" as const, label: "Password", icon: Lock },
                  { id: "cfaccess" as const, label: "CF Access", icon: ShieldCheck },
                ]).map((item, index) => {
                  const Icon = item.icon;
                  const selected = access === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => setAccess(item.id)}
                      className={`inline-flex min-w-0 items-center justify-center gap-1.5 px-2 py-2 text-[10px] transition-colors ${
                        index > 0 ? "border-l border-subtle" : ""
                      } ${
                        selected
                          ? "bg-accent-bg text-accent-ink"
                          : "text-ink-2 hover:bg-white/[0.03] hover:text-ink"
                      }`}
                    >
                      <Icon size={13} weight="regular" className="shrink-0" />
                      <span className="truncate">{item.label}</span>
                    </button>
                  );
                })}
              </div>
              <p className="mt-2 text-[10px] leading-4 text-ink-3">
                {accessDetail[access].text}
                {accessDetail[access].action && (
                  <>
                    {" "}
                    <button
                      type="button"
                      onClick={accessDetail[access].onAction}
                      className="text-accent transition hover:brightness-110"
                    >
                      {accessDetail[access].action}
                    </button>
                  </>
                )}
              </p>
            </div>
          )}
        </section>
      </div>

      <section className="border-t border-subtle">
        <button
          type="button"
          aria-expanded={outputOpen}
          onClick={() => setOutputOpen((value) => !value)}
          className="flex w-full items-center gap-2 px-4 py-3 text-left transition-colors hover:bg-white/[0.025]"
        >
          <CaretRight
            size={13}
            weight="bold"
            className={`shrink-0 text-ink-3 transition-transform ${
              outputOpen ? "rotate-90" : ""
            }`}
          />
          <TerminalWindow size={15} weight="regular" className="shrink-0 text-ink-2" />
          <span className="text-[11px] font-medium text-ink-2">Tunnel output</span>
          <span className="text-[10px] text-ink-3">
            {tunnelLogs.length > 0
              ? `${tunnelLogs.length} ${tunnelLogs.length === 1 ? "line" : "lines"}`
              : "Debug stream"}
          </span>
          {!outputOpen && tunnelLogs.length > 0 && (
            <span className="ml-auto max-w-[270px] truncate font-mono text-[9px] text-ink-3">
              {tunnelLogs[tunnelLogs.length - 1]}
            </span>
          )}
        </button>

        {outputOpen && (
          <div className="px-4 pb-4">
            <div className="mb-2 flex items-center">
              <p className="text-[10px] text-ink-3">
                Live stdout/stderr from the active tunnel connector.
              </p>
              {tunnelLogs.length > 0 && (
                <button
                  type="button"
                  onClick={() => clearTunnelLog(app.id)}
                  className="ml-auto inline-flex items-center gap-1 text-[10px] text-ink-3 transition-colors hover:text-ink"
                >
                  <Trash size={12} weight="regular" />
                  Clear
                </button>
              )}
            </div>
            <PublishLog lines={tunnelLogs} />
          </div>
        )}
      </section>

      {onOpenAccessSettings && (
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            onOpenAccessSettings();
          }}
          className="flex w-full items-center justify-center gap-2 border-t border-subtle px-4 py-3 text-[12px] text-ink-2 transition-colors hover:bg-white/[0.025] hover:text-ink"
        >
          <SlidersHorizontal size={15} weight="regular" />
          Manage routes & access…
        </button>
      )}
    </Popover>
  );
}
