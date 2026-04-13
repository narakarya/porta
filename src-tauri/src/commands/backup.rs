use std::collections::HashMap;
use tauri::State;

use crate::app_state::AppState;
use crate::backup::{self, PortaFile};
use crate::db::models::App;
use super::setup::sync_caddy;

#[tauri::command]
pub fn export_data(state: State<AppState>) -> Result<String, String> {
    let db = state.db.lock().unwrap();
    let workspaces = db.list_workspaces().map_err(|e| e.to_string())?;
    let apps = db.list_apps().map_err(|e| e.to_string())?;
    backup::export(&workspaces, &apps).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn import_data(
    state: State<AppState>,
    json: String,
    replace: bool,
) -> Result<(), String> {
    let file: PortaFile = backup::parse_import(&json).map_err(|e| e.to_string())?;
    let mut db = state.db.lock().unwrap();

    if replace {
        for a in db.list_apps().map_err(|e| e.to_string())? {
            db.delete_app(&a.id).ok();
        }
        for w in db.list_workspaces().map_err(|e| e.to_string())? {
            db.delete_workspace(&w.id).ok();
        }
    }

    let existing_ports = db.used_ports().map_err(|e| e.to_string())?;
    let existing_domains: Vec<String> = db
        .list_workspaces()
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|w| w.domain)
        .collect();

    for w in &file.workspaces {
        if !existing_domains.contains(&w.domain) {
            db.insert_workspace(w).ok();
        }
    }
    for a in &file.apps {
        if !existing_ports.contains(&a.port) {
            let app = App {
                id: a.id.clone(),
                workspace_id: a.workspace_id.clone(),
                name: a.name.clone(),
                root_dir: a.root_dir.clone(),
                port: a.port,
                subdomain: a.subdomain.clone(),
                start_command: a.start_command.clone(),
                start_command_source: a.start_command_source.clone(),
                status: "stopped".into(),
                pid: None,
                env_file: None,
                auto_start: false,
                env_vars: HashMap::new(),
                restart_policy: "on-failure".into(),
                max_retries: 3,
                health_check_path: None,
                depends_on: vec![],
                extra_subdomains: a.extra_subdomains.clone(),
                tunnel_provider: None,
                tunnel_url: None,
                tunnel_active: false,
                deploy_config_path: None,
                deploy_custom_commands: vec![],
            };
            db.insert_app(&app).ok();
        }
    }
    drop(db);
    sync_caddy(&state)?;
    backup::auto_backup(&state.db_path).ok();
    Ok(())
}

#[tauri::command]
pub fn list_backups() -> Vec<String> {
    let dir = backup::backup_dir();
    std::fs::read_dir(&dir)
        .map(|entries| {
            let mut names: Vec<String> = entries
                .filter_map(|e| e.ok())
                .filter(|e| e.path().extension().is_some_and(|x| x == "db"))
                .map(|e| e.file_name().to_string_lossy().to_string())
                .collect();
            names.sort();
            names.reverse();
            names
        })
        .unwrap_or_default()
}

#[tauri::command]
pub fn restore_backup(state: State<AppState>, filename: String) -> Result<(), String> {
    let backup_path = backup::backup_dir().join(&filename);
    std::fs::copy(&backup_path, &state.db_path).map_err(|e| e.to_string())?;
    Ok(())
}
