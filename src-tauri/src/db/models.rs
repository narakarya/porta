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
    ReverseProxy { host: String, port: u16, auth: Option<BasicAuth>, app_id: Option<String> },
    FileServer { host: String, root: String, auth: Option<BasicAuth>, app_id: Option<String> },
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
    },
}

/// HTTP Basic Auth credentials attached to a Caddy route. `password_hash` is
/// always a bcrypt hash; the plaintext is never stored.
#[derive(Debug, Clone)]
pub struct BasicAuth {
    pub username: String,
    pub password_hash: String,
}

fn default_app_kind() -> String { "process".into() }

#[derive(Debug, Clone, Serialize, Deserialize)]
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
}

fn default_tunnel_alias_rewrite_host() -> bool { true }

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

    pub fn all_routes(&self, workspaces: &[Workspace]) -> Vec<Route> {
        let domain = self.effective_domain(workspaces);
        let auth = self.route_auth();
        let app_id = Some(self.id.clone());
        let mut routes = Vec::new();

        if self.is_static() {
            // Primary host
            routes.push(Route::FileServer {
                host: self.resolved_host(workspaces),
                root: self.root_dir.clone(),
                auth: auth.clone(),
                app_id: app_id.clone(),
            });
            // Extra subdomains (also serve same folder)
            for sub in &self.extra_subdomains {
                let trimmed = sub.trim();
                if !trimmed.is_empty() {
                    routes.push(Route::FileServer {
                        host: format!("{}.{}", trimmed, domain),
                        root: self.root_dir.clone(),
                        auth: auth.clone(),
                        app_id: app_id.clone(),
                    });
                }
            }
            // port_bindings are not meaningful for static apps — skip
            return routes;
        }

        // Primary binding
        routes.push(Route::ReverseProxy {
            host: self.resolved_host(workspaces),
            port: self.port,
            auth: auth.clone(),
            app_id: app_id.clone(),
        });

        // Extra subdomains (existing feature — all map to primary port)
        for sub in &self.extra_subdomains {
            let trimmed = sub.trim();
            if !trimmed.is_empty() {
                routes.push(Route::ReverseProxy {
                    host: format!("{}.{}", trimmed, domain),
                    port: self.port,
                    auth: auth.clone(),
                    app_id: app_id.clone(),
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
            routes.push(Route::ReverseProxy {
                host: format!("{}.{}", sub, binding_domain),
                port: binding.port,
                auth: auth.clone(),
                app_id: app_id.clone(),
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
            tunnel_alias_domain: None,
            tunnel_alias_rewrite_host: true,
        }
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
