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

/// Send a sample notification so the user can verify the OS-level permission
/// is granted. Bypasses the in-app `notifications_enabled` toggle on purpose —
/// the point of this button is to test the underlying macOS plumbing, not
/// the toggle itself.
#[tauri::command]
pub fn send_test_notification(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title("Porta")
        .body("Test notification — if you see this, notifications are working.")
        .show()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_cf_api_token() -> String {
    read_porta_config()["cf_api_token"].as_str().unwrap_or("").to_string()
}

#[tauri::command]
pub fn set_cf_api_token(token: String) {
    let mut cfg = read_porta_config();
    if token.trim().is_empty() {
        if let Some(m) = cfg.as_object_mut() {
            m.remove("cf_api_token");
        }
    } else {
        cfg["cf_api_token"] = serde_json::json!(token);
    }
    write_porta_config(&cfg);
}

// ── Image update notifications ────────────────────────────────────────────────

pub(crate) fn image_update_notify_enabled() -> bool {
    read_porta_config()["image_update_notify"].as_bool().unwrap_or(true)
}

#[tauri::command]
pub fn get_image_update_notify_enabled() -> bool {
    image_update_notify_enabled()
}

#[tauri::command]
pub fn set_image_update_notify_enabled(enabled: bool) {
    let mut cfg = read_porta_config();
    cfg["image_update_notify"] = serde_json::json!(enabled);
    write_porta_config(&cfg);
}

#[tauri::command]
pub fn notify_image_updates_found(app: tauri::AppHandle, app_names: Vec<String>) {
    if !image_update_notify_enabled() { return; }
    let body = match app_names.len() {
        0 => return,
        1 => format!("{} has a new image version available", app_names[0]),
        n => format!("{n} apps have new image versions available"),
    };
    notify(&app, "Image Updates Available", &body);
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
