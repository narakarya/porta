use std::path::Path;
use std::thread;
use std::time::Duration;
use tauri::Emitter;
use tauri::Manager;
use tauri::State;

use crate::app_state::AppState;
use crate::db::models::App;
use super::settings::{notify, notify_crash};
use crate::tray::rebuild_tray_menu;

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

    // Capture auto-restart parameters for the on_exit closure
    let exit_id = id.clone();
    let exit_handle = handle.clone();
    let exit_name = app_data.name.clone();
    let restart_policy = app_data.restart_policy.clone();
    let max_retries = app_data.max_retries;
    let on_exit = move |exit_code: i32, is_stop: bool| {
        let reported = if is_stop { 0 } else { exit_code };
        exit_handle.emit(&format!("app:exit:{}", exit_id), reported).ok();

        if is_stop || exit_code == 0 {
            return;
        }

        // Non-zero exit, not intentional stop → crash
        notify_crash(&exit_handle, &exit_name, exit_code);

        // Check if auto-restart is configured
        let should_restart = match restart_policy.as_str() {
            "always" => true,
            "on-failure" => exit_code != 0,
            _ => false, // "never"
        };
        if !should_restart {
            return;
        }

        // Read current retry count from app state, attempt restart
        let state: State<AppState> = exit_handle.state();
        let retry_count = {
            let mut retries = state.processes.retry_counts.lock().unwrap();
            let count = retries.entry(exit_id.clone()).or_insert(0);
            *count += 1;
            *count
        };

        if retry_count > max_retries as u32 {
            // Max retries exhausted
            exit_handle.emit(&format!("app:max-retries:{}", exit_id), max_retries).ok();
            notify(&exit_handle, &format!("{} stopped", exit_name),
                &format!("Max retries ({}) reached", max_retries));
            state.processes.retry_counts.lock().unwrap().remove(&exit_id);
            return;
        }

        // Emit crashed event with attempt number
        exit_handle.emit(&format!("app:crashed:{}", exit_id), retry_count).ok();

        // Auto-restart after a short delay
        let restart_handle = exit_handle.clone();
        let restart_id = exit_id.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_secs(2));
            let state: State<AppState> = restart_handle.state();
            // Re-read app from DB in case it was deleted
            let app_opt = state.db.lock().unwrap().list_apps()
                .ok()
                .and_then(|apps| apps.into_iter().find(|a| a.id == restart_id));
            if let Some(app) = app_opt {
                start_single(&restart_handle, &app, false).ok();
            }
        });
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

    // Reset retry count on successful start
    state.processes.retry_counts.lock().unwrap().remove(id);

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

/// Kill an arbitrary PID with SIGKILL — also try killing the process group.
#[tauri::command]
pub fn kill_pid(pid: u32) -> Result<(), String> {
    let p = nix::unistd::Pid::from_raw(pid as i32);
    // Try killing the process group first (catches child processes)
    let _ = nix::sys::signal::killpg(p, nix::sys::signal::Signal::SIGKILL);
    // Also kill the individual PID in case it's not a group leader
    nix::sys::signal::kill(p, nix::sys::signal::Signal::SIGKILL)
        .map_err(|e| e.to_string())
}

/// Kill whatever process is currently holding `port`.
/// Kills ALL PIDs found on the port (not just the first one).
#[tauri::command]
pub fn kill_port_holder(port: u16) -> Result<u32, String> {
    let output = std::process::Command::new("lsof")
        .args(["-ti", &format!("tcp:{}", port)])
        .output()
        .map_err(|e| e.to_string())?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let pids: Vec<u32> = stdout
        .lines()
        .filter_map(|l| l.trim().parse::<u32>().ok())
        .collect();

    if pids.is_empty() {
        return Err(format!("No process found on port {}", port));
    }

    for &pid in &pids {
        let p = nix::unistd::Pid::from_raw(pid as i32);
        let _ = nix::sys::signal::killpg(p, nix::sys::signal::Signal::SIGKILL);
        let _ = nix::sys::signal::kill(p, nix::sys::signal::Signal::SIGKILL);
    }
    Ok(pids[0])
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
