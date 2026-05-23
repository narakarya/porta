use crate::log_rotation::{
    clear_all, clear_log_file, log_sizes, rotate_all, ClearSummary, RotateSummary,
    DEFAULT_MAX_LOG_BYTES,
};
use crate::process_manager::log_file_path;

#[derive(serde::Serialize)]
pub struct AppLogSize {
    pub app_id: String,
    pub bytes: u64,
}

#[derive(serde::Serialize)]
pub struct LogsDiskUsage {
    pub total_bytes: u64,
    pub per_app: Vec<AppLogSize>,
}

fn logs_dir() -> std::path::PathBuf {
    crate::porta_dir().join("logs")
}

#[tauri::command]
pub fn app_logs_disk_usage() -> LogsDiskUsage {
    let dir = logs_dir();
    let raw = log_sizes(&dir);
    let total_bytes = raw.iter().map(|(_, s)| *s).sum();
    let per_app = raw
        .into_iter()
        .map(|(app_id, bytes)| AppLogSize { app_id, bytes })
        .collect();
    LogsDiskUsage { total_bytes, per_app }
}

#[tauri::command]
pub fn rotate_app_logs() -> Result<RotateSummary, String> {
    rotate_all(&logs_dir(), current_max_log_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clear_app_log_file(app_id: String) -> Result<u64, String> {
    let p = log_file_path(&app_id);
    if !p.exists() {
        return Ok(0);
    }
    clear_log_file(&p).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clear_all_app_logs() -> Result<ClearSummary, String> {
    clear_all(&logs_dir()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_max_log_bytes() -> u64 {
    current_max_log_bytes()
}

#[tauri::command]
pub fn set_max_log_bytes(max_bytes: u64) {
    // 64 KB minimum — anything smaller would rotate logs on practically every
    // line and isn't useful.
    let clamped = max_bytes.max(64 * 1024);
    let mut cfg = super::settings::read_porta_config();
    cfg["max_log_bytes_per_app"] = serde_json::json!(clamped);
    super::settings::write_porta_config(&cfg);
}

pub(crate) fn current_max_log_bytes() -> u64 {
    super::settings::read_porta_config()["max_log_bytes_per_app"]
        .as_u64()
        .unwrap_or(DEFAULT_MAX_LOG_BYTES)
}

/// Spawn a background task that rotates oversized logs every 60 seconds.
/// Hooked from `lib.rs` setup() block.
pub fn spawn_log_rotation_task() {
    tauri::async_runtime::spawn(async move {
        // Tiny initial delay so we don't fight with app spawn at boot.
        tokio::time::sleep(std::time::Duration::from_secs(15)).await;
        loop {
            let max = current_max_log_bytes();
            if let Err(e) = rotate_all(&logs_dir(), max) {
                eprintln!("[log_rotation] sweep failed: {e}");
            }
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        }
    });
}
