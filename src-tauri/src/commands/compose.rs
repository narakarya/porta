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

/// Validate YAML then write `content` to `target`. Used by both the Tauri
/// command and internal app-add/update callers that already know the path.
pub fn save_compose_to_path(target: &std::path::Path, content: &str) -> Result<String, String> {
    serde_yaml::from_str::<serde_yaml::Value>(content)
        .map_err(|e| format!("Invalid YAML: {}", e))?;
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(target, content).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().into_owned())
}

/// Validate then write a compose YAML for `app_id`.
///
/// Behaviour depends on how the app was added:
///   - Paste-mode apps store their compose under Porta's managed tree
///     (`<porta_dir>/compose/<app_id>/docker-compose.yml`) — saves go there.
///   - File-mode apps point at a user-owned file on disk — saves overwrite
///     that file in place. This is what the user expects when they pick
///     "File on disk" or use the unified file editor: Edit means "edit the
///     file", not "fork into a hidden Porta copy".
///
/// Returns the absolute path of the written file.
#[tauri::command]
pub fn save_compose_yaml(
    state: tauri::State<'_, crate::app_state::AppState>,
    app_id: String,
    content: String,
) -> Result<String, String> {
    let stored = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.list_apps()
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|a| a.id == app_id)
            .and_then(|a| a.compose_file)
    };

    let target: std::path::PathBuf = match stored {
        // User-owned file → write in place.
        Some(p) if !p.trim().is_empty() && !is_managed(&p) => std::path::PathBuf::from(p),
        // Paste-mode (no file path, or path lives under Porta's managed tree).
        _ => managed_compose_path(&app_id),
    };

    save_compose_to_path(&target, &content)
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

// ── In-place image tag patch ────────────────────────────────────────────────

/// Rewrite the `image:` line of a single service in a compose YAML, preserving
/// formatting (whitespace, comments, key order) outside of that one line.
///
/// We deliberately do NOT round-trip through serde_yaml because that drops
/// comments and reflows layout. Instead this is a targeted line edit:
///
///   1. Walk lines; track current indent level.
///   2. When we cross into the target service block (under `services:`),
///      look for an `image:` line at indent > service's indent.
///   3. Replace just the `<repo>:<tag>` portion of that line, keeping any
///      leading whitespace and trailing comments intact.
///
/// Returns the new file path on success (same as the input). Errors out if
/// the service or its image line can't be located.
fn patch_image_tag_in_yaml(
    yaml: &str,
    service_name: &str,
    new_tag: &str,
) -> Result<String, String> {
    let mut out: Vec<String> = Vec::with_capacity(yaml.lines().count() + 1);
    let mut in_services = false;
    let mut services_indent: Option<usize> = None;
    let mut in_target = false;
    let mut target_indent: Option<usize> = None;
    let mut patched = false;

    let line_indent = |s: &str| s.chars().take_while(|c| *c == ' ').count();
    let stripped_kind = |trimmed: &str| -> Option<String> {
        // Returns the key name when the line looks like `key:` (with
        // optional value). Skips list items and comments.
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with('-') {
            return None;
        }
        let colon = trimmed.find(':')?;
        Some(trimmed[..colon].to_string())
    };

    for raw in yaml.split_inclusive('\n') {
        // Strip exactly one trailing \n (or \r\n) to inspect, then re-add.
        let has_nl = raw.ends_with('\n');
        let body = if has_nl { &raw[..raw.len() - 1] } else { raw };
        let body = body.strip_suffix('\r').unwrap_or(body);

        let trimmed = body.trim_start();
        let indent = line_indent(body);

        if !patched {
            if trimmed == "services:" || trimmed.starts_with("services:") && stripped_kind(trimmed).as_deref() == Some("services") {
                in_services = true;
                services_indent = Some(indent);
                in_target = false;
                target_indent = None;
            } else if in_services {
                let svc_block_indent = services_indent.unwrap_or(0);
                if indent <= svc_block_indent && !trimmed.is_empty() && !trimmed.starts_with('#') {
                    // Left services: block.
                    in_services = false;
                    in_target = false;
                } else if let Some(key) = stripped_kind(trimmed) {
                    if !in_target {
                        // Service header at indent > services_indent.
                        if indent > svc_block_indent && key == service_name {
                            in_target = true;
                            target_indent = Some(indent);
                        }
                    } else {
                        // Inside target service.
                        let tgt_indent = target_indent.unwrap_or(0);
                        if indent <= tgt_indent {
                            // Block ended (sibling service or out).
                            in_target = false;
                            target_indent = None;
                            // Re-evaluate this line as a potential new service header.
                            if indent > svc_block_indent && key == service_name {
                                in_target = true;
                                target_indent = Some(indent);
                            }
                        } else if key == "image" {
                            // Targeted line: split off any inline trailing comment.
                            let (value_part, comment_part) = match body.find('#') {
                                Some(idx) => (&body[..idx], &body[idx..]),
                                None => (body, ""),
                            };
                            // value_part: "  image: foo:bar  "
                            let after_colon = value_part
                                .find(':')
                                .map(|i| i + 1)
                                .ok_or_else(|| "image line missing colon".to_string())?;
                            let prefix = &value_part[..after_colon];
                            let tail_ws_len = value_part.len() - value_part.trim_end().len();
                            let trail_ws = &value_part[value_part.len() - tail_ws_len..];
                            let raw_value = value_part[after_colon..value_part.len() - tail_ws_len].trim();

                            let (repo, _old_tag) = match raw_value.rsplit_once(':') {
                                // Don't be confused by registry-host port (e.g. localhost:5000/x:1.0):
                                // a colon inside a path-like prefix means we should split on the LAST colon
                                // only when the right side has no `/`.
                                Some((r, t)) if !t.contains('/') => (r, t),
                                _ => (raw_value, "latest"),
                            };

                            let new_value = format!("{}:{}", repo, new_tag);
                            let mut rebuilt = String::new();
                            rebuilt.push_str(prefix);
                            // Preserve a single space after the colon (most YAML uses this).
                            if !prefix.ends_with(' ') {
                                rebuilt.push(' ');
                            }
                            rebuilt.push_str(&new_value);
                            rebuilt.push_str(trail_ws);
                            rebuilt.push_str(comment_part);
                            if has_nl {
                                rebuilt.push('\n');
                            }
                            out.push(rebuilt);
                            patched = true;
                            continue;
                        }
                    }
                }
            }
        }
        out.push(raw.to_string());
    }

    if !patched {
        return Err(format!(
            "service '{}' or its image: line not found in compose",
            service_name
        ));
    }
    Ok(out.concat())
}

/// Apply a recommended image tag (e.g. from update-risk analysis) to the
/// compose file in place. Validates the resulting YAML still parses, then
/// writes back to the same path.
#[tauri::command]
pub fn update_compose_image_tag(
    path: String,
    service_name: String,
    new_tag: String,
) -> Result<String, String> {
    let original = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let updated = patch_image_tag_in_yaml(&original, &service_name, &new_tag)?;
    serde_yaml::from_str::<serde_yaml::Value>(&updated)
        .map_err(|e| format!("Patched compose no longer parses: {}", e))?;
    let target = std::path::PathBuf::from(&path);
    save_compose_to_path(&target, &updated)
}

/// Higher-level patch: find every service whose `image` matches `current_image`
/// (verbatim — `repo:tag` or repo only) and bump it to `new_tag`. Convenient
/// from the UI: caller has the offending image string from update classification
/// and doesn't need to first walk the parsed compose to learn the service name.
///
/// Returns the list of services that were patched. Errors when no service in
/// the file uses the given image.
#[derive(serde::Serialize)]
pub struct ImageTagUpdateSummary {
    pub services_updated: Vec<String>,
    pub path: String,
}

#[tauri::command]
pub fn update_compose_image_for(
    path: String,
    current_image: String,
    new_tag: String,
) -> Result<ImageTagUpdateSummary, String> {
    let original = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let parsed = compose_parser::parse_compose_str(&original)
        .map_err(|e| format!("Failed to parse compose: {}", e))?;

    // Match either the exact "repo:tag" or just the repo (for tag-less specs).
    let (current_repo, _current_tag) = match current_image.rsplit_once(':') {
        Some((r, t)) if !t.contains('/') => (r.to_string(), Some(t.to_string())),
        _ => (current_image.clone(), None),
    };

    let mut to_patch: Vec<String> = Vec::new();
    for svc in &parsed.services {
        let Some(img) = svc.image.as_deref() else { continue };
        let (svc_repo, _) = match img.rsplit_once(':') {
            Some((r, t)) if !t.contains('/') => (r, Some(t)),
            _ => (img, None),
        };
        if svc_repo == current_repo {
            to_patch.push(svc.name.clone());
        }
    }

    if to_patch.is_empty() {
        return Err(format!(
            "no service in compose uses image '{}'",
            current_image
        ));
    }

    let mut content = original;
    for svc_name in &to_patch {
        content = patch_image_tag_in_yaml(&content, svc_name, &new_tag)?;
    }
    serde_yaml::from_str::<serde_yaml::Value>(&content)
        .map_err(|e| format!("Patched compose no longer parses: {}", e))?;
    let target = std::path::PathBuf::from(&path);
    let written = save_compose_to_path(&target, &content)?;
    Ok(ImageTagUpdateSummary {
        services_updated: to_patch,
        path: written,
    })
}

#[cfg(test)]
mod tests {
    use super::patch_image_tag_in_yaml;

    #[test]
    fn replaces_simple_tag() {
        let src = "services:\n  db:\n    image: mysql:8.0\n    restart: unless-stopped\n";
        let out = patch_image_tag_in_yaml(src, "db", "8.4").unwrap();
        assert!(out.contains("image: mysql:8.4"));
        assert!(out.contains("restart: unless-stopped"));
    }

    #[test]
    fn preserves_inline_comment() {
        let src = "services:\n  db:\n    image: mysql:8.0  # legacy LTS\n";
        let out = patch_image_tag_in_yaml(src, "db", "8.4").unwrap();
        assert!(out.contains("image: mysql:8.4  # legacy LTS"));
    }

    #[test]
    fn handles_registry_with_port() {
        let src = "services:\n  app:\n    image: ghcr.io/foo/bar:1.2.3\n";
        let out = patch_image_tag_in_yaml(src, "app", "1.3.0").unwrap();
        assert!(out.contains("image: ghcr.io/foo/bar:1.3.0"));
    }

    #[test]
    fn only_patches_named_service() {
        let src =
            "services:\n  db:\n    image: mysql:8.0\n  cache:\n    image: redis:7\n";
        let out = patch_image_tag_in_yaml(src, "cache", "7.4").unwrap();
        assert!(out.contains("image: mysql:8.0"));
        assert!(out.contains("image: redis:7.4"));
    }

    #[test]
    fn errors_on_missing_service() {
        let src = "services:\n  db:\n    image: mysql:8.0\n";
        let err = patch_image_tag_in_yaml(src, "missing", "x").unwrap_err();
        assert!(err.contains("missing"));
    }
}
