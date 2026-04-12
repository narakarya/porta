use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DetectResult {
    pub command: String,
    pub source: String,
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
                let cmd = line.splitn(2, ':').nth(1).unwrap_or("").trim().to_string();
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
