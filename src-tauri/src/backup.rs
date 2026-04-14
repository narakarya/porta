use anyhow::Result;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

use crate::db::models::{App, PortBinding, Workspace};

#[derive(Debug, Serialize, Deserialize)]
pub struct PortaFile {
    pub version: u32,
    pub exported_at: String,
    pub workspaces: Vec<Workspace>,
    pub apps: Vec<AppExport>,
    pub port_registry: Vec<PortEntry>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AppExport {
    pub id: String,
    pub workspace_id: Option<String>,
    pub name: String,
    pub root_dir: String,
    pub port: u16,
    pub subdomain: Option<String>,
    pub start_command: String,
    pub start_command_source: String,
    #[serde(default)]
    pub extra_subdomains: Vec<String>,
    #[serde(default)]
    pub custom_domain: Option<String>,
    #[serde(default)]
    pub port_bindings: Vec<PortBinding>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PortEntry {
    pub port: u16,
    pub app_id: String,
}

impl From<&App> for AppExport {
    fn from(a: &App) -> Self {
        AppExport {
            id: a.id.clone(),
            workspace_id: a.workspace_id.clone(),
            name: a.name.clone(),
            root_dir: a.root_dir.clone(),
            port: a.port,
            subdomain: a.subdomain.clone(),
            start_command: a.start_command.clone(),
            start_command_source: a.start_command_source.clone(),
            extra_subdomains: a.extra_subdomains.clone(),
            custom_domain: a.custom_domain.clone(),
            port_bindings: a.port_bindings.clone(),
        }
    }
}

pub fn backup_dir() -> PathBuf {
    crate::porta_dir().join("backups")
}

pub fn auto_backup(db_path: &Path) -> Result<()> {
    let dir = backup_dir();
    fs::create_dir_all(&dir)?;

    let stamp = Utc::now().format("%Y%m%d_%H%M%S").to_string();
    fs::copy(db_path, dir.join(format!("{}.db", stamp)))?;

    // Keep newest 10 snapshots
    let mut entries: Vec<_> = fs::read_dir(&dir)?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().is_some_and(|x| x == "db"))
        .collect();
    entries.sort_by_key(|e| e.file_name());
    entries.reverse();
    for old in entries.iter().skip(10) {
        let _ = fs::remove_file(old.path());
    }
    Ok(())
}

pub fn export(workspaces: &[Workspace], apps: &[App]) -> Result<String> {
    let file = PortaFile {
        version: 1,
        exported_at: Utc::now().to_rfc3339(),
        workspaces: workspaces.to_vec(),
        apps: apps.iter().map(AppExport::from).collect(),
        port_registry: apps
            .iter()
            .map(|a| PortEntry { port: a.port, app_id: a.id.clone() })
            .collect(),
    };
    Ok(serde_json::to_string_pretty(&file)?)
}

pub fn parse_import(json: &str) -> Result<PortaFile> {
    let file: PortaFile = serde_json::from_str(json)?;
    if file.version != 1 {
        return Err(anyhow::anyhow!("Unsupported .porta version: {}", file.version));
    }
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::models::{App, Workspace};

    fn sample_workspace() -> Workspace {
        Workspace { id: "w1".into(), name: "Test".into(), domain: "test.test".into(), deployment: None }
    }

    fn sample_app() -> App {
        App {
            id: "a1".into(),
            workspace_id: Some("w1".into()),
            name: "api".into(),
            root_dir: "/tmp".into(),
            port: 4001,
            subdomain: None,
            start_command: "mix phx.server".into(),
            start_command_source: "auto".into(),
            status: "stopped".into(),
            pid: None,
            env_file: None,
            auto_start: false,
            env_vars: std::collections::HashMap::new(),
            restart_policy: "on-failure".into(),
            max_retries: 3,
            health_check_path: None,
            depends_on: vec![],
            extra_subdomains: vec![],
            custom_domain: None,
            tunnel_provider: None,
            tunnel_url: None,
            tunnel_active: false,
            deploy_config_path: None,
            deploy_custom_commands: vec![],
            port_bindings: vec![],
            env_profiles: vec![],
            active_profile_id: None,
        }
    }

    #[test]
    fn test_export_round_trip() {
        let json = export(&[sample_workspace()], &[sample_app()]).unwrap();
        let parsed = parse_import(&json).unwrap();
        assert_eq!(parsed.workspaces.len(), 1);
        assert_eq!(parsed.apps[0].name, "api");
    }

    #[test]
    fn test_parse_import_rejects_bad_version() {
        let json =
            r#"{"version":99,"exported_at":"","workspaces":[],"apps":[],"port_registry":[]}"#;
        assert!(parse_import(json).is_err());
    }

    #[test]
    fn test_export_excludes_runtime_state() {
        let json = export(&[], &[sample_app()]).unwrap();
        assert!(!json.contains("\"status\""));
        assert!(!json.contains("\"pid\""));
    }
}
