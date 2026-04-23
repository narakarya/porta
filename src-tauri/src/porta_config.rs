use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::db::models::{App, Workspace};

// ── Portable config types ────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct PortaConfig {
    pub version: u32,
    pub workspace: PortaWorkspaceConfig,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PortaWorkspaceConfig {
    pub name: String,
    pub domain: String,
    pub apps: Vec<PortaAppConfig>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PortaAppConfig {
    pub name: String,
    pub root_dir: String,
    pub port: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subdomain: Option<String>,
    pub start_command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env_file: Option<String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub env_vars: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub depends_on: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub health_check_path: Option<String>,
}

// ── Export ────────────────────────────────────────────────────────────────────

/// Serialize a workspace and its apps to YAML. Absolute root_dirs are converted
/// to paths relative to `base_dir` (the directory containing .porta.yml).
pub fn export_config(
    workspace: &Workspace,
    apps: &[App],
    base_dir: &Path,
) -> Result<String> {
    let app_configs: Vec<PortaAppConfig> = apps
        .iter()
        .map(|app| {
            let relative = make_relative(&app.root_dir, base_dir);
            // Resolve depends_on IDs to app names for portability
            let depends_on_names: Vec<String> = app
                .depends_on
                .iter()
                .filter_map(|dep_id| apps.iter().find(|a| a.id == *dep_id).map(|a| a.name.clone()))
                .collect();

            PortaAppConfig {
                name: app.name.clone(),
                root_dir: relative,
                port: app.port,
                subdomain: app.subdomain.clone(),
                start_command: app.start_command.clone(),
                env_file: app.env_file.clone(),
                env_vars: app.env_vars.clone(),
                depends_on: depends_on_names,
                health_check_path: app.health_check_path.clone(),
            }
        })
        .collect();

    let config = PortaConfig {
        version: 1,
        workspace: PortaWorkspaceConfig {
            name: workspace.name.clone(),
            domain: workspace.domain.clone(),
            apps: app_configs,
        },
    };

    serde_yaml::to_string(&config).context("failed to serialize porta config to YAML")
}

// ── Parse ────────────────────────────────────────────────────────────────────

/// Parse a .porta.yml string. Relative root_dirs are resolved to absolute paths
/// using `base_dir` (the directory containing the .porta.yml file).
pub fn parse_config(yaml_str: &str, base_dir: &Path) -> Result<PortaConfig> {
    let mut config: PortaConfig =
        serde_yaml::from_str(yaml_str).context("failed to parse porta config YAML")?;

    for app in &mut config.workspace.apps {
        let resolved = base_dir.join(&app.root_dir);
        app.root_dir = resolved
            .canonicalize()
            .unwrap_or(resolved)
            .to_string_lossy()
            .into_owned();
    }

    Ok(config)
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/// Convert an absolute path to a relative one from `base`. Falls back to the
/// original path string if relativisation fails (e.g. different volume roots on
/// Windows).
fn make_relative(abs: &str, base: &Path) -> String {
    let abs_path = PathBuf::from(abs);
    pathdiff::diff_paths(&abs_path, base)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| abs.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn sample_workspace() -> Workspace {
        Workspace {
            id: "ws1".into(),
            name: "My Project".into(),
            domain: "myproject.test".into(),
            deployment: None,
        }
    }

    fn sample_apps() -> Vec<App> {
        vec![
            App {
                id: "a1".into(),
                workspace_id: Some("ws1".into()),
                name: "api".into(),
                root_dir: "/home/user/projects/myproject/api".into(),
                port: 4000,
                subdomain: Some("api".into()),
                start_command: "mix phx.server".into(),
                start_command_source: "auto".into(),
                status: "stopped".into(),
                pid: None,
                env_file: None,
                auto_start: false,
                env_vars: HashMap::new(),
                restart_policy: "on-failure".into(),
                max_retries: 3,
                health_check_path: Some("/health".into()),
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
                kind: "process".into(),
                docker_image: None,
                docker_container_port: None,
                docker_args: None,
                docker_volumes: vec![],
                compose_file: None,
                network_share: false,
                tunnel_name: None,
                tunnel_custom_hostname: None,
            },
            App {
                id: "a2".into(),
                workspace_id: Some("ws1".into()),
                name: "web".into(),
                root_dir: "/home/user/projects/myproject/web".into(),
                port: 3000,
                subdomain: None,
                start_command: "npm run dev".into(),
                start_command_source: "auto".into(),
                status: "stopped".into(),
                pid: None,
                env_file: Some(".env.local".into()),
                auto_start: false,
                env_vars: {
                    let mut m = HashMap::new();
                    m.insert("API_URL".into(), "http://localhost:4000".into());
                    m
                },
                restart_policy: "on-failure".into(),
                max_retries: 3,
                health_check_path: None,
                depends_on: vec!["a1".into()], // depends on api by ID
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
                kind: "process".into(),
                docker_image: None,
                docker_container_port: None,
                docker_args: None,
                docker_volumes: vec![],
                compose_file: None,
                network_share: false,
                tunnel_name: None,
                tunnel_custom_hostname: None,
            },
        ]
    }

    #[test]
    fn test_export_and_parse_round_trip() {
        let ws = sample_workspace();
        let apps = sample_apps();
        let base = Path::new("/home/user/projects/myproject");

        let yaml = export_config(&ws, &apps, base).unwrap();

        // Should contain relative paths
        assert!(yaml.contains("root_dir: api"));
        assert!(yaml.contains("root_dir: web"));
        // depends_on should use names, not IDs
        assert!(yaml.contains("api"));

        let parsed = parse_config(&yaml, base).unwrap();
        assert_eq!(parsed.version, 1);
        assert_eq!(parsed.workspace.name, "My Project");
        assert_eq!(parsed.workspace.apps.len(), 2);
        // root_dirs should be resolved back to absolute (or attempted)
        assert!(parsed.workspace.apps[0].root_dir.contains("myproject"));
    }

    #[test]
    fn test_make_relative() {
        let base = Path::new("/home/user/projects");
        assert_eq!(make_relative("/home/user/projects/api", base), "api");
        assert_eq!(
            make_relative("/home/user/projects/deep/nested", base),
            "deep/nested"
        );
    }
}
