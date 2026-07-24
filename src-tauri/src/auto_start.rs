use std::io::Write as _;
use std::time::{Duration, Instant};

use tauri::Manager;

use crate::app_state::AppState;
use crate::db;
use crate::docker_manager::DockerManager;
use crate::process_manager::log_file_path;

const DOCKER_AUTO_START_TIMEOUT: Duration = Duration::from_secs(120);
const DOCKER_AUTO_START_FAST_POLL: Duration = Duration::from_secs(2);
const DOCKER_AUTO_START_SLOW_POLL: Duration = Duration::from_secs(5);
const DOCKER_AUTO_START_FAST_WINDOW: Duration = Duration::from_secs(30);

/// The apps eligible for auto-start, in stored order.
///
/// This used to topologically sort by `depends_on` ("Start After"), which is
/// gone from the UI: the ordering was invisible, only reachable via a
/// docker-compose import, and a single slow dependency stalled every app behind
/// it for up to 30s. Auto-start now just walks the list.
pub fn auto_start_apps(all_apps: Vec<db::models::App>) -> Vec<db::models::App> {
    all_apps
        .into_iter()
        .filter(|a| a.auto_start && (!a.start_command.is_empty() || a.is_docker() || a.is_compose()))
        .collect()
}

fn wait_for_docker_engine(timeout: Duration) -> bool {
    let started = Instant::now();
    loop {
        if DockerManager::is_engine_ready() {
            return true;
        }
        if started.elapsed() >= timeout {
            return false;
        }
        let poll = if started.elapsed() < DOCKER_AUTO_START_FAST_WINDOW {
            DOCKER_AUTO_START_FAST_POLL
        } else {
            DOCKER_AUTO_START_SLOW_POLL
        };
        std::thread::sleep(poll);
    }
}

fn append_auto_start_note(app_id: &str, message: &str) {
    let log_path = log_file_path(app_id);
    if let Some(parent) = log_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
    {
        let _ = writeln!(file, "── {message} ──");
    }
}

/// Spawn a background thread that auto-starts apps flagged with `auto_start = true`.
/// Porta finishes setup immediately while this runs in the background.
pub fn spawn_auto_start(app: &tauri::App) {
    let apps_to_start = {
        let state = app.state::<AppState>();
        let db = state.db.lock().unwrap_or_else(|e| e.into_inner());
        let all = db.list_apps().unwrap_or_default();
        auto_start_apps(all)
    };

    let tray_db_path = app.state::<AppState>().db_path.clone();
    let auto_start_handle = app.handle().clone();
    std::thread::spawn(move || {
        let mut docker_ready: Option<bool> = None;

        for app_data in &apps_to_start {
            // Skip apps that are already running (survived from previous session)
            if app_data.status == "running" {
                continue;
            }

            if app_data.is_docker() || app_data.is_compose() {
                let ready = *docker_ready
                    .get_or_insert_with(|| wait_for_docker_engine(DOCKER_AUTO_START_TIMEOUT));
                if !ready {
                    append_auto_start_note(
                        &app_data.id,
                        "Auto-start skipped because Docker/OrbStack was not ready",
                    );
                    continue;
                }
            }

            if let Err(e) = crate::commands::app_lifecycle::start_single(
                &auto_start_handle,
                app_data,
                false,
                false,
            ) {
                eprintln!("auto-start failed for {}: {}", app_data.name, e);
                append_auto_start_note(&app_data.id, &format!("Auto-start failed: {e}"));
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
        crate::tray::rebuild_tray_menu(&auto_start_handle, &tray_db_path);
    });
}
