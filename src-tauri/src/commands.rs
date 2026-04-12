use std::path::PathBuf;
use std::sync::Mutex;
use tauri::State;
use uuid::Uuid;

use crate::auto_detect::DetectResult;
use crate::backup::{self, PortaFile};
use crate::caddy::CaddyManager;
use crate::db::{
    models::{App, Workspace},
    Database,
};
use crate::port_scanner::find_available_port;
use crate::process_manager::ProcessManager;
use crate::setup::SetupStatus;

pub struct AppState {
    pub db: Mutex<Database>,
    pub processes: ProcessManager,
    pub caddy: CaddyManager,
    pub db_path: PathBuf,
}

/// Rebuild Caddy config from current DB state and reload.
fn sync_caddy(state: &AppState) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    let workspaces = db.list_workspaces().map_err(|e| e.to_string())?;
    let apps = db.list_apps().map_err(|e| e.to_string())?;
    let routes: Vec<(String, u16)> = apps
        .iter()
        .map(|a| (a.resolved_host(&workspaces), a.port))
        .collect();
    drop(db);
    state.caddy.reload(&routes).map_err(|e| e.to_string())
}

// ── Setup ─────────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn check_setup() -> SetupStatus {
    crate::setup::check()
}

#[tauri::command]
pub fn run_setup() -> Result<(), String> {
    crate::setup::run_full_setup().map_err(|e| e.to_string())
}

// ── Workspaces ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn list_workspaces(state: State<AppState>) -> Result<Vec<Workspace>, String> {
    state.db.lock().unwrap().list_workspaces().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn add_workspace(
    state: State<AppState>,
    name: String,
    domain: String,
) -> Result<Workspace, String> {
    let w = Workspace { id: Uuid::new_v4().to_string(), name, domain };
    state.db.lock().unwrap().insert_workspace(&w).map_err(|e| e.to_string())?;
    backup::auto_backup(&state.db_path).ok();
    Ok(w)
}

#[tauri::command]
pub fn delete_workspace(state: State<AppState>, id: String) -> Result<(), String> {
    state.db.lock().unwrap().delete_workspace(&id).map_err(|e| e.to_string())?;
    sync_caddy(&state)?;
    backup::auto_backup(&state.db_path).ok();
    Ok(())
}

// ── Apps ──────────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn list_apps(state: State<AppState>) -> Result<Vec<App>, String> {
    state.db.lock().unwrap().list_apps().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn detect_start_command(root_dir: String) -> DetectResult {
    crate::auto_detect::detect(std::path::Path::new(&root_dir))
}

#[tauri::command]
pub fn next_available_port(state: State<AppState>) -> Result<u16, String> {
    let used = state.db.lock().unwrap().used_ports().map_err(|e| e.to_string())?;
    find_available_port(&used, 3000, 9999).ok_or_else(|| "No available port".into())
}

#[tauri::command]
pub fn add_app(
    state: State<AppState>,
    workspace_id: Option<String>,
    name: String,
    root_dir: String,
    port: u16,
    subdomain: Option<String>,
    start_command: String,
    start_command_source: String,
) -> Result<App, String> {
    let app = App {
        id: Uuid::new_v4().to_string(),
        workspace_id,
        name,
        root_dir,
        port,
        subdomain,
        start_command,
        start_command_source,
        status: "stopped".into(),
        pid: None,
    };
    state
        .db
        .lock()
        .unwrap()
        .insert_app(&app)
        .map_err(|e| e.to_string())?;
    sync_caddy(&state)?;
    backup::auto_backup(&state.db_path).ok();
    Ok(app)
}

#[tauri::command]
pub fn delete_app(state: State<AppState>, id: String) -> Result<(), String> {
    state.processes.stop(&id).ok();
    state.db.lock().unwrap().delete_app(&id).map_err(|e| e.to_string())?;
    sync_caddy(&state)?;
    backup::auto_backup(&state.db_path).ok();
    Ok(())
}

#[tauri::command]
pub fn start_app(state: State<AppState>, id: String) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    let apps = db.list_apps().map_err(|e| e.to_string())?;
    let app = apps
        .iter()
        .find(|a| a.id == id)
        .ok_or_else(|| format!("app {} not found", id))?
        .clone();
    drop(db);

    let pid = state
        .processes
        .start(&id, &app.start_command, std::path::Path::new(&app.root_dir))
        .map_err(|e| e.to_string())?;

    state
        .db
        .lock()
        .unwrap()
        .update_app_status(&id, "running", Some(pid))
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn stop_app(state: State<AppState>, id: String) -> Result<(), String> {
    state.processes.stop(&id).map_err(|e| e.to_string())?;
    state
        .db
        .lock()
        .unwrap()
        .update_app_status(&id, "stopped", None)
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ── Backup / Export / Import ──────────────────────────────────────────────────

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
                .filter(|e| e.path().extension().map_or(false, |x| x == "db"))
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
    // DB will be reloaded from restored file on next Porta launch
    Ok(())
}
