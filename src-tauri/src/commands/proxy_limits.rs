use tauri::State;

use crate::app_state::AppState;
use super::setup::sync_caddy;

/// Default cap (bytes) on request bodies Caddy will proxy to an app, applied to
/// any app that doesn't set its own `max_upload_bytes`. 100 MB comfortably
/// covers typical uploads (CSV imports, media) while keeping the Traffic
/// Inspector's captured bodies bounded — log rotation caps total size anyway.
pub const DEFAULT_MAX_UPLOAD_BYTES: u64 = 100 * 1024 * 1024;

#[tauri::command]
pub fn get_default_max_upload_bytes() -> u64 {
    current_default_max_upload_bytes()
}

#[tauri::command]
pub fn set_default_max_upload_bytes(state: State<AppState>, max_bytes: u64) -> Result<(), String> {
    let mut cfg = super::settings::read_porta_config();
    cfg["proxy_max_body_bytes"] = serde_json::json!(max_bytes);
    super::settings::write_porta_config(&cfg);
    // Re-emit Caddy config so the new default takes effect immediately for
    // every app that doesn't have a per-app override.
    sync_caddy(&state)
}

/// Global default, falling back to [`DEFAULT_MAX_UPLOAD_BYTES`] when unset.
/// `0` is a valid stored value meaning "unlimited".
pub(crate) fn current_default_max_upload_bytes() -> u64 {
    super::settings::read_porta_config()["proxy_max_body_bytes"]
        .as_u64()
        .unwrap_or(DEFAULT_MAX_UPLOAD_BYTES)
}
