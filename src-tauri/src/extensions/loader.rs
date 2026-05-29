use std::path::PathBuf;
use std::sync::Mutex;
use anyhow::Result;

use super::manifest::{ExtensionManifest, LoadedExtension};
use crate::db::Database;
use crate::porta_dir;

/// Returns the extensions directory: `~/.porta/extensions/` (or dev equivalent).
pub fn extensions_dir() -> PathBuf {
    porta_dir().join("extensions")
}

/// Scan `~/.porta/extensions/` and load all valid manifests.
/// Invalid or disabled entries are logged but don't fail the whole scan.
pub fn scan_extensions(db: &Database) -> Vec<LoadedExtension> {
    let dir = extensions_dir();
    if !dir.exists() {
        let _ = std::fs::create_dir_all(&dir);
        return vec![];
    }

    let state_map = load_extension_state(db);

    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(e) => {
            eprintln!("[extensions] Cannot read extensions dir: {}", e);
            return vec![];
        }
    };

    let mut loaded = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        match ExtensionManifest::load_from_dir(&path) {
            Ok(manifest) => {
                let (enabled, source) = state_map
                    .get(&manifest.id)
                    .cloned()
                    .unwrap_or((true, None));
                // Persist if not already tracked
                let _ = upsert_extension(db, &manifest.id, &path, enabled);
                loaded.push(LoadedExtension::new(manifest, path, enabled, source));
            }
            Err(e) => {
                eprintln!("[extensions] Skipping {:?}: {}", path.file_name().unwrap_or_default(), e);
            }
        }
    }

    loaded.sort_by(|a, b| a.manifest.name.cmp(&b.manifest.name));
    loaded
}

/// Load enabled state + install source for all known extensions from DB.
fn load_extension_state(db: &Database) -> std::collections::HashMap<String, (bool, Option<String>)> {
    let mut map = std::collections::HashMap::new();
    let result = db.conn.prepare("SELECT id, enabled, source FROM extensions");
    if let Ok(mut stmt) = result {
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, bool>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        });
        if let Ok(rows) = rows {
            for row in rows.flatten() {
                map.insert(row.0, (row.1, row.2));
            }
        }
    }
    map
}

/// Look up the remote install source for an extension, if any.
pub fn get_extension_source(db: &Database, id: &str) -> Option<String> {
    db.conn
        .query_row(
            "SELECT source FROM extensions WHERE id = ?1",
            rusqlite::params![id],
            |r| r.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten()
}

fn upsert_extension(db: &Database, id: &str, path: &std::path::Path, enabled: bool) -> Result<()> {
    db.conn.execute(
        "INSERT OR IGNORE INTO extensions (id, path, enabled, installed_at)
         VALUES (?1, ?2, ?3, strftime('%s','now'))",
        rusqlite::params![id, path.to_string_lossy(), enabled],
    )?;
    Ok(())
}

/// Persist enable/disable change to DB.
pub fn set_extension_enabled(db: &Database, id: &str, enabled: bool) -> Result<()> {
    db.conn.execute(
        "UPDATE extensions SET enabled = ?1 WHERE id = ?2",
        rusqlite::params![enabled, id],
    )?;
    Ok(())
}

/// Remove extension record from DB and delete its folder.
pub fn uninstall_extension(db: &Database, id: &str) -> Result<()> {
    // Get path first
    let path: Option<String> = db.conn.query_row(
        "SELECT path FROM extensions WHERE id = ?1",
        rusqlite::params![id],
        |r| r.get(0),
    ).ok();

    db.conn.execute("DELETE FROM extensions WHERE id = ?1", rusqlite::params![id])?;

    if let Some(p) = path {
        let dir = PathBuf::from(p);
        if dir.starts_with(extensions_dir()) {
            let _ = std::fs::remove_dir_all(&dir);
        }
    }
    Ok(())
}

/// Install an extension from a source folder path.
/// Validates the manifest, copies to extensions_dir/{id}/, persists to DB.
/// `source` records the remote origin (GitHub url/ref) so the extension can be
/// updated later; pass None for local-folder installs.
pub fn install_from_folder(
    db: &Database,
    src: &std::path::Path,
    source: Option<&str>,
) -> Result<LoadedExtension> {
    let manifest = ExtensionManifest::load_from_dir(src)?;
    let _ = std::fs::create_dir_all(extensions_dir());
    let dest = extensions_dir().join(&manifest.id);

    if dest.exists() {
        std::fs::remove_dir_all(&dest)?;
    }

    copy_dir_recursive(src, &dest)?;

    db.conn.execute(
        "INSERT OR REPLACE INTO extensions (id, path, enabled, installed_at, source)
         VALUES (?1, ?2, 1, strftime('%s','now'), ?3)",
        rusqlite::params![&manifest.id, dest.to_string_lossy(), source],
    )?;

    Ok(LoadedExtension::new(manifest, dest, true, source.map(|s| s.to_string())))
}

fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)?.flatten() {
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            std::fs::copy(&src_path, &dst_path)?;
        }
    }
    Ok(())
}

/// Reject subpaths that could escape the archive root after we join them.
///
/// The archive is extracted under a TempDir we control, then we join the
/// subpath onto that root. Without validation a value like `../etc` would
/// resolve outside the tempdir and `..` segments through `Path::join` ignore
/// the parent. Refuse anything that:
///   - is absolute (`/etc/...`) — handled by `trim_start_matches('/')` at
///     install time, but reject here so the error is upfront.
///   - contains a parent (`..`) segment.
///   - contains a backslash (Windows separator — not used in repo paths and
///     can confuse `Path::join` on Windows builds).
///   - contains a NUL byte (defence-in-depth; would fail at FS-call time
///     anyway but better to refuse early with a clear message).
fn validate_subpath(sub: &str) -> Result<()> {
    if sub.starts_with('/') {
        anyhow::bail!("subpath must be relative, got '{}'", sub);
    }
    if sub.contains('\0') {
        anyhow::bail!("subpath contains NUL byte");
    }
    if sub.contains('\\') {
        anyhow::bail!("subpath contains backslash '{}'", sub);
    }
    for seg in sub.split('/') {
        if seg == ".." {
            anyhow::bail!("subpath escapes archive root with '..' in '{}'", sub);
        }
    }
    Ok(())
}

/// Parse a GitHub URL or shorthand into (owner, repo, branch, subpath).
/// Accepts:
///   https://github.com/owner/repo
///   https://github.com/owner/repo/tree/branch
///   https://github.com/owner/repo/tree/branch/sub/path
///   owner/repo
///   owner/repo@branch
///   owner/repo:sub/path
///   owner/repo@branch:sub/path
///
/// The `:subpath` suffix lets one repo host multiple extensions in
/// subfolders (e.g. `extensions-bundled/git-manager`). When set, the loader
/// downloads the whole archive but reads `porta.json` from the subpath
/// instead of the archive root. The subpath is validated via
/// `validate_subpath` to ensure it can't escape the archive root.
fn parse_github_ref(input: &str) -> Result<(String, String, String, Option<String>)> {
    let input = input.trim();
    if let Some(rest) = input.strip_prefix("https://github.com/") {
        let rest = rest.trim_end_matches('/');
        // /tree/branch[/sub/path] suffix: branch is the first path segment
        // after /tree/, everything beyond is the subpath.
        if let Some(idx) = rest.find("/tree/") {
            let (repo_part, branch_tail) = rest.split_at(idx);
            let after_tree = branch_tail.trim_start_matches("/tree/");
            let (branch, subpath) = match after_tree.split_once('/') {
                Some((b, s)) if !s.is_empty() => {
                    validate_subpath(s)?;
                    (b.to_string(), Some(s.to_string()))
                }
                _ => (after_tree.to_string(), None),
            };
            let mut parts = repo_part.splitn(2, '/');
            let owner = parts.next().ok_or_else(|| anyhow::anyhow!("invalid GitHub URL"))?.to_string();
            let repo = parts.next().ok_or_else(|| anyhow::anyhow!("invalid GitHub URL"))?.to_string();
            return Ok((owner, repo, branch, subpath));
        }
        // No branch: owner/repo only
        let mut parts = rest.splitn(2, '/');
        let owner = parts.next().ok_or_else(|| anyhow::anyhow!("invalid GitHub URL"))?.to_string();
        let repo = parts.next().ok_or_else(|| anyhow::anyhow!("invalid GitHub URL"))?.to_string();
        return Ok((owner, repo, "main".to_string(), None));
    }
    // Shorthand: `owner/repo[@branch][:subpath]`. Pull the subpath first so
    // a branch like `feat/foo:sub` doesn't get its colon eaten by the
    // @branch parse.
    let (input, subpath) = match input.split_once(':') {
        Some((head, sub)) if !sub.is_empty() => {
            validate_subpath(sub)?;
            (head, Some(sub.to_string()))
        }
        _ => (input, None),
    };
    if let Some((repo_part, branch)) = input.split_once('@') {
        let mut parts = repo_part.splitn(2, '/');
        let owner = parts.next().ok_or_else(|| anyhow::anyhow!("expected owner/repo@branch"))?.to_string();
        let repo = parts.next().ok_or_else(|| anyhow::anyhow!("expected owner/repo@branch"))?.to_string();
        return Ok((owner, repo, branch.to_string(), subpath));
    }
    let mut parts = input.splitn(2, '/');
    let owner = parts.next().ok_or_else(|| anyhow::anyhow!("expected owner/repo"))?.to_string();
    let repo = parts.next().ok_or_else(|| anyhow::anyhow!("expected owner/repo"))?.to_string();
    Ok((owner, repo, "main".to_string(), subpath))
}

/// Download a GitHub repo zip and extract it to a TempDir.
/// Returns `(TempDir, path_to_extension_root)` — keep TempDir alive until done.
/// `path_to_extension_root` is the archive root, or `archive_root/<subpath>`
/// when the URL specified one. Separating download from DB persist avoids
/// holding MutexGuard across await.
pub async fn download_github_to_temp(url: &str) -> Result<(tempfile::TempDir, PathBuf)> {
    let (owner, repo, branch, subpath) = parse_github_ref(url)?;
    let zip_url = format!(
        "https://github.com/{}/{}/archive/refs/heads/{}.zip",
        owner, repo, branch
    );

    let client = reqwest::Client::builder()
        .user_agent("porta-app/1.0")
        .build()?;
    let resp = client.get(&zip_url).send().await?;
    if !resp.status().is_success() {
        anyhow::bail!("GitHub returned {}: {}", resp.status(), zip_url);
    }
    let bytes = resp.bytes().await?;

    let tmp = tempfile::tempdir()?;
    let prefix = format!("{}-{}/", repo, branch);

    let cursor = std::io::Cursor::new(&bytes[..]);
    let mut archive = zip::ZipArchive::new(cursor)?;
    for i in 0..archive.len() {
        let mut file = archive.by_index(i)?;
        let raw_name = file.name().to_string();
        let rel = raw_name.strip_prefix(&prefix).unwrap_or(&raw_name).to_string();
        if rel.is_empty() {
            continue;
        }
        let out_path = tmp.path().join(&rel);
        if raw_name.ends_with('/') {
            std::fs::create_dir_all(&out_path)?;
        } else {
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let mut out_file = std::fs::File::create(&out_path)?;
            std::io::copy(&mut file, &mut out_file)?;
        }
    }

    // Point the caller at the subpath inside the archive when set, so
    // install_from_folder finds porta.json in the right place. A trim on
    // leading slashes lets `:/path` and `:path` both work.
    let mut root = tmp.path().to_path_buf();
    if let Some(sub) = subpath {
        let cleaned = sub.trim_start_matches('/');
        root = root.join(cleaned);
        if !root.exists() {
            anyhow::bail!("Subpath '{}' not found in archive {}-{}.zip", cleaned, repo, branch);
        }
    }
    Ok((tmp, root))
}


/// AppState field — thread-safe extensions list.
pub type ExtensionsState = Mutex<Vec<LoadedExtension>>;

/// Called during Tauri app setup. Loads extensions into AppState.
pub fn startup_load_extensions(extensions: &ExtensionsState, db: &Database) {
    let loaded = scan_extensions(db);
    if let Ok(mut guard) = extensions.lock() {
        *guard = loaded;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── validate_subpath ─────────────────────────────────────────────────

    #[test]
    fn validate_subpath_accepts_normal_paths() {
        assert!(validate_subpath("extensions-bundled/git-manager").is_ok());
        assert!(validate_subpath("a").is_ok());
        assert!(validate_subpath("a/b/c").is_ok());
        assert!(validate_subpath("with.dots/and-dashes_etc").is_ok());
    }

    #[test]
    fn validate_subpath_rejects_absolute() {
        let err = validate_subpath("/etc/passwd").unwrap_err().to_string();
        assert!(err.contains("must be relative"), "got: {err}");
    }

    #[test]
    fn validate_subpath_rejects_parent_segments() {
        for case in ["../etc", "a/../b", "foo/..", ".."] {
            let err = validate_subpath(case).unwrap_err().to_string();
            assert!(err.contains("escapes archive root"), "expected reject for {case}, got: {err}");
        }
    }

    #[test]
    fn validate_subpath_rejects_nul_and_backslash() {
        assert!(validate_subpath("a\0b").is_err());
        assert!(validate_subpath("a\\b").is_err());
    }

    #[test]
    fn validate_subpath_does_not_reject_single_dot() {
        // `.` is the current directory — harmless, equivalent to no subpath.
        assert!(validate_subpath(".").is_ok());
        assert!(validate_subpath("./a").is_ok());
    }

    // ── parse_github_ref ─────────────────────────────────────────────────

    #[test]
    fn parse_shorthand_owner_repo() {
        let (owner, repo, branch, sub) = parse_github_ref("foo/bar").unwrap();
        assert_eq!((owner.as_str(), repo.as_str(), branch.as_str()), ("foo", "bar", "main"));
        assert!(sub.is_none());
    }

    #[test]
    fn parse_shorthand_with_branch() {
        let (_, _, branch, sub) = parse_github_ref("foo/bar@feature/x").unwrap();
        assert_eq!(branch, "feature/x");
        assert!(sub.is_none());
    }

    #[test]
    fn parse_shorthand_with_subpath() {
        let (_, _, branch, sub) = parse_github_ref("foo/bar:ext/git-manager").unwrap();
        assert_eq!(branch, "main");
        assert_eq!(sub.as_deref(), Some("ext/git-manager"));
    }

    #[test]
    fn parse_shorthand_with_branch_and_subpath() {
        let (_, _, branch, sub) = parse_github_ref("foo/bar@dev:ext/a").unwrap();
        assert_eq!(branch, "dev");
        assert_eq!(sub.as_deref(), Some("ext/a"));
    }

    #[test]
    fn parse_url_with_tree_branch_and_subpath() {
        let (owner, repo, branch, sub) =
            parse_github_ref("https://github.com/foo/bar/tree/main/sub/path").unwrap();
        assert_eq!((owner.as_str(), repo.as_str(), branch.as_str()), ("foo", "bar", "main"));
        assert_eq!(sub.as_deref(), Some("sub/path"));
    }

    #[test]
    fn parse_url_without_tree() {
        let (_, _, branch, sub) = parse_github_ref("https://github.com/foo/bar").unwrap();
        assert_eq!(branch, "main");
        assert!(sub.is_none());
    }

    #[test]
    fn parse_rejects_traversal_in_subpath() {
        assert!(parse_github_ref("foo/bar:../escape").is_err());
        assert!(parse_github_ref("https://github.com/foo/bar/tree/main/../escape").is_err());
    }
}
