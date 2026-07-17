use tauri::State;
use uuid::Uuid;

use crate::app_state::AppState;
use crate::auto_detect::{DetectResult, CommandSuggestion, detect_tags};
use crate::db::models::{App, PortBinding, HostAuthOverride};
use crate::port_scanner::find_available_port;
use super::setup::sync_caddy;

/// Per-host Basic Auth override as it arrives from the modal — carries the
/// *plaintext* password (empty/None ⇒ keep the stored hash). The command
/// bcrypt-hashes it before persisting; the stored model never sees plaintext.
#[derive(Debug, serde::Deserialize)]
pub struct HostAuthOverrideInput {
    pub host: String,
    /// "off" | "custom". Anything else ⇒ inherit the app default (no entry stored).
    pub mode: String,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
}

#[tauri::command]
pub fn list_apps(state: State<AppState>) -> Result<Vec<App>, String> {
    let apps = state.db.lock().unwrap().list_apps().map_err(|e| e.to_string())?;
    Ok(apps)
}

#[tauri::command]
pub fn detect_start_command(root_dir: String) -> DetectResult {
    crate::auto_detect::detect(std::path::Path::new(&root_dir))
}

#[tauri::command]
pub fn list_available_commands(root_dir: String) -> Vec<CommandSuggestion> {
    crate::auto_detect::list_commands(std::path::Path::new(&root_dir))
}

#[tauri::command]
pub fn detect_app_tags(root_dir: String) -> Vec<String> {
    detect_tags(std::path::Path::new(&root_dir))
}

#[tauri::command]
pub fn next_available_port(state: State<AppState>) -> Result<u16, String> {
    let used = state.db.lock().unwrap().used_ports().map_err(|e| e.to_string())?;
    find_available_port(&used, 3000, 9999).ok_or_else(|| "No available port".into())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn add_app(
    state: State<AppState>,
    workspace_id: Option<String>,
    name: String,
    root_dir: String,
    port: u16,
    subdomain: Option<String>,
    start_command: String,
    start_command_source: String,
    kind: Option<String>,
    docker_image: Option<String>,
    docker_container_port: Option<u16>,
    docker_args: Option<String>,
    docker_volumes: Option<Vec<String>>,
    compose_file: Option<String>,
    compose_yaml: Option<String>,
    network_share: Option<bool>,
    tunnel_name: Option<String>,
    tunnel_custom_hostname: Option<String>,
) -> Result<App, String> {
    let resolved_kind = kind.unwrap_or_else(|| "process".into());
    // Static and proxy apps are served by Caddy as soon as the route is
    // registered, so they boot straight into "running" — no separate "Start" step.
    let initial_status = if resolved_kind == "static" || resolved_kind == "proxy" { "running" } else { "stopped" };
    let app_id = Uuid::new_v4().to_string();
    // If a pasted YAML was provided, persist it to Porta's managed compose
    // location and use that path as `compose_file`.
    let resolved_compose_file = if let Some(yaml) = compose_yaml.as_ref().filter(|s| !s.trim().is_empty()) {
        let target = super::compose::managed_compose_path(&app_id);
        Some(super::compose::save_compose_to_path(&target, yaml)?)
    } else {
        compose_file
    };
    let app = App {
        id: app_id,
        workspace_id,
        name,
        root_dir,
        port,
        subdomain,
        start_command,
        start_command_source,
        status: initial_status.into(),
        pid: None,
        env_file: None,
        auto_start: false,
        env_vars: std::collections::HashMap::new(),
        restart_policy: "on-failure".into(),
        max_retries: 3,
        health_check_path: None,
        depends_on: vec![],
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
        kind: resolved_kind,
        docker_image,
        docker_container_port,
        docker_args,
        docker_volumes: docker_volumes.unwrap_or_default(),
        compose_file: resolved_compose_file,
        network_share: network_share.unwrap_or(false),
        tunnel_name,
        tunnel_custom_hostname,
    };
    state
        .db
        .lock()
        .unwrap()
        .insert_app(&app)
        .map_err(|e| e.to_string())?;
    sync_caddy(&state)?;
    crate::backup::auto_backup(&state.db_path).ok();
    Ok(app)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn update_app(
    state: State<AppState>,
    id: String,
    name: String,
    root_dir: Option<String>,
    port: u16,
    subdomain: Option<String>,
    start_command: String,
    env_file: Option<String>,
    auto_start: bool,
    env_vars: Option<std::collections::HashMap<String, String>>,
    restart_policy: Option<String>,
    max_retries: Option<u8>,
    health_check_path: Option<String>,
    depends_on: Option<Vec<String>>,
    extra_subdomains: Option<Vec<String>>,
    custom_domain: Option<String>,
    port_bindings: Option<Vec<PortBinding>>,
    env_profiles: Option<Vec<crate::db::models::EnvProfile>>,
    active_profile_id: Option<String>,
    docker_image: Option<String>,
    docker_container_port: Option<u16>,
    docker_args: Option<String>,
    docker_volumes: Option<Vec<String>>,
    compose_file: Option<String>,
    compose_yaml: Option<String>,
    network_share: Option<bool>,
    tunnel_name: Option<String>,
    tunnel_custom_hostname: Option<String>,
    basic_auth_enabled: Option<bool>,
    basic_auth_username: Option<String>,
    // Plaintext from the modal. Empty/None preserves the stored bcrypt hash
    // (user toggled auth or edited the username without retyping the secret).
    basic_auth_password: Option<String>,
    // Public alias hostname for tunnel exposure (e.g. "*.nasrulgunawan.com").
    // None preserves the stored value when omitted from the payload.
    tunnel_alias_domain: Option<String>,
    tunnel_alias_rewrite_host: Option<bool>,
    // Per-host Basic Auth overrides. None = field omitted ⇒ keep stored set;
    // Some = authoritative replacement (passwords plaintext, hashed below).
    host_auth_overrides: Option<Vec<HostAuthOverrideInput>>,
) -> Result<App, String> {
    let resolved_compose_file = if let Some(yaml) = compose_yaml.as_ref().filter(|s| !s.trim().is_empty()) {
        let target = super::compose::managed_compose_path(&id);
        Some(super::compose::save_compose_to_path(&target, yaml)?)
    } else {
        compose_file
    };
    let new_password_hash: Option<String> = match basic_auth_password.as_deref() {
        Some(p) if !p.is_empty() => Some(
            bcrypt::hash(p, bcrypt::DEFAULT_COST)
                .map_err(|e| format!("bcrypt hash failed: {}", e))?,
        ),
        _ => None,
    };
    if let Some(dir) = root_dir.as_deref() {
        let path = std::path::Path::new(dir);
        if !path.exists() {
            return Err(format!("Folder not found: {}", dir));
        }
        if !path.is_dir() {
            return Err(format!("Path is not a folder: {}", dir));
        }
    }
    // Merge per-host auth overrides. Each "custom" host either gets a fresh
    // bcrypt hash (password typed) or keeps its stored one (left blank). When
    // the field is omitted entirely, preserve whatever is on disk.
    let merged_overrides: Vec<HostAuthOverride> = match host_auth_overrides {
        Some(inputs) => {
            let prev = state.db.lock().unwrap().list_apps().ok()
                .and_then(|apps| apps.into_iter().find(|a| a.id == id))
                .map(|a| a.host_auth_overrides)
                .unwrap_or_default();
            let mut out = Vec::new();
            for inp in inputs {
                let host = inp.host.trim().to_string();
                if host.is_empty() {
                    continue;
                }
                match inp.mode.as_str() {
                    "off" => out.push(HostAuthOverride {
                        host,
                        mode: "off".into(),
                        username: None,
                        password_hash: None,
                        password_set: false,
                    }),
                    "custom" => {
                        let hash = match inp.password.as_deref() {
                            Some(p) if !p.is_empty() => Some(
                                bcrypt::hash(p, bcrypt::DEFAULT_COST)
                                    .map_err(|e| format!("bcrypt hash failed: {}", e))?,
                            ),
                            // Left blank — keep the host's previously stored hash.
                            _ => prev.iter().find(|o| o.host == host)
                                .and_then(|o| o.password_hash.clone()),
                        };
                        out.push(HostAuthOverride {
                            host,
                            mode: "custom".into(),
                            username: inp.username.map(|u| u.trim().to_string()),
                            password_hash: hash,
                            password_set: false,
                        });
                    }
                    // "default" / unknown → inherit app default (no stored entry).
                    _ => {}
                }
            }
            out
        }
        None => state.db.lock().unwrap().list_apps().ok()
            .and_then(|apps| apps.into_iter().find(|a| a.id == id))
            .map(|a| a.host_auth_overrides)
            .unwrap_or_default(),
    };
    state
        .db
        .lock()
        .unwrap()
        .update_app(
            &id, &name,
            root_dir.as_deref(),
            port,
            subdomain.as_deref(),
            &start_command,
            env_file.as_deref(),
            auto_start,
            &env_vars.unwrap_or_default(),
            restart_policy.as_deref().unwrap_or("on-failure"),
            max_retries.unwrap_or(3),
            health_check_path.as_deref(),
            &depends_on.unwrap_or_default(),
            &extra_subdomains.unwrap_or_default(),
            custom_domain.as_deref(),
            &port_bindings.unwrap_or_default(),
            &env_profiles.unwrap_or_default(),
            active_profile_id.as_deref(),
            docker_image.as_deref(),
            docker_container_port,
            docker_args.as_deref(),
            &docker_volumes.unwrap_or_default(),
            resolved_compose_file.as_deref(),
            network_share.unwrap_or(false),
            tunnel_name.as_deref(),
            tunnel_custom_hostname.as_deref(),
            basic_auth_enabled.unwrap_or(false),
            basic_auth_username.as_deref(),
            new_password_hash.as_deref(),
            tunnel_alias_domain.as_deref().map(str::trim).filter(|s| !s.is_empty()),
            tunnel_alias_rewrite_host.unwrap_or(true),
            &merged_overrides,
        )
        .map_err(|e| e.to_string())?;
    sync_caddy(&state)?;
    crate::backup::auto_backup(&state.db_path).ok();

    let apps = state.db.lock().unwrap().list_apps().map_err(|e| e.to_string())?;
    apps.into_iter().find(|a| a.id == id).ok_or_else(|| "app not found".into())
}

/// Reassign an app to a workspace (or to standalone when `workspace_id` is
/// `None`). Backs the migration that moves workspace-less apps under a
/// workspace. The workspace determines the app's effective domain, so re-sync
/// Caddy before returning the refreshed App.
#[tauri::command]
pub fn move_app_to_workspace(
    state: State<AppState>,
    app_id: String,
    workspace_id: Option<String>,
) -> Result<App, String> {
    state
        .db
        .lock()
        .unwrap()
        .conn
        .execute(
            "UPDATE apps SET workspace_id = ?1 WHERE id = ?2",
            rusqlite::params![workspace_id, app_id],
        )
        .map_err(|e| e.to_string())?;
    sync_caddy(&state)?;
    crate::backup::auto_backup(&state.db_path).ok();
    let apps = state.db.lock().unwrap().list_apps().map_err(|e| e.to_string())?;
    apps.into_iter().find(|a| a.id == app_id).ok_or_else(|| "app not found".into())
}

/// Persist a single app's auto-sleep config. Returns the refreshed App so the
/// store can patch its copy without a full reload. Config-only — does not start
/// or stop anything.
#[tauri::command]
pub fn set_app_auto_sleep(
    state: State<AppState>,
    id: String,
    enabled: bool,
    idle_timeout_secs: u32,
) -> Result<App, String> {
    // Clamp to a sane floor so a typo (e.g. 0) can't put the app into an
    // instant sleep/wake loop.
    let secs = idle_timeout_secs.max(30);
    state
        .db
        .lock()
        .unwrap()
        .set_app_auto_sleep(&id, enabled, secs)
        .map_err(|e| e.to_string())?;
    let apps = state.db.lock().unwrap().list_apps().map_err(|e| e.to_string())?;
    apps.into_iter().find(|a| a.id == id).ok_or_else(|| "app not found".into())
}

/// Persist a single app's max upload body size and re-emit Caddy config so the
/// new `request_body` limit applies immediately. `max_bytes = None` clears the
/// override (inherit the global default); `Some(0)` means unlimited. Returns
/// the refreshed App so the store can patch its copy.
#[tauri::command]
pub fn set_app_max_upload_bytes(
    state: State<AppState>,
    id: String,
    max_bytes: Option<u64>,
) -> Result<App, String> {
    state
        .db
        .lock()
        .unwrap()
        .set_app_max_upload_bytes(&id, max_bytes)
        .map_err(|e| e.to_string())?;
    sync_caddy(&state)?;
    let apps = state.db.lock().unwrap().list_apps().map_err(|e| e.to_string())?;
    apps.into_iter().find(|a| a.id == id).ok_or_else(|| "app not found".into())
}

#[tauri::command]
pub fn delete_app(state: State<AppState>, id: String) -> Result<(), String> {
    let app_data = state.db.lock().unwrap().list_apps().ok()
        .and_then(|apps| apps.into_iter().find(|a| a.id == id));
    let is_static = app_data.as_ref().map(|a| a.is_static()).unwrap_or(false);
    let is_proxy = app_data.as_ref().map(|a| a.is_proxy()).unwrap_or(false);
    let is_docker = app_data.as_ref().map(|a| a.is_docker()).unwrap_or(false);
    let is_compose = app_data.as_ref().map(|a| a.is_compose()).unwrap_or(false);
    if is_compose {
        if let Some(ref a) = app_data {
            let root = if a.root_dir.is_empty() { None } else { Some(a.root_dir.as_str()) };
            let file = a.compose_file.as_deref().unwrap_or("");
            state.docker.compose_stop(&id, file, root).ok();
        }
    } else if is_docker {
        state.docker.stop(&id).ok();
    } else if !is_static && !is_proxy {
        state.processes.stop(&id).ok();
    }
    // Tear down any worktree instances first. The app_instances FK cascade is
    // inert (PRAGMA foreign_keys is off), so without this an instance would
    // outlive its app as a leaked process + reserved port + orphaned row — with
    // no UI card left to Stop it.
    let instance_ids: Vec<String> = state
        .db
        .lock()
        .unwrap()
        .list_instances_for(&id)
        .unwrap_or_default()
        .into_iter()
        .map(|i| i.id)
        .collect();
    for iid in &instance_ids {
        state.processes.stop(iid).ok();
        state.db.lock().unwrap().delete_instance(iid).ok();
    }
    state.db.lock().unwrap().delete_app(&id).map_err(|e| e.to_string())?;
    // Remove any pasted compose YAML Porta was managing for this app.
    super::compose::cleanup_managed_compose(&id);
    sync_caddy(&state)?;
    crate::backup::auto_backup(&state.db_path).ok();
    Ok(())
}
