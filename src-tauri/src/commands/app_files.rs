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

/// Open an https/http URL in the user's default browser. Tauri WebView's
/// `window.open` no-ops for external URLs without scope config; shell out to
/// macOS `open` directly. Scheme-locked to avoid being a generic exec wedge.
#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if !(trimmed.starts_with("https://") || trimmed.starts_with("http://")) {
        return Err("Only http/https URLs are allowed".into());
    }
    std::process::Command::new("open")
        .arg(trimmed)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ── config file editor ──────────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct ConfigFileInfo {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub modified_at: Option<i64>, // epoch seconds; None if unreadable
    pub is_in_compose: bool,
    /// Editor behaviour bucket: "env" (rows + secret masking) or "generic" (code editor).
    pub kind: String,
    /// Syntax-highlight language hint for the generic editor: "toml" | "json" | "text" | "env".
    pub language: String,
    /// Absolute path this file would create if copied as a template (e.g.
    /// `.env.example` → `.env`). Only set when the target does NOT exist yet,
    /// so the UI's "create from template" banner clears itself on the next
    /// listing without any client-side bookkeeping.
    pub template_target: Option<String>,
}

/// Returns true for filenames that look like an env file. Matches:
///   - `.env`, `.env.<anything>` (covers `.env.dev`, `.env.production`, `.env.dev.local`, …)
///   - `.envrc` (direnv)
///   - `<anything>.env` (covers `dev.env`, `test.env`)
///
/// Excludes editor backup/swap leftovers: trailing `~`, `.swp`, `.bak`, `.orig`,
/// `.tmp` (our own atomic-write temp). Also excludes obvious dotfiles that
/// just happen to start with `.env` like `.environment` (must be exactly `.env`
/// or have `.env.` prefix).
fn is_env_file_name(name: &str) -> bool {
    if name.is_empty() {
        return false;
    }
    if name.ends_with('~')
        || name.ends_with(".swp")
        || name.ends_with(".swo")
        || name.ends_with(".bak")
        || name.ends_with(".orig")
        || name.ends_with(".tmp")
    {
        return false;
    }
    if name == ".env" || name == ".envrc" {
        return true;
    }
    if let Some(rest) = name.strip_prefix(".env.") {
        // require something after the dot (avoid matching `.env.` literal)
        return !rest.is_empty();
    }
    // <stem>.env (no leading dot) — common in Heroku/Procfile-style setups
    if let Some(stem) = name.strip_suffix(".env") {
        return !stem.is_empty() && !stem.starts_with('.');
    }
    false
}

/// Recognised non-env config files Porta lets you edit in-app. Returns the
/// editor `kind` and syntax `language` for a filename, or None if unrecognised.
/// Env files are matched separately by [`is_env_file_name`].
fn classify_extra_config(name: &str) -> Option<(&'static str, &'static str)> {
    match name {
        "mise.toml" | ".mise.toml" | "mise.local.toml" | ".mise.local.toml" => {
            Some(("generic", "toml"))
        }
        ".tool-versions" => Some(("generic", "text")),
        "package.json" => Some(("generic", "json")),
        ".nvmrc" | ".ruby-version" => Some(("generic", "text")),
        _ => None,
    }
}

/// Filename suffixes that mark a file as a template of its stem, in descending
/// priority. When two templates derive the same target, the earlier one wins.
const TEMPLATE_SUFFIXES: &[&str] = &["example", "sample", "template", "dist"];

/// Lowercased final extension of `name`, if it is a template suffix.
fn template_suffix(name: &str) -> Option<String> {
    let (_, ext) = name.rsplit_once('.')?;
    let lower = ext.to_ascii_lowercase();
    TEMPLATE_SUFFIXES.contains(&lower.as_str()).then_some(lower)
}

/// Position of `name`'s template suffix in [`TEMPLATE_SUFFIXES`]. Lower wins.
fn template_priority(name: &str) -> usize {
    template_suffix(name)
        .and_then(|s| TEMPLATE_SUFFIXES.iter().position(|t| *t == s))
        .unwrap_or(usize::MAX)
}

/// The filename a template would produce: strip one trailing template suffix,
/// and only accept the result if it is still an env file we know how to edit.
///
///   `.env.example`     → `.env`
///   `.env.dev.example` → `.env.dev`
///   `.env.local`       → None (not a template)
///   `.example`         → None (empty stem)
fn derive_template_target(name: &str) -> Option<String> {
    let (stem, _) = name.rsplit_once('.')?;
    template_suffix(name)?;
    is_env_file_name(stem).then(|| stem.to_string())
}

/// Substrings (matched against the uppercased key) whose values get emptied when
/// a template is copied. Deliberately narrower than the frontend's masking regex:
/// masking is reversible, blanking is not, so a false positive here costs the user
/// a default they must retype — `API_URL`, `AUTH_URL`, and `SIGNUP_ENABLED` are
/// all safe. Known false positive: `TOKEN_URL`.
const SECRET_BLANK_TOKENS: &[&str] = &[
    "SECRET",
    "PASSWORD",
    "PASSWD",
    "PWD",
    "TOKEN",
    "PRIVATE_KEY",
    "API_KEY",
    "APIKEY",
    "ACCESS_KEY",
    "CREDENTIAL",
    "JWT",
    "HMAC",
    "SALT",
];

fn should_blank_key(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    SECRET_BLANK_TOKENS.iter().any(|t| upper.contains(t))
}

/// Empty the value of every secret-looking `KEY=VALUE` line, leaving comments,
/// blank lines, `export ` prefixes, and non-secret lines byte-identical. Lines
/// whose value is already empty are left alone.
fn blank_secret_values(content: &str) -> String {
    let mut out = String::with_capacity(content.len());
    for (i, line) in content.split('\n').enumerate() {
        if i > 0 {
            out.push('\n');
        }
        let trimmed = line.trim_start();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            out.push_str(line);
            continue;
        }
        let Some(eq) = line.find('=') else {
            out.push_str(line);
            continue;
        };
        let raw_key = line[..eq].trim();
        let key = raw_key.strip_prefix("export ").map(str::trim).unwrap_or(raw_key);
        if line[eq + 1..].is_empty() || !should_blank_key(key) {
            out.push_str(line);
            continue;
        }
        // Keep everything through the `=`, drop the value.
        out.push_str(&line[..=eq]);
    }
    out
}

/// Combined sort key for the config file list: env files first (in their own
/// helpful order), then everything else alphabetically.
fn config_sort_key(info: &ConfigFileInfo) -> (u8, u8, String) {
    if info.kind == "env" {
        (0, env_file_sort_key(&info.name).0, info.name.clone())
    } else {
        (1, 0, info.name.clone())
    }
}

/// Sort key for env files: stable, helpful files first.
///   0 = `.env`           (most common)
///   1 = `.env.example`   (templates)
///   2 = `.envrc`
///   3 = everything else, alphabetically
fn env_file_sort_key(name: &str) -> (u8, String) {
    match name {
        ".env" => (0, String::new()),
        ".env.example" => (1, String::new()),
        ".envrc" => (2, String::new()),
        other => (3, other.to_string()),
    }
}

/// Canonicalize a directory string. Returns None if it doesn't exist or isn't a dir.
fn canon_dir(p: &str) -> Option<std::path::PathBuf> {
    std::fs::canonicalize(p).ok().filter(|p| p.is_dir())
}

/// Returns the canonicalized root_dir for an app whose root contains the
/// given absolute path. Used to validate that read/write targets are inside
/// some registered app's working directory — not arbitrary filesystem paths.
fn validate_path_in_any_app(
    state: &tauri::State<'_, crate::app_state::AppState>,
    abs_path: &str,
) -> Result<std::path::PathBuf, String> {
    let target = std::path::Path::new(abs_path);
    // Canonicalize parent (file may not exist yet for atomic-write tmp), then
    // re-attach the filename.
    let parent = target.parent().ok_or_else(|| "Invalid path".to_string())?;
    let parent_canon = std::fs::canonicalize(parent)
        .map_err(|e| format!("Cannot resolve parent: {}", e))?;
    let file_name = target.file_name().ok_or_else(|| "Invalid path".to_string())?;
    let resolved = parent_canon.join(file_name);

    let apps = state
        .db
        .lock()
        .map_err(|e| e.to_string())?
        .list_apps()
        .map_err(|e| e.to_string())?;
    for a in &apps {
        if a.root_dir.is_empty() {
            continue;
        }
        if let Some(root) = canon_dir(&a.root_dir) {
            if resolved.starts_with(&root) {
                return Ok(resolved);
            }
        }
    }
    Err("Path is not inside any app working directory".into())
}

/// Pull `env_file:` entries from a compose YAML. Supports the three legal
/// shapes (string, list of strings, list of `{path: ..., required: ...}`
/// mappings). Returns paths as written — caller resolves against compose dir.
fn collect_env_files_from_compose(yaml: &str) -> Vec<String> {
    let mut out = Vec::new();
    let Ok(val) = serde_yaml::from_str::<serde_yaml::Value>(yaml) else {
        return out;
    };
    let Some(services) = val.get("services").and_then(|v| v.as_mapping()) else {
        return out;
    };
    for (_name, svc) in services {
        let Some(ef) = svc.get("env_file") else { continue };
        match ef {
            serde_yaml::Value::String(s) => out.push(s.clone()),
            serde_yaml::Value::Sequence(seq) => {
                for item in seq {
                    match item {
                        serde_yaml::Value::String(s) => out.push(s.clone()),
                        serde_yaml::Value::Mapping(m) => {
                            if let Some(serde_yaml::Value::String(s)) =
                                m.get(serde_yaml::Value::String("path".into()))
                            {
                                out.push(s.clone());
                            }
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    out
}

#[tauri::command]
pub fn list_app_config_files(
    state: tauri::State<'_, crate::app_state::AppState>,
    app_id: String,
) -> Result<Vec<ConfigFileInfo>, String> {
    let app = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.list_apps()
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|a| a.id == app_id)
            .ok_or_else(|| "App not found".to_string())?
    };
    if app.root_dir.is_empty() {
        return Ok(vec![]);
    }
    let root = canon_dir(&app.root_dir)
        .ok_or_else(|| format!("App working dir does not exist: {}", app.root_dir))?;

    // 1. compose-referenced env_files (resolved relative to compose file's dir)
    let mut compose_set: std::collections::HashSet<std::path::PathBuf> =
        std::collections::HashSet::new();
    if let Some(cf) = app.compose_file.as_deref() {
        let compose_path = if std::path::Path::new(cf).is_absolute() {
            std::path::PathBuf::from(cf)
        } else {
            root.join(cf)
        };
        if let Ok(compose_canon) = std::fs::canonicalize(&compose_path) {
            if let Ok(content) = std::fs::read_to_string(&compose_canon) {
                let compose_dir = compose_canon.parent().unwrap_or(&root).to_path_buf();
                for rel in collect_env_files_from_compose(&content) {
                    let p = if std::path::Path::new(&rel).is_absolute() {
                        std::path::PathBuf::from(&rel)
                    } else {
                        compose_dir.join(&rel)
                    };
                    if let Ok(canon) = std::fs::canonicalize(&p) {
                        if canon.starts_with(&root) {
                            compose_set.insert(canon);
                        }
                    }
                }
            }
        }
    }

    // 2. scan root_dir for any env-shaped filename (.env, .env.*, .envrc, *.env)
    let mut all: Vec<std::path::PathBuf> = Vec::new();
    let mut seen: std::collections::HashSet<std::path::PathBuf> =
        std::collections::HashSet::new();
    if let Ok(entries) = std::fs::read_dir(&root) {
        for entry in entries.flatten() {
            let Ok(ft) = entry.file_type() else { continue };
            // Follow symlinks pointing at a file; skip dirs.
            let path = entry.path();
            let is_file = ft.is_file()
                || (ft.is_symlink()
                    && std::fs::metadata(&path).map(|m| m.is_file()).unwrap_or(false));
            if !is_file {
                continue;
            }
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else { continue };
            if !is_env_file_name(name) && classify_extra_config(name).is_none() {
                continue;
            }
            if let Ok(canon) = std::fs::canonicalize(&path) {
                if seen.insert(canon.clone()) {
                    all.push(canon);
                }
            }
        }
    }
    for p in &compose_set {
        if seen.insert(p.clone()) {
            all.push(p.clone());
        }
    }

    let mut infos: Vec<ConfigFileInfo> = all
        .into_iter()
        .filter_map(|p| {
            let meta = std::fs::metadata(&p).ok()?;
            let size = meta.len();
            let modified_at = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64);
            let name = p.strip_prefix(&root).unwrap_or(&p).to_string_lossy().into_owned();
            let is_in_compose = compose_set.contains(&p);
            let file_name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
            // Env files (incl. anything referenced from compose's env_file:) get
            // the rows/secret-masking editor; recognised others get the generic one.
            let (kind, language) = if is_in_compose || is_env_file_name(file_name) {
                ("env", "env")
            } else {
                classify_extra_config(file_name).unwrap_or(("generic", "text"))
            };
            Some(ConfigFileInfo {
                path: p.to_string_lossy().into_owned(),
                name,
                size,
                modified_at,
                is_in_compose,
                kind: kind.to_string(),
                language: language.to_string(),
                template_target: None,
            })
        })
        .collect();
    infos.sort_by(|a, b| config_sort_key(a).cmp(&config_sort_key(b)));

    // Templates whose target doesn't exist yet become "create from template"
    // offers. If several templates derive the same target (a repo carrying both
    // `.env.example` and `.env.sample`), only the highest-priority one offers it.
    let mut claimed: std::collections::HashMap<std::path::PathBuf, usize> =
        std::collections::HashMap::new();
    for (i, info) in infos.iter().enumerate() {
        let path = std::path::Path::new(&info.path);
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else { continue };
        let Some(target_name) = derive_template_target(name) else { continue };
        let target = path.with_file_name(&target_name);
        if target.exists() {
            continue;
        }
        let better = match claimed.get(&target) {
            Some(&j) => {
                let held = std::path::Path::new(&infos[j].path)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("");
                template_priority(name) < template_priority(held)
            }
            None => true,
        };
        if better {
            claimed.insert(target, i);
        }
    }
    for (target, i) in claimed {
        infos[i].template_target = Some(target.to_string_lossy().into_owned());
    }

    Ok(infos)
}

#[tauri::command]
pub fn read_config_file(
    state: tauri::State<'_, crate::app_state::AppState>,
    absolute_path: String,
) -> Result<String, String> {
    let resolved = validate_path_in_any_app(&state, &absolute_path)?;
    std::fs::read_to_string(&resolved).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_config_file(
    state: tauri::State<'_, crate::app_state::AppState>,
    absolute_path: String,
    content: String,
) -> Result<(), String> {
    let resolved = validate_path_in_any_app(&state, &absolute_path)?;

    // Preserve trailing newline if the original file had one. If the file is
    // new (no original), respect what the user typed.
    let final_content = if let Ok(orig) = std::fs::read_to_string(&resolved) {
        let had_trailing = orig.ends_with('\n');
        let has_trailing = content.ends_with('\n');
        if had_trailing && !has_trailing {
            let mut s = content;
            s.push('\n');
            s
        } else {
            content
        }
    } else {
        content
    };

    // Atomic write: write to <path>.tmp, then rename. Same parent dir guarantees
    // rename is atomic on macOS (APFS).
    let mut tmp = resolved.clone().into_os_string();
    tmp.push(".tmp");
    let tmp_path = std::path::PathBuf::from(tmp);
    std::fs::write(&tmp_path, &final_content).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp_path, &resolved).map_err(|e| {
        // Best-effort cleanup; ignore secondary error.
        let _ = std::fs::remove_file(&tmp_path);
        e.to_string()
    })?;
    Ok(())
}

/// Copy `source` to `target` with secret values blanked. Fails if `target`
/// already exists.
///
/// Unlike [`write_config_file`]'s tmp-file + rename (which would happily clobber),
/// this opens with `create_new`, so "don't overwrite" is enforced by the kernel
/// rather than by a check-then-write that could lose a race.
fn create_from_template_at(
    source: &std::path::Path,
    target: &std::path::Path,
) -> Result<String, String> {
    use std::io::Write;

    let content = std::fs::read_to_string(source)
        .map_err(|e| format!("Cannot read {}: {}", source.display(), e))?;
    let blanked = blank_secret_values(&content);

    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::AlreadyExists => {
                format!("{} already exists", target.display())
            }
            _ => format!("Cannot create {}: {}", target.display(), e),
        })?;
    file.write_all(blanked.as_bytes())
        .map_err(|e| format!("Cannot write {}: {}", target.display(), e))?;

    Ok(blanked)
}

/// Create `target_path` from template `source_path`, returning the new content
/// so the caller can render it without a follow-up read.
#[tauri::command]
pub fn create_config_from_template(
    state: tauri::State<'_, crate::app_state::AppState>,
    source_path: String,
    target_path: String,
) -> Result<String, String> {
    let source = validate_path_in_any_app(&state, &source_path)?;
    let target = validate_path_in_any_app(&state, &target_path)?;
    create_from_template_at(&source, &target)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_standard_env_files() {
        assert!(is_env_file_name(".env"));
        assert!(is_env_file_name(".env.local"));
        assert!(is_env_file_name(".env.production"));
        assert!(is_env_file_name(".env.development"));
        assert!(is_env_file_name(".env.example"));
    }

    #[test]
    fn matches_phoenix_env_files() {
        // Phoenix conventionally pairs MIX_ENV with .env.<env>.
        assert!(is_env_file_name(".env.dev"));
        assert!(is_env_file_name(".env.test"));
        assert!(is_env_file_name(".env.prod"));
        assert!(is_env_file_name(".env.staging"));
        // Direnv users.
        assert!(is_env_file_name(".envrc"));
        // Nested overrides.
        assert!(is_env_file_name(".env.dev.local"));
    }

    #[test]
    fn matches_stem_dot_env() {
        // Heroku/Procfile-ish patterns.
        assert!(is_env_file_name("dev.env"));
        assert!(is_env_file_name("test.env"));
        assert!(is_env_file_name("prod.env"));
    }

    #[test]
    fn rejects_backup_and_swap() {
        assert!(!is_env_file_name(".env~"));
        assert!(!is_env_file_name(".env.swp"));
        assert!(!is_env_file_name(".env.swo"));
        assert!(!is_env_file_name(".env.bak"));
        assert!(!is_env_file_name(".env.orig"));
        assert!(!is_env_file_name(".env.tmp"));
        // tmp suffix on stem.env too
        assert!(!is_env_file_name("dev.env.tmp"));
    }

    #[test]
    fn rejects_non_env_files() {
        assert!(!is_env_file_name(""));
        assert!(!is_env_file_name(".env."));
        assert!(!is_env_file_name(".environment"));
        assert!(!is_env_file_name("env"));
        assert!(!is_env_file_name(".envoy"));
        assert!(!is_env_file_name("README.md"));
        // dotfiles ending in .env should still NOT match (e.g. .x.env)
        assert!(!is_env_file_name(".x.env"));
    }

    #[test]
    fn classifies_extra_config_files() {
        assert_eq!(classify_extra_config("mise.toml"), Some(("generic", "toml")));
        assert_eq!(classify_extra_config(".mise.toml"), Some(("generic", "toml")));
        assert_eq!(classify_extra_config("mise.local.toml"), Some(("generic", "toml")));
        assert_eq!(classify_extra_config(".tool-versions"), Some(("generic", "text")));
        assert_eq!(classify_extra_config("package.json"), Some(("generic", "json")));
        assert_eq!(classify_extra_config(".nvmrc"), Some(("generic", "text")));
        assert_eq!(classify_extra_config(".ruby-version"), Some(("generic", "text")));
        // Not in the allowlist.
        assert_eq!(classify_extra_config("Cargo.toml"), None);
        assert_eq!(classify_extra_config("README.md"), None);
        assert_eq!(classify_extra_config(".env"), None);
    }

    #[test]
    fn sort_key_orders_common_first() {
        let mut names = vec![".env.dev", ".env", ".envrc", ".env.example", "zzz.env"];
        names.sort_by_key(|a| env_file_sort_key(a));
        assert_eq!(names, vec![".env", ".env.example", ".envrc", ".env.dev", "zzz.env"]);
    }

    #[test]
    fn derives_template_targets() {
        assert_eq!(derive_template_target(".env.example").as_deref(), Some(".env"));
        assert_eq!(derive_template_target(".env.sample").as_deref(), Some(".env"));
        assert_eq!(derive_template_target(".env.template").as_deref(), Some(".env"));
        assert_eq!(derive_template_target(".env.dist").as_deref(), Some(".env"));
        // Suffix stripping preserves the rest of the name.
        assert_eq!(derive_template_target(".env.dev.example").as_deref(), Some(".env.dev"));
        assert_eq!(derive_template_target(".env.prod.sample").as_deref(), Some(".env.prod"));
        // Case-insensitive suffix.
        assert_eq!(derive_template_target(".env.EXAMPLE").as_deref(), Some(".env"));
    }

    #[test]
    fn rejects_non_templates() {
        // Real env files, not templates.
        assert_eq!(derive_template_target(".env"), None);
        assert_eq!(derive_template_target(".env.local"), None);
        assert_eq!(derive_template_target(".env.production"), None);
        assert_eq!(derive_template_target(".envrc"), None);
        // Template suffix but the stem isn't an env file we can edit.
        assert_eq!(derive_template_target(".example"), None);
        assert_eq!(derive_template_target("config.yml.example"), None);
        assert_eq!(derive_template_target("README.example"), None);
        // No extension at all.
        assert_eq!(derive_template_target("example"), None);
    }

    #[test]
    fn template_priority_prefers_example() {
        assert!(template_priority(".env.example") < template_priority(".env.sample"));
        assert!(template_priority(".env.sample") < template_priority(".env.template"));
        assert!(template_priority(".env.template") < template_priority(".env.dist"));
        assert_eq!(template_priority(".env.local"), usize::MAX);
    }

    #[test]
    fn blanks_only_secret_values() {
        let src = "\
# Database
DB_PASSWORD=hunter2
DATABASE_URL=postgres://localhost/dev

API_URL=http://localhost:3000
AUTH_URL=http://localhost:4000
SIGNUP_ENABLED=true
KEYCLOAK_HOST=localhost
export SECRET_KEY_BASE=abc123
STRIPE_API_KEY=sk_test_123
EMPTY_TOKEN=
";
        let want = "\
# Database
DB_PASSWORD=
DATABASE_URL=postgres://localhost/dev

API_URL=http://localhost:3000
AUTH_URL=http://localhost:4000
SIGNUP_ENABLED=true
KEYCLOAK_HOST=localhost
export SECRET_KEY_BASE=
STRIPE_API_KEY=
EMPTY_TOKEN=
";
        assert_eq!(blank_secret_values(src), want);
    }

    #[test]
    fn blanking_preserves_structure() {
        // Comments, blank lines, and lines without `=` pass through untouched,
        // including a missing trailing newline.
        let src = "#!/bin/sh\n\n# comment with PASSWORD=x inside\nNOT_AN_ASSIGNMENT\nFOO=bar";
        assert_eq!(blank_secret_values(src), src);
    }

    #[test]
    fn create_from_template_blanks_and_refuses_overwrite() {
        let dir = std::env::temp_dir().join(format!("porta-tpl-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let source = dir.join(".env.example");
        let target = dir.join(".env");
        std::fs::write(&source, "API_URL=http://x\nDB_PASSWORD=secret\n").unwrap();

        let content = create_from_template_at(&source, &target).unwrap();
        assert_eq!(content, "API_URL=http://x\nDB_PASSWORD=\n");
        assert_eq!(std::fs::read_to_string(&target).unwrap(), content);

        // Second call must not clobber the file the user has since filled in.
        std::fs::write(&target, "DB_PASSWORD=filled-in\n").unwrap();
        let err = create_from_template_at(&source, &target).unwrap_err();
        assert!(err.contains("already exists"), "unexpected error: {err}");
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "DB_PASSWORD=filled-in\n");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn create_from_template_errors_on_missing_source() {
        let dir = std::env::temp_dir().join(format!("porta-tpl-missing-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let err = create_from_template_at(&dir.join(".env.example"), &dir.join(".env")).unwrap_err();
        assert!(err.starts_with("Cannot read"), "unexpected error: {err}");
        assert!(!dir.join(".env").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
