use crate::sync::LockExt;
use serde::Serialize;
use tauri::State;
use uuid::Uuid;

use crate::app_state::AppState;
use crate::db::models::{SshAuth, SshHost, SshPortForward};
use crate::ssh::config_import::{self, SshConfigEntry};

// Re-exported so `commands::SshManager` resolves for `.manage(...)` and
// `State<'_, SshManager>` call sites in `lib.rs` (and brings the name into
// scope for use within this file).
pub use crate::ssh::engine::SshManager;

fn now_epoch() -> i64 {
    chrono::Utc::now().timestamp()
}

#[tauri::command]
pub fn ssh_list_hosts(state: State<AppState>) -> Result<Vec<SshHost>, String> {
    state.db.lock_or_recover().list_ssh_hosts().map_err(|e| e.to_string())
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
pub async fn ssh_delete_host(
    app: tauri::AppHandle,
    id: String,
    manager: State<'_, SshManager>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Stop the host's forwards before the rules vanish. Deleting only the rows
    // left the listener bound and still tunnelling into the remote network,
    // with the sidebar row — the only way to stop it — gone from the UI.
    let forwards = state
        .db
        .lock_or_recover()
        .list_ssh_forwards_for_host(&id)
        .unwrap_or_default();
    for f in &forwards {
        manager.stop_forward_if_running(&app, &f.id).await;
    }
    state
        .db
        .lock_or_recover()
        .delete_ssh_host(&id)
        .map_err(|e| e.to_string())
}

/// A `~/.ssh/config` entry offered for import, plus whether the vault already
/// has it. The frontend pre-unchecks the duplicates rather than hiding them —
/// seeing "already imported" is what tells the user the scan actually worked.
#[derive(Debug, Serialize)]
pub struct SshConfigCandidate {
    #[serde(flatten)]
    pub entry: SshConfigEntry,
    pub already_in_vault: bool,
}

/// Identity of a host for duplicate detection: `user@hostname:port`. Labels are
/// free-text and get renamed, so they can't carry this.
fn identity(username: &str, hostname: &str, port: u16) -> String {
    format!("{}@{}:{}", username.to_lowercase(), hostname.to_lowercase(), port)
}

fn local_username() -> String {
    std::env::var("USER").unwrap_or_else(|_| "root".to_string())
}

#[tauri::command]
pub fn ssh_scan_config(state: State<AppState>) -> Result<Vec<SshConfigCandidate>, String> {
    let Some(path) = config_import::default_config_path() else {
        return Ok(Vec::new());
    };
    let existing: std::collections::HashSet<String> = state
        .db
        .lock_or_recover()
        .list_ssh_hosts()
        .map_err(|e| e.to_string())?
        .iter()
        .map(|h| identity(&h.username, &h.hostname, h.port))
        .collect();

    Ok(config_import::scan(&path, &local_username())
        .into_iter()
        .map(|entry| SshConfigCandidate {
            already_in_vault: existing.contains(&identity(
                &entry.username,
                &entry.hostname,
                entry.port,
            )),
            entry,
        })
        .collect())
}

/// Import the selected `~/.ssh/config` aliases into the vault.
///
/// Re-scans rather than trusting entries round-tripped through the frontend:
/// the file is the source of truth, and a stale selection should import what is
/// on disk now. `ProxyJump` is wired in a second pass, since the alias it names
/// may itself be one of the rows created by this call.
#[tauri::command]
pub fn ssh_import_config_hosts(
    aliases: Vec<String>,
    workspace_ids: Vec<String>,
    state: State<AppState>,
) -> Result<Vec<SshHost>, String> {
    let Some(path) = config_import::default_config_path() else {
        return Err("No home directory — can't locate ~/.ssh/config.".into());
    };
    let wanted: std::collections::HashSet<&str> = aliases.iter().map(String::as_str).collect();
    let entries: Vec<SshConfigEntry> = config_import::scan(&path, &local_username())
        .into_iter()
        .filter(|e| wanted.contains(e.alias.as_str()))
        .collect();

    let db = state.db.lock_or_recover();
    let existing = db.list_ssh_hosts().map_err(|e| e.to_string())?;
    let seen: std::collections::HashSet<String> = existing
        .iter()
        .map(|h| identity(&h.username, &h.hostname, h.port))
        .collect();

    // Pass 1: insert. Skipping duplicates here means re-running the import
    // after adding one host to ~/.ssh/config doesn't clone the other twenty.
    let mut imported = Vec::new();
    for entry in &entries {
        if seen.contains(&identity(&entry.username, &entry.hostname, entry.port)) {
            continue;
        }
        let host = SshHost {
            id: Uuid::new_v4().to_string(),
            label: entry.alias.clone(),
            group: None,
            hostname: entry.hostname.clone(),
            port: entry.port,
            username: entry.username.clone(),
            auth: match &entry.identity_file {
                Some(path) => SshAuth::KeyFile { path: path.clone() },
                None => SshAuth::Agent,
            },
            jump_host_id: None,
            created_at: now_epoch(),
            last_used_at: None,
            workspace_ids: workspace_ids.clone(),
            detected_os: None,
        };
        db.insert_ssh_host(&host).map_err(|e| e.to_string())?;
        imported.push(host);
    }

    // Pass 2: resolve ProxyJump aliases to ids, against both the rows just
    // created and whatever was already in the vault.
    // Owned keys/values: pass 2 takes `&mut imported`, so this map can't hold
    // borrows into it.
    let by_label: std::collections::HashMap<String, String> = imported
        .iter()
        .chain(existing.iter())
        .map(|h| (h.label.clone(), h.id.clone()))
        .collect();
    let jump_of: std::collections::HashMap<&str, &str> = entries
        .iter()
        .filter_map(|e| e.proxy_jump.as_deref().map(|j| (e.alias.as_str(), j)))
        .collect();

    for host in &mut imported {
        let Some(jump_alias) = jump_of.get(host.label.as_str()) else {
            continue;
        };
        // An unresolvable jump alias (it points outside the imported set) is
        // left unset — a dangling id would fail the connect with a confusing
        // "jump host no longer exists" instead of just connecting directly.
        let Some(id) = by_label.get(*jump_alias) else {
            continue;
        };
        if *id == host.id {
            continue;
        }
        host.jump_host_id = Some(id.clone());
        db.update_ssh_host(host).map_err(|e| e.to_string())?;
    }

    Ok(imported)
}

#[tauri::command]
pub async fn ssh_connect(
    app: tauri::AppHandle,
    host_id: String,
    session_id: String,
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
    manager
        .connect(app, session_id.clone(), host, state.db.clone())
        .await?;
    Ok(session_id)
}

// ── Port forwards ────────────────────────────────────────────────────────────

#[tauri::command]
pub fn ssh_list_forwards(host_id: String, state: State<AppState>) -> Result<Vec<SshPortForward>, String> {
    state
        .db
        .lock_or_recover()
        .list_ssh_forwards_for_host(&host_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn ssh_add_forward(
    mut forward: SshPortForward,
    state: State<AppState>,
) -> Result<SshPortForward, String> {
    // Reject before persisting — a saved rule that can never start is worse
    // than a rejected one, because it fails again on every reconnect.
    crate::ssh::forward::validate(&forward)?;
    if forward.id.is_empty() {
        forward.id = Uuid::new_v4().to_string();
    }
    forward.created_at = now_epoch();
    state
        .db
        .lock_or_recover()
        .insert_ssh_forward(&forward)
        .map_err(|e| e.to_string())?;
    Ok(forward)
}

/// Edit a rule. A running forward is stopped rather than mutated in place: its
/// listener is already bound to the old port, so the change would otherwise
/// only take effect on the next reconnect while the UI showed the new values.
#[tauri::command]
pub async fn ssh_update_forward(
    app: tauri::AppHandle,
    forward: SshPortForward,
    manager: State<'_, SshManager>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    crate::ssh::forward::validate(&forward)?;
    manager.stop_forward_if_running(&app, &forward.id).await;
    state
        .db
        .lock_or_recover()
        .update_ssh_forward(&forward)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ssh_delete_forward(
    app: tauri::AppHandle,
    id: String,
    manager: State<'_, SshManager>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Stop first: deleting the row while the listener still holds the port
    // leaves an orphan nothing in the UI can reach.
    manager.stop_forward_if_running(&app, &id).await;
    state
        .db
        .lock_or_recover()
        .delete_ssh_forward(&id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ssh_start_forward(
    app: tauri::AppHandle,
    session_id: String,
    forward_id: String,
    manager: State<'_, SshManager>,
    state: State<'_, AppState>,
) -> Result<u16, String> {
    let forward = state
        .db
        .lock_or_recover()
        .get_ssh_forward(&forward_id)
        .map_err(|e| e.to_string())?
        .ok_or("That forward no longer exists.")?;
    manager.start_forward(app, &session_id, forward).await
}

#[tauri::command]
pub async fn ssh_stop_forward(
    app: tauri::AppHandle,
    forward_id: String,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    manager.stop_forward(&app, &forward_id).await
}

#[tauri::command]
pub async fn ssh_running_forwards(
    session_id: String,
    manager: State<'_, SshManager>,
) -> Result<Vec<String>, String> {
    Ok(manager.running_forwards(&session_id).await)
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
pub async fn ssh_close(
    app: tauri::AppHandle,
    session_id: String,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    manager.close(&app, &session_id).await;
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
