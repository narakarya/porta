use crate::compose_parser::{self, ComposeProject};

#[tauri::command]
pub fn parse_docker_compose(path: String) -> Result<ComposeProject, String> {
    compose_parser::parse_compose(&path)
}

/// Parse compose YAML content directly (no file read). Used by the UI to
/// auto-detect ports/services from a pasted yml.
#[tauri::command]
pub fn parse_compose_string(content: String) -> Result<ComposeProject, String> {
    compose_parser::parse_compose_str(&content)
}

/// Directory where Porta manages pasted compose files.
/// Each app gets `<porta_dir>/compose/<app_id>/docker-compose.yml`.
fn managed_compose_dir(app_id: &str) -> std::path::PathBuf {
    crate::porta_dir().join("compose").join(app_id)
}

pub fn managed_compose_path(app_id: &str) -> std::path::PathBuf {
    managed_compose_dir(app_id).join("docker-compose.yml")
}

/// Validate then write a pasted compose YAML to Porta's managed location.
/// Returns the absolute path of the written file.
#[tauri::command]
pub fn save_compose_yaml(app_id: String, content: String) -> Result<String, String> {
    // Basic YAML validation — ensure it parses. We don't enforce the compose
    // schema (that's up to docker compose); we just catch obviously-broken YAML.
    serde_yaml::from_str::<serde_yaml::Value>(&content)
        .map_err(|e| format!("Invalid YAML: {}", e))?;

    let dir = managed_compose_dir(&app_id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("docker-compose.yml");
    std::fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// Load a compose file's raw contents. Used when editing a pasted compose in
/// Settings so the textarea is pre-filled.
#[tauri::command]
pub fn load_compose_yaml(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Remove Porta's managed compose directory for an app (if any). Called from
/// delete_app so pasted YAML doesn't linger after the app is gone.
pub fn cleanup_managed_compose(app_id: &str) {
    let dir = managed_compose_dir(app_id);
    if dir.exists() {
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// True if `path` lives inside Porta's managed compose tree.
pub fn is_managed(path: &str) -> bool {
    let managed_root = crate::porta_dir().join("compose");
    std::path::Path::new(path).starts_with(managed_root)
}
