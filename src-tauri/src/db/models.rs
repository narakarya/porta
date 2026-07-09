use std::collections::HashMap;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvProfile {
    pub id: String,
    pub name: String,
    pub env_file: Option<String>,
    pub env_vars: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortBinding {
    pub id: String,
    pub label: String,
    pub port: u16,
    pub subdomain: Option<String>,
    pub custom_domain: Option<String>,
}

// ── Porta Relay (self-hosted expose) ───────────────────────────────────────────

/// A user-owned VPS registered as a Porta Relay target. Porta reaches its Caddy
/// admin API over the WireGuard tunnel at `tunnel_ip:admin_port`, and the VPS
/// reverse-proxies public traffic back to this Mac's local Caddy at
/// `mac_tunnel_ip:443`. `wg_interface` is a manual override; `None` auto-detects.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteHost {
    pub id: String,
    pub name: String,
    pub tunnel_ip: String,
    pub admin_port: u16,
    pub base_domain: String,
    pub wg_interface: Option<String>,
    pub mac_tunnel_ip: String,
    pub created_at: i64,
    /// Additional domains this host serves besides `base_domain` (all pointing at
    /// the same VPS). Expose can target any of them.
    #[serde(default)]
    pub extra_domains: Vec<String>,
    /// VPS public IP — used for the Cloudflare A record (R6). WG `tunnel_ip`
    /// isn't publicly routable, so DNS must point here.
    #[serde(default)]
    pub public_ip: Option<String>,
    /// Opt-in: auto-create a DNS-only A record via Cloudflare on expose (R6).
    #[serde(default)]
    pub auto_dns: bool,
    /// SSH user for tailing the VPS Caddy access log (R8). Uses the system ssh
    /// client + the user's existing keys; Porta stores no credentials.
    #[serde(default)]
    pub ssh_user: Option<String>,
    /// Path to the VPS Caddy access log (R8). Blank → default.
    #[serde(default)]
    pub remote_log_path: Option<String>,
}

/// One public route Porta manages on a `RemoteHost`. `subdomain` + the host's
/// `base_domain` form the public hostname; `port` is the local app port the
/// route ultimately targets (via local Caddy). `status`: "active" once the VPS
/// Caddy has the route, "pending" if the push hasn't been confirmed.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteRoute {
    pub id: String,
    pub app_id: String,
    pub host_id: String,
    pub subdomain: String,
    pub port: u16,
    pub status: String,
    pub created_at: i64,
    /// Which of the host's domains this route was exposed on. `None` falls back
    /// to the host's `base_domain` (rows created before multi-domain support).
    #[serde(default)]
    pub domain: Option<String>,
}

impl RemoteHost {
    /// All domains this host serves: the primary `base_domain` first, then any
    /// `extra_domains`, de-duplicated and non-empty.
    pub fn domains(&self) -> Vec<String> {
        let mut out = vec![self.base_domain.clone()];
        for d in &self.extra_domains {
            let d = d.trim();
            if !d.is_empty() && !out.iter().any(|x| x == d) {
                out.push(d.to_string());
            }
        }
        out.retain(|d| !d.trim().is_empty());
        out
    }
}

// ── Service ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Service {
    pub id: String,
    pub name: String,
    pub image: String,
    pub tag: String,
    pub port: u16,
    pub env_vars: HashMap<String, String>,
    pub volumes: Vec<String>, // "source:target" pairs
    pub scope: String, // "global" or workspace_id
    pub status: String, // "stopped" | "pulling" | "starting" | "running"
    pub container_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub domain: String,
    /// Populated at runtime by list_workspaces (not stored as a column).
    #[serde(default)]
    pub deployment: Option<serde_json::Value>,
}

/// A Caddy route generated from an app's bindings. `ReverseProxy` for normal
/// apps that own a process on a port; `FileServer` for static apps where Caddy
/// serves files directly from `root` (no upstream).
///
/// `app_id` lets us wire each route to a per-app access logger so the
/// Traffic Inspector UI can show requests per app.
#[derive(Debug, Clone)]
pub enum Route {
    ReverseProxy { host: String, port: u16, auth: Option<BasicAuth>, app_id: Option<String>, max_body: Option<u64> },
    FileServer { host: String, root: String, auth: Option<BasicAuth>, app_id: Option<String>, max_body: Option<u64> },
    /// Alias route used by `tunnel_alias_domain`: matches a wildcard or exact
    /// hostname (e.g. `*.nasrulgunawan.com`) and reverse-proxies to the same
    /// upstream port as the app's primary route. When `rewrite_host_to` is
    /// `Some(local_root)` Caddy also overrides the upstream `Host` header so
    /// multi-tenant apps that key on hostname keep working under the tunnel
    /// alias. The wildcard label is reused: e.g. `aus.nasrulgunawan.com` gets
    /// proxied with `Host: aus.<local_root>`.
    AliasReverseProxy {
        host: String,
        port: u16,
        rewrite_host_to: Option<String>,
        app_id: Option<String>,
        max_body: Option<u64>,
    },
}

/// HTTP Basic Auth credentials attached to a Caddy route. `password_hash` is
/// always a bcrypt hash; the plaintext is never stored.
#[derive(Debug, Clone)]
pub struct BasicAuth {
    pub username: String,
    pub password_hash: String,
}

/// Per-host override for the app-level Basic Auth default. Lets a single app
/// protect some of its hosts (e.g. `admin.foo.id`) with different — or no —
/// credentials than the rest. Hosts without an entry inherit the app default.
///
/// `mode`:
///   - `"off"`    → this host is public regardless of the app default.
///   - `"custom"` → use this entry's `username`/`password_hash` for this host.
/// (Absence of an entry, or any other value, means "inherit the app default".)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostAuthOverride {
    /// Fully resolved host this override applies to, e.g. `admin.sidiq.sch.id`.
    /// Matches the host Caddy routes on and the value shown in the UI list.
    pub host: String,
    pub mode: String,
    #[serde(default)]
    pub username: Option<String>,
    /// Bcrypt hash for `mode == "custom"`. Hidden from the frontend (mirrors
    /// the app-level `basic_auth_password_hash`); the repo persists it via an
    /// explicit JSON shape rather than this serializer.
    #[serde(default, skip_serializing)]
    pub password_hash: Option<String>,
    /// Runtime-only flag for the UI: true when a custom hash is stored.
    #[serde(default)]
    pub password_set: bool,
}

fn default_app_kind() -> String { "process".into() }

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct App {
    pub id: String,
    pub workspace_id: Option<String>,
    pub name: String,
    pub root_dir: String,
    pub port: u16,
    pub subdomain: Option<String>,
    pub start_command: String,
    pub start_command_source: String,
    pub status: String,
    pub pid: Option<u32>,
    pub env_file: Option<String>,
    pub auto_start: bool,
    /// "process" (default) — Porta spawns start_command and Caddy reverse-proxies to port.
    /// "static" — no process; Caddy serves files directly from root_dir.
    /// "docker" — Porta runs a docker container; Caddy reverse-proxies to port (host).
    #[serde(default = "default_app_kind")]
    pub kind: String,
    /// Docker image reference (e.g. "databasus/databasus:latest"). Required when kind="docker".
    #[serde(default)]
    pub docker_image: Option<String>,
    /// Container-internal port. Porta maps host `port` → this port.
    #[serde(default)]
    pub docker_container_port: Option<u16>,
    /// Extra `docker run` args (flags we don't have a dedicated field for). Optional.
    #[serde(default)]
    pub docker_args: Option<String>,
    /// Volume mounts in "source:target" format. Relative `source` paths
    /// (./foo, ../foo, or bare) are resolved against `root_dir` at start time.
    #[serde(default)]
    pub docker_volumes: Vec<String>,
    /// Path to `docker-compose.yml` for kind="compose". Relative paths resolve
    /// against `root_dir`.
    #[serde(default)]
    pub compose_file: Option<String>,
    /// If true, Porta attaches this app's container(s) to a shared workspace
    /// docker network (`porta-ws-<workspace_id>` or `porta-standalone`) so apps
    /// can reach each other via container names.
    #[serde(default)]
    pub network_share: bool,
    /// Cloudflare named tunnel to run this app through (id or name from
    /// `cloudflared tunnel list`). If set, Porta uses named-tunnel mode; if
    /// None, quick `trycloudflare.com` mode.
    #[serde(default)]
    pub tunnel_name: Option<String>,
    /// Display-only hostname the user expects traffic to arrive on (e.g.
    /// `myapp.example.com`). User must have routed DNS via `cloudflared tunnel
    /// route dns <name> <hostname>` once.
    #[serde(default)]
    pub tunnel_custom_hostname: Option<String>,
    // v0.2 additions
    pub env_vars: HashMap<String, String>,
    pub restart_policy: String,
    pub max_retries: u8,
    // dependency graph
    pub health_check_path: Option<String>,
    pub depends_on: Vec<String>,
    // multiple subdomains — additional hostnames that also route to this app's port
    #[serde(default)]
    pub extra_subdomains: Vec<String>,
    // optional custom domain — overrides workspace domain for this app
    #[serde(default)]
    pub custom_domain: Option<String>,
    // tunnel — tunnel_provider stored in DB (column added v0.3); others are
    // frontend-only runtime state.
    #[serde(default)]
    pub tunnel_provider: Option<String>,
    /// When true, starting the app also starts its tunnel.
    #[serde(default)]
    pub tunnel_auto_start: bool,
    #[serde(default)]
    pub tunnel_url: Option<String>,
    #[serde(default)]
    pub tunnel_active: bool,
    /// Extra port bindings — each gets its own Caddy route with a separate port.
    #[serde(default)]
    pub port_bindings: Vec<PortBinding>,
    /// Named environment profiles (e.g. "development", "staging", "test").
    #[serde(default)]
    pub env_profiles: Vec<EnvProfile>,
    /// ID of the active environment profile. If None, root-level env_file/env_vars are used.
    #[serde(default)]
    pub active_profile_id: Option<String>,
    /// When true, Caddy gates this app's routes with HTTP Basic Auth.
    #[serde(default)]
    pub basic_auth_enabled: bool,
    /// Username for Basic Auth. None when `basic_auth_enabled` is false or unset.
    #[serde(default)]
    pub basic_auth_username: Option<String>,
    /// Bcrypt hash of the Basic Auth password. Never serialized to the
    /// frontend — UI only receives `basic_auth_password_set` derived from
    /// `is_some()`. Set by repo at read time.
    #[serde(default, skip_serializing, skip_deserializing)]
    pub basic_auth_password_hash: Option<String>,
    /// Runtime-only: true if a hash is stored. Lets the UI render
    /// "Password set ✓ — leave blank to keep" without exposing the hash.
    #[serde(default)]
    pub basic_auth_password_set: bool,
    /// Per-host overrides of the app-level Basic Auth default. Only hosts that
    /// deviate from the default get an entry; see [`HostAuthOverride`].
    #[serde(default)]
    pub host_auth_overrides: Vec<HostAuthOverride>,
    /// Public alias hostname pattern this app should also be reachable at —
    /// used together with a Cloudflare tunnel to expose a multi-tenant app
    /// at `*.<public-domain>` while keeping its local routing intact. Stored
    /// verbatim, e.g. `*.nasrulgunawan.com` or `app.example.com`.
    #[serde(default)]
    pub tunnel_alias_domain: Option<String>,
    /// When true (default), Caddy rewrites the upstream `Host` header on
    /// alias-domain requests so the app sees its native domain (preserving
    /// the wildcard label). Disable when the app already accepts the alias
    /// domain natively in its tenant matcher.
    #[serde(default = "default_tunnel_alias_rewrite_host")]
    pub tunnel_alias_rewrite_host: bool,
    /// When true, Porta stops this app after `idle_timeout_secs` without HTTP
    /// traffic and transparently wakes it on the next request. Opt-in per app.
    #[serde(default)]
    pub auto_sleep_enabled: bool,
    /// Idle window before sleeping (seconds). Default 30 minutes.
    #[serde(default = "default_idle_timeout_secs")]
    pub idle_timeout_secs: u32,
    /// Runtime flag: true when the idle watcher put the app to sleep (vs. a
    /// manual stop). Drives the 💤 badge and tells the wake path it may start.
    #[serde(default)]
    pub auto_slept: bool,
    /// Max request body (bytes) Caddy accepts for this app's routes. `None`
    /// inherits the global default; `Some(0)` means unlimited. Uploads larger
    /// than the limit get a 413 from Caddy's `request_body` handler. Per-app
    /// override of the global `proxy_max_body_bytes` setting.
    #[serde(default)]
    pub max_upload_bytes: Option<u64>,
}

fn default_tunnel_alias_rewrite_host() -> bool { true }
fn default_idle_timeout_secs() -> u32 { 1800 }

impl App {
    /// The effective domain for this app: custom_domain if set, otherwise workspace domain,
    /// falling back to "narakarya.test" for standalone apps.
    pub fn effective_domain(&self, workspaces: &[Workspace]) -> String {
        if let Some(ref cd) = self.custom_domain {
            if !cd.is_empty() {
                return cd.clone();
            }
        }
        self.workspace_id
            .as_ref()
            .and_then(|wid| workspaces.iter().find(|w| &w.id == wid))
            .map(|w| w.domain.clone())
            .unwrap_or_else(|| "narakarya.test".into())
    }

    pub fn resolved_host(&self, workspaces: &[Workspace]) -> String {
        let domain = self.effective_domain(workspaces);
        let sub = self.subdomain.as_deref().unwrap_or(&self.name);
        if sub == "*" {
            format!("*.{}", domain)
        } else {
            format!("{}.{}", sub, domain)
        }
    }

    pub fn is_static(&self) -> bool {
        self.kind == "static"
    }

    pub fn is_docker(&self) -> bool {
        self.kind == "docker"
    }

    pub fn is_compose(&self) -> bool {
        self.kind == "compose"
    }

    /// Pure reverse-proxy: no folder, no managed process. Caddy fronts a
    /// service the user runs themselves (e.g. localhost:9832).
    pub fn is_proxy(&self) -> bool {
        self.kind == "proxy"
    }

    /// Name of the docker network this app joins when `network_share` is true.
    /// Workspace-scoped so apps in different workspaces stay isolated.
    pub fn workspace_network_name(&self) -> String {
        match &self.workspace_id {
            Some(ws) if !ws.is_empty() => format!("porta-ws-{}", ws),
            _ => "porta-standalone".into(),
        }
    }

    /// Returns all Caddy routes for this app. Static apps emit a single
    /// FileServer route per host (primary + extras) pointing at root_dir;
    /// process apps emit ReverseProxy routes for primary, extras, and each
    /// port binding.
    /// Basic Auth credentials to attach to this app's routes, or None if
    /// auth is disabled / incomplete (missing username or hash).
    pub fn route_auth(&self) -> Option<BasicAuth> {
        if !self.basic_auth_enabled {
            return None;
        }
        let user = self.basic_auth_username.as_deref()?.trim();
        let hash = self.basic_auth_password_hash.as_deref()?;
        if user.is_empty() || hash.is_empty() {
            return None;
        }
        Some(BasicAuth { username: user.to_string(), password_hash: hash.to_string() })
    }

    /// Basic Auth for a specific resolved host, honoring per-host overrides:
    ///   - override `mode == "off"`    → no auth (host stays public).
    ///   - override `mode == "custom"` → that host's own credentials (falls
    ///     back to the app default if the custom entry is incomplete).
    ///   - no override (or any other mode) → the app-level default.
    fn route_auth_for(&self, host: &str) -> Option<BasicAuth> {
        match self.host_auth_overrides.iter().find(|o| o.host == host) {
            Some(o) if o.mode == "off" => None,
            Some(o) if o.mode == "custom" => {
                let user = o.username.as_deref().unwrap_or("").trim();
                let hash = o.password_hash.as_deref().unwrap_or("");
                if user.is_empty() || hash.is_empty() {
                    // Incomplete custom entry — don't silently leave the host
                    // open; fall back to the app default.
                    self.route_auth()
                } else {
                    Some(BasicAuth { username: user.to_string(), password_hash: hash.to_string() })
                }
            }
            _ => self.route_auth(),
        }
    }

    pub fn all_routes(&self, workspaces: &[Workspace]) -> Vec<Route> {
        let domain = self.effective_domain(workspaces);
        // Auth is resolved per host (see `route_auth_for`) so individual hosts
        // can override the app-level default — protect `admin.*` only, leave
        // others public, etc.
        let app_id = Some(self.id.clone());
        let mut routes = Vec::new();

        if self.is_static() {
            // Primary host
            let host = self.resolved_host(workspaces);
            routes.push(Route::FileServer {
                auth: self.route_auth_for(&host),
                host,
                root: self.root_dir.clone(),
                app_id: app_id.clone(),
                max_body: self.max_upload_bytes,
            });
            // Extra subdomains (also serve same folder)
            for sub in &self.extra_subdomains {
                let trimmed = sub.trim();
                if !trimmed.is_empty() {
                    let host = format!("{}.{}", trimmed, domain);
                    routes.push(Route::FileServer {
                        auth: self.route_auth_for(&host),
                        host,
                        root: self.root_dir.clone(),
                        app_id: app_id.clone(),
                        max_body: self.max_upload_bytes,
                    });
                }
            }
            // port_bindings are not meaningful for static apps — skip
            return routes;
        }

        // Primary binding
        let primary_host = self.resolved_host(workspaces);
        routes.push(Route::ReverseProxy {
            auth: self.route_auth_for(&primary_host),
            host: primary_host,
            port: self.port,
            app_id: app_id.clone(),
            max_body: self.max_upload_bytes,
        });

        // Extra subdomains (existing feature — all map to primary port)
        for sub in &self.extra_subdomains {
            let trimmed = sub.trim();
            if !trimmed.is_empty() {
                let host = format!("{}.{}", trimmed, domain);
                routes.push(Route::ReverseProxy {
                    auth: self.route_auth_for(&host),
                    host,
                    port: self.port,
                    app_id: app_id.clone(),
                    max_body: self.max_upload_bytes,
                });
            }
        }

        // Port bindings (each has its own port)
        for binding in &self.port_bindings {
            let binding_domain = binding.custom_domain.as_deref()
                .filter(|d| !d.is_empty())
                .unwrap_or(&domain);
            let fallback_sub = binding.label.to_lowercase().replace(' ', "-");
            let sub = binding.subdomain.as_deref()
                .filter(|s| !s.is_empty())
                .unwrap_or(&fallback_sub);
            let host = format!("{}.{}", sub, binding_domain);
            routes.push(Route::ReverseProxy {
                auth: self.route_auth_for(&host),
                host,
                port: binding.port,
                app_id: app_id.clone(),
                max_body: self.max_upload_bytes,
            });
        }

        // Public alias hostname — for apps exposed through a Cloudflare
        // tunnel under a different domain. Caddy gets a parallel route that
        // matches the alias pattern; if the rewrite toggle is on, the
        // upstream sees the local domain so multi-tenant matchers keep
        // working unchanged.
        if let Some(alias) = self.tunnel_alias_domain.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            let rewrite = if self.tunnel_alias_rewrite_host {
                Some(domain.clone())
            } else {
                None
            };
            routes.push(Route::AliasReverseProxy {
                host: alias.to_string(),
                port: self.port,
                rewrite_host_to: rewrite,
                app_id: app_id.clone(),
                max_body: self.max_upload_bytes,
            });
        }

        routes
    }

    /// Public DNS base derived from `tunnel_custom_hostname` — the registrable
    /// domain (eTLD+1) per the Public Suffix List. Used to project extras and
    /// port_bindings onto the public side as siblings of the primary, e.g.:
    ///   primary `app.example.com` + extra `admin` → `admin.example.com`
    ///   primary `example.com`     + extra `admin` → `admin.example.com`
    ///   primary `www.sidiq.sch.id`+ extra `admin` → `admin.sidiq.sch.id`
    ///   primary `sidiq.sch.id`    + extra `admin` → `admin.sidiq.sch.id`
    ///
    /// Naive `split_once('.')` fails for ccTLD SLDs like `sch.id` / `co.uk` —
    /// stripping the first label of `sidiq.sch.id` leaves `sch.id` (a public
    /// suffix), so extras would land on a TLD instead of the user's domain.
    /// PSL handles this correctly. Returns None if no hostname is set.
    pub fn tunnel_public_base(&self) -> Option<String> {
        let host = self.tunnel_custom_hostname.as_deref()?.trim();
        if host.is_empty() {
            return None;
        }
        psl::domain_str(host).map(|d| d.to_string())
    }

    /// Pairs of (public_hostname, local_hostname_for_caddy) that this app should
    /// expose through a Cloudflare named tunnel. Each local host MUST have a
    /// corresponding Caddy route — that's what we send the host header as so
    /// Caddy can route the request locally.
    ///
    /// Empty primary hostname → empty list (caller falls back to legacy path).
    /// Wildcard primary subdomain (`*`) → only the primary entry, since extras
    /// would already be covered by the wildcard locally but need explicit DNS
    /// records on the public side.
    pub fn tunnel_public_hostnames(&self, workspaces: &[Workspace]) -> Vec<(String, String)> {
        let primary_public = match self.tunnel_custom_hostname.as_deref() {
            Some(h) if !h.trim().is_empty() => h.trim().to_string(),
            _ => return Vec::new(),
        };
        let primary_local = self.resolved_host(workspaces);
        let mut out = vec![(primary_public.clone(), primary_local)];

        // Extras + port_bindings need a base to project onto. If the primary
        // hostname has no dot we can't derive one — skip extras entirely.
        let base = match self.tunnel_public_base() {
            Some(b) => b,
            None => return out,
        };
        let local_domain = self.effective_domain(workspaces);

        for sub in &self.extra_subdomains {
            let trimmed = sub.trim();
            if trimmed.is_empty() {
                continue;
            }
            out.push((
                format!("{}.{}", trimmed, base),
                format!("{}.{}", trimmed, local_domain),
            ));
        }

        for binding in &self.port_bindings {
            let local_domain_for_binding = binding.custom_domain.as_deref()
                .filter(|d| !d.is_empty())
                .unwrap_or(&local_domain);
            let fallback_sub = binding.label.to_lowercase().replace(' ', "-");
            let sub = binding.subdomain.as_deref()
                .filter(|s| !s.is_empty())
                .unwrap_or(&fallback_sub);
            out.push((
                format!("{}.{}", sub, base),
                format!("{}.{}", sub, local_domain_for_binding),
            ));
        }

        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app_with_hostname(hostname: Option<&str>) -> App {
        App {
            id: "t".into(),
            workspace_id: None,
            name: "t".into(),
            root_dir: "/".into(),
            port: 1,
            subdomain: None,
            start_command: String::new(),
            start_command_source: "manual".into(),
            status: "stopped".into(),
            pid: None,
            env_file: None,
            auto_start: false,
            kind: "process".into(),
            docker_image: None,
            docker_container_port: None,
            docker_args: None,
            docker_volumes: vec![],
            compose_file: None,
            network_share: false,
            tunnel_name: None,
            tunnel_custom_hostname: hostname.map(String::from),
            env_vars: HashMap::new(),
            restart_policy: "on-failure".into(),
            max_retries: 3,
            health_check_path: None,
            depends_on: vec![],
            extra_subdomains: vec![],
            custom_domain: None,
            tunnel_provider: None,
            tunnel_auto_start: false,
            tunnel_url: None,
            tunnel_active: false,
            port_bindings: vec![],
            env_profiles: vec![],
            active_profile_id: None,
            basic_auth_enabled: false,
            basic_auth_username: None,
            basic_auth_password_hash: None,
            basic_auth_password_set: false,
            host_auth_overrides: vec![],
            tunnel_alias_domain: None,
            tunnel_alias_rewrite_host: true, auto_sleep_enabled: false, idle_timeout_secs: 1800, auto_slept: false, max_upload_bytes: None,
        }
    }

    #[test]
    fn per_host_auth_overrides_default_off_and_custom() {
        let mut a = app_with_hostname(None);
        a.subdomain = Some("app".into());
        a.custom_domain = Some("example.com".into());
        a.extra_subdomains = vec!["admin".into(), "secret".into()];
        // App-level default protects everything.
        a.basic_auth_enabled = true;
        a.basic_auth_username = Some("default-user".into());
        a.basic_auth_password_hash = Some("default-hash".into());
        a.host_auth_overrides = vec![
            // admin host opts out entirely.
            HostAuthOverride { host: "admin.example.com".into(), mode: "off".into(), username: None, password_hash: None, password_set: false },
            // secret host uses its own credentials.
            HostAuthOverride { host: "secret.example.com".into(), mode: "custom".into(), username: Some("vip".into()), password_hash: Some("vip-hash".into()), password_set: true },
        ];

        // Primary inherits the default.
        let primary = a.route_auth_for("app.example.com").expect("primary protected");
        assert_eq!(primary.username, "default-user");
        assert_eq!(primary.password_hash, "default-hash");
        // admin is public.
        assert!(a.route_auth_for("admin.example.com").is_none());
        // secret uses its own creds.
        let secret = a.route_auth_for("secret.example.com").expect("secret protected");
        assert_eq!(secret.username, "vip");
        assert_eq!(secret.password_hash, "vip-hash");

        // all_routes wires the same per-host auth into each Route.
        let routes = a.all_routes(&[]);
        let auth_for = |host: &str| routes.iter().find_map(|r| match r {
            Route::ReverseProxy { host: h, auth, .. } if h == host => Some(auth.clone()),
            _ => None,
        }).unwrap();
        assert!(auth_for("app.example.com").is_some());
        assert!(auth_for("admin.example.com").is_none());
        assert_eq!(auth_for("secret.example.com").unwrap().username, "vip");
    }

    #[test]
    fn per_host_custom_falls_back_to_default_when_incomplete() {
        let mut a = app_with_hostname(None);
        a.subdomain = Some("app".into());
        a.custom_domain = Some("example.com".into());
        a.basic_auth_enabled = true;
        a.basic_auth_username = Some("default-user".into());
        a.basic_auth_password_hash = Some("default-hash".into());
        // Custom mode but no hash → must not silently leave the host open.
        a.host_auth_overrides = vec![
            HostAuthOverride { host: "app.example.com".into(), mode: "custom".into(), username: Some("vip".into()), password_hash: None, password_set: false },
        ];
        let auth = a.route_auth_for("app.example.com").expect("falls back to default");
        assert_eq!(auth.username, "default-user");
    }

    #[test]
    fn tunnel_public_base_subdomain_under_simple_tld() {
        let a = app_with_hostname(Some("app.example.com"));
        assert_eq!(a.tunnel_public_base().as_deref(), Some("example.com"));
    }

    #[test]
    fn tunnel_public_base_apex_under_simple_tld() {
        let a = app_with_hostname(Some("example.com"));
        assert_eq!(a.tunnel_public_base().as_deref(), Some("example.com"));
    }

    #[test]
    fn tunnel_public_base_subdomain_under_cctld_sld() {
        let a = app_with_hostname(Some("www.sidiq.sch.id"));
        assert_eq!(a.tunnel_public_base().as_deref(), Some("sidiq.sch.id"));
    }

    #[test]
    fn tunnel_public_base_apex_under_cctld_sld() {
        let a = app_with_hostname(Some("sidiq.sch.id"));
        assert_eq!(a.tunnel_public_base().as_deref(), Some("sidiq.sch.id"));
    }

    #[test]
    fn tunnel_public_base_co_uk() {
        let a = app_with_hostname(Some("foo.example.co.uk"));
        assert_eq!(a.tunnel_public_base().as_deref(), Some("example.co.uk"));
    }

    #[test]
    fn tunnel_public_base_none_when_unset() {
        let a = app_with_hostname(None);
        assert_eq!(a.tunnel_public_base(), None);
    }

    #[test]
    fn tunnel_public_base_none_when_blank() {
        let a = app_with_hostname(Some("   "));
        assert_eq!(a.tunnel_public_base(), None);
    }

    /// Proxy apps must emit a `ReverseProxy` route to the upstream port —
    /// not a `FileServer` (which would 404 trying to serve files from an
    /// empty `root_dir`).
    #[test]
    fn proxy_app_emits_reverse_proxy_route_with_no_folder() {
        let mut a = app_with_hostname(None);
        a.kind = "proxy".into();
        a.root_dir = String::new();
        a.port = 9832;
        a.subdomain = Some("upstream".into());
        let ws = vec![Workspace {
            id: "w".into(),
            name: "uq".into(),
            domain: "uq.test".into(),
            deployment: None,
        }];
        a.workspace_id = Some("w".into());

        let routes = a.all_routes(&ws);
        assert_eq!(routes.len(), 1);
        match &routes[0] {
            Route::ReverseProxy { host, port, .. } => {
                assert_eq!(host, "upstream.uq.test");
                assert_eq!(*port, 9832);
            }
            Route::FileServer { .. } => panic!("expected ReverseProxy, got FileServer"),
            Route::AliasReverseProxy { .. } => panic!("expected ReverseProxy, got AliasReverseProxy"),
        }
    }

    /// Regression for the apex-domain bug where extras landed on the public
    /// suffix (e.g. `admin.sch.id`) instead of the user's registrable domain.
    #[test]
    fn tunnel_extras_project_correctly_under_apex() {
        let mut a = app_with_hostname(Some("sidiq.sch.id"));
        a.subdomain = Some("sidiq".into());
        a.extra_subdomains = vec!["admin".into(), "platform".into()];
        let ws = vec![Workspace {
            id: "w".into(),
            name: "uq".into(),
            domain: "uq.test".into(),
            deployment: None,
        }];
        a.workspace_id = Some("w".into());

        let pairs = a.tunnel_public_hostnames(&ws);
        let publics: Vec<&str> = pairs.iter().map(|(p, _)| p.as_str()).collect();
        assert_eq!(
            publics,
            vec!["sidiq.sch.id", "admin.sidiq.sch.id", "platform.sidiq.sch.id"]
        );
    }
}
