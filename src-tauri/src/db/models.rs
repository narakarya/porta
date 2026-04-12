use std::collections::HashMap;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub domain: String,
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
}
