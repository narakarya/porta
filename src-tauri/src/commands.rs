use std::collections::HashMap;
use std::io::BufRead;
use std::os::unix::io::RawFd;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;
use tauri::Manager as _;
use nix::sys::signal::{kill, Signal};
use nix::unistd::Pid;
use tauri::State;
use uuid::Uuid;

use tauri::Emitter;

use crate::auto_detect::{DetectResult, CommandSuggestion};
use crate::backup::{self, PortaFile};
use crate::db::{
    models::{App, Workspace},
    Database,
};
use crate::port_scanner::find_available_port;
use crate::setup::SetupStatus;

pub use crate::app_state::AppState;

// ── Terminal session store ────────────────────────────────────────────────────

struct TerminalHandle {
    master_fd: RawFd,
    child_pid: u32,
}

fn terminals() -> &'static Mutex<HashMap<String, TerminalHandle>> {
    static T: OnceLock<Mutex<HashMap<String, TerminalHandle>>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(HashMap::new()))
}

// ── Porta config (notifications enabled, etc.) ───────────────────────────────

fn porta_config_path() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    std::path::PathBuf::from(home).join(".porta").join("config.json")
}

fn read_porta_config() -> serde_json::Value {
    std::fs::read_to_string(porta_config_path())
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| serde_json::json!({}))
}

fn write_porta_config(cfg: &serde_json::Value) {
    let path = porta_config_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    std::fs::write(&path, serde_json::to_string_pretty(cfg).unwrap_or_default()).ok();
}

fn notifications_enabled() -> bool {
    read_porta_config()["notifications_enabled"].as_bool().unwrap_or(true)
}

pub fn notify_crash(app: &tauri::AppHandle, app_name: &str, exit_code: i32) {
    notify(app, &format!("{} crashed", app_name), &format!("Exit code: {exit_code}"));
}

fn notify(app: &tauri::AppHandle, title: &str, body: &str) {
    if !notifications_enabled() { return; }
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .ok();
}

#[tauri::command]
pub fn get_notifications_enabled() -> bool {
    notifications_enabled()
}

#[tauri::command]
pub fn set_notifications_enabled(enabled: bool) {
    let mut cfg = read_porta_config();
    cfg["notifications_enabled"] = serde_json::json!(enabled);
    write_porta_config(&cfg);
}

/// Returns whether Caddy is currently running (listens on 443).
#[tauri::command]
pub fn caddy_status() -> bool {
    crate::setup::check().caddy_running
}

/// Detect Google Drive Desktop mount on macOS.
/// Looks for ~/Library/CloudStorage/GoogleDrive-*/My Drive
#[tauri::command]
pub fn detect_gdrive_path() -> Option<String> {
    let home = std::env::var("HOME").ok()?;
    let cloud_storage = std::path::Path::new(&home).join("Library/CloudStorage");
    for entry in std::fs::read_dir(&cloud_storage).ok()?.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str.starts_with("GoogleDrive-") {
            let candidate = entry.path().join("My Drive");
            if candidate.exists() {
                return Some(candidate.to_string_lossy().to_string());
            }
        }
    }
    None
}

// ── Port watcher ──────────────────────────────────────────────────────────────

/// Block the calling thread until `port` accepts a TCP connection or `timeout_ms` elapses.
/// Used to wait for a dependency app to be ready before starting dependents.
pub(crate) fn wait_for_port(port: u16, timeout_ms: u64) {
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let steps = timeout_ms / 500;
    for _ in 0..steps {
        thread::sleep(Duration::from_millis(500));
        if std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok() {
            return;
        }
    }
}

/// Start a single app process without dependency resolution.
/// Can be called from any thread via `handle.state::<AppState>()`.
pub(crate) fn start_single(handle: &tauri::AppHandle, app_data: &App, truncate_log: bool) -> Result<(), String> {
    let state: State<AppState> = handle.state();
    let id = &app_data.id;

    let log_id = id.clone();
    let log_handle = handle.clone();
    let on_log = move |line: String| {
        log_handle.emit(&format!("app:log:{}", log_id), line).ok();
    };

    let exit_id = id.clone();
    let exit_handle = handle.clone();
    let exit_name = app_data.name.clone();
    let on_exit = move |exit_code: i32, is_stop: bool| {
        let reported = if is_stop { 0 } else { exit_code };
        exit_handle.emit(&format!("app:exit:{}", exit_id), reported).ok();
        if exit_code != 0 && !is_stop {
            notify(&exit_handle, &format!("{} crashed", exit_name), &format!("Exit code: {exit_code}"));
        }
    };

    let pid = state
        .processes
        .start(
            id,
            &app_data.start_command,
            Path::new(&app_data.root_dir),
            app_data.port,
            app_data.env_file.as_deref(),
            &app_data.env_vars,
            truncate_log,
            on_log,
            on_exit,
        )
        .map_err(|e| e.to_string())?;

    state
        .db
        .lock()
        .unwrap()
        .update_app_status(id, "starting", Some(pid))
        .map_err(|e| e.to_string())?;

    spawn_port_watcher(handle.clone(), id.clone(), app_data.port, app_data.name.clone());
    Ok(())
}

/// Spawns a background thread that polls `port` via TCP until it accepts a connection,
/// then emits `app:ready:{id}` and sends a macOS notification if enabled.
/// Times out after 60 s and emits anyway (non-HTTP apps).
pub fn spawn_port_watcher(handle: tauri::AppHandle, id: String, port: u16, app_name: String) {
    thread::spawn(move || {
        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
        for _ in 0..120 {
            thread::sleep(Duration::from_millis(500));
            if std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok() {
                handle.emit(&format!("app:ready:{}", id), ()).ok();
                notify(&handle, &format!("{} is ready", app_name), &format!("Running on :{port}"));
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
    // Flatten: each extra subdomain becomes its own (hostname, port) route
    let routes: Vec<(String, u16)> = apps
        .iter()
        .flat_map(|a| a.all_hosts(&workspaces).into_iter().map(move |h| (h, a.port)))
        .collect();
    drop(db);
    state.caddy.reload(&routes).map_err(|e| e.to_string())
}

// ── Setup ─────────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn check_setup() -> SetupStatus {
    crate::setup::check()
}

/// Silently try to start Caddy without running the full wizard.
/// Used for auto-recovery on launch. Will show macOS admin prompt if certs exist.
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
    let w = Workspace { id: Uuid::new_v4().to_string(), name, domain, deployment: None };
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
    Ok(Workspace { id, name, domain, deployment: None })
}

#[tauri::command]
pub fn delete_workspace(state: State<AppState>, id: String) -> Result<(), String> {
    state.db.lock().unwrap().delete_workspace(&id).map_err(|e| e.to_string())?;
    sync_caddy(&state)?;
    backup::auto_backup(&state.db_path).ok();
    Ok(())
}

#[tauri::command]
pub fn reorder_workspaces(state: State<AppState>, ids: Vec<String>) -> Result<(), String> {
    state.db.lock().unwrap().reorder_workspaces(&ids).map_err(|e| e.to_string())
}

// ── Apps ──────────────────────────────────────────────────────────────────────

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
        tunnel_provider: None,
        tunnel_url: None,
        tunnel_active: false,
        deploy_config_path: None,
        deploy_custom_commands: vec![],
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
        )
        .map_err(|e| e.to_string())?;
    sync_caddy(&state)?;
    backup::auto_backup(&state.db_path).ok();

    let apps = state.db.lock().unwrap().list_apps().map_err(|e| e.to_string())?;
    apps.into_iter().find(|a| a.id == id).ok_or_else(|| "app not found".into())
}

/// Write `contents` to `path` on disk (used for export-to-chosen-location).
#[tauri::command]
pub fn save_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| e.to_string())
}

/// Reveal a file or folder in Finder (macOS `open -R`).
#[tauri::command]
pub fn reveal_in_finder(path: String) -> Result<(), String> {
    std::process::Command::new("open")
        .args(["-R", &path])
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
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

    // Collect dependencies that are not already running or starting
    let unstarted_deps: Vec<App> = app_data
        .depends_on
        .iter()
        .filter_map(|dep_id| apps.iter().find(|a| a.id == *dep_id).cloned())
        .filter(|dep| dep.status != "running" && dep.status != "starting")
        .collect();

    let tray_db_path = state.db_path.clone();

    if unstarted_deps.is_empty() {
        // Fast path: all dependencies already up
        start_single(&app, &app_data, true)?;
        let tray_handle = app.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(200));
            rebuild_tray_menu(&tray_handle, &tray_db_path);
        });
    } else {
        // Slow path: start each unstarted dependency, wait for its port to open,
        // then start the requested app. Runs in a background thread so start_app
        // returns immediately and the frontend sees the "starting" state.
        let handle = app.clone();
        thread::spawn(move || {
            for dep in &unstarted_deps {
                if start_single(&handle, dep, true).is_ok() {
                    // Wait up to 30 s for the dependency to be TCP-ready
                    wait_for_port(dep.port, 30_000);
                }
            }
            start_single(&handle, &app_data, true).ok();
            thread::sleep(Duration::from_millis(200));
            rebuild_tray_menu(&handle, &tray_db_path);
        });
    }

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

/// Returns all log lines written by this app's process (persisted to disk).
/// Called on startup (to replay into Zustand) and on-demand when the LogViewer opens.
#[tauri::command]
pub fn get_app_logs(id: String) -> Vec<String> {
    let path = crate::process_manager::log_file_path(&id);
    let Ok(bytes) = std::fs::read(&path) else { return vec![] };
    String::from_utf8_lossy(&bytes)
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| l.to_string())
        .collect()
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
pub fn stop_app(state: State<AppState>, app: tauri::AppHandle, id: String) -> Result<(), String> {
    state.processes.stop(&id).map_err(|e| e.to_string())?;
    state
        .db
        .lock()
        .unwrap()
        .update_app_status(&id, "stopped", None)
        .map_err(|e| e.to_string())?;

    let tray_handle = app.clone();
    let tray_db_path = state.db_path.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(200));
        rebuild_tray_menu(&tray_handle, &tray_db_path);
    });

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
pub fn restart_app(state: State<AppState>, app: tauri::AppHandle, id: String) -> Result<(), String> {
    // Block until process is confirmed dead so the port is free before we start fresh.
    // Falls back to SIGKILL at 1.5 s and returns after 3 s max.
    state.processes.stop_and_wait(&id, 3000).ok();
    state.db.lock().unwrap().update_app_status(&id, "stopped", None).map_err(|e| e.to_string())?;

    // Then start fresh — reuse start_app logic
    start_app(state, app, id)
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
                env_vars: std::collections::HashMap::new(),
                restart_policy: "on-failure".into(),
                max_retries: 3,
                health_check_path: None,
                depends_on: vec![],
                extra_subdomains: a.extra_subdomains.clone(),
                tunnel_provider: None,
                tunnel_url: None,
                tunnel_active: false,
                deploy_config_path: None,
                deploy_custom_commands: vec![],
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
                .filter(|e| e.path().extension().is_some_and(|x| x == "db"))
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

// ── Kamal ─────────────────────────────────────────────────────────────────────

/// Check if the `kamal` binary is in PATH. Returns { installed, version }.
#[tauri::command]
pub fn check_kamal() -> serde_json::Value {
    // Try direct binary first (gem-installed kamal)
    if let Ok(out) = std::process::Command::new("kamal").arg("version").output() {
        if out.status.success() {
            let raw = String::from_utf8_lossy(&out.stdout);
            return serde_json::json!({ "installed": true, "version": raw.trim() });
        }
    }

    // Fall back to shell check — handles zsh aliases (e.g. Docker-based kamal),
    // rbenv/asdf shims, or any other shell-level kamal wrapper.
    // `type kamal` returns zero exit if kamal resolves (binary, alias, function, etc.)
    if let Ok(out) = std::process::Command::new("zsh")
        .args(["-i", "-c", "type kamal 2>/dev/null"])
        .output()
    {
        if out.status.success() {
            let stdout = String::from_utf8_lossy(&out.stdout);
            if !stdout.is_empty() && !stdout.contains("not found") {
                // Can't easily get version from an alias without running it;
                // return null version but mark as installed.
                return serde_json::json!({ "installed": true, "version": null });
            }
        }
    }

    serde_json::json!({ "installed": false, "version": null })
}

// ── Google Drive OAuth ────────────────────────────────────────────────────────
// Uses the "installed app" OAuth 2.0 flow.
// Client credentials are stored at runtime in ~/.porta/config.json
// (set via `set_gdrive_credentials`).

fn gdrive_token_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("gdrive_token.json"))
}

/// Persist the user's Google OAuth client_id + client_secret to porta config.
#[tauri::command]
pub fn set_gdrive_credentials(client_id: String, client_secret: String) {
    let mut cfg = read_porta_config();
    cfg["gdrive_client_id"] = serde_json::json!(client_id);
    cfg["gdrive_client_secret"] = serde_json::json!(client_secret);
    write_porta_config(&cfg);
}

/// Return the currently configured gdrive client_id (empty string if not set).
#[tauri::command]
pub fn get_gdrive_credentials() -> serde_json::Value {
    let cfg = read_porta_config();
    serde_json::json!({
        "client_id": cfg["gdrive_client_id"].as_str().unwrap_or(""),
        "client_secret": cfg["gdrive_client_secret"].as_str().unwrap_or(""),
    })
}

#[tauri::command]
pub async fn gdrive_connect(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    // Priority: build-time env vars → runtime config (~/.porta/config.json)
    // Developers embed credentials via GDRIVE_CLIENT_ID/GDRIVE_CLIENT_SECRET
    // at build time so end users never see any credential setup.
    let build_client_id     = option_env!("GDRIVE_CLIENT_ID").unwrap_or("");
    let build_client_secret = option_env!("GDRIVE_CLIENT_SECRET").unwrap_or("");

    let cfg = read_porta_config();
    let client_id = if !build_client_id.is_empty() {
        build_client_id.to_string()
    } else {
        cfg["gdrive_client_id"].as_str().unwrap_or("").to_string()
    };
    let client_secret = if !build_client_secret.is_empty() {
        build_client_secret.to_string()
    } else {
        cfg["gdrive_client_secret"].as_str().unwrap_or("").to_string()
    };

    if client_id.is_empty() {
        return Err("not_configured".to_string());
    }

    // Bind a local port for the OAuth redirect
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect_uri = format!("http://127.0.0.1:{}/callback", port);

    // Build consent URL
    let auth_url = reqwest::Url::parse_with_params(
        "https://accounts.google.com/o/oauth2/v2/auth",
        &[
            ("client_id",     client_id.as_str()),
            ("redirect_uri",  redirect_uri.as_str()),
            ("response_type", "code"),
            ("scope",         "https://www.googleapis.com/auth/drive.file email"),
            ("access_type",   "offline"),
            ("prompt",        "consent"),
        ],
    )
    .map_err(|e| e.to_string())?
    .to_string();

    // Open browser (macOS)
    std::process::Command::new("open")
        .arg(&auth_url)
        .spawn()
        .map_err(|e| format!("Cannot open browser: {e}"))?;

    // Wait up to 5 minutes for the redirect
    let code = tokio::time::timeout(
        std::time::Duration::from_secs(300),
        accept_oauth_code(listener),
    )
    .await
    .map_err(|_| "Google auth timed out (5 min). Please try again.")?
    .map_err(|e| e.to_string())?;

    // Exchange code for tokens
    let client = reqwest::Client::new();
    let token_resp: serde_json::Value = client
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("code",          code.as_str()),
            ("client_id",     client_id.as_str()),
            ("client_secret", client_secret.as_str()),
            ("redirect_uri",  redirect_uri.as_str()),
            ("grant_type",    "authorization_code"),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    if let Some(err) = token_resp["error"].as_str() {
        return Err(format!("Token exchange failed: {err}"));
    }

    let access_token = token_resp["access_token"].as_str().unwrap_or("").to_string();

    // Fetch user email
    let user_info: serde_json::Value = client
        .get("https://www.googleapis.com/oauth2/v3/userinfo")
        .bearer_auth(&access_token)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    let email = user_info["email"].as_str().unwrap_or("").to_string();

    // Persist token
    let stored = serde_json::json!({
        "access_token":  access_token,
        "refresh_token": token_resp["refresh_token"],
        "email":         email,
    });
    if let Some(path) = gdrive_token_path(&app) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        std::fs::write(&path, serde_json::to_string(&stored).unwrap_or_default()).ok();
    }

    Ok(serde_json::json!({ "email": email }))
}

/// Accept one HTTP request from the local OAuth redirect and extract the `code` query param.
async fn accept_oauth_code(
    listener: tokio::net::TcpListener,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let (mut stream, _) = listener.accept().await?;
    let mut buf = vec![0u8; 4096];
    let n = stream.read(&mut buf).await?;
    let request = String::from_utf8_lossy(&buf[..n]);

    // GET /callback?code=XXX HTTP/1.1
    let code = request
        .lines()
        .find(|l| l.starts_with("GET "))
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|path| path.split_once('?').map(|(_, q)| q))
        .and_then(|query| {
            query.split('&').find_map(|kv| {
                kv.strip_prefix("code=").map(|v| v.to_string())
            })
        })
        .ok_or("No 'code' in OAuth redirect")?;

    let html = b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n\
        <html><body style='font-family:sans-serif;padding:2rem'>\
        <h2 style='color:#22c55e'>Connected!</h2>\
        <p>Google Drive is now linked to Porta. You can close this tab.</p>\
        </body></html>";
    stream.write_all(html).await.ok();

    Ok(code)
}

#[tauri::command]
pub fn gdrive_status(app: tauri::AppHandle) -> serde_json::Value {
    if let Some(path) = gdrive_token_path(&app) {
        if let Ok(raw) = std::fs::read_to_string(&path) {
            if let Ok(token) = serde_json::from_str::<serde_json::Value>(&raw) {
                let email = token["email"].as_str().unwrap_or("").to_string();
                if !email.is_empty() {
                    return serde_json::json!({ "connected": true, "email": email });
                }
            }
        }
    }
    serde_json::json!({ "connected": false, "email": null })
}

#[tauri::command]
pub fn gdrive_disconnect(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(path) = gdrive_token_path(&app) {
        if path.exists() {
            std::fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

// ── Docker service commands ───────────────────────────────────────────────────

/// Resolve the docker binary path. Docker Desktop on macOS puts the CLI at
/// /usr/local/bin/docker (Intel) or the same path via symlink (Apple Silicon).
fn find_docker() -> String {
    for p in &["/usr/local/bin/docker", "/opt/homebrew/bin/docker", "/usr/bin/docker"] {
        if std::path::Path::new(p).exists() {
            return p.to_string();
        }
    }
    "docker".to_string()
}

fn docker_container_running(container_name: &str) -> bool {
    std::process::Command::new(find_docker())
        .args(["inspect", "--format={{.State.Running}}", container_name])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "true")
        .unwrap_or(false)
}

#[tauri::command]
pub fn list_services(state: State<AppState>) -> Result<Vec<crate::db::models::Service>, String> {
    let mut services = state.db.lock().unwrap().list_services().map_err(|e| e.to_string())?;

    // Reconcile: mark containers stale if they're no longer running in Docker
    let stale_ids: Vec<String> = services.iter()
        .filter(|s| s.status == "running")
        .filter(|s| !docker_container_running(&format!("porta-{}", s.id)))
        .map(|s| s.id.clone())
        .collect();

    if !stale_ids.is_empty() {
        let db = state.db.lock().unwrap();
        for id in &stale_ids {
            db.update_service_status(id, "stopped", None).ok();
        }
    }

    for svc in services.iter_mut() {
        if stale_ids.contains(&svc.id) {
            svc.status = "stopped".to_string();
            svc.container_id = None;
        }
    }

    Ok(services)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn add_service(
    name: String, image: String, tag: String, port: u16,
    env_vars: HashMap<String, String>, volumes: Vec<String>, scope: String,
    state: State<AppState>,
) -> Result<crate::db::models::Service, String> {
    let svc = crate::db::models::Service {
        id: Uuid::new_v4().to_string(),
        name, image, tag, port, env_vars, volumes, scope,
        status: "stopped".to_string(),
        container_id: None,
    };
    state.db.lock().unwrap().insert_service(&svc).map_err(|e| e.to_string())?;
    Ok(svc)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn update_service(
    id: String, name: String, image: String, tag: String, port: u16,
    env_vars: HashMap<String, String>, volumes: Vec<String>, scope: String,
    state: State<AppState>,
) -> Result<crate::db::models::Service, String> {
    state.db.lock().unwrap()
        .update_service(&id, &name, &image, &tag, port, &env_vars, &volumes, &scope)
        .map_err(|e| e.to_string())?;
    // Return updated record
    state.db.lock().unwrap().list_services()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|s| s.id == id)
        .ok_or_else(|| "Service not found after update".to_string())
}

#[tauri::command]
pub fn delete_service(id: String, state: State<AppState>) -> Result<(), String> {
    // Stop container if it's running (fire-and-forget, don't fail delete on docker error)
    let container_name = format!("porta-{}", id);
    let _ = std::process::Command::new(find_docker())
        .args(["stop", &container_name])
        .output();

    state.db.lock().unwrap().delete_service(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn reorder_services(state: State<AppState>, ids: Vec<String>) -> Result<(), String> {
    state.db.lock().unwrap().reorder_services(&ids).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn start_service(
    id: String,
    state: State<AppState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let svc = state.db.lock().unwrap().list_services()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|s| s.id == id)
        .ok_or_else(|| "Service not found".to_string())?;

    // Immediately mark as pulling
    state.db.lock().unwrap()
        .update_service_status(&id, "pulling", None)
        .map_err(|e| e.to_string())?;

    let db_path = state.db_path.clone();

    thread::spawn(move || {
        let docker = find_docker();

        let emit_status = |status: &str, container_id: Option<&str>| {
            app_handle.emit(&format!("service:status:{}", id), serde_json::json!({
                "status": status,
                "container_id": container_id
            })).ok();
        };
        let emit_log = |line: &str| {
            app_handle.emit(&format!("service:log:{}", id), line).ok();
        };

        let fail = |_reason: &str, db_path: &PathBuf, id: &str| {
            if let Ok(db) = crate::db::Database::open(db_path.clone()) {
                db.update_service_status(id, "stopped", None).ok();
            }
        };

        // ── 1. Pull image ────────────────────────────────────────────────────
        emit_status("pulling", None);
        let image_ref = format!("{}:{}", svc.image, svc.tag);
        emit_log(&format!("Pulling {}…", image_ref));

        let mut pull = match std::process::Command::new(&docker)
            .args(["pull", &image_ref])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                emit_log(&format!("[err] Cannot start docker: {e}. Is Docker Desktop running?"));
                emit_status("stopped", None);
                fail("spawn pull", &db_path, &id);
                return;
            }
        };

        // Stream pull output
        if let Some(stdout) = pull.stdout.take() {
            for line in std::io::BufReader::new(stdout).lines().map_while(Result::ok) {
                emit_log(&line);
            }
        }
        if let Some(stderr) = pull.stderr.take() {
            for line in std::io::BufReader::new(stderr).lines().map_while(Result::ok) {
                if !line.trim().is_empty() { emit_log(&format!("[err] {line}")); }
            }
        }
        match pull.wait() {
            Ok(s) if !s.success() => {
                emit_log(&format!("[err] docker pull exited {}", s.code().unwrap_or(-1)));
                emit_status("stopped", None);
                fail("pull failed", &db_path, &id);
                return;
            }
            Err(e) => {
                emit_log(&format!("[err] {e}"));
                emit_status("stopped", None);
                fail("pull wait", &db_path, &id);
                return;
            }
            _ => {}
        }

        // ── 2. Run container ─────────────────────────────────────────────────
        emit_status("starting", None);
        let container_name = format!("porta-{}", id);

        // Remove any leftover container from a previous run
        let _ = std::process::Command::new(&docker)
            .args(["rm", "-f", &container_name])
            .output();

        let mut run_args: Vec<String> = vec![
            "run".into(), "-d".into(),
            "--name".into(), container_name.clone(),
            "-p".into(), format!("{}:{}", svc.port, svc.port),
        ];
        for (k, v) in &svc.env_vars {
            run_args.push("-e".into());
            run_args.push(format!("{k}={v}"));
        }
        for vol in &svc.volumes {
            if !vol.trim().is_empty() {
                run_args.push("-v".into());
                run_args.push(vol.clone());
            }
        }
        run_args.push(image_ref.clone());

        let run_out = std::process::Command::new(&docker)
            .args(&run_args)
            .output();

        let container_id = match run_out {
            Err(e) => {
                emit_log(&format!("[err] docker run: {e}"));
                emit_status("stopped", None);
                fail("run error", &db_path, &id);
                return;
            }
            Ok(o) if !o.status.success() => {
                let msg = String::from_utf8_lossy(&o.stderr).trim().to_string();
                emit_log(&format!("[err] {msg}"));
                emit_status("stopped", None);
                fail("run failed", &db_path, &id);
                return;
            }
            Ok(o) => {
                let full_id = String::from_utf8_lossy(&o.stdout).trim().to_string();
                // Store first 12 chars of container ID (standard Docker short ID)
                full_id[..full_id.len().min(12)].to_string()
            }
        };

        // Update DB + emit running
        if let Ok(db) = crate::db::Database::open(db_path.clone()) {
            db.update_service_status(&id, "running", Some(&container_id)).ok();
        }
        emit_log(&format!("Container started ({container_id})"));
        emit_status("running", Some(&container_id));

        // ── 3. Stream container logs ─────────────────────────────────────────
        let mut logs = match std::process::Command::new(&docker)
            .args(["logs", "-f", &container_name])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
        {
            Ok(c) => c,
            Err(_) => return,
        };

        let stdout = logs.stdout.take();
        let stderr = logs.stderr.take();

        let id2 = id.clone();
        let handle2 = app_handle.clone();
        if let Some(out) = stdout {
            thread::spawn(move || {
                for line in std::io::BufReader::new(out).lines().map_while(Result::ok) {
                    handle2.emit(&format!("service:log:{}", id2), &line).ok();
                }
            });
        }
        let id3 = id.clone();
        let handle3 = app_handle.clone();
        if let Some(err) = stderr {
            thread::spawn(move || {
                for line in std::io::BufReader::new(err).lines().map_while(Result::ok) {
                    handle3.emit(&format!("service:log:{}", id3), format!("[err] {line}")).ok();
                }
            });
        }

        // When logs process exits, the container has stopped
        let _ = logs.wait();
        if let Ok(db) = crate::db::Database::open(db_path) {
            db.update_service_status(&id, "stopped", None).ok();
        }
        app_handle.emit(&format!("service:status:{}", id), serde_json::json!({
            "status": "stopped",
            "container_id": null
        })).ok();
    });

    Ok(())
}

#[tauri::command]
pub fn stop_service(id: String, state: State<AppState>) -> Result<(), String> {
    let container_name = format!("porta-{}", id);

    // docker stop — graceful SIGTERM then SIGKILL after 10s
    let _ = std::process::Command::new(find_docker())
        .args(["stop", &container_name])
        .output();

    state.db.lock().unwrap()
        .update_service_status(&id, "stopped", None)
        .map_err(|e| e.to_string())
}

/// Determine the working directory for a kamal config path.
/// If path ends in /config/deploy.yml → two parents up, otherwise one parent up.
fn kamal_work_dir(config_path: &str) -> PathBuf {
    let p = std::path::Path::new(config_path);
    if config_path.ends_with("/config/deploy.yml") {
        p.parent()
            .and_then(|p| p.parent())
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."))
    } else {
        p.parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."))
    }
}

// ── PTY helper ───────────────────────────────────────────────────────────────

/// Spawn `zsh -i -c <cmd>` inside a PTY slave so that Docker-based kamal
/// aliases (which include `docker run -it ...`) don't fail with
/// "the input device is not a TTY".  Allocating a real PTY makes `isatty(0)`
/// return true in every process in the child chain, which is what Docker
/// checks before it honours the `-t` flag.
/// Spawn `cmd_str` inside a PTY and stream output via `on_line`.
/// Returns the child's exit code.
///
/// ## Why two threads?
/// The naive approach — blocking `BufReader::read` on the PTY master until EOF,
/// then calling `child.wait()` — hangs whenever a subprocess (Docker, SSH)
/// inherits the slave fd and keeps it open after the main command finishes.
/// The master never sees EOF, so `child.wait()` is never reached and the
/// caller never emits the `kamal:exit` event.
///
/// Fix: run `child.wait()` concurrently with the PTY drain.  Once the direct
/// child (zsh) exits, close both master fd copies after a short drain window
/// so the reader thread's `libc::read` returns EBADF and unblocks.
fn spawn_pty_command<F>(cmd_str: &str, cwd: &Path, on_line: F) -> Result<i32, String>
where
    F: Fn(String) + Send + Sync + 'static,
{
    use std::os::unix::io::FromRawFd;
    use std::os::unix::process::CommandExt;
    use std::sync::atomic::{AtomicI32, Ordering};

    let (master_fd, slave_fd) = unsafe {
        let mut m: libc::c_int = -1;
        let mut s: libc::c_int = -1;
        if libc::openpty(&mut m, &mut s, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut()) != 0 {
            return Err(format!("openpty: {}", std::io::Error::last_os_error()));
        }
        (m, s)
    };

    let (stdin_fd, stdout_fd, stderr_fd) = unsafe {(
        libc::dup(slave_fd), libc::dup(slave_fd), libc::dup(slave_fd),
    )};
    if stdin_fd < 0 || stdout_fd < 0 || stderr_fd < 0 {
        unsafe { libc::close(slave_fd); libc::close(master_fd); }
        return Err("dup() failed when setting up PTY".into());
    }

    // A second copy of the master — owned by the reader thread via raw reads.
    // The main thread closes both copies after child.wait() + drain period,
    // which causes the reader's libc::read to return an error and unblock.
    let reader_fd = unsafe { libc::dup(master_fd) };
    if reader_fd < 0 {
        unsafe { libc::close(slave_fd); libc::close(master_fd); }
        return Err("dup() for reader failed".into());
    }
    // Share the reader fd atomically so the main thread can close it
    let shared_rfd = Arc::new(AtomicI32::new(reader_fd));
    let shared_rfd2 = Arc::clone(&shared_rfd);

    let mut cmd = std::process::Command::new("zsh");
    cmd.args(["-i", "-c", cmd_str])
       .current_dir(cwd)
       .stdin(unsafe  { std::process::Stdio::from_raw_fd(stdin_fd)  })
       .stdout(unsafe { std::process::Stdio::from_raw_fd(stdout_fd) })
       .stderr(unsafe { std::process::Stdio::from_raw_fd(stderr_fd) });

    unsafe {
        cmd.pre_exec(move || {
            libc::close(slave_fd);
            libc::close(master_fd);
            libc::close(reader_fd); // child doesn't need any master copy
            Ok(())
        });
    }

    let mut child = cmd.spawn().map_err(|e| {
        unsafe { libc::close(slave_fd); libc::close(master_fd); libc::close(reader_fd); }
        format!("spawn: {e}")
    })?;

    // Parent: close the original slave fd — child has its own dup'd copies.
    unsafe { libc::close(slave_fd); }

    // ── Reader thread ─────────────────────────────────────────────────────────
    // Uses raw libc::read so the main thread can close the fd and unblock it.
    // Does NOT own reader_fd via a File wrapper (which would prevent external close).
    let on_line = Arc::new(on_line);
    let on_line_r = Arc::clone(&on_line);
    thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut leftover: Vec<u8> = Vec::new();
        loop {
            let fd = shared_rfd2.load(Ordering::Acquire);
            if fd < 0 { break; }
            let n = unsafe { libc::read(fd, buf.as_mut_ptr() as *mut libc::c_void, buf.len()) };
            if n <= 0 { break; } // EOF, EIO (slave closed), or EBADF (fd closed by main)
            leftover.extend_from_slice(&buf[..n as usize]);
            while let Some(pos) = leftover.iter().position(|&b| b == b'\n') {
                let end = if pos > 0 && leftover[pos - 1] == b'\r' { pos - 1 } else { pos };
                if let Ok(line) = std::str::from_utf8(&leftover[..end]) {
                    if !line.is_empty() { on_line_r(line.to_string()); }
                }
                leftover = leftover[pos + 1..].to_vec();
            }
        }
        // Flush any partial line remaining in the buffer
        if !leftover.is_empty() {
            let end = if leftover.last() == Some(&b'\r') { leftover.len() - 1 } else { leftover.len() };
            if let Ok(line) = std::str::from_utf8(&leftover[..end]) {
                if !line.is_empty() { on_line_r(line.to_string()); }
            }
        }
    });

    // ── Main thread: wait for the direct child (zsh) ──────────────────────────
    // This returns as soon as zsh exits, regardless of Docker/SSH subprocesses.
    let code = child.wait().map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);

    // Short drain window so the reader can flush the last output lines produced
    // by the child just before it exited.
    thread::sleep(Duration::from_millis(250));

    // Close both master copies → reader's next libc::read returns EBADF and stops.
    unsafe { libc::close(master_fd); }
    let rfd = shared_rfd.swap(-1, Ordering::SeqCst);
    if rfd >= 0 { unsafe { libc::close(rfd); } }

    Ok(code)
}

// ── Kamal commands ────────────────────────────────────────────────────────────

/// Run any kamal command. Streams lines to `kamal:log:{run_id}`,
/// emits `kamal:exit:{run_id}` with the exit code when done.
/// Each invocation receives a unique `run_id` so multiple commands
/// can run concurrently with fully isolated event channels.
#[tauri::command]
pub fn kamal_run(
    app: tauri::AppHandle,
    app_id: String,
    config_path: String,
    args: Vec<String>,
    run_id: String,
) -> Result<(), String> {
    let _ = app_id; // kept for API compatibility
    let work_dir = kamal_work_dir(&config_path);
    thread::spawn(move || {
        let kamal_cmd = format!("kamal {}", args.join(" "));
        let log_app = app.clone();
        let log_id  = run_id.clone();
        match spawn_pty_command(&kamal_cmd, &work_dir, move |line| {
            log_app.emit(&format!("kamal:log:{}", log_id), line).ok();
        }) {
            Ok(code) => { app.emit(&format!("kamal:exit:{}", run_id), code).ok(); }
            Err(e)   => {
                app.emit(&format!("kamal:log:{}", run_id), format!("[err] {e}")).ok();
                app.emit(&format!("kamal:exit:{}", run_id), -1i32).ok();
            }
        }
    });
    Ok(())
}

/// Run `gem install kamal`. Streams to `kamal:log:{run_id}`, emits `kamal:exit:{run_id}`.
#[tauri::command]
pub fn install_kamal(app: tauri::AppHandle, app_id: String, run_id: String) -> Result<(), String> {
    let _ = app_id;
    thread::spawn(move || {
        let log_app = app.clone();
        let log_id  = run_id.clone();
        match spawn_pty_command("gem install kamal", std::path::Path::new("/tmp"), move |line| {
            log_app.emit(&format!("kamal:log:{}", log_id), line).ok();
        }) {
            Ok(code) => { app.emit(&format!("kamal:exit:{}", run_id), code).ok(); }
            Err(e)   => {
                app.emit(&format!("kamal:log:{}", run_id), format!("[err] {e}")).ok();
                app.emit(&format!("kamal:exit:{}", run_id), -1i32).ok();
            }
        }
    });
    Ok(())
}

// ── Kamal accessories + custom commands ──────────────────────────────────────

#[tauri::command]
pub fn parse_kamal_accessories(config_path: String) -> Vec<String> {
    let Ok(content) = std::fs::read_to_string(&config_path) else {
        return vec![];
    };
    let Ok(value) = serde_yaml::from_str::<serde_yaml::Value>(&content) else {
        return vec![];
    };
    value
        .get("accessories")
        .and_then(|v| v.as_mapping())
        .map(|m| {
            m.keys()
                .filter_map(|k| k.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

#[tauri::command]
pub fn add_deploy_custom_cmd(
    state: State<AppState>,
    app_id: String,
    cmd: serde_json::Value,
) -> Result<(), String> {
    let new_cmd: crate::db::models::CustomDeployCmd =
        serde_json::from_value(cmd).map_err(|e| e.to_string())?;
    let db = state.db.lock().unwrap();
    let mut cmds = db.get_deploy_custom_cmds(&app_id).map_err(|e| e.to_string())?;
    if cmds.iter().any(|c| c.id == new_cmd.id) {
        return Err("Command with this id already exists".into());
    }
    cmds.push(new_cmd);
    db.set_deploy_custom_cmds(&app_id, &cmds).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_deploy_custom_cmd(
    state: State<AppState>,
    app_id: String,
    cmd: serde_json::Value,
) -> Result<(), String> {
    let updated: crate::db::models::CustomDeployCmd =
        serde_json::from_value(cmd).map_err(|e| e.to_string())?;
    let db = state.db.lock().unwrap();
    let mut cmds = db.get_deploy_custom_cmds(&app_id).map_err(|e| e.to_string())?;
    let pos = cmds.iter().position(|c| c.id == updated.id)
        .ok_or_else(|| "Command not found".to_string())?;
    cmds[pos] = updated;
    db.set_deploy_custom_cmds(&app_id, &cmds).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_deploy_custom_cmd(
    state: State<AppState>,
    app_id: String,
    cmd_id: String,
) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    let mut cmds = db.get_deploy_custom_cmds(&app_id).map_err(|e| e.to_string())?;
    cmds.retain(|c| c.id != cmd_id);
    db.set_deploy_custom_cmds(&app_id, &cmds).map_err(|e| e.to_string())
}

// ── Certificate management ────────────────────────────────────────────────────

/// Re-generate wildcard SSL certificates for all workspace domains.
/// This is idempotent — safe to call even when certs already exist.
#[tauri::command]
pub fn regenerate_certs(state: State<AppState>) -> Result<(), String> {
    let domains = workspace_domains(&state)?;
    crate::setup::generate_certs(&domains).map_err(|e| e.to_string())?;
    sync_caddy(&state).ok();
    Ok(())
}

// ── In-app terminal (PTY shell) ───────────────────────────────────────────────

/// Spawn an interactive `zsh` shell in `root_dir` inside a PTY.
/// Output is streamed to `terminal:data:{app_id}` events as raw bytes (base64).
/// Emits `terminal:exit:{app_id}` when the shell exits.
#[tauri::command]
pub fn terminal_open(
    app: tauri::AppHandle,
    app_id: String,
    root_dir: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    use std::os::unix::io::FromRawFd;
    use std::os::unix::process::CommandExt;

    // Close any existing terminal for this app first.
    terminal_close(app_id.clone())?;

    let (master_fd, slave_fd) = unsafe {
        let mut m: libc::c_int = -1;
        let mut s: libc::c_int = -1;
        let mut ws = libc::winsize {
            ws_row: rows, ws_col: cols, ws_xpixel: 0, ws_ypixel: 0,
        };
        let ret = libc::openpty(
            &mut m, &mut s, std::ptr::null_mut(), std::ptr::null_mut(), &mut ws,
        );
        if ret != 0 {
            return Err(format!("openpty: {}", std::io::Error::last_os_error()));
        }
        (m, s)
    };

    let (stdin_fd, stdout_fd, stderr_fd) = unsafe {(
        libc::dup(slave_fd),
        libc::dup(slave_fd),
        libc::dup(slave_fd),
    )};

    let cwd = std::path::PathBuf::from(&root_dir);
    let mut cmd = std::process::Command::new("zsh");
    cmd.arg("-i")
       .env("TERM", "xterm-256color")
       .current_dir(&cwd)
       .stdin(unsafe  { std::process::Stdio::from_raw_fd(stdin_fd)  })
       .stdout(unsafe { std::process::Stdio::from_raw_fd(stdout_fd) })
       .stderr(unsafe { std::process::Stdio::from_raw_fd(stderr_fd) });

    unsafe {
        cmd.pre_exec(move || {
            libc::close(slave_fd);
            libc::close(master_fd);
            libc::setsid();
            libc::ioctl(0, libc::TIOCSCTTY.into(), 0i32);
            Ok(())
        });
    }

    let child = cmd.spawn().map_err(|e| format!("spawn shell: {e}"))?;
    let child_pid = child.id();

    unsafe { libc::close(slave_fd); }

    // Detach child so we don't leave a zombie — we wait in a background thread.
    let wait_pid = child_pid;
    thread::spawn(move || unsafe { libc::waitpid(wait_pid as i32, std::ptr::null_mut(), 0); });

    terminals().lock().unwrap().insert(app_id.clone(), TerminalHandle { master_fd, child_pid });

    // Stream PTY output to frontend as raw bytes (UTF-8 best-effort).
    let app_clone = app.clone();
    let id_clone  = app_id.clone();
    thread::spawn(move || {
        let mut buf = vec![0u8; 4096];
        loop {
            let n = unsafe {
                libc::read(master_fd, buf.as_mut_ptr() as *mut libc::c_void, buf.len())
            };
            if n <= 0 { break; }
            // Send raw bytes as a Vec<u8> — Tauri serialises to JSON array.
            let chunk: Vec<u8> = buf[..n as usize].to_vec();
            app_clone.emit(&format!("terminal:data:{}", id_clone), chunk).ok();
        }
        // Shell exited or fd closed — clean up.
        terminals().lock().unwrap().remove(&id_clone);
        unsafe { libc::close(master_fd); }
        app_clone.emit(&format!("terminal:exit:{}", id_clone), ()).ok();
    });

    Ok(())
}

/// Write bytes from the frontend keyboard input into the PTY master.
#[tauri::command]
pub fn terminal_write(app_id: String, data: Vec<u8>) -> Result<(), String> {
    let map = terminals().lock().unwrap();
    if let Some(h) = map.get(&app_id) {
        unsafe {
            libc::write(h.master_fd, data.as_ptr() as *const libc::c_void, data.len());
        }
    }
    Ok(())
}

/// Resize the terminal PTY (called when the xterm.js viewport changes).
#[tauri::command]
pub fn terminal_resize(app_id: String, rows: u16, cols: u16) -> Result<(), String> {
    let map = terminals().lock().unwrap();
    if let Some(h) = map.get(&app_id) {
        let ws = libc::winsize { ws_row: rows, ws_col: cols, ws_xpixel: 0, ws_ypixel: 0 };
        unsafe { libc::ioctl(h.master_fd, libc::TIOCSWINSZ, &ws); }
    }
    Ok(())
}

/// Close (and kill) a terminal session.
#[tauri::command]
pub fn terminal_close(app_id: String) -> Result<(), String> {
    if let Some(h) = terminals().lock().unwrap().remove(&app_id) {
        unsafe {
            libc::kill(h.child_pid as i32, libc::SIGHUP);
            libc::kill(h.child_pid as i32, libc::SIGTERM);
            // Close master fd — causes the read thread to get EIO and stop.
            libc::close(h.master_fd);
        }
    }
    Ok(())
}

// ── Tunneling (cloudflared quick tunnels) ─────────────────────────────────────

fn tunnel_pids() -> &'static Mutex<HashMap<String, u32>> {
    static T: OnceLock<Mutex<HashMap<String, u32>>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(HashMap::new()))
}

fn find_cloudflared() -> Option<String> {
    for p in &[
        "/usr/local/bin/cloudflared",
        "/opt/homebrew/bin/cloudflared",
        "/usr/bin/cloudflared",
    ] {
        if std::path::Path::new(p).exists() {
            return Some(p.to_string());
        }
    }
    if let Ok(out) = std::process::Command::new("which").arg("cloudflared").output() {
        if out.status.success() {
            let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !path.is_empty() {
                return Some(path);
            }
        }
    }
    None
}

#[tauri::command]
pub fn check_cloudflared() -> bool {
    find_cloudflared().is_some()
}

#[tauri::command]
pub fn start_tunnel(id: String, port: u16, app_handle: tauri::AppHandle) -> Result<(), String> {
    let cf = find_cloudflared().ok_or_else(|| {
        "cloudflared not installed. Run: brew install cloudflare/cloudflare/cloudflared".to_string()
    })?;

    // Kill any existing tunnel for this app
    {
        let mut pids = tunnel_pids().lock().unwrap();
        if let Some(pid) = pids.remove(&id) {
            let _ = kill(Pid::from_raw(pid as i32), Signal::SIGTERM);
        }
    }

    let id2 = id.clone();
    let handle = app_handle.clone();

    thread::spawn(move || {
        let mut child = match std::process::Command::new(&cf)
            .args(["tunnel", "--url", &format!("http://localhost:{}", port)])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                handle
                    .emit(
                        &format!("app:tunnel:{}", id2),
                        serde_json::json!({ "active": false, "url": null, "error": e.to_string() }),
                    )
                    .ok();
                return;
            }
        };

        tunnel_pids().lock().unwrap().insert(id2.clone(), child.id());

        // cloudflared outputs the assigned URL to stderr
        if let Some(stderr) = child.stderr.take() {
            let id3 = id2.clone();
            let handle2 = handle.clone();
            thread::spawn(move || {
                for line in std::io::BufReader::new(stderr).lines().map_while(Result::ok) {
                    if let Some(pos) = line.find("https://") {
                        let url = line[pos..]
                            .split_whitespace()
                            .next()
                            .unwrap_or("")
                            .trim_end_matches('|')
                            .trim()
                            .to_string();
                        if url.contains("trycloudflare.com") || url.contains(".cloudflare.com") {
                            handle2
                                .emit(
                                    &format!("app:tunnel:{}", id3),
                                    serde_json::json!({ "active": true, "url": url }),
                                )
                                .ok();
                        }
                    }
                }
            });
        }

        let _ = child.wait();

        // Tunnel ended — clean up and notify frontend
        tunnel_pids().lock().unwrap().remove(&id2);
        handle
            .emit(
                &format!("app:tunnel:{}", id2),
                serde_json::json!({ "active": false, "url": null }),
            )
            .ok();
    });

    Ok(())
}

#[tauri::command]
pub fn stop_tunnel(id: String) -> Result<(), String> {
    if let Some(pid) = tunnel_pids().lock().unwrap().remove(&id) {
        let _ = kill(Pid::from_raw(pid as i32), Signal::SIGTERM);
    }
    Ok(())
}

// ── Launch at Login ───────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_launch_at_login(app: tauri::AppHandle) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
pub fn set_launch_at_login(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let mgr = app.autolaunch();
    if enabled {
        mgr.enable().map_err(|e| e.to_string())
    } else {
        mgr.disable().map_err(|e| e.to_string())
    }
}

// ── Google Drive sync (upload backup) ────────────────────────────────────────

async fn get_gdrive_access_token(app: &tauri::AppHandle) -> Result<String, String> {
    let token_path = gdrive_token_path(app).ok_or("no token path")?;
    let raw = std::fs::read_to_string(&token_path)
        .map_err(|_| "Not connected to Google Drive".to_string())?;
    let token: serde_json::Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;

    let refresh_token = token["refresh_token"].as_str().unwrap_or("").to_string();
    if refresh_token.is_empty() {
        return Err("No refresh token — please reconnect Google Drive".to_string());
    }

    let build_client_id = option_env!("GDRIVE_CLIENT_ID").unwrap_or("");
    let build_client_secret = option_env!("GDRIVE_CLIENT_SECRET").unwrap_or("");
    let cfg = read_porta_config();
    let client_id = if !build_client_id.is_empty() {
        build_client_id.to_string()
    } else {
        cfg["gdrive_client_id"].as_str().unwrap_or("").to_string()
    };
    let client_secret = if !build_client_secret.is_empty() {
        build_client_secret.to_string()
    } else {
        cfg["gdrive_client_secret"].as_str().unwrap_or("").to_string()
    };

    if client_id.is_empty() {
        return Err("not_configured".to_string());
    }

    let client = reqwest::Client::new();
    let resp: serde_json::Value = client
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
            ("refresh_token", refresh_token.as_str()),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    if let Some(err) = resp["error"].as_str() {
        return Err(format!("Token refresh failed: {err} — please reconnect Google Drive"));
    }

    resp["access_token"]
        .as_str()
        .ok_or_else(|| "No access_token in response".to_string())
        .map(|s| s.to_string())
}

#[tauri::command]
pub async fn gdrive_sync(app: tauri::AppHandle) -> Result<String, String> {
    let access_token = get_gdrive_access_token(&app).await?;

    // Export current DB state
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    let db_path = std::path::PathBuf::from(home).join(".porta").join("porta.db");
    let db = Database::open(db_path).map_err(|e| e.to_string())?;
    let workspaces = db.list_workspaces().map_err(|e| e.to_string())?;
    let apps = db.list_apps().map_err(|e| e.to_string())?;
    let json = crate::backup::export(&workspaces, &apps).map_err(|e| e.to_string())?;

    let client = reqwest::Client::new();

    // Check if porta-config.json already exists in Drive
    let search: serde_json::Value = client
        .get("https://www.googleapis.com/drive/v3/files")
        .query(&[
            ("q", "name='porta-config.json' and trashed=false"),
            ("fields", "files(id)"),
        ])
        .bearer_auth(&access_token)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    let existing_id = search["files"]
        .as_array()
        .and_then(|f| f.first())
        .and_then(|f| f["id"].as_str())
        .map(|s| s.to_string());

    if let Some(file_id) = existing_id {
        // Overwrite existing file
        client
            .patch(format!(
                "https://www.googleapis.com/upload/drive/v3/files/{}?uploadType=media",
                file_id
            ))
            .bearer_auth(&access_token)
            .header("Content-Type", "application/json")
            .body(json)
            .send()
            .await
            .map_err(|e| e.to_string())?;
    } else {
        // Create new file (multipart: JSON metadata + body)
        let boundary = "porta_multipart_boundary";
        let body = format!(
            "--{b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n\
             {{\"name\":\"porta-config.json\",\"mimeType\":\"application/json\"}}\r\n\
             --{b}\r\nContent-Type: application/json\r\n\r\n{json}\r\n--{b}--",
            b = boundary,
            json = json
        );
        client
            .post("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart")
            .bearer_auth(&access_token)
            .header(
                "Content-Type",
                format!("multipart/related; boundary={}", boundary),
            )
            .body(body)
            .send()
            .await
            .map_err(|e| e.to_string())?;
    }

    Ok(chrono::Utc::now().to_rfc3339())
}

// ── Dynamic tray menu (per-app start/stop) ────────────────────────────────────

/// Rebuild the system tray menu to reflect current app status.
/// Opens a fresh DB connection to avoid holding locks.
pub fn rebuild_tray_menu(app: &tauri::AppHandle, db_path: &Path) {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};

    let Ok(db) = Database::open(db_path.to_path_buf()) else { return };
    let Ok(workspaces) = db.list_workspaces() else { return };
    let Ok(apps) = db.list_apps() else { return };
    let Some(tray) = app.tray_by_id("porta-main") else { return };

    let Ok(menu) = Menu::new(app) else { return };

    let Ok(show) = MenuItem::with_id(app, "show", "Open Dashboard", true, None::<&str>) else {
        return;
    };
    menu.append(&show).ok();

    if !apps.is_empty() {
        let Ok(sep) = PredefinedMenuItem::separator(app) else { return };
        menu.append(&sep).ok();

        for app_data in &apps {
            let ws_name = workspaces
                .iter()
                .find(|w| Some(&w.id) == app_data.workspace_id.as_ref())
                .map(|w| w.name.as_str())
                .unwrap_or("Global");
            let dot = if app_data.status == "running" { "●" } else { "○" };
            let label = format!("{} {}  [{}]", dot, app_data.name, ws_name);
            if let Ok(item) = MenuItem::with_id(
                app,
                format!("toggle-{}", app_data.id),
                label,
                true,
                None::<&str>,
            ) {
                menu.append(&item).ok();
            }
        }
    }

    let Ok(sep2) = PredefinedMenuItem::separator(app) else { return };
    menu.append(&sep2).ok();
    let Ok(quit) = MenuItem::with_id(app, "quit", "Quit Porta", true, None::<&str>) else {
        return;
    };
    menu.append(&quit).ok();

    tray.set_menu(Some(menu)).ok();
}
