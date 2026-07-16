use tauri::State;
use uuid::Uuid;

use crate::app_state::AppState;
use crate::db::models::SshHost;

// Re-exported so `commands::SshManager` resolves for `.manage(...)` and
// `State<'_, SshManager>` call sites in `lib.rs` (and brings the name into
// scope for use within this file).
pub use crate::ssh::engine::SshManager;

fn now_epoch() -> i64 {
    chrono::Utc::now().timestamp()
}

#[tauri::command]
pub fn ssh_list_hosts(state: State<AppState>) -> Result<Vec<SshHost>, String> {
    state.db.lock().unwrap().list_ssh_hosts().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn ssh_add_host(mut host: SshHost, state: State<AppState>) -> Result<SshHost, String> {
    if host.id.is_empty() {
        host.id = Uuid::new_v4().to_string();
    }
    host.created_at = now_epoch();
    state
        .db
        .lock()
        .unwrap()
        .insert_ssh_host(&host)
        .map_err(|e| e.to_string())?;
    Ok(host)
}

#[tauri::command]
pub fn ssh_update_host(host: SshHost, state: State<AppState>) -> Result<(), String> {
    state
        .db
        .lock()
        .unwrap()
        .update_ssh_host(&host)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn ssh_delete_host(id: String, state: State<AppState>) -> Result<(), String> {
    state
        .db
        .lock()
        .unwrap()
        .delete_ssh_host(&id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ssh_connect(
    app: tauri::AppHandle,
    host_id: String,
    manager: State<'_, SshManager>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let host = state
        .db
        .lock()
        .unwrap()
        .get_ssh_host(&host_id)
        .map_err(|e| e.to_string())?
        .ok_or("host not found")?;
    let session_id = Uuid::new_v4().to_string();
    manager
        .connect(app, session_id.clone(), host, state.db.clone())
        .await?;
    Ok(session_id)
}

#[tauri::command]
pub async fn ssh_write(
    session_id: String,
    data: Vec<u8>,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    manager.write(&session_id, data).await;
    Ok(())
}

#[tauri::command]
pub async fn ssh_resize(
    session_id: String,
    rows: u16,
    cols: u16,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    manager.resize(&session_id, rows, cols).await;
    Ok(())
}

#[tauri::command]
pub async fn ssh_close(session_id: String, manager: State<'_, SshManager>) -> Result<(), String> {
    manager.close(&session_id).await;
    Ok(())
}

#[tauri::command]
pub async fn ssh_trust_host(
    session_id: String,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    manager.trust(&session_id).await
}

#[tauri::command]
pub async fn ssh_provide_secret(
    session_id: String,
    value: String,
    remember: bool,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    manager.provide_secret(&session_id, value, remember).await
}
