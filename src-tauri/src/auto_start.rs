use std::collections::{HashMap, HashSet};

use tauri::Manager;

use crate::app_state::AppState;
use crate::db;

/// Topological sort: returns `auto_start` apps in dependency order (deps first).
/// Apps that are not `auto_start` are excluded from the result.
/// If a dep is not in the `auto_start` set it is skipped (not started automatically).
pub fn topo_sort_auto_start(all_apps: Vec<db::models::App>) -> Vec<db::models::App> {
    let auto_ids: HashSet<String> = all_apps
        .iter()
        .filter(|a| a.auto_start && !a.start_command.is_empty())
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

/// Spawn a background thread that auto-starts apps flagged with `auto_start = true`,
/// in dependency order. Porta finishes setup immediately while this runs in the background.
pub fn spawn_auto_start(app: &tauri::App) {
    let auto_start_apps = {
        let state = app.state::<AppState>();
        let db = state.db.lock().unwrap();
        let all = db.list_apps().unwrap_or_default();
        topo_sort_auto_start(all)
    };

    let tray_db_path = app.state::<AppState>().db_path.clone();
    let auto_start_handle = app.handle().clone();
    std::thread::spawn(move || {
        for app_data in &auto_start_apps {
            if let Err(e) = crate::commands::app_lifecycle::start_single(&auto_start_handle, app_data, false) {
                eprintln!("auto-start failed for {}: {}", app_data.name, e);
                continue;
            }
            // Wait for this app to be TCP-ready before starting apps that depend on it
            if auto_start_apps.iter().any(|a| a.depends_on.contains(&app_data.id)) {
                crate::commands::app_lifecycle::wait_for_port(app_data.port, 30_000);
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
        crate::tray::rebuild_tray_menu(&auto_start_handle, &tray_db_path);
    });
}
