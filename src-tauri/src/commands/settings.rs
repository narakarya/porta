fn porta_config_path() -> std::path::PathBuf {
    crate::porta_dir().join("config.json")
}

pub(crate) fn read_porta_config() -> serde_json::Value {
    std::fs::read_to_string(porta_config_path())
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| serde_json::json!({}))
}

pub(crate) fn write_porta_config(cfg: &serde_json::Value) {
    let path = porta_config_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    std::fs::write(&path, serde_json::to_string_pretty(cfg).unwrap_or_default()).ok();
}

fn notifications_enabled() -> bool {
    read_porta_config()["notifications_enabled"].as_bool().unwrap_or(true)
}

pub(crate) fn notify_crash(app: &tauri::AppHandle, app_name: &str, exit_code: i32) {
    notify(app, &format!("{} crashed", app_name), &format!("Exit code: {exit_code}"));
}

pub(crate) fn notify(app: &tauri::AppHandle, title: &str, body: &str) {
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
