use std::collections::HashMap;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomDeployCmd {
    pub id: String,
    pub label: String,
    pub args: Vec<String>,
    pub interactive: bool,
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
}

impl App {
    pub fn resolved_host(&self, workspaces: &[Workspace]) -> String {
        let domain = self
            .workspace_id
            .as_ref()
            .and_then(|wid| workspaces.iter().find(|w| &w.id == wid))
            .map(|w| w.domain.as_str())
            .unwrap_or("narakarya.test");
        let sub = self.subdomain.as_deref().unwrap_or(&self.name);
        if sub == "*" {
            format!("*.{}", domain)
        } else {
            format!("{}.{}", sub, domain)
        }
    }

    /// Returns all hostnames for this app — primary plus any extra subdomains.
    /// Used by Caddy sync to register every hostname that should route to this port.
    pub fn all_hosts(&self, workspaces: &[Workspace]) -> Vec<String> {
        let domain = self
            .workspace_id
            .as_ref()
            .and_then(|wid| workspaces.iter().find(|w| &w.id == wid))
            .map(|w| w.domain.as_str())
            .unwrap_or("narakarya.test");

        let mut hosts = vec![self.resolved_host(workspaces)];
        for sub in &self.extra_subdomains {
            let trimmed = sub.trim();
            if !trimmed.is_empty() {
                hosts.push(format!("{}.{}", trimmed, domain));
            }
        }
        hosts
    }
}
