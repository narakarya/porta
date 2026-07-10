use std::collections::{HashMap, HashSet};
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

/// Topological sort: returns `auto_start` apps in dependency order (deps first).
/// Apps that are not `auto_start` are excluded from the result.
/// If a dep is not in the `auto_start` set it is skipped (not started automatically).
pub fn topo_sort_auto_start(all_apps: Vec<db::models::App>) -> Vec<db::models::App> {
    let auto_ids: HashSet<String> = all_apps
        .iter()
        .filter(|a| a.auto_start && (!a.start_command.is_empty() || a.is_docker() || a.is_compose()))
        .map(|a| a.id.clone())
        .collect();

    let app_map: HashMap<String, db::models::App> = all_apps
        .into_iter()
        .filter(|a| auto_ids.contains(&a.id))
        .map(|a| (a.id.clone(), a))
        .collect();

    let mut visited: HashSet<String> = HashSet::new();
    let mut result: Vec<db::models::App> = Vec::new();

    fn visit(
        id: &str,
        app_map: &HashMap<String, db::models::App>,
        auto_ids: &HashSet<String>,
        visited: &mut HashSet<String>,
        result: &mut Vec<db::models::App>,
    ) {
        if !visited.insert(id.to_string()) {
            return;
        }
        if let Some(app) = app_map.get(id) {
            for dep_id in &app.depends_on {
                if auto_ids.contains(dep_id) {
                    visit(dep_id, app_map, auto_ids, visited, result);
                }
            }
            result.push(app.clone());
        }
    }

    let ids: Vec<String> = app_map.keys().cloned().collect();
    for id in &ids {
        if !visited.contains(id) {
            visit(id, &app_map, &auto_ids, &mut visited, &mut result);
        }
    }
    result
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

/// Spawn a background thread that auto-starts apps flagged with `auto_start = true`,
/// in dependency order. Porta finishes setup immediately while this runs in the background.
pub fn spawn_auto_start(app: &tauri::App) {
    let auto_start_apps = {
        let state = app.state::<AppState>();
        let db = state.db.lock().unwrap_or_else(|e| e.into_inner());
        let all = db.list_apps().unwrap_or_default();
        topo_sort_auto_start(all)
    };

    let tray_db_path = app.state::<AppState>().db_path.clone();
    let auto_start_handle = app.handle().clone();
    std::thread::spawn(move || {
        let auto_start_ids: HashSet<String> =
            auto_start_apps.iter().map(|a| a.id.clone()).collect();
        let mut skipped_ids: HashSet<String> = HashSet::new();
        let mut docker_ready: Option<bool> = None;

        for app_data in &auto_start_apps {
            // Skip apps that are already running (survived from previous session)
            if app_data.status == "running" {
                continue;
            }

            if app_data
                .depends_on
                .iter()
                .any(|dep_id| auto_start_ids.contains(dep_id) && skipped_ids.contains(dep_id))
            {
                skipped_ids.insert(app_data.id.clone());
                append_auto_start_note(
                    &app_data.id,
                    "Auto-start skipped because a dependency did not start",
                );
                continue;
            }

            if app_data.is_docker() || app_data.is_compose() {
                let ready = *docker_ready
                    .get_or_insert_with(|| wait_for_docker_engine(DOCKER_AUTO_START_TIMEOUT));
                if !ready {
                    skipped_ids.insert(app_data.id.clone());
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
                skipped_ids.insert(app_data.id.clone());
                append_auto_start_note(&app_data.id, &format!("Auto-start failed: {e}"));
                continue;
            }
            // Wait for this app to be TCP-ready before starting apps that depend on it
            if auto_start_apps
                .iter()
                .any(|a| a.depends_on.contains(&app_data.id))
            {
                if !crate::commands::app_lifecycle::wait_for_port(app_data.port, 30_000) {
                    skipped_ids.insert(app_data.id.clone());
                    append_auto_start_note(
                        &app_data.id,
                        "Auto-start dependency did not become ready in time",
                    );
                }
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
        crate::tray::rebuild_tray_menu(&auto_start_handle, &tray_db_path);
    });
}
