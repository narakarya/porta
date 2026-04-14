use tauri::{Emitter, Manager, State};

use crate::app_state::AppState;
use crate::setup::SetupStatus;

/// Collect all unique domains that need SSL certs: workspace domains + app custom domains.
fn all_domains(state: &AppState) -> Result<Vec<String>, String> {
    let db = state.db.lock().unwrap();
    let mut domains: Vec<String> = db
        .list_workspaces()
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|w| w.domain)
        .collect();
    // Add any app-level custom domains + binding custom domains
    let apps = db.list_apps().map_err(|e| e.to_string())?;
    for app in &apps {
        if let Some(ref cd) = app.custom_domain {
            if !cd.is_empty() && !domains.contains(cd) {
                domains.push(cd.clone());
            }
        }
        for binding in &app.port_bindings {
            if let Some(ref cd) = binding.custom_domain {
                if !cd.is_empty() && !domains.contains(cd) {
                    domains.push(cd.clone());
                }
            }
        }
    }
    Ok(domains)
}

pub(crate) fn sync_caddy(state: &AppState) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    let workspaces = db.list_workspaces().map_err(|e| e.to_string())?;
    let apps = db.list_apps().map_err(|e| e.to_string())?;
    let routes: Vec<(String, u16)> = apps
        .iter()
        .flat_map(|a| a.all_routes(&workspaces))
        .collect();

    // Collect all domains that need certs (workspace + app custom_domain + binding custom_domains)
    let mut domains: Vec<String> = workspaces.iter().map(|w| w.domain.clone()).collect();
    for app in &apps {
        if let Some(ref cd) = app.custom_domain {
            if !cd.is_empty() && !domains.contains(cd) {
                domains.push(cd.clone());
            }
        }
        for binding in &app.port_bindings {
            if let Some(ref cd) = binding.custom_domain {
                if !cd.is_empty() && !domains.contains(cd) {
                    domains.push(cd.clone());
                }
            }
        }
    }
    drop(db);

    // Regenerate certs if mkcert is available — ensures new custom domains get covered
    if crate::setup::certs_exist() {
        crate::setup::generate_certs(&domains).ok();
    }

    state.caddy.reload(&routes).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn check_setup() -> SetupStatus {
    crate::setup::check()
}

/// Silently try to start Caddy without running the full wizard.
/// Runs on a background thread so the UI doesn't freeze during the wait.
#[tauri::command]
pub async fn start_caddy(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::setup::start_caddy(&|_| {}).map_err(|e| e.to_string())?;
        let state = app.state::<AppState>();
        sync_caddy(&state).ok();
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn run_setup(state: State<AppState>, app: tauri::AppHandle) -> Result<(), String> {
    let domains = all_domains(&state)?;
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
    let domains = all_domains(&state)?;
    crate::setup::generate_certs(&domains).map_err(|e| e.to_string())?;
    sync_caddy(&state).ok();
    Ok(())
}
