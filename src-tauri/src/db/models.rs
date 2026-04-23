use std::collections::HashMap;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomDeployCmd {
    pub id: String,
    pub label: String,
    pub args: Vec<String>,
    pub interactive: bool,
}

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
#[derive(Debug, Clone)]
pub enum Route {
    ReverseProxy { host: String, port: u16 },
    FileServer { host: String, root: String },
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
    // tunnel — frontend-only state, not stored in DB
    #[serde(default)]
    pub tunnel_provider: Option<String>,
    #[serde(default)]
    pub tunnel_url: Option<String>,
    #[serde(default)]
    pub tunnel_active: bool,
    /// Computed at runtime (not stored in DB). Set by list_apps to the first
    /// deploy.yml found under the app's root_dir.
    #[serde(default)]
    pub deploy_config_path: Option<String>,
    /// User-defined custom deploy commands, stored as JSON in DB.
    #[serde(default)]
    pub deploy_custom_commands: Vec<CustomDeployCmd>,
    /// Extra port bindings — each gets its own Caddy route with a separate port.
    #[serde(default)]
    pub port_bindings: Vec<PortBinding>,
    /// Named environment profiles (e.g. "development", "staging", "test").
    #[serde(default)]
    pub env_profiles: Vec<EnvProfile>,
    /// ID of the active environment profile. If None, root-level env_file/env_vars are used.
    #[serde(default)]
    pub active_profile_id: Option<String>,
}

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
    pub fn all_routes(&self, workspaces: &[Workspace]) -> Vec<Route> {
        let domain = self.effective_domain(workspaces);
        let mut routes = Vec::new();

        if self.is_static() {
            // Primary host
            routes.push(Route::FileServer {
                host: self.resolved_host(workspaces),
                root: self.root_dir.clone(),
            });
            // Extra subdomains (also serve same folder)
            for sub in &self.extra_subdomains {
                let trimmed = sub.trim();
                if !trimmed.is_empty() {
                    routes.push(Route::FileServer {
                        host: format!("{}.{}", trimmed, domain),
                        root: self.root_dir.clone(),
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
        });

        // Extra subdomains (existing feature — all map to primary port)
        for sub in &self.extra_subdomains {
            let trimmed = sub.trim();
            if !trimmed.is_empty() {
                routes.push(Route::ReverseProxy {
                    host: format!("{}.{}", trimmed, domain),
                    port: self.port,
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
            });
        }

        routes
    }
}
