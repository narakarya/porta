use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DetectResult {
    pub command: String,
    pub source: String,
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

pub fn detect(root: &Path) -> DetectResult {
    if root.join("mix.exs").exists() {
        return DetectResult { command: "mix phx.server".into(), source: "auto".into() };
    }

    if let Ok(raw) = fs::read_to_string(root.join("package.json")) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) {
            let scripts = &json["scripts"];
            if scripts["dev"].is_string() {
                return DetectResult { command: "npm run dev".into(), source: "auto".into() };
            }
            if scripts["start"].is_string() {
                return DetectResult { command: "npm start".into(), source: "auto".into() };
            }
        }
    }

    if root.join("Procfile").exists() {
        if let Ok(content) = fs::read_to_string(root.join("Procfile")) {
            if let Some(line) = content.lines().next() {
                let cmd = line.split_once(':').map(|(_, v)| v.trim()).unwrap_or("").to_string();
                if !cmd.is_empty() {
                    return DetectResult { command: cmd, source: "auto".into() };
                }
            }
        }
    }

    if let Ok(content) = fs::read_to_string(root.join("Makefile")) {
        if content.contains("\ndev:") || content.starts_with("dev:") {
            return DetectResult { command: "make dev".into(), source: "auto".into() };
        }
    }

    DetectResult { command: "".into(), source: "manual".into() }
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
    }
}
