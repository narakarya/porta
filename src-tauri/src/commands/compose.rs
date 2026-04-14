use crate::compose_parser::{self, ComposeProject};

#[tauri::command]
pub fn parse_docker_compose(path: String) -> Result<ComposeProject, String> {
    compose_parser::parse_compose(&path)
}
