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

    /// Returns all (hostname, port) routes for this app — primary binding,
    /// extra subdomains (mapped to the primary port), and port bindings
    /// (each with its own port).
    pub fn all_routes(&self, workspaces: &[Workspace]) -> Vec<(String, u16)> {
        let domain = self.effective_domain(workspaces);
        let mut routes = Vec::new();

        // Primary binding
        routes.push((self.resolved_host(workspaces), self.port));

        // Extra subdomains (existing feature — all map to primary port)
        for sub in &self.extra_subdomains {
            let trimmed = sub.trim();
            if !trimmed.is_empty() {
                routes.push((format!("{}.{}", trimmed, domain), self.port));
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
            routes.push((format!("{}.{}", sub, binding_domain), binding.port));
        }

        routes
    }
}
