use std::path::PathBuf;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use nix::sys::signal::{kill, Signal};
use nix::unistd::Pid;
use tauri::State;
use uuid::Uuid;

use tauri::Emitter;

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

/// Spawns a background thread that polls `port` via TCP until it accepts a connection,
/// then emits `app:ready:{id}`. Times out after 60 s and emits anyway (non-HTTP apps).
pub fn spawn_port_watcher(handle: tauri::AppHandle, id: String, port: u16) {
    thread::spawn(move || {
        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
        for _ in 0..120 {
            thread::sleep(Duration::from_millis(500));
            if std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok() {
                handle.emit(&format!("app:ready:{}", id), ()).ok();
                return;
            }
        }
        // Timeout — emit anyway so the dot doesn't stay amber forever
        handle.emit(&format!("app:ready:{}", id), ()).ok();
    });
}

/// Public Tauri command — lets the frontend trigger a Caddy config reload.
#[tauri::command]
pub fn reload_caddy(state: State<AppState>) -> Result<(), String> {
    sync_caddy(&state)
}

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

    // Regenerate certs so the new workspace domain gets its own wildcard
    if crate::setup::certs_exist() {
        let domains = workspace_domains(&state)?;
        crate::setup::generate_certs(&domains).ok(); // best-effort
        sync_caddy(&state).ok();
    }

    backup::auto_backup(&state.db_path).ok();
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
    backup::auto_backup(&state.db_path).ok();
    Ok(Workspace { id, name, domain })
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
        env_file: None,
        auto_start: false,
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
pub fn update_app(
    state: State<AppState>,
    id: String,
    name: String,
    port: u16,
    subdomain: Option<String>,
    start_command: String,
    env_file: Option<String>,
    auto_start: bool,
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
        )
        .map_err(|e| e.to_string())?;
    sync_caddy(&state)?;
    backup::auto_backup(&state.db_path).ok();

    let apps = state.db.lock().unwrap().list_apps().map_err(|e| e.to_string())?;
    apps.into_iter().find(|a| a.id == id).ok_or_else(|| "app not found".into())
}

#[tauri::command]
pub fn open_in_editor(root_dir: String) -> Result<(), String> {
    // Try editors in order: cursor, code, zed, then fall back to Finder
    let editors = ["cursor", "code", "zed"];
    for editor in &editors {
        if std::process::Command::new(editor)
            .arg(&root_dir)
            .spawn()
            .is_ok()
        {
            return Ok(());
        }
    }
    // Fallback: open in Finder
    std::process::Command::new("open")
        .arg(&root_dir)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
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
pub fn start_app(state: State<AppState>, app: tauri::AppHandle, id: String) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    let apps = db.list_apps().map_err(|e| e.to_string())?;
    let app_data = apps
        .iter()
        .find(|a| a.id == id)
        .ok_or_else(|| format!("app {} not found", id))?
        .clone();
    drop(db);

    let log_id = id.clone();
    let log_handle = app.clone();
    let on_log = move |line: String| {
        log_handle.emit(&format!("app:log:{}", log_id), line).ok();
    };

    let exit_id = id.clone();
    let exit_handle = app.clone();
    let on_exit = move |exit_code: i32| {
        exit_handle.emit(&format!("app:exit:{}", exit_id), exit_code).ok();
    };

    let pid = state
        .processes
        .start(
            &id,
            &app_data.start_command,
            std::path::Path::new(&app_data.root_dir),
            app_data.port,
            app_data.env_file.as_deref(),
            on_log,
            on_exit,
        )
        .map_err(|e| e.to_string())?;

    state
        .db
        .lock()
        .unwrap()
        .update_app_status(&id, "starting", Some(pid))
        .map_err(|e| e.to_string())?;

    spawn_port_watcher(app, id, app_data.port);
    Ok(())
}

/// Called by the frontend when `app:ready:{id}` fires — transitions starting → running.
#[tauri::command]
pub fn mark_app_ready(state: State<AppState>, id: String) -> Result<(), String> {
    state
        .db
        .lock()
        .unwrap()
        .update_app_status_only(&id, "running")
        .map_err(|e| e.to_string())
}

/// Called by the frontend when it receives an app:exit event, to sync DB status.
#[tauri::command]
pub fn mark_app_stopped(state: State<AppState>, id: String) -> Result<(), String> {
    state
        .db
        .lock()
        .unwrap()
        .update_app_status(&id, "stopped", None)
        .map_err(|e| e.to_string())
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

/// Kill an arbitrary PID with SIGKILL (e.g. a build-lock holder found in logs).
#[tauri::command]
pub fn kill_pid(pid: u32) -> Result<(), String> {
    kill(Pid::from_raw(pid as i32), Signal::SIGKILL).map_err(|e| e.to_string())
}

/// Kill whatever process is currently holding `port` (e.g. a leftover dev server).
/// Uses `lsof -ti tcp:{port}` to find the PID, then sends SIGKILL.
#[tauri::command]
pub fn kill_port_holder(port: u16) -> Result<u32, String> {
    let output = std::process::Command::new("lsof")
        .args(["-ti", &format!("tcp:{}", port)])
        .output()
        .map_err(|e| e.to_string())?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let pid_str = stdout.lines().next().unwrap_or("").trim().to_string();
    if pid_str.is_empty() {
        return Err(format!("No process found on port {}", port));
    }
    let pid: u32 = pid_str.parse().map_err(|_| format!("Invalid PID: {}", pid_str))?;
    kill(Pid::from_raw(pid as i32), Signal::SIGKILL).map_err(|e| e.to_string())?;
    Ok(pid)
}

#[tauri::command]
pub fn kill_app(state: State<AppState>, id: String) -> Result<(), String> {
    state.processes.kill(&id).map_err(|e| e.to_string())?;
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
                env_file: None,
                auto_start: false,
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
