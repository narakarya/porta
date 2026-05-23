use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DetectResult {
    pub command: String,
    pub source: String,
    /// "process" (default) or "static". Static is detected when `index.html`
    /// exists at the root and there is no `package.json`/`yarn.lock`/`pnpm-lock.yaml`
    /// — i.e. the folder looks like plain HTML rather than a JS project.
    #[serde(default = "default_kind")]
    pub kind: String,
}

fn default_kind() -> String { "process".into() }

/// Returns "static" if the folder looks like a plain static site
/// (index.html present and no JS/Ruby/Elixir project files), else "process".
pub fn detect_kind(root: &Path) -> String {
    let has_index = root.join("index.html").exists();
    if !has_index {
        return "process".into();
    }
    let has_project_files = root.join("package.json").exists()
        || root.join("yarn.lock").exists()
        || root.join("pnpm-lock.yaml").exists()
        || root.join("mix.exs").exists()
        || root.join("Gemfile").exists()
        || root.join("Procfile").exists();
    if has_project_files { "process".into() } else { "static".into() }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandSuggestion {
    pub label: String,
    pub source: String,
}

/// Return every runnable command discovered in `root` — used to populate
/// the start-command picker in the UI.
pub fn list_commands(root: &Path) -> Vec<CommandSuggestion> {
    let mut out: Vec<CommandSuggestion> = Vec::new();

    // ── Elixir / Phoenix ──────────────────────────────────────────────────────
    if root.join("mix.exs").exists() {
        for cmd in &[
            "mix phx.server",
            "iex -S mix phx.server",
            "mix test",
            "mix ecto.setup",
            "mix ecto.migrate",
        ] {
            out.push(CommandSuggestion { label: cmd.to_string(), source: "mix.exs".to_string() });
        }
    }

    // ── Node.js (detect yarn / pnpm / npm) ───────────────────────────────────
    if let Ok(raw) = fs::read_to_string(root.join("package.json")) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(scripts) = json["scripts"].as_object() {
                let pm = if root.join("yarn.lock").exists() { "yarn" }
                         else if root.join("pnpm-lock.yaml").exists() { "pnpm run" }
                         else { "npm run" };
                let mut keys: Vec<&String> = scripts.keys().collect();
                keys.sort();
                for key in keys {
                    out.push(CommandSuggestion {
                        label: format!("{} {}", pm, key),
                        source: format!("package.json → {}", key),
                    });
                }
            }
        }
    }

    // ── Ruby / Rails ──────────────────────────────────────────────────────────
    if root.join("Gemfile").exists() {
        out.push(CommandSuggestion { label: "bin/rails server".to_string(), source: "Rails".to_string() });
        out.push(CommandSuggestion { label: "bundle exec rails s".to_string(), source: "Gemfile".to_string() });
    }

    // ── Procfile ──────────────────────────────────────────────────────────────
    if let Ok(content) = fs::read_to_string(root.join("Procfile")) {
        for line in content.lines() {
            if let Some((_, cmd)) = line.split_once(':') {
                let cmd = cmd.trim().to_string();
                if !cmd.is_empty() {
                    out.push(CommandSuggestion { label: cmd, source: "Procfile".to_string() });
                }
            }
        }
    }

    // ── Makefile targets ──────────────────────────────────────────────────────
    if let Ok(content) = fs::read_to_string(root.join("Makefile")) {
        for line in content.lines() {
            if line.starts_with('\t') || line.starts_with('#') || line.is_empty() { continue; }
            // "target: deps" — grab the part before ':'
            if let Some(target) = line.split(':').next() {
                let t = target.trim();
                if !t.is_empty() && !t.starts_with('.') && !t.contains(' ') && !t.contains('$') {
                    out.push(CommandSuggestion { label: format!("make {}", t), source: "Makefile".to_string() });
                }
            }
        }
    }

    out
}

/// Detect framework tags for a given root directory.
/// Returns a list of lowercase tag strings like ["elixir", "phoenix", "nodejs"].
/// Used by the extension system to determine which extensions should activate.
pub fn detect_tags(root: &Path) -> Vec<String> {
    let mut tags = Vec::new();

    // Elixir / Phoenix
    if root.join("mix.exs").exists() {
        tags.push("elixir".into());
        // Check if mix.exs references phoenix
        let is_phoenix = fs::read_to_string(root.join("mix.exs"))
            .map(|s| s.contains("{:phoenix,") || s.contains(":phoenix_live_view") || s.contains("Phoenix"))
            .unwrap_or(false)
            || root.join("deps").join("phoenix").exists()
            || root.join("lib").exists() && root.join("config").join("config.exs").exists();
        if is_phoenix {
            tags.push("phoenix".into());
        }
    }

    // Node.js
    if root.join("package.json").exists() {
        tags.push("nodejs".into());
        if root.join("next.config.js").exists() || root.join("next.config.ts").exists() || root.join("next.config.mjs").exists() {
            tags.push("nextjs".into());
        }
        if root.join("angular.json").exists() {
            tags.push("angular".into());
        }
        if root.join("vite.config.ts").exists() || root.join("vite.config.js").exists() {
            tags.push("vite".into());
        }
    }

    // Ruby / Rails
    if root.join("Gemfile").exists() {
        tags.push("ruby".into());
        let is_rails = fs::read_to_string(root.join("Gemfile"))
            .map(|s| s.contains("rails"))
            .unwrap_or(false)
            || root.join("bin").join("rails").exists();
        if is_rails {
            tags.push("rails".into());
        }
    }

    // Python
    if root.join("requirements.txt").exists() || root.join("pyproject.toml").exists() || root.join("setup.py").exists() {
        tags.push("python".into());
        if root.join("manage.py").exists() {
            tags.push("django".into());
        }
    }

    // Go
    if root.join("go.mod").exists() {
        tags.push("go".into());
    }

    // Rust
    if root.join("Cargo.toml").exists() {
        tags.push("rust".into());
    }

    // Java / Kotlin
    if root.join("pom.xml").exists() {
        tags.push("java".into());
        tags.push("maven".into());
    }
    if root.join("build.gradle").exists() || root.join("build.gradle.kts").exists() {
        tags.push("java".into());
        tags.push("gradle".into());
    }

    tags.dedup();
    tags
}

pub fn detect(root: &Path) -> DetectResult {
    let kind = detect_kind(root);

    // Static folder — no command needed; Caddy serves it directly.
    if kind == "static" {
        return DetectResult { command: "".into(), source: "auto".into(), kind };
    }

    if root.join("mix.exs").exists() {
        return DetectResult { command: "mix phx.server".into(), source: "auto".into(), kind };
    }

    if let Ok(raw) = fs::read_to_string(root.join("package.json")) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) {
            let scripts = &json["scripts"];
            if scripts["dev"].is_string() {
                return DetectResult { command: "npm run dev".into(), source: "auto".into(), kind };
            }
            if scripts["start"].is_string() {
                return DetectResult { command: "npm start".into(), source: "auto".into(), kind };
            }
        }
    }

    if root.join("Procfile").exists() {
        if let Ok(content) = fs::read_to_string(root.join("Procfile")) {
            if let Some(line) = content.lines().next() {
                let cmd = line.split_once(':').map(|(_, v)| v.trim()).unwrap_or("").to_string();
                if !cmd.is_empty() {
                    return DetectResult { command: cmd, source: "auto".into(), kind };
                }
            }
        }
    }

    if let Ok(content) = fs::read_to_string(root.join("Makefile")) {
        if content.contains("\ndev:") || content.starts_with("dev:") {
            return DetectResult { command: "make dev".into(), source: "auto".into(), kind };
        }
    }

    DetectResult { command: "".into(), source: "manual".into(), kind }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn test_detects_elixir() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("mix.exs"), "# mix").unwrap();
        let result = detect(dir.path());
        assert_eq!(result.command, "mix phx.server");
        assert_eq!(result.source, "auto");
    }

    #[test]
    fn test_detects_npm_dev() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("package.json"), r#"{"scripts":{"dev":"next dev"}}"#).unwrap();
        let result = detect(dir.path());
        assert_eq!(result.command, "npm run dev");
    }

    #[test]
    fn test_detects_npm_start_fallback() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("package.json"), r#"{"scripts":{"start":"node server.js"}}"#).unwrap();
        let result = detect(dir.path());
        assert_eq!(result.command, "npm start");
    }

    #[test]
    fn test_detects_procfile() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("Procfile"), "web: bundle exec rails s\n").unwrap();
        let result = detect(dir.path());
        assert_eq!(result.command, "bundle exec rails s");
    }

    #[test]
    fn test_returns_manual_when_nothing_found() {
        let dir = tempdir().unwrap();
        let result = detect(dir.path());
        assert_eq!(result.source, "manual");
        assert_eq!(result.command, "");
        assert_eq!(result.kind, "process");
    }

    #[test]
    fn test_detects_static_when_only_index_html() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("index.html"), "<h1>hi</h1>").unwrap();
        let result = detect(dir.path());
        assert_eq!(result.kind, "static");
        assert_eq!(result.command, "");
    }

    #[test]
    fn test_index_html_with_package_json_is_process() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("index.html"), "<h1>hi</h1>").unwrap();
        fs::write(dir.path().join("package.json"), r#"{"scripts":{"dev":"vite"}}"#).unwrap();
        let result = detect(dir.path());
        assert_eq!(result.kind, "process");
        assert_eq!(result.command, "npm run dev");
    }
}
