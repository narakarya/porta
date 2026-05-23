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

    let enabled_map = load_enabled_map(db);

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
                let enabled = enabled_map.get(&manifest.id).copied().unwrap_or(true);
                // Persist if not already tracked
                let _ = upsert_extension(db, &manifest.id, &path, enabled);
                loaded.push(LoadedExtension::new(manifest, path, enabled));
            }
            Err(e) => {
                eprintln!("[extensions] Skipping {:?}: {}", path.file_name().unwrap_or_default(), e);
            }
        }
    }

    loaded.sort_by(|a, b| a.manifest.name.cmp(&b.manifest.name));
    loaded
}

/// Load enabled/disabled state for all known extensions from DB.
fn load_enabled_map(db: &Database) -> std::collections::HashMap<String, bool> {
    let mut map = std::collections::HashMap::new();
    let result = db.conn.prepare(
        "SELECT id, enabled FROM extensions"
    );
    if let Ok(mut stmt) = result {
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?))
        });
        if let Ok(rows) = rows {
            for row in rows.flatten() {
                map.insert(row.0, row.1);
            }
        }
    }
    map
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
pub fn install_from_folder(db: &Database, src: &std::path::Path) -> Result<LoadedExtension> {
    let manifest = ExtensionManifest::load_from_dir(src)?;
    let _ = std::fs::create_dir_all(extensions_dir());
    let dest = extensions_dir().join(&manifest.id);

    if dest.exists() {
        std::fs::remove_dir_all(&dest)?;
    }

    copy_dir_recursive(src, &dest)?;

    db.conn.execute(
        "INSERT OR REPLACE INTO extensions (id, path, enabled, installed_at)
         VALUES (?1, ?2, 1, strftime('%s','now'))",
        rusqlite::params![&manifest.id, dest.to_string_lossy()],
    )?;

    Ok(LoadedExtension::new(manifest, dest, true))
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

/// Parse a GitHub URL or shorthand into (owner, repo, branch).
/// Accepts:
///   https://github.com/owner/repo
///   https://github.com/owner/repo/tree/branch
///   owner/repo
///   owner/repo@branch
fn parse_github_ref(input: &str) -> Result<(String, String, String)> {
    let input = input.trim();
    if let Some(rest) = input.strip_prefix("https://github.com/") {
        let rest = rest.trim_end_matches('/');
        // Check for /tree/branch suffix
        if let Some(idx) = rest.find("/tree/") {
            let (repo_part, branch_tail) = rest.split_at(idx);
            let branch = branch_tail.trim_start_matches("/tree/").to_string();
            let mut parts = repo_part.splitn(2, '/');
            let owner = parts.next().ok_or_else(|| anyhow::anyhow!("invalid GitHub URL"))?.to_string();
            let repo = parts.next().ok_or_else(|| anyhow::anyhow!("invalid GitHub URL"))?.to_string();
            return Ok((owner, repo, branch));
        }
        // No branch: owner/repo only
        let mut parts = rest.splitn(2, '/');
        let owner = parts.next().ok_or_else(|| anyhow::anyhow!("invalid GitHub URL"))?.to_string();
        let repo = parts.next().ok_or_else(|| anyhow::anyhow!("invalid GitHub URL"))?.to_string();
        return Ok((owner, repo, "main".to_string()));
    }
    // Shorthand: owner/repo or owner/repo@branch
    if let Some((repo_part, branch)) = input.split_once('@') {
        let mut parts = repo_part.splitn(2, '/');
        let owner = parts.next().ok_or_else(|| anyhow::anyhow!("expected owner/repo@branch"))?.to_string();
        let repo = parts.next().ok_or_else(|| anyhow::anyhow!("expected owner/repo@branch"))?.to_string();
        return Ok((owner, repo, branch.to_string()));
    }
    let mut parts = input.splitn(2, '/');
    let owner = parts.next().ok_or_else(|| anyhow::anyhow!("expected owner/repo"))?.to_string();
    let repo = parts.next().ok_or_else(|| anyhow::anyhow!("expected owner/repo"))?.to_string();
    Ok((owner, repo, "main".to_string()))
}

/// Download a GitHub repo zip and extract it to a TempDir.
/// Returns (TempDir, path_to_extracted_root) — keep TempDir alive until done.
/// Separating download from DB persist avoids holding MutexGuard across await.
pub async fn download_github_to_temp(url: &str) -> Result<(tempfile::TempDir, PathBuf)> {
    let (owner, repo, branch) = parse_github_ref(url)?;
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

    let root = tmp.path().to_path_buf();
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
