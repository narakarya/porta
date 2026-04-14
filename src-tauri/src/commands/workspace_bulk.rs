use std::collections::{HashMap, HashSet, VecDeque};
use std::thread;
use tauri::Emitter;
use tauri::State;

use crate::app_state::AppState;
use crate::db::models::App;
use super::app_lifecycle::{start_single, wait_for_port};

fn topo_sort_apps(apps: &[App]) -> Vec<App> {
    let id_set: HashSet<&str> = apps.iter().map(|a| a.id.as_str()).collect();
    let mut in_deg: HashMap<&str, usize> = HashMap::new();
    let mut children: HashMap<&str, Vec<&str>> = HashMap::new();

    for a in apps {
        in_deg.entry(a.id.as_str()).or_insert(0);
        for dep in &a.depends_on {
            if id_set.contains(dep.as_str()) {
                children.entry(dep.as_str()).or_default().push(a.id.as_str());
                *in_deg.entry(a.id.as_str()).or_insert(0) += 1;
            }
        }
    }

    let mut queue: VecDeque<&str> = in_deg
        .iter()
        .filter(|(_, &deg)| deg == 0)
        .map(|(&id, _)| id)
        .collect();
    let mut ordered_ids: Vec<&str> = Vec::new();

    while let Some(id) = queue.pop_front() {
        ordered_ids.push(id);
        for child in children.get(id).unwrap_or(&vec![]) {
            if let Some(d) = in_deg.get_mut(child) {
                *d = d.saturating_sub(1);
                if *d == 0 {
                    queue.push_back(child);
                }
            }
        }
    }

    for a in apps {
        if !ordered_ids.contains(&a.id.as_str()) {
            ordered_ids.push(a.id.as_str());
        }
    }

    let app_map: HashMap<&str, &App> = apps.iter().map(|a| (a.id.as_str(), a)).collect();
    ordered_ids
        .iter()
        .filter_map(|id| app_map.get(id).map(|a| (*a).clone()))
        .collect()
}

#[tauri::command]
pub fn start_workspace_apps(
    state: State<AppState>,
    app: tauri::AppHandle,
    workspace_id: String,
) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    let all_apps = db.list_apps().map_err(|e| e.to_string())?;
    drop(db);

    let ws_apps: Vec<App> = all_apps
        .into_iter()
        .filter(|a| a.workspace_id.as_deref() == Some(&workspace_id))
        .filter(|a| a.status == "stopped" && !a.start_command.is_empty())
        .collect();

    if ws_apps.is_empty() {
        return Ok(());
    }

    let sorted = topo_sort_apps(&ws_apps);
    let handle = app.clone();

    thread::spawn(move || {
        for app_data in &sorted {
            handle
                .emit(
                    "workspace:start-progress",
                    serde_json::json!({ "app_id": app_data.id, "status": "starting" }),
                )
                .ok();

            if let Err(e) = start_single(&handle, app_data, true) {
                eprintln!("workspace start failed for {}: {}", app_data.name, e);
                handle
                    .emit(
                        "workspace:start-progress",
                        serde_json::json!({ "app_id": app_data.id, "status": "error" }),
                    )
                    .ok();
                continue;
            }

            if app_data.depends_on.iter().any(|dep| sorted.iter().any(|s| s.id == *dep)) {
                wait_for_port(app_data.port, 10_000);
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub fn stop_workspace_apps(
    state: State<AppState>,
    app: tauri::AppHandle,
    workspace_id: String,
) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    let all_apps = db.list_apps().map_err(|e| e.to_string())?;
    drop(db);

    let ws_apps: Vec<App> = all_apps
        .into_iter()
        .filter(|a| a.workspace_id.as_deref() == Some(&workspace_id))
        .filter(|a| a.status == "running" || a.status == "starting")
        .collect();

    let sorted = topo_sort_apps(&ws_apps);

    for app_data in sorted.iter().rev() {
        state.processes.stop(&app_data.id).ok();
        state
            .db
            .lock()
            .unwrap()
            .update_app_status(&app_data.id, "stopped", None)
            .ok();
        app.emit(&format!("app:exit:{}", app_data.id), 0).ok();
    }

    Ok(())
}
