use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::commands::settings::{read_porta_config, write_porta_config};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServiceTemplate {
    pub id: String,
    pub label: String,
    pub icon: String,
    pub image: String,
    pub tag: String,
    #[serde(default)]
    pub versions: Vec<String>,
    pub port: u16,
    #[serde(default)]
    pub env_vars: HashMap<String, String>,
    #[serde(default)]
    pub volumes: Vec<String>,
}

fn load() -> Vec<ServiceTemplate> {
    read_porta_config()
        .get("service_templates")
        .and_then(|v| serde_json::from_value::<Vec<ServiceTemplate>>(v.clone()).ok())
        .unwrap_or_default()
}

fn persist(templates: &[ServiceTemplate]) -> Result<(), String> {
    let mut cfg = read_porta_config();
    cfg["service_templates"] = serde_json::to_value(templates).map_err(|e| e.to_string())?;
    write_porta_config(&cfg);
    Ok(())
}

#[tauri::command]
pub fn list_service_templates() -> Vec<ServiceTemplate> {
    load()
}

#[tauri::command]
pub fn save_service_template(template: ServiceTemplate) -> Result<ServiceTemplate, String> {
    let mut templates = load();
    if let Some(existing) = templates.iter_mut().find(|t| t.id == template.id) {
        *existing = template.clone();
    } else {
        templates.push(template.clone());
    }
    persist(&templates)?;
    Ok(template)
}

#[tauri::command]
pub fn delete_service_template(id: String) -> Result<(), String> {
    let mut templates = load();
    templates.retain(|t| t.id != id);
    persist(&templates)
}
