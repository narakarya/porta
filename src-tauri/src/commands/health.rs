use std::collections::HashMap;
use tauri::State;

use crate::app_state::AppState;
use crate::health::HealthStatus;

#[tauri::command]
pub fn check_app_health(state: State<AppState>, id: String) -> Result<HealthStatus, String> {
    let db = state.db.lock().unwrap();
    let apps = db.list_apps().map_err(|e| e.to_string())?;
    let app = apps.into_iter().find(|a| a.id == id).ok_or("App not found")?;
    drop(db);

    if app.status != "running" {
        return Ok(HealthStatus::Unknown);
    }

    Ok(crate::health::check_health(app.port, app.health_check_path.as_deref()))
}

#[tauri::command]
pub fn check_all_health(state: State<AppState>) -> Result<HashMap<String, HealthStatus>, String> {
    let db = state.db.lock().unwrap();
    let apps = db.list_apps().map_err(|e| e.to_string())?;
    drop(db);

    let mut result = HashMap::new();
    for app in &apps {
        if app.status != "running" {
            continue;
        }
        let status = crate::health::check_health(app.port, app.health_check_path.as_deref());
        result.insert(app.id.clone(), status);
    }
    Ok(result)
}
