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

#[tauri::command]
pub fn get_notification_permission_state(app: tauri::AppHandle) -> Result<String, String> {
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .permission_state()
        .map(|state| state.to_string())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn request_notification_permission_access(app: tauri::AppHandle) -> Result<String, String> {
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .request_permission()
        .map(|state| state.to_string())
        .map_err(|e| e.to_string())
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

/// Reads through `crate::secrets`, which keeps the token in the macOS Keychain
/// and migrates the old plaintext `config.json` value on first read.
#[tauri::command]
pub fn get_cf_api_token() -> String {
    crate::secrets::cf_token_get()
}

/// Returns where the token landed — `"keychain"` normally, `"config"` if the
/// keychain was unusable and we fell back to plaintext, `"none"` when cleared.
#[tauri::command]
pub fn set_cf_api_token(token: String) -> String {
    crate::secrets::cf_token_set(&token).as_str().to_string()
}

/// Where the saved token lives, so the UI can warn when it is not protected.
#[tauri::command]
pub fn get_cf_token_storage() -> String {
    crate::secrets::cf_token_storage().as_str().to_string()
}

// ── App-down health alerts ───────────────────────────────────────────────────

pub(crate) fn health_alert_enabled() -> bool {
    read_porta_config()["health_alert_enabled"].as_bool().unwrap_or(true)
}

/// Consecutive failed probes before an app counts as down. Clamped so a
/// hand-edited config can't disable debouncing entirely (1) or push the alert
/// so far out it never fires (10 rounds ≈ 5 minutes at the 30s poll).
pub(crate) fn health_alert_threshold() -> u32 {
    read_porta_config()["health_alert_threshold"]
        .as_u64()
        .map(|n| n.clamp(1, 10) as u32)
        .unwrap_or(crate::health_alert::DEFAULT_THRESHOLD)
}

#[tauri::command]
pub fn get_health_alert_enabled() -> bool {
    health_alert_enabled()
}

#[tauri::command]
pub fn set_health_alert_enabled(enabled: bool) {
    let mut cfg = read_porta_config();
    cfg["health_alert_enabled"] = serde_json::json!(enabled);
    write_porta_config(&cfg);
}

#[tauri::command]
pub fn get_health_alert_threshold() -> u32 {
    health_alert_threshold()
}

#[tauri::command]
pub fn set_health_alert_threshold(rounds: u32) {
    let mut cfg = read_porta_config();
    cfg["health_alert_threshold"] = serde_json::json!(rounds.clamp(1, 10));
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

// ── Git autofetch ─────────────────────────────────────────────────────────────

pub(crate) fn git_autofetch_enabled() -> bool {
    read_porta_config()["git_autofetch"].as_bool().unwrap_or(true)
}

/// Clamped to the choices the settings UI offers, so a hand-edited config can't
/// make the poller hammer every remote once a second.
pub(crate) fn git_autofetch_interval_secs() -> u64 {
    read_porta_config()["git_autofetch_interval_secs"]
        .as_u64()
        .unwrap_or(180)
        .clamp(60, 600)
}

#[tauri::command]
pub fn get_git_autofetch_enabled() -> bool {
    git_autofetch_enabled()
}

#[tauri::command]
pub fn set_git_autofetch_enabled(enabled: bool) {
    let mut cfg = read_porta_config();
    cfg["git_autofetch"] = serde_json::json!(enabled);
    write_porta_config(&cfg);
}

#[tauri::command]
pub fn get_git_autofetch_interval_secs() -> u64 {
    git_autofetch_interval_secs()
}

#[tauri::command]
pub fn set_git_autofetch_interval_secs(secs: u64) {
    let mut cfg = read_porta_config();
    cfg["git_autofetch_interval_secs"] = serde_json::json!(secs.clamp(60, 600));
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

// ── Session hosting (tmux) ────────────────────────────────────────────────────

/// What the Sessions settings section renders.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TmuxStatus {
    /// A usable tmux is on disk. Everything below is inert without it — the
    /// app falls back to piping, and apps die with Porta as they always did.
    pub installed: bool,
    pub version: Option<String>,
    /// Host app processes in tmux sessions.
    pub sessions_enabled: bool,
    /// Host terminal panes in tmux sessions.
    pub terminal_enabled: bool,
    /// Leave hosted apps running when Porta exits.
    pub keep_running_on_quit: bool,
    /// The socket sessions live on, so the UI can show how to reach them from
    /// a terminal.
    pub socket: String,
}

#[tauri::command]
pub fn get_tmux_status() -> TmuxStatus {
    let cfg = read_porta_config();
    let installed = crate::tmux::available();
    let version = crate::tmux::binary().and_then(|bin| {
        std::process::Command::new(bin)
            .arg("-V")
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
    });
    TmuxStatus {
        installed,
        version,
        sessions_enabled: cfg["tmux_sessions_enabled"].as_bool().unwrap_or(true),
        terminal_enabled: cfg["tmux_terminal_enabled"].as_bool().unwrap_or(true),
        keep_running_on_quit: cfg["keep_apps_running_on_quit"].as_bool().unwrap_or(true),
        socket: crate::tmux::socket().to_string(),
    }
}

#[tauri::command]
pub fn set_tmux_sessions_enabled(enabled: bool) {
    let mut cfg = read_porta_config();
    cfg["tmux_sessions_enabled"] = serde_json::json!(enabled);
    write_porta_config(&cfg);
}

#[tauri::command]
pub fn set_tmux_terminal_enabled(enabled: bool) {
    let mut cfg = read_porta_config();
    cfg["tmux_terminal_enabled"] = serde_json::json!(enabled);
    write_porta_config(&cfg);
}

#[tauri::command]
pub fn set_keep_apps_running_on_quit(enabled: bool) {
    let mut cfg = read_porta_config();
    cfg["keep_apps_running_on_quit"] = serde_json::json!(enabled);
    write_porta_config(&cfg);
}

/// Install tmux via Homebrew, for the Sessions section's one-click setup.
#[tauri::command]
pub fn install_tmux() -> Result<(), String> {
    crate::setup::brew_install("tmux", &|line| println!("[tmux install] {line}"))
        .map_err(|e| e.to_string())
}
