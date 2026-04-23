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

#[derive(serde::Serialize)]
pub struct GitStatus {
    pub in_repo: bool,
    pub branch: Option<String>,
    pub dirty: bool,
}

/// Read git branch + dirty state for an app's root_dir. Best-effort: returns
/// `in_repo: false` for non-repos, missing dirs, or if `git` isn't installed.
/// `--no-optional-locks` keeps us from interfering with the user's git work.
#[tauri::command]
pub fn get_git_status(root_dir: String) -> GitStatus {
    let path = std::path::Path::new(&root_dir);
    if !path.exists() {
        return GitStatus { in_repo: false, branch: None, dirty: false };
    }

    let in_repo = std::process::Command::new("git")
        .args(["-C", &root_dir, "--no-optional-locks", "rev-parse", "--is-inside-work-tree"])
        .output()
        .ok()
        .map(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == "true")
        .unwrap_or(false);

    if !in_repo {
        return GitStatus { in_repo: false, branch: None, dirty: false };
    }

    let branch = std::process::Command::new("git")
        .args(["-C", &root_dir, "--no-optional-locks", "branch", "--show-current"])
        .output()
        .ok()
        .and_then(|o| {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if s.is_empty() {
                // Detached HEAD — show short SHA instead.
                std::process::Command::new("git")
                    .args(["-C", &root_dir, "--no-optional-locks", "rev-parse", "--short", "HEAD"])
                    .output()
                    .ok()
                    .map(|o2| String::from_utf8_lossy(&o2.stdout).trim().to_string())
                    .filter(|s| !s.is_empty())
            } else {
                Some(s)
            }
        });

    let dirty = std::process::Command::new("git")
        .args(["-C", &root_dir, "--no-optional-locks", "status", "--porcelain"])
        .output()
        .ok()
        .map(|o| !o.stdout.is_empty())
        .unwrap_or(false);

    GitStatus { in_repo: true, branch, dirty }
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
