use tauri::Emitter;
use tauri::State;

use crate::app_state::AppState;
use crate::setup::SetupStatus;

fn workspace_domains(state: &AppState) -> Result<Vec<String>, String> {
    Ok(state
        .db
        .lock()
        .unwrap()
        .list_workspaces()
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|w| w.domain)
        .collect())
}

pub(crate) fn sync_caddy(state: &AppState) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    let workspaces = db.list_workspaces().map_err(|e| e.to_string())?;
    let apps = db.list_apps().map_err(|e| e.to_string())?;
    let routes: Vec<(String, u16)> = apps
        .iter()
        .flat_map(|a| a.all_hosts(&workspaces).into_iter().map(move |h| (h, a.port)))
        .collect();
    drop(db);
    state.caddy.reload(&routes).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn check_setup() -> SetupStatus {
    crate::setup::check()
}

/// Silently try to start Caddy without running the full wizard.
#[tauri::command]
pub fn start_caddy(state: State<AppState>) -> Result<(), String> {
    crate::setup::start_caddy(&|_| {}).map_err(|e| e.to_string())?;
    sync_caddy(&state).ok();
    Ok(())
}

#[tauri::command]
pub fn run_setup(state: State<AppState>, app: tauri::AppHandle) -> Result<(), String> {
    let domains = workspace_domains(&state)?;
    crate::setup::run_full_setup(
        &domains,
        &|step_key| { app.emit("setup:step", step_key).ok(); },
        &|line|     { app.emit("setup:log",  line).ok(); },
    )
    .map_err(|e| e.to_string())?;
    sync_caddy(&state).ok();
    Ok(())
}

/// Returns whether Caddy is currently running (listens on 443).
#[tauri::command]
pub fn caddy_status() -> bool {
    crate::setup::check().caddy_running
}

/// Public Tauri command — lets the frontend trigger a Caddy config reload.
#[tauri::command]
pub fn reload_caddy(state: State<AppState>) -> Result<(), String> {
    sync_caddy(&state)
}

/// Re-generate wildcard SSL certificates for all workspace domains.
#[tauri::command]
pub fn regenerate_certs(state: State<AppState>) -> Result<(), String> {
    let domains = workspace_domains(&state)?;
    crate::setup::generate_certs(&domains).map_err(|e| e.to_string())?;
    sync_caddy(&state).ok();
    Ok(())
}
