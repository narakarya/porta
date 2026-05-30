use std::path::PathBuf;
use serde_json::{Map, Value};
use tauri::State;

use crate::porta_dir;
use crate::app_state::AppState;

/// Directory holding one `<extension_id>.json` file per extension.
fn storage_dir() -> PathBuf {
    porta_dir().join("extension-storage")
}

/// Reject ids that aren't `[a-z0-9-]` so they can't escape `storage_dir()`.
fn safe_id(extension_id: &str) -> Result<(), String> {
    if extension_id.is_empty()
        || !extension_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err(format!("Invalid extension id '{}'", extension_id));
    }
    Ok(())
}

fn store_path(extension_id: &str) -> Result<PathBuf, String> {
    safe_id(extension_id)?;
    Ok(storage_dir().join(format!("{extension_id}.json")))
}

fn read_store(extension_id: &str) -> Result<Map<String, Value>, String> {
    let path = store_path(extension_id)?;
    match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str::<Map<String, Value>>(&s)
            .map_err(|e| format!("Corrupt storage for '{}': {}", extension_id, e)),
        Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Map::new()),
        Err(e) => Err(format!("Failed to read storage: {}", e)),
    }
}

fn write_store(extension_id: &str, map: &Map<String, Value>) -> Result<(), String> {
    let path = store_path(extension_id)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create storage dir: {}", e))?;
    }
    let body = serde_json::to_string(map).map_err(|e| e.to_string())?;
    std::fs::write(&path, body).map_err(|e| format!("Failed to write storage: {}", e))
}

/// Confirm the extension exists, is enabled, and holds the `storage` permission.
fn check_storage_permission(extension_id: &str, state: &State<'_, AppState>) -> Result<(), String> {
    let exts = state.extensions.lock().unwrap();
    let ext = exts
        .iter()
        .find(|e| e.manifest.id == extension_id)
        .ok_or_else(|| format!("Extension '{}' not found", extension_id))?;
    if !ext.manifest.has_storage_permission() {
        return Err(format!("Extension '{}' does not have 'storage' permission", extension_id));
    }
    if !ext.enabled {
        return Err(format!("Extension '{}' is disabled", extension_id));
    }
    Ok(())
}

#[tauri::command]
pub fn extension_storage_get(
    extension_id: String,
    key: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    check_storage_permission(&extension_id, &state)?;
    let map = read_store(&extension_id)?;
    Ok(map.get(&key).cloned().unwrap_or(Value::Null))
}

#[tauri::command]
pub fn extension_storage_set(
    extension_id: String,
    key: String,
    value: Value,
    state: State<'_, AppState>,
) -> Result<(), String> {
    check_storage_permission(&extension_id, &state)?;
    let mut map = read_store(&extension_id)?;
    map.insert(key, value);
    write_store(&extension_id, &map)
}

#[tauri::command]
pub fn extension_storage_remove(
    extension_id: String,
    key: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    check_storage_permission(&extension_id, &state)?;
    let mut map = read_store(&extension_id)?;
    map.remove(&key);
    write_store(&extension_id, &map)
}

#[tauri::command]
pub fn extension_storage_keys(
    extension_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    check_storage_permission(&extension_id, &state)?;
    let map = read_store(&extension_id)?;
    Ok(map.keys().cloned().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_id_rejects_traversal() {
        assert!(safe_id("kamal").is_ok());
        assert!(safe_id("git-manager").is_ok());
        assert!(safe_id("../etc").is_err());
        assert!(safe_id("a/b").is_err());
        assert!(safe_id("").is_err());
    }

    #[test]
    fn read_missing_store_is_empty() {
        // A never-written id resolves to an empty map, not an error.
        let map = read_store("definitely-does-not-exist-xyz").unwrap();
        assert!(map.is_empty());
    }
}
