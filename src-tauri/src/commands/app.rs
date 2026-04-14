use tauri::State;
use uuid::Uuid;

use crate::app_state::AppState;
use crate::auto_detect::{DetectResult, CommandSuggestion};
use crate::db::models::{App, PortBinding};
use crate::port_scanner::find_available_port;
use super::setup::sync_caddy;

#[tauri::command]
pub fn list_apps(state: State<AppState>) -> Result<Vec<App>, String> {
    let mut apps = state.db.lock().unwrap().list_apps().map_err(|e| e.to_string())?;
    // Compute deploy_config_path for each app at runtime
    for app in &mut apps {
        let root = std::path::Path::new(&app.root_dir);
        let config_yml = root.join("config").join("deploy.yml");
        let root_yml = root.join("deploy.yml");
        app.deploy_config_path = if config_yml.exists() {
            Some(config_yml.to_string_lossy().into_owned())
        } else if root_yml.exists() {
            Some(root_yml.to_string_lossy().into_owned())
        } else {
            None
        };
    }
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
        tunnel_url: None,
        tunnel_active: false,
        deploy_config_path: None,
        deploy_custom_commands: vec![],
        port_bindings: vec![],
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
) -> Result<App, String> {
    state
        .db
        .lock()
        .unwrap()
        .update_app(
            &id, &name, port,
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
        )
        .map_err(|e| e.to_string())?;
    sync_caddy(&state)?;
    crate::backup::auto_backup(&state.db_path).ok();

    let apps = state.db.lock().unwrap().list_apps().map_err(|e| e.to_string())?;
    apps.into_iter().find(|a| a.id == id).ok_or_else(|| "app not found".into())
}

#[tauri::command]
pub fn delete_app(state: State<AppState>, id: String) -> Result<(), String> {
    state.processes.stop(&id).ok();
    state.db.lock().unwrap().delete_app(&id).map_err(|e| e.to_string())?;
    sync_caddy(&state)?;
    crate::backup::auto_backup(&state.db_path).ok();
    Ok(())
}
