use std::path::PathBuf;
use std::process::Command;
use tauri::State;

use crate::app_state::AppState;

/// Returns the local git sync repo directory inside porta data dir.
fn sync_repo_dir() -> PathBuf {
    crate::porta_dir().join("sync")
}

fn run_git(args: &[&str], cwd: &PathBuf) -> Result<String, String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("git command failed: {}", e))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("git {} failed: {}", args.join(" "), stderr.trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Check if git is available.
#[tauri::command]
pub fn git_sync_check() -> Result<bool, String> {
    Command::new("git")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .map_err(|e| e.to_string())
}

/// Get the currently configured sync repo URL (if any).
#[tauri::command]
pub fn git_sync_get_repo() -> Option<String> {
    let dir = sync_repo_dir();
    if !dir.join(".git").exists() {
        return None;
    }
    run_git(&["remote", "get-url", "origin"], &dir).ok()
}

/// Configure the sync repo URL. Clones if new, updates remote if changed.
#[tauri::command]
pub fn git_sync_set_repo(url: String) -> Result<(), String> {
    let dir = sync_repo_dir();

    if dir.join(".git").exists() {
        // Update remote URL
        run_git(&["remote", "set-url", "origin", &url], &dir)?;
        run_git(&["pull", "--rebase", "--autostash"], &dir).ok(); // best-effort pull
        return Ok(());
    }

    // Fresh clone
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // Clone into the sync dir
    let parent = dir.parent().unwrap_or(&dir);
    let dir_name = dir.file_name().unwrap().to_string_lossy().to_string();
    run_git(&["clone", &url, &dir_name], &parent.to_path_buf())?;
    Ok(())
}

/// Test connection to the configured repo (fetch without merging).
#[tauri::command]
pub fn git_sync_test() -> Result<(), String> {
    let dir = sync_repo_dir();
    if !dir.join(".git").exists() {
        return Err("No sync repository configured".into());
    }
    run_git(&["fetch", "--dry-run"], &dir)
        .map(|_| ())
}

/// Push current config to the sync repo.
#[tauri::command]
pub fn git_sync_push(state: State<AppState>) -> Result<String, String> {
    let dir = sync_repo_dir();
    if !dir.join(".git").exists() {
        return Err("No sync repository configured".into());
    }

    // Pull latest first
    run_git(&["pull", "--rebase", "--autostash"], &dir).ok();

    // Export current state
    let db = state.db.lock().unwrap();
    let workspaces = db.list_workspaces().map_err(|e| e.to_string())?;
    let apps = db.list_apps().map_err(|e| e.to_string())?;
    drop(db);
    let json = crate::backup::export(&workspaces, &apps).map_err(|e| e.to_string())?;

    // Write config file
    let config_path = dir.join("porta-config.json");
    std::fs::write(&config_path, &json).map_err(|e| e.to_string())?;

    // Check if there are changes
    let status = run_git(&["status", "--porcelain"], &dir)?;
    if status.is_empty() {
        return Ok("No changes to sync".into());
    }

    // Commit and push
    run_git(&["add", "porta-config.json"], &dir)?;
    let timestamp = chrono::Utc::now().to_rfc3339();
    run_git(&["commit", "-m", &format!("porta sync {}", timestamp)], &dir)?;
    run_git(&["push"], &dir)?;

    Ok(timestamp)
}

/// Pull config from the sync repo and return the JSON content (frontend decides whether to import).
#[tauri::command]
pub fn git_sync_pull() -> Result<Option<String>, String> {
    let dir = sync_repo_dir();
    if !dir.join(".git").exists() {
        return Err("No sync repository configured".into());
    }

    run_git(&["pull", "--rebase", "--autostash"], &dir)?;

    let config_path = dir.join("porta-config.json");
    if !config_path.exists() {
        return Ok(None);
    }

    let json = std::fs::read_to_string(&config_path).map_err(|e| e.to_string())?;
    Ok(Some(json))
}

/// Disconnect: remove the local sync repo.
#[tauri::command]
pub fn git_sync_disconnect() -> Result<(), String> {
    let dir = sync_repo_dir();
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}
