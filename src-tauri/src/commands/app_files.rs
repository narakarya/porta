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
    // macOS apps launched via Finder/Dock don't inherit shell PATH,
    // so we also check common install locations for editor CLIs.
    let candidates: &[&[&str]] = &[
        &["cursor", "/usr/local/bin/cursor", "/opt/homebrew/bin/cursor"],
        &["code", "/usr/local/bin/code", "/opt/homebrew/bin/code"],
        &["zed", "/usr/local/bin/zed", "/opt/homebrew/bin/zed"],
    ];
    for group in candidates {
        for bin in *group {
            if std::process::Command::new(bin)
                .arg(&root_dir)
                .spawn()
                .is_ok()
            {
                return Ok(());
            }
        }
    }
    // Fallback: open via macOS `open -a` with known editor app bundles
    let app_bundles = [
        "Cursor",
        "Visual Studio Code",
        "Zed",
    ];
    for app in &app_bundles {
        if std::process::Command::new("open")
            .args(["-a", app, &root_dir])
            .spawn()
            .is_ok()
        {
            return Ok(());
        }
    }
    Err("No editor found. Install Cursor, VS Code, or Zed.".into())
}
