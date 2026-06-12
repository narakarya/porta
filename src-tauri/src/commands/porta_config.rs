use std::path::Path;

use tauri::State;
use uuid::Uuid;

use crate::app_state::AppState;
use crate::db::models::App;
use crate::porta_config;
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

#[tauri::command]
pub fn import_porta_config(state: State<AppState>, src_path: String) -> Result<(), String> {
    let src = Path::new(&src_path);
    let base_dir = src
        .parent()
        .ok_or_else(|| "invalid source path".to_string())?;

    let yaml = std::fs::read_to_string(src)
        .map_err(|e| format!("failed to read file: {}", e))?;

    let config = porta_config::parse_config(&yaml, base_dir).map_err(|e| e.to_string())?;

    let mut db = state.db.lock().unwrap();

    // Create workspace
    let ws_id = Uuid::new_v4().to_string();
    let workspace = crate::db::models::Workspace {
        id: ws_id.clone(),
        name: config.workspace.name.clone(),
        domain: config.workspace.domain.clone(),
        deployment: None,
    };
    db.insert_workspace(&workspace).map_err(|e| e.to_string())?;

    // Collect used ports so we can skip conflicts
    let used_ports = db.used_ports().map_err(|e| e.to_string())?;

    // First pass: create apps and build a name -> id map for depends_on resolution
    let mut name_to_id: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut apps_to_insert: Vec<App> = Vec::new();

    for app_cfg in &config.workspace.apps {
        if used_ports.contains(&app_cfg.port) {
            // Skip apps whose port is already taken
            continue;
        }

        let app_id = Uuid::new_v4().to_string();
        name_to_id.insert(app_cfg.name.clone(), app_id.clone());

        let app = App {
            id: app_id,
            workspace_id: Some(ws_id.clone()),
            name: app_cfg.name.clone(),
            root_dir: app_cfg.root_dir.clone(),
            port: app_cfg.port,
            subdomain: app_cfg.subdomain.clone(),
            start_command: app_cfg.start_command.clone(),
            start_command_source: "porta.yml".into(),
            status: "stopped".into(),
            pid: None,
            env_file: app_cfg.env_file.clone(),
            auto_start: false,
            env_vars: app_cfg.env_vars.clone(),
            restart_policy: "on-failure".into(),
            max_retries: 3,
            health_check_path: app_cfg.health_check_path.clone(),
            depends_on: vec![], // resolved in second pass
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
        };
        apps_to_insert.push(app);
    }

    // Second pass: resolve depends_on names to IDs
    for (i, app_cfg) in config.workspace.apps.iter().enumerate() {
        if i >= apps_to_insert.len() {
            break;
        }
        // Only process if this app was actually inserted (name matches)
        if apps_to_insert[i].name != app_cfg.name {
            continue;
        }
        let resolved: Vec<String> = app_cfg
            .depends_on
            .iter()
            .filter_map(|name| name_to_id.get(name).cloned())
            .collect();
        apps_to_insert[i].depends_on = resolved;
    }

    // Insert all apps
    for app in &apps_to_insert {
        db.insert_app(app).map_err(|e| e.to_string())?;
    }

    drop(db);

    // Sync Caddy and backup
    sync_caddy(&state)?;
    crate::backup::auto_backup(&state.db_path).ok();

    Ok(())
}
