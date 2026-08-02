//! Which SSH host an app deploys to. Core remembers the link; it never deploys.
//!
//! The act of deploying lives in an extension (`narakarya/porta-kamal`), which
//! was moved out of core precisely so it could be released on its own schedule.
//! What an extension could not do was find out *where* an app goes — the vault
//! and the deploy config had no way to refer to each other. This is that link
//! and nothing more.
//!
//! There is deliberately no `deploy` command here, and none is coming. A verb
//! named Deploy in core is one fuzzy command-palette match away from mutating
//! production with no screen showing which machine it hit — the same reasoning
//! that made the remote Docker view read-only.

use crate::sync::LockExt;
use serde::Serialize;
use tauri::State;
use uuid::Uuid;

use crate::app_state::AppState;
use crate::db::models::AppDeployTarget;

/// A target joined to the host it names, for display.
///
/// Carries the host's identity and nothing that could be used to connect
/// without going through Porta: no auth method, no key path, no jump chain.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployTargetView {
    pub id: String,
    pub app_id: String,
    pub env: String,
    pub host_id: String,
    pub host_label: String,
    /// `user@hostname:port`, for showing which machine this is.
    pub host_address: String,
}

fn view(t: AppDeployTarget, hosts: &[crate::db::models::SshHost]) -> Option<DeployTargetView> {
    let host = hosts.iter().find(|h| h.id == t.host_id)?;
    Some(DeployTargetView {
        id: t.id,
        app_id: t.app_id,
        env: t.env,
        host_id: host.id.clone(),
        host_label: host.label.clone(),
        host_address: format!("{}@{}:{}", host.username, host.hostname, host.port),
    })
}

#[tauri::command]
pub fn list_deploy_targets(
    app_id: String,
    state: State<AppState>,
) -> Result<Vec<DeployTargetView>, String> {
    let db = state.db.lock_or_recover();
    let hosts = db.list_ssh_hosts().map_err(|e| e.to_string())?;
    let targets = db
        .list_deploy_targets_for_app(&app_id)
        .map_err(|e| e.to_string())?;
    // A target whose host vanished is dropped rather than rendered half-empty;
    // delete_ssh_host clears them, so this only catches a hand-edited database.
    Ok(targets.into_iter().filter_map(|t| view(t, &hosts)).collect())
}

#[tauri::command]
pub fn set_deploy_target(
    app_id: String,
    host_id: String,
    env: String,
    state: State<AppState>,
) -> Result<DeployTargetView, String> {
    let env = env.trim().to_string();
    if env.is_empty() {
        return Err("Name the environment this host is for (production, staging, …).".into());
    }
    let db = state.db.lock_or_recover();
    let hosts = db.list_ssh_hosts().map_err(|e| e.to_string())?;
    if !hosts.iter().any(|h| h.id == host_id) {
        return Err("That host isn't in the vault any more.".into());
    }

    // Keep the existing row's id when re-pointing an environment: an extension
    // stores its own settings against that id, and minting a new one would
    // orphan them every time the user changed host.
    let existing = db
        .list_deploy_targets_for_app(&app_id)
        .unwrap_or_default()
        .into_iter()
        .find(|t| t.env == env);
    let target = AppDeployTarget {
        id: existing.as_ref().map(|t| t.id.clone()).unwrap_or_else(|| Uuid::new_v4().to_string()),
        app_id,
        host_id,
        env,
        created_at: existing
            .as_ref()
            .map(|t| t.created_at)
            .unwrap_or_else(|| chrono::Utc::now().timestamp()),
    };
    db.upsert_deploy_target(&target).map_err(|e| e.to_string())?;
    view(target, &hosts).ok_or_else(|| "host disappeared while saving".to_string())
}

#[tauri::command]
pub fn delete_deploy_target(id: String, state: State<AppState>) -> Result<(), String> {
    state
        .db
        .lock_or_recover()
        .delete_deploy_target(&id)
        .map_err(|e| e.to_string())
}
