use tauri::State;
use uuid::Uuid;

use crate::app_state::AppState;
use crate::db::models::Workspace;
use super::setup::sync_caddy;

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
    let w = Workspace { id: Uuid::new_v4().to_string(), name, domain, deployment: None };
    state.db.lock().unwrap().insert_workspace(&w).map_err(|e| e.to_string())?;

    // Regenerate certs so the new workspace domain gets its own wildcard
    if crate::setup::certs_exist() {
        let domains: Vec<String> = state
            .db
            .lock()
            .unwrap()
            .list_workspaces()
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|w| w.domain)
            .collect();
        crate::setup::generate_certs(&domains).ok();
        sync_caddy(&state).ok();
    }

    crate::backup::auto_backup(&state.db_path).ok();
    Ok(w)
}

#[tauri::command]
pub fn update_workspace(
    state: State<AppState>,
    id: String,
    name: String,
    domain: String,
) -> Result<Workspace, String> {
    state
        .db
        .lock()
        .unwrap()
        .update_workspace(&id, &name, &domain)
        .map_err(|e| e.to_string())?;
    sync_caddy(&state)?;
    crate::backup::auto_backup(&state.db_path).ok();
    Ok(Workspace { id, name, domain, deployment: None })
}

#[tauri::command]
pub fn delete_workspace(state: State<AppState>, id: String) -> Result<(), String> {
    state.db.lock().unwrap().delete_workspace(&id).map_err(|e| e.to_string())?;
    sync_caddy(&state)?;
    crate::backup::auto_backup(&state.db_path).ok();
    Ok(())
}

#[tauri::command]
pub fn reorder_workspaces(state: State<AppState>, ids: Vec<String>) -> Result<(), String> {
    state.db.lock().unwrap().reorder_workspaces(&ids).map_err(|e| e.to_string())
}
