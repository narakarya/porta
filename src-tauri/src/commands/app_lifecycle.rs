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
    let is_docker_exit = app_data.is_docker();
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

        // Read current retry count from the appropriate manager's counters
        let state: State<AppState> = exit_handle.state();
        let retry_count = {
            let retries_map = if is_docker_exit {
                &state.docker.retry_counts
            } else {
                &state.processes.retry_counts
            };
            let mut retries = retries_map.lock().unwrap();
            let count = retries.entry(exit_id.clone()).or_insert(0);
            *count += 1;
            *count
        };

        if retry_count > max_retries as u32 {
            // Max retries exhausted
            exit_handle.emit(&format!("app:max-retries:{}", exit_id), max_retries).ok();
            notify(&exit_handle, &format!("{} stopped", exit_name),
                &format!("Max retries ({}) reached", max_retries));
            let retries_map = if is_docker_exit {
                &state.docker.retry_counts
            } else {
                &state.processes.retry_counts
            };
            retries_map.lock().unwrap().remove(&exit_id);
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

    if app_data.is_compose() {
        let compose_file = app_data
            .compose_file
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| "compose app has no compose file".to_string())?
            .to_string();
        let root_dir_owned = if app_data.root_dir.is_empty() {
            None
        } else {
            Some(app_data.root_dir.clone())
        };
        let shared_net = if app_data.network_share {
            Some(app_data.workspace_network_name())
        } else {
            None
        };
        // Flip status to "starting" immediately and set the port watcher going
        // so the UI shows a spinner while `docker compose up -d` does the (slow)
        // image pull in a background thread.
        state.docker.retry_counts.lock().unwrap().remove(id);
        // Clear any leftover stop request — this is an intentional start, so
        // the prior compose_stop's flag must not abort us. A Stop click that
        // arrives *after* this point will re-set the flag, and `compose_start`
        // re-reads it after `up -d` to honor the user's intent.
        state.docker.stopping.lock().unwrap().remove(id);
        state
            .db
            .lock()
            .unwrap()
            .update_app_status(id, "starting", None)
            .map_err(|e| e.to_string())?;
        handle.emit(&format!("app:starting:{}", id), ()).ok();
        spawn_port_watcher(handle.clone(), id.clone(), app_data.port, app_data.name.clone());

        let id_owned = id.clone();
        let handle_owned = handle.clone();
        let env_vars = app_data.env_vars.clone();
        thread::spawn(move || {
            let state: tauri::State<AppState> = handle_owned.state();
            let result = state.docker.compose_start(
                &id_owned,
                &compose_file,
                root_dir_owned.as_deref(),
                shared_net.as_deref(),
                &env_vars,
                truncate_log,
                on_log,
            );
            if let Err(e) = result {
                let msg = e.to_string();
                state.db.lock().unwrap().update_app_status(&id_owned, "stopped", None).ok();
                if msg.contains("aborted by user stop") {
                    // User clicked Stop mid-start — emit a clean exit so the UI
                    // resets to "stopped" without the start-failed alert.
                    state.docker.stopping.lock().unwrap().remove(&id_owned);
                    handle_owned.emit(&format!("app:exit:{}", id_owned), 0i32).ok();
                } else {
                    handle_owned.emit(&format!("app:start-failed:{}", id_owned), msg).ok();
                    handle_owned.emit(&format!("app:exit:{}", id_owned), -1i32).ok();
                }
            }
        });
        return Ok(());
    }

    if app_data.is_docker() {
        let image = app_data
            .docker_image
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| "docker app has no image".to_string())?
            .to_string();
        let container_port = app_data
            .docker_container_port
            .ok_or_else(|| "docker app has no container port".to_string())?;
        let root_dir_owned = if app_data.root_dir.is_empty() {
            None
        } else {
            Some(app_data.root_dir.clone())
        };
        let shared_net = if app_data.network_share {
            Some(app_data.workspace_network_name())
        } else {
            None
        };
        state.docker.retry_counts.lock().unwrap().remove(id);
        state
            .db
            .lock()
            .unwrap()
            .update_app_status(id, "starting", None)
            .map_err(|e| e.to_string())?;
        handle.emit(&format!("app:starting:{}", id), ()).ok();
        spawn_port_watcher(handle.clone(), id.clone(), app_data.port, app_data.name.clone());

        let id_owned = id.clone();
        let handle_owned = handle.clone();
        let docker_args = app_data.docker_args.clone();
        let docker_volumes = app_data.docker_volumes.clone();
        let env_vars = app_data.env_vars.clone();
        let host_port = app_data.port;
        thread::spawn(move || {
            let state: tauri::State<AppState> = handle_owned.state();
            let result = state.docker.start(
                &id_owned,
                &image,
                host_port,
                container_port,
                docker_args.as_deref(),
                &docker_volumes,
                root_dir_owned.as_deref(),
                shared_net.as_deref(),
                &env_vars,
                truncate_log,
                on_log,
                on_exit,
            );
            if let Err(e) = result {
                state.db.lock().unwrap().update_app_status(&id_owned, "stopped", None).ok();
                handle_owned.emit(&format!("app:start-failed:{}", id_owned), e.to_string()).ok();
                handle_owned.emit(&format!("app:exit:{}", id_owned), -1i32).ok();
            }
        });
        return Ok(());
    }

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
///
/// Aborts silently if the app's DB status is no longer `"starting"` — that
/// means the user stopped (or restarted differently) the app while we were
/// polling, and emitting `ready` now would resurrect the dot to "running"
/// against their intent.
pub(crate) fn spawn_port_watcher(handle: tauri::AppHandle, id: String, port: u16, app_name: String) {
    thread::spawn(move || {
        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));

        let still_starting = |handle: &tauri::AppHandle| -> bool {
            let state: tauri::State<AppState> = handle.state();
            state
                .db
                .lock()
                .ok()
                .and_then(|db| db.list_apps().ok())
                .and_then(|apps| apps.into_iter().find(|a| a.id == id).map(|a| a.status))
                .map(|s| s == "starting")
                .unwrap_or(false)
        };

        for _ in 0..120 {
            thread::sleep(Duration::from_millis(500));
            if !still_starting(&handle) {
                return;
            }
            if std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok() {
                handle.emit(&format!("app:ready:{}", id), ()).ok();
                notify(&handle, &format!("{} is ready", app_name), &format!("Running on :{port}"));
                return;
            }
        }
        // Timeout fallback — only nudge the UI to "ready" if the user is
        // still expecting a startup. Otherwise the stop already happened
        // and we'd be flipping the dot back to running.
        if still_starting(&handle) {
            handle.emit(&format!("app:ready:{}", id), ()).ok();
        }
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

    // Static and proxy apps have no process — Caddy serves them as long as
    // it's running. Mark as "running" so the UI reflects it and skip spawn.
    if app_data.is_static() || app_data.is_proxy() {
        state.db.lock().unwrap()
            .update_app_status(&id, "running", None)
            .map_err(|e| e.to_string())?;
        app.emit(&format!("app:ready:{}", id), ()).ok();
        return Ok(());
    }

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

/// Fallback for a process app orphaned across a Porta restart: the in-memory
/// `ProcessManager` map is empty (only docker/compose apps are re-adopted on
/// startup, see `lib.rs`), so `processes.stop/kill` is a silent no-op and the
/// card stays stuck "running". Signal the PID recorded in the DB directly. The
/// child is its own process-group leader (`pid == pgid`, see `process_group(0)`
/// in process_manager.rs), so `killpg` reaches its children too.
fn signal_orphan_pid(app_data: &Option<App>, sig: nix::sys::signal::Signal) {
    if let Some(pid) = app_data.as_ref().and_then(|a| a.pid) {
        let p = nix::unistd::Pid::from_raw(pid as i32);
        let _ = nix::sys::signal::killpg(p, sig);
        let _ = nix::sys::signal::kill(p, sig);
    }
}

#[tauri::command]
pub fn stop_app(state: State<AppState>, app: tauri::AppHandle, id: String) -> Result<(), String> {
    let app_data = state.db.lock().unwrap().list_apps().ok()
        .and_then(|apps| apps.into_iter().find(|a| a.id == id));
    let is_static = app_data.as_ref().map(|a| a.is_static()).unwrap_or(false);
    let is_proxy = app_data.as_ref().map(|a| a.is_proxy()).unwrap_or(false);
    let is_docker = app_data.as_ref().map(|a| a.is_docker()).unwrap_or(false);
    let is_compose = app_data.as_ref().map(|a| a.is_compose()).unwrap_or(false);
    if is_compose {
        // Set the stop-request flag *before* doing anything so a concurrent
        // restart (`compose_start` mid-flight) sees it and aborts. Then
        // block on the actual `down` so the IPC reflects reality — when this
        // returns, the containers really are gone, not just queued to stop.
        if let Some(ref a) = app_data {
            let root = if a.root_dir.is_empty() { None } else { Some(a.root_dir.as_str()) };
            let file = a.compose_file.as_deref().unwrap_or("");
            state.docker.stopping.lock().unwrap().insert(id.clone());
            state.docker.compose_stop_and_wait(&id, file, root).map_err(|e| e.to_string())?;
        }
    } else if is_docker {
        state.docker.stop(&id).map_err(|e| e.to_string())?;
    } else if !is_static && !is_proxy {
        if state.processes.is_running(&id) {
            state.processes.stop(&id).map_err(|e| e.to_string())?;
        } else {
            signal_orphan_pid(&app_data, nix::sys::signal::Signal::SIGTERM);
        }
    }
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
    // Read the port and kind before stopping so we can route to the right manager.
    let (port_opt, is_static, is_proxy, is_docker, is_compose, compose_file, root_dir) = {
        let db = state.db.lock().unwrap();
        let app_opt = db.list_apps().ok()
            .and_then(|apps| apps.into_iter().find(|a| a.id == id));
        (
            app_opt.as_ref().map(|a| a.port),
            app_opt.as_ref().map(|a| a.is_static()).unwrap_or(false),
            app_opt.as_ref().map(|a| a.is_proxy()).unwrap_or(false),
            app_opt.as_ref().map(|a| a.is_docker()).unwrap_or(false),
            app_opt.as_ref().map(|a| a.is_compose()).unwrap_or(false),
            app_opt.as_ref().and_then(|a| a.compose_file.clone()),
            app_opt.map(|a| a.root_dir).unwrap_or_default(),
        )
    };

    if is_compose {
        let root = if root_dir.is_empty() { None } else { Some(root_dir.as_str()) };
        let file = compose_file.as_deref().unwrap_or("");
        state.docker.compose_stop_and_wait(&id, file, root).ok();
    } else if is_docker {
        state.docker.stop_and_wait(&id, 10_000).ok();
    } else if !is_static && !is_proxy {
        state.processes.stop_and_wait(&id, 3000).ok();
    }

    // After stop_and_wait the main process group is dead, but child processes that
    // called setsid()/setpgid() escape the group kill and may still hold the port.
    // Force-kill anything still listening on the port before we start fresh.
    // Skip for docker/compose apps — the port is held by docker-proxy, killing it breaks docker.
    // Skip for static/proxy — there's no Porta-owned process and the port is held
    // by the user's own service or nothing at all.
    if !is_docker && !is_compose && !is_static && !is_proxy { if let Some(port) = port_opt {
        if let Ok(output) = std::process::Command::new("lsof")
            .args(["-ti", &format!("tcp:{}", port)])
            .output()
        {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let pids: Vec<u32> = stdout
                .lines()
                .filter_map(|l| l.trim().parse::<u32>().ok())
                .collect();
            for pid in pids {
                let p = nix::unistd::Pid::from_raw(pid as i32);
                let _ = nix::sys::signal::killpg(p, nix::sys::signal::Signal::SIGKILL);
                let _ = nix::sys::signal::kill(p, nix::sys::signal::Signal::SIGKILL);
            }
            // Brief pause so the OS can release the socket after the kill
            if !stdout.trim().is_empty() {
                thread::sleep(Duration::from_millis(200));
            }
        }
    } }

    state.db.lock().unwrap().update_app_status(&id, "stopped", None).map_err(|e| e.to_string())?;
    start_app(state, app, id)
}

#[tauri::command]
pub fn kill_app(state: State<AppState>, id: String) -> Result<(), String> {
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
            state.docker.compose_stop_and_wait(&id, file, root).ok();
        }
    } else if is_docker {
        state.docker.kill(&id).map_err(|e| e.to_string())?;
    } else if !is_static && !is_proxy {
        if state.processes.is_running(&id) {
            state.processes.kill(&id).map_err(|e| e.to_string())?;
        } else {
            signal_orphan_pid(&app_data, nix::sys::signal::Signal::SIGKILL);
        }
    }
    state
        .db
        .lock()
        .unwrap()
        .update_app_status(&id, "stopped", None)
        .map_err(|e| e.to_string())?;
    Ok(())
}
