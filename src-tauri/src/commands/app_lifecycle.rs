use std::path::Path;
use std::thread;
use std::time::Duration;
use tauri::Emitter;
use tauri::Manager;
use tauri::State;

use crate::app_state::AppState;
use crate::db::models::App;
use super::settings::notify;
use super::rebuild_tray_menu;

/// Block the calling thread until `port` accepts a TCP connection or `timeout_ms` elapses.
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
pub(crate) fn spawn_port_watcher(handle: tauri::AppHandle, id: String, port: u16, app_name: String) {
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

    let unstarted_deps: Vec<App> = app_data
        .depends_on
        .iter()
        .filter_map(|dep_id| apps.iter().find(|a| a.id == *dep_id).cloned())
        .filter(|dep| dep.status != "running" && dep.status != "starting")
        .collect();

    let tray_db_path = state.db_path.clone();

    if unstarted_deps.is_empty() {
        start_single(&app, &app_data, true)?;
        let tray_handle = app.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(200));
            rebuild_tray_menu(&tray_handle, &tray_db_path);
        });
    } else {
        let handle = app.clone();
        thread::spawn(move || {
            for dep in &unstarted_deps {
                if start_single(&handle, dep, true).is_ok() {
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

/// Kill an arbitrary PID with SIGKILL.
#[tauri::command]
pub fn kill_pid(pid: u32) -> Result<(), String> {
    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(pid as i32),
        nix::sys::signal::Signal::SIGKILL,
    )
    .map_err(|e| e.to_string())
}

/// Kill whatever process is currently holding `port`.
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
    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(pid as i32),
        nix::sys::signal::Signal::SIGKILL,
    )
    .map_err(|e| e.to_string())?;
    Ok(pid)
}

#[tauri::command]
pub fn restart_app(state: State<AppState>, app: tauri::AppHandle, id: String) -> Result<(), String> {
    state.processes.stop_and_wait(&id, 3000).ok();
    state.db.lock().unwrap().update_app_status(&id, "stopped", None).map_err(|e| e.to_string())?;
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
