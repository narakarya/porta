#[tauri::command]
pub fn get_app_logs(id: String) -> Vec<String> {
    let path = crate::process_manager::log_file_path(&id);
    let Ok(bytes) = std::fs::read(&path) else { return vec![] };
    String::from_utf8_lossy(&bytes)
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| l.to_string())
        .collect()
}

/// Write `contents` to `path` on disk (used for export-to-chosen-location).
#[tauri::command]
pub fn save_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| e.to_string())
}

/// Reveal a file or folder in Finder (macOS `open -R`).
#[tauri::command]
pub fn reveal_in_finder(path: String) -> Result<(), String> {
    std::process::Command::new("open")
        .args(["-R", &path])
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn open_in_editor(root_dir: String) -> Result<(), String> {
    // Try editors in order: cursor, code, zed, then fall back to Finder
    let editors = ["cursor", "code", "zed"];
    for editor in &editors {
        if std::process::Command::new(editor)
            .arg(&root_dir)
            .spawn()
            .is_ok()
        {
            return Ok(());
        }
    }
    // Fallback: open in Finder
    std::process::Command::new("open")
        .arg(&root_dir)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}
