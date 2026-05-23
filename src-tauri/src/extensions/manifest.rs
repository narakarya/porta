use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionContrib {
    pub id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tooltip: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ExtensionContributes {
    #[serde(default, rename = "appActions")]
    pub app_actions: Vec<ActionContrib>,
}

/// Parsed content of `porta.json` inside an extension folder.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtensionManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    /// Filter: which app kinds this extension activates for.
    /// Examples: ["*"], ["app:kind:phoenix"], ["app:kind:elixir", "app:kind:phoenix"]
    #[serde(default, rename = "activateOn")]
    pub activate_on: Vec<String>,
    #[serde(default)]
    pub contributes: ExtensionContributes,
    /// Required Porta capabilities: "shell", "fs:read"
    #[serde(default)]
    pub permissions: Vec<String>,
    /// Relative path to main HTML entry point inside the extension folder.
    pub main: String,
    #[serde(skip_serializing_if = "Option::is_none", rename = "minPortaVersion")]
    pub min_porta_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
}

impl ExtensionManifest {
    /// Load and parse `porta.json` from `folder_path`.
    pub fn load_from_dir(folder_path: &std::path::Path) -> anyhow::Result<Self> {
        let manifest_path = folder_path.join("porta.json");
        let raw = std::fs::read_to_string(&manifest_path)
            .map_err(|e| anyhow::anyhow!("Cannot read porta.json at {:?}: {}", manifest_path, e))?;
        let manifest: Self = serde_json::from_str(&raw)
            .map_err(|e| anyhow::anyhow!("Invalid porta.json in {:?}: {}", folder_path, e))?;
        manifest.validate(folder_path)?;
        Ok(manifest)
    }

    /// Basic sanity checks after parsing.
    pub fn validate(&self, folder_path: &std::path::Path) -> anyhow::Result<()> {
        if self.id.is_empty() {
            anyhow::bail!("Extension id cannot be empty");
        }
        // id: only lowercase alphanumeric + hyphens
        if !self.id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            anyhow::bail!("Extension id '{}' must only contain [a-z0-9-]", self.id);
        }
        if self.name.is_empty() {
            anyhow::bail!("Extension name cannot be empty");
        }
        let main_path = folder_path.join(&self.main);
        if !main_path.exists() {
            anyhow::bail!("main file '{}' not found in {:?}", self.main, folder_path);
        }
        Ok(())
    }

    /// Returns true if this extension should activate for an app with the given kind tag.
    /// kind_tag examples: "phoenix", "elixir", "compose", "docker", "process"
    pub fn matches_app_kind(&self, kind_tag: &str) -> bool {
        if self.activate_on.is_empty() {
            return false;
        }
        for pattern in &self.activate_on {
            if pattern == "*" {
                return true;
            }
            if pattern == &format!("app:kind:{}", kind_tag) {
                return true;
            }
            if pattern == "app:root:*" {
                return true;
            }
        }
        false
    }

    /// Returns true if this extension requires shell execution permission.
    pub fn has_shell_permission(&self) -> bool {
        self.permissions.iter().any(|p| p == "shell")
    }
}

/// Runtime representation stored in AppState.
#[derive(Debug, Clone, Serialize)]
pub struct LoadedExtension {
    pub manifest: ExtensionManifest,
    /// Absolute path to the extension folder.
    pub path: std::path::PathBuf,
    /// Absolute path to the main HTML file.
    pub main_path: std::path::PathBuf,
    pub enabled: bool,
}

impl LoadedExtension {
    pub fn new(manifest: ExtensionManifest, folder: std::path::PathBuf, enabled: bool) -> Self {
        let main_path = folder.join(&manifest.main);
        Self { manifest, path: folder, main_path, enabled }
    }

    /// Serialized form sent to the frontend.
    pub fn to_info(&self) -> ExtensionInfo {
        ExtensionInfo {
            id: self.manifest.id.clone(),
            name: self.manifest.name.clone(),
            version: self.manifest.version.clone(),
            description: self.manifest.description.clone(),
            author: self.manifest.author.clone().unwrap_or_default(),
            enabled: self.enabled,
            path: self.path.to_string_lossy().into_owned(),
            main_path: self.main_path.to_string_lossy().into_owned(),
            contributes_app_actions: self.manifest.contributes.app_actions.clone(),
            permissions: self.manifest.permissions.clone(),
            activate_on: self.manifest.activate_on.clone(),
        }
    }
}

/// Serialized extension info sent to the frontend via IPC.
#[derive(Debug, Clone, Serialize)]
pub struct ExtensionInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub author: String,
    pub enabled: bool,
    pub path: String,
    pub main_path: String,
    pub contributes_app_actions: Vec<ActionContrib>,
    pub permissions: Vec<String>,
    pub activate_on: Vec<String>,
}
