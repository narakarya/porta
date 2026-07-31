use std::path::Path;

use serde::Serialize;
use tauri::State;
use uuid::Uuid;

use crate::app_state::AppState;
use crate::db::models::App;
use crate::port_scanner::find_available_port;
use crate::porta_config::{self, PortaAppConfig, PortaConfig};
use super::setup::sync_caddy;

#[tauri::command]
pub fn export_porta_config(
    state: State<AppState>,
    workspace_id: String,
    dest_path: String,
) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    let workspaces = db.list_workspaces().map_err(|e| e.to_string())?;
    let workspace = workspaces
        .iter()
        .find(|w| w.id == workspace_id)
        .ok_or_else(|| format!("workspace {} not found", workspace_id))?;

    let all_apps = db.list_apps().map_err(|e| e.to_string())?;
    let ws_apps: Vec<_> = all_apps
        .iter()
        .filter(|a| a.workspace_id.as_deref() == Some(&workspace_id))
        .cloned()
        .collect();

    let dest = Path::new(&dest_path);
    let base_dir = dest
        .parent()
        .ok_or_else(|| "invalid destination path".to_string())?;

    let yaml = porta_config::export_config(workspace, &ws_apps, base_dir)
        .map_err(|e| e.to_string())?;

    std::fs::write(dest, yaml).map_err(|e| format!("failed to write file: {}", e))?;
    Ok(())
}

// ── Adopt ────────────────────────────────────────────────────────────────────

/// What Porta intends to do with one app in a config, decided before anything
/// is written so the UI can show it and the user can back out.
#[derive(Serialize, Clone)]
pub struct AdoptAppPreview {
    pub name: String,
    pub root_dir: String,
    /// The port the config asks for — shown even when it is taken, so the
    /// reassignment reads as a change rather than an arbitrary number.
    pub port: u16,
    pub start_command: String,
    /// `new` | `port_taken` | `duplicate`
    pub status: String,
    /// Where Porta would move a taken port. `None` means the whole 3000-9999
    /// range is spoken for, and the app can only be skipped.
    pub suggested_port: Option<u16>,
    /// For `duplicate`: the app already registered against this folder.
    pub existing_app: Option<String>,
}

#[derive(Serialize)]
pub struct AdoptPreview {
    pub config_path: String,
    pub workspace_name: String,
    pub workspace_domain: String,
    /// A workspace already on this domain. Adopting into it is the sane
    /// default — re-importing a repo you already set up should not leave two
    /// workspaces answering for the same hostnames.
    pub existing_workspace_id: Option<String>,
    pub existing_workspace_name: Option<String>,
    pub apps: Vec<AdoptAppPreview>,
}

#[derive(Serialize)]
pub struct SkippedApp {
    pub name: String,
    pub reason: String,
}

#[derive(Serialize)]
pub struct ImportSummary {
    pub workspace_id: String,
    pub workspace_name: String,
    /// Names of the apps that were created, in config order.
    pub imported: Vec<String>,
    /// Everything that did not make it, with why. Import used to drop these
    /// silently, which read as "nothing happened" when a single port clashed.
    pub skipped: Vec<SkippedApp>,
}

/// Does this folder ship a Porta config? Returns its path so the caller can
/// preview it without re-deriving the filename.
#[tauri::command]
pub fn detect_porta_config(dir: String) -> Option<String> {
    porta_config::find_in_dir(Path::new(&dir)).map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn preview_porta_config(
    state: State<AppState>,
    src_path: String,
) -> Result<AdoptPreview, String> {
    let config = read_config(&src_path)?;

    let db = state.db.lock().unwrap();
    let workspaces = db.list_workspaces().map_err(|e| e.to_string())?;
    let existing_apps = db.list_apps().map_err(|e| e.to_string())?;
    let used_ports = db.used_ports().map_err(|e| e.to_string())?;
    drop(db);

    let existing = workspaces
        .iter()
        .find(|w| w.domain.eq_ignore_ascii_case(&config.workspace.domain));

    Ok(AdoptPreview {
        config_path: src_path,
        workspace_name: config.workspace.name.clone(),
        workspace_domain: config.workspace.domain.clone(),
        existing_workspace_id: existing.map(|w| w.id.clone()),
        existing_workspace_name: existing.map(|w| w.name.clone()),
        apps: plan_apps(&config, &existing_apps, &used_ports),
    })
}

/// `workspace_id` adopts into an existing workspace instead of creating one.
/// `reassign_ports` moves a clashing port to a free one rather than skipping
/// the app outright.
#[tauri::command]
pub fn import_porta_config(
    state: State<AppState>,
    src_path: String,
    workspace_id: Option<String>,
    reassign_ports: Option<bool>,
) -> Result<ImportSummary, String> {
    let config = read_config(&src_path)?;
    let reassign = reassign_ports.unwrap_or(false);

    let mut db = state.db.lock().unwrap();
    let workspaces = db.list_workspaces().map_err(|e| e.to_string())?;
    let existing_apps = db.list_apps().map_err(|e| e.to_string())?;
    let used_ports = db.used_ports().map_err(|e| e.to_string())?;

    // Resolve the target workspace before planning so an adopt into an existing
    // workspace does not create one on the way to failing.
    let (ws_id, ws_name) = match workspace_id {
        Some(id) => {
            let ws = workspaces
                .iter()
                .find(|w| w.id == id)
                .ok_or_else(|| format!("workspace {} not found", id))?;
            (ws.id.clone(), ws.name.clone())
        }
        None => {
            let ws = crate::db::models::Workspace {
                id: Uuid::new_v4().to_string(),
                name: config.workspace.name.clone(),
                domain: config.workspace.domain.clone(),
                deployment: None,
            };
            db.insert_workspace(&ws).map_err(|e| e.to_string())?;
            (ws.id, ws.name)
        }
    };

    let plan = plan_apps(&config, &existing_apps, &used_ports);

    // Mint ids up front so `depends_on` can be resolved by name in one pass.
    // The old two-pass version walked the config and the insert list by the
    // same index, which desynced the moment one app was skipped and quietly
    // dropped every dependency after it.
    let mut name_to_id: std::collections::HashMap<&str, String> = std::collections::HashMap::new();
    let mut planned: Vec<(&PortaAppConfig, u16, String)> = Vec::new();
    let mut skipped: Vec<SkippedApp> = Vec::new();

    for (cfg, preview) in config.workspace.apps.iter().zip(plan.iter()) {
        let port = match preview.status.as_str() {
            "new" => cfg.port,
            "duplicate" => {
                skipped.push(SkippedApp {
                    name: cfg.name.clone(),
                    reason: format!(
                        "already added as \"{}\"",
                        preview.existing_app.as_deref().unwrap_or("another app")
                    ),
                });
                continue;
            }
            _ => match (reassign, preview.suggested_port) {
                (true, Some(p)) => p,
                (true, None) => {
                    skipped.push(SkippedApp {
                        name: cfg.name.clone(),
                        reason: "no free port available".into(),
                    });
                    continue;
                }
                (false, _) => {
                    skipped.push(SkippedApp {
                        name: cfg.name.clone(),
                        reason: format!("port {} is already in use", cfg.port),
                    });
                    continue;
                }
            },
        };
        let id = Uuid::new_v4().to_string();
        name_to_id.insert(cfg.name.as_str(), id.clone());
        planned.push((cfg, port, id));
    }

    let mut imported = Vec::new();
    for (cfg, port, id) in &planned {
        let depends_on = cfg
            .depends_on
            .iter()
            .filter_map(|name| name_to_id.get(name.as_str()).cloned())
            .collect();
        let app = build_app(cfg, id.clone(), ws_id.clone(), *port, depends_on);
        db.insert_app(&app).map_err(|e| e.to_string())?;
        imported.push(cfg.name.clone());
    }

    drop(db);

    sync_caddy(&state)?;
    crate::backup::auto_backup_state(&state).ok();

    Ok(ImportSummary {
        workspace_id: ws_id,
        workspace_name: ws_name,
        imported,
        skipped,
    })
}

// ── Helpers ──────────────────────────────────────────────────────────────────

fn read_config(src_path: &str) -> Result<PortaConfig, String> {
    let src = Path::new(src_path);
    let base_dir = src
        .parent()
        .ok_or_else(|| "invalid source path".to_string())?;
    let yaml =
        std::fs::read_to_string(src).map_err(|e| format!("failed to read file: {}", e))?;
    porta_config::parse_config(&yaml, base_dir).map_err(|e| e.to_string())
}

/// Decide the fate of every app in a config against the current database.
/// Shared by preview and import so what the user approved is what runs.
fn plan_apps(
    config: &PortaConfig,
    existing_apps: &[App],
    used_ports: &[u16],
) -> Vec<AdoptAppPreview> {
    // Ports claimed by earlier apps in this same config count as taken, or two
    // reassignments in one import would land on the same number.
    let mut claimed: Vec<u16> = used_ports.to_vec();
    let mut out = Vec::with_capacity(config.workspace.apps.len());

    for cfg in &config.workspace.apps {
        let duplicate = existing_apps
            .iter()
            .find(|a| same_path(&a.root_dir, &cfg.root_dir));

        let (status, suggested_port, existing_app) = match duplicate {
            Some(app) => ("duplicate", None, Some(app.name.clone())),
            None if claimed.contains(&cfg.port) => {
                let suggested = find_available_port(&claimed, 3000, 9999);
                if let Some(p) = suggested {
                    claimed.push(p);
                }
                ("port_taken", suggested, None)
            }
            None => {
                claimed.push(cfg.port);
                ("new", None, None)
            }
        };

        out.push(AdoptAppPreview {
            name: cfg.name.clone(),
            root_dir: cfg.root_dir.clone(),
            port: cfg.port,
            start_command: cfg.start_command.clone(),
            status: status.into(),
            suggested_port,
            existing_app,
        });
    }

    out
}

/// Two paths pointing at the same folder. `parse_config` canonicalises what it
/// can, but a config referencing a folder that does not exist on this machine
/// stays as written — so fall back to comparing the text without a trailing
/// separator.
fn same_path(a: &str, b: &str) -> bool {
    let canon = |s: &str| {
        Path::new(s)
            .canonicalize()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| s.trim_end_matches('/').to_string())
    };
    canon(a) == canon(b)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::porta_config::PortaWorkspaceConfig;

    fn cfg_app(name: &str, root_dir: &str, port: u16) -> PortaAppConfig {
        PortaAppConfig {
            name: name.into(),
            root_dir: root_dir.into(),
            port,
            subdomain: None,
            start_command: "npm run dev".into(),
            env_file: None,
            env_vars: Default::default(),
            depends_on: vec![],
            health_check_path: None,
            profiles: vec![],
            active_profile: None,
        }
    }

    fn config(apps: Vec<PortaAppConfig>) -> PortaConfig {
        PortaConfig {
            version: 1,
            workspace: PortaWorkspaceConfig {
                name: "Demo".into(),
                domain: "demo.test".into(),
                apps,
            },
        }
    }

    fn existing(name: &str, root_dir: &str, port: u16) -> App {
        build_app(&cfg_app(name, root_dir, port), "id".into(), "ws".into(), port, vec![])
    }

    #[test]
    fn plans_untouched_apps_as_new() {
        let c = config(vec![cfg_app("web", "/p/web", 3000), cfg_app("api", "/p/api", 4000)]);
        let plan = plan_apps(&c, &[], &[]);
        assert_eq!(plan.iter().map(|a| a.status.as_str()).collect::<Vec<_>>(), ["new", "new"]);
        assert!(plan.iter().all(|a| a.suggested_port.is_none()));
    }

    #[test]
    fn flags_a_taken_port_and_suggests_a_free_one() {
        let c = config(vec![cfg_app("web", "/p/web", 3000)]);
        let plan = plan_apps(&c, &[], &[3000]);
        assert_eq!(plan[0].status, "port_taken");
        // The requested port is still reported — the UI shows 3000 → suggestion.
        assert_eq!(plan[0].port, 3000);
        assert_ne!(plan[0].suggested_port, Some(3000));
        assert!(plan[0].suggested_port.is_some());
    }

    #[test]
    fn flags_an_already_added_folder_as_duplicate() {
        let c = config(vec![cfg_app("web", "/p/web", 3000)]);
        let plan = plan_apps(&c, &[existing("frontend", "/p/web/", 9999)], &[]);
        assert_eq!(plan[0].status, "duplicate");
        assert_eq!(plan[0].existing_app.as_deref(), Some("frontend"));
        // A folder Porta already runs is skipped whatever its port does.
        assert_eq!(plan[0].suggested_port, None);
    }

    #[test]
    fn two_apps_wanting_the_same_port_do_not_both_get_it() {
        let c = config(vec![cfg_app("web", "/p/web", 3000), cfg_app("api", "/p/api", 3000)]);
        let plan = plan_apps(&c, &[], &[]);
        assert_eq!(plan[0].status, "new");
        assert_eq!(plan[1].status, "port_taken");
        assert_ne!(plan[1].suggested_port, Some(3000));
    }

    #[test]
    fn successive_reassignments_get_distinct_ports() {
        let c = config(vec![
            cfg_app("web", "/p/web", 3000),
            cfg_app("api", "/p/api", 3000),
            cfg_app("worker", "/p/worker", 3000),
        ]);
        let plan = plan_apps(&c, &[], &[3000]);
        let ports: Vec<u16> = plan.iter().filter_map(|a| a.suggested_port).collect();
        assert_eq!(ports.len(), 3);
        let mut sorted = ports.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), 3, "reassigned ports collided: {ports:?}");
    }
}

fn build_app(
    cfg: &PortaAppConfig,
    id: String,
    workspace_id: String,
    port: u16,
    depends_on: Vec<String>,
) -> App {
    // Profile ids are machine-local, so mint fresh ones and match the config's
    // `active_profile` by name.
    let env_profiles: Vec<crate::db::models::EnvProfile> = cfg
        .profiles
        .iter()
        .map(|p| crate::db::models::EnvProfile {
            id: Uuid::new_v4().to_string(),
            name: p.name.clone(),
            env_file: p.env_file.clone(),
            env_vars: p.env_vars.clone(),
            start_command: p.start_command.clone(),
            build_command: p.build_command.clone(),
        })
        .collect();
    let active_profile_id = cfg.active_profile.as_deref().and_then(|name| {
        env_profiles
            .iter()
            .find(|p| p.name == name)
            .map(|p| p.id.clone())
    });

    App {
        id,
        workspace_id: Some(workspace_id),
        name: cfg.name.clone(),
        root_dir: cfg.root_dir.clone(),
        port,
        subdomain: cfg.subdomain.clone(),
        start_command: cfg.start_command.clone(),
        start_command_source: "porta.yml".into(),
        status: "stopped".into(),
        pid: None,
        env_file: cfg.env_file.clone(),
        auto_start: false,
        env_vars: cfg.env_vars.clone(),
        restart_policy: "on-failure".into(),
        max_retries: 3,
        health_check_path: cfg.health_check_path.clone(),
        depends_on,
        extra_subdomains: vec![],
        custom_domain: None,
        tunnel_provider: None,
        tunnel_auto_start: false,
        tunnel_url: None,
        tunnel_active: false,
        port_bindings: vec![],
        env_profiles,
        active_profile_id,
        basic_auth_enabled: false,
        basic_auth_username: None,
        basic_auth_password_hash: None,
        basic_auth_password_set: false,
        host_auth_overrides: vec![],
        tunnel_alias_domain: None,
        tunnel_alias_rewrite_host: true,
        auto_sleep_enabled: false,
        idle_timeout_secs: 1800,
        auto_slept: false,
        max_upload_bytes: None,
        kind: "process".into(),
        docker_image: None,
        docker_container_port: None,
        docker_args: None,
        docker_volumes: vec![],
        compose_file: None,
        network_share: false,
        tunnel_name: None,
        tunnel_custom_hostname: None,
    }
}
