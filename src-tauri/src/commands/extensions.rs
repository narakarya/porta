use tauri::State;

use crate::app_state::AppState;
use crate::extensions::loader::{download_github_to_temp, get_extension_source, install_from_folder, set_extension_enabled, uninstall_extension};
use crate::extensions::manifest::ExtensionInfo;

/// List all installed extensions (enabled and disabled).
#[tauri::command]
pub fn list_extensions(state: State<'_, AppState>) -> Vec<ExtensionInfo> {
    let guard = state.extensions.lock().unwrap();
    guard.iter().map(|e| e.to_info()).collect()
}

/// Return extensions whose `activateOn` matches the given app.
/// `app_kind` is the app's kind string: "process" | "docker" | "compose" | "static" | "proxy".
/// `app_tags` are optional auto-detected tech tags: ["phoenix", "elixir", ...].
#[tauri::command]
pub fn get_extensions_for_app(
    app_kind: String,
    app_tags: Vec<String>,
    state: State<'_, AppState>,
) -> Vec<ExtensionInfo> {
    let guard = state.extensions.lock().unwrap();
    guard
        .iter()
        .filter(|e| {
            if !e.enabled {
                return false;
            }
            // Check against kind and all tags
            e.manifest.matches_app_kind(&app_kind)
                || app_tags.iter().any(|tag| e.manifest.matches_app_kind(tag))
        })
        .map(|e| e.to_info())
        .collect()
}

/// Install an extension from a GitHub URL or owner/repo[@branch] shorthand.
#[tauri::command]
pub async fn install_extension_from_github(
    url: String,
    state: tauri::State<'_, AppState>,
) -> Result<ExtensionInfo, String> {
    // Download + extract (async, no lock held)
    let (_tmp_dir, src_path) = download_github_to_temp(&url).await.map_err(|e| e.to_string())?;

    // Install from extracted dir (sync, brief lock). Record `url` as the source
    // so the extension can be updated later.
    let loaded = {
        let db = state.db.lock().unwrap();
        install_from_folder(&db, &src_path, Some(&url)).map_err(|e| e.to_string())?
    };
    // _tmp_dir cleaned up here

    let id = loaded.manifest.id.clone();
    let info = loaded.to_info();
    let mut guard = state.extensions.lock().unwrap();
    guard.retain(|e| e.manifest.id != id);
    guard.push(loaded);
    guard.sort_by(|a, b| a.manifest.name.cmp(&b.manifest.name));
    Ok(info)
}

/// Re-fetch an extension from its recorded GitHub source and reinstall in place.
/// Errors if the extension has no remote source (e.g. installed from a folder).
#[tauri::command]
pub async fn update_extension(
    id: String,
    state: tauri::State<'_, AppState>,
) -> Result<ExtensionInfo, String> {
    // Read the stored source (brief lock, no await held).
    let source = {
        let db = state.db.lock().unwrap();
        get_extension_source(&db, &id)
    };
    let source = source.ok_or_else(|| {
        "This extension has no remote source — reinstall it from folder to update.".to_string()
    })?;

    // Download + extract (async, no lock held).
    let (_tmp_dir, src_path) = download_github_to_temp(&source).await.map_err(|e| e.to_string())?;

    // Reinstall from extracted dir, preserving the source.
    let loaded = {
        let db = state.db.lock().unwrap();
        install_from_folder(&db, &src_path, Some(&source)).map_err(|e| e.to_string())?
    };

    let new_id = loaded.manifest.id.clone();
    let info = loaded.to_info();
    let mut guard = state.extensions.lock().unwrap();
    guard.retain(|e| e.manifest.id != new_id);
    guard.push(loaded);
    guard.sort_by(|a, b| a.manifest.name.cmp(&b.manifest.name));
    Ok(info)
}

/// Enable or disable an extension.
#[tauri::command]
pub fn set_extension_enabled_cmd(
    id: String,
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    set_extension_enabled(&db, &id, enabled).map_err(|e| e.to_string())?;
    drop(db);

    let mut guard = state.extensions.lock().unwrap();
    if let Some(ext) = guard.iter_mut().find(|e| e.manifest.id == id) {
        ext.enabled = enabled;
    }
    Ok(())
}

/// Install an extension by copying a local folder into the extensions directory.
#[tauri::command]
pub fn install_extension_from_folder(
    path: String,
    state: State<'_, AppState>,
) -> Result<ExtensionInfo, String> {
    let src = std::path::Path::new(&path);
    let db = state.db.lock().unwrap();
    let loaded = install_from_folder(&db, src, None).map_err(|e| e.to_string())?;
    drop(db);

    let id = loaded.manifest.id.clone();
    let info = loaded.to_info();
    let mut guard = state.extensions.lock().unwrap();
    guard.retain(|e| e.manifest.id != id);
    guard.push(loaded);
    guard.sort_by(|a, b| a.manifest.name.cmp(&b.manifest.name));
    Ok(info)
}

/// Re-scan the extensions directory and reload all manifests.
#[tauri::command]
pub fn rescan_extensions(state: State<'_, AppState>) -> Vec<ExtensionInfo> {
    let db = state.db.lock().unwrap();
    let loaded = crate::extensions::loader::scan_extensions(&db);
    drop(db);
    let infos: Vec<ExtensionInfo> = loaded.iter().map(|e| e.to_info()).collect();
    let mut guard = state.extensions.lock().unwrap();
    *guard = loaded;
    infos
}

/// Uninstall an extension — removes DB record and deletes its folder.
#[tauri::command]
pub fn uninstall_extension_cmd(
    id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    uninstall_extension(&db, &id).map_err(|e| e.to_string())?;
    drop(db);

    let mut guard = state.extensions.lock().unwrap();
    guard.retain(|e| e.manifest.id != id);
    Ok(())
}
