//! Remote file browsing and editing over SFTP.
//!
//! Scope is deliberately narrow: list a directory, read a text file, write it
//! back. Nothing here touches the local filesystem, which is where every
//! genuinely dangerous case lives — a server-supplied name that collides on
//! case-insensitive APFS, that normalises onto a neighbour under NFC/NFD, or
//! that escapes the target directory through `..`. Downloads will need all of
//! that handled; browsing and editing need none of it.
//!
//! No `unwrap()` in this module. The release profile aborts on panic, so one
//! malformed packet from a hostile server would take the whole app down.

use russh_sftp::client::SftpSession;
use serde::Serialize;

/// Entries returned for one directory. `read_dir` in russh-sftp is eager — it
/// materialises the whole listing before returning — so this bounds the IPC
/// payload and the render cost, not the round trips.
pub const MAX_ENTRIES: usize = 5_000;

/// Files larger than this are refused for editing. The content crosses IPC as a
/// string and lands in a CodeMirror buffer; a 500 MB log would take the window
/// down long before the user saw anything useful.
pub const MAX_EDIT_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SftpKind {
    File,
    Dir,
    Symlink,
    Other,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpEntry {
    pub name: String,
    pub path: String,
    /// From LSTAT semantics: a symlink reports `Symlink`, never its target's
    /// kind. v1 displays the target but never follows it.
    pub kind: SftpKind,
    pub size: Option<u64>,
    pub mtime: Option<u32>,
    pub permissions: Option<u32>,
    /// `drwxr-xr-x`, rendered here so the UI never re-derives it.
    pub mode_str: Option<String>,
    /// russh-sftp decodes filenames with `String::from_utf8_lossy`, so a
    /// non-UTF-8 name arrives holding U+FFFD and no longer matches the file on
    /// the server. It can be listed but never opened, and the UI must show it
    /// disabled. A genuine U+FFFD in a name false-positives, which fails safe.
    pub lossy_name: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpListing {
    /// Absolute, resolved server-side.
    pub path: String,
    pub entries: Vec<SftpEntry>,
    /// Hit [`MAX_ENTRIES`]. The UI must say so rather than imply the directory
    /// is small.
    pub truncated: bool,
    pub total_seen: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpFileContent {
    pub path: String,
    pub content: String,
    pub size: u64,
    /// Echoed back on save so a concurrent edit can be detected.
    pub mtime: Option<u32>,
    pub permissions: Option<u32>,
    /// Not valid UTF-8; `content` is empty and the editor must refuse.
    pub binary: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum SftpSaveOutcome {
    Saved {
        mtime: Option<u32>,
    },
    /// The remote mtime moved between read and save. Nothing was written.
    Conflict {
        remote_mtime: Option<u32>,
    },
}

/// Join a parent directory and a child name into an absolute path.
///
/// String join, not `PathBuf`: these are remote POSIX paths and must not pick
/// up the local platform's separator rules.
pub fn join_path(parent: &str, name: &str) -> String {
    if parent.ends_with('/') {
        format!("{parent}{name}")
    } else {
        format!("{parent}/{name}")
    }
}

/// The parent of an absolute remote path. `/` is its own parent, so "up" at the
/// root is a no-op rather than an error.
pub fn parent_path(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rfind('/') {
        None | Some(0) => "/".to_string(),
        Some(i) => trimmed[..i].to_string(),
    }
}

/// `ls -l`-style mode string from a POSIX mode word.
pub fn mode_str(mode: u32) -> String {
    let kind = match mode & 0o170000 {
        0o040000 => 'd',
        0o120000 => 'l',
        0o060000 => 'b',
        0o020000 => 'c',
        0o010000 => 'p',
        0o140000 => 's',
        _ => '-',
    };
    let mut out = String::with_capacity(10);
    out.push(kind);
    for (shift, special) in [(6, 0o4000u32), (3, 0o2000), (0, 0o1000)] {
        let bits = (mode >> shift) & 0o7;
        out.push(if bits & 0o4 != 0 { 'r' } else { '-' });
        out.push(if bits & 0o2 != 0 { 'w' } else { '-' });
        // setuid/setgid/sticky replace the execute slot, upper-case when the
        // execute bit is clear — same convention as coreutils `ls`.
        let x = bits & 0o1 != 0;
        out.push(match (mode & special != 0, x, shift) {
            (true, true, 0) => 't',
            (true, false, 0) => 'T',
            (true, true, _) => 's',
            (true, false, _) => 'S',
            (false, true, _) => 'x',
            (false, false, _) => '-',
        });
    }
    out
}

/// A name that did not survive the crate's lossy UTF-8 decode.
pub fn is_lossy(name: &str) -> bool {
    name.contains('\u{FFFD}')
}

fn kind_of(attrs: &russh_sftp::protocol::FileAttributes) -> SftpKind {
    match attrs.permissions.map(|p| p & 0o170000) {
        Some(0o040000) => SftpKind::Dir,
        Some(0o120000) => SftpKind::Symlink,
        Some(0o100000) => SftpKind::File,
        // No permission bits at all still means a file for display purposes;
        // some servers omit them from readdir attrs.
        None => SftpKind::File,
        _ => SftpKind::Other,
    }
}

/// Directories first, then names, case-insensitively. Matches how every file
/// manager the user already has behaves.
fn sort_entries(entries: &mut [SftpEntry]) {
    entries.sort_by(|a, b| {
        let rank = |k: SftpKind| if k == SftpKind::Dir { 0 } else { 1 };
        rank(a.kind)
            .cmp(&rank(b.kind))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
}

/// The session's starting directory, resolved server-side.
pub async fn home(sftp: &SftpSession) -> Result<String, String> {
    sftp.canonicalize(".")
        .await
        .map_err(|e| format!("resolve home directory: {e}"))
}

pub async fn list(sftp: &SftpSession, path: &str) -> Result<SftpListing, String> {
    // Resolve first so breadcrumbs show a real absolute path and `..` collapses
    // server-side rather than being reimplemented here.
    let abs = sftp
        .canonicalize(path)
        .await
        .map_err(|e| format!("resolve {path}: {e}"))?;

    let dir = sftp
        .read_dir(abs.clone())
        .await
        .map_err(|e| format!("list {abs}: {e}"))?;

    let mut entries = Vec::new();
    let mut total_seen = 0usize;
    for item in dir {
        total_seen += 1;
        let name = item.file_name();
        if name == "." || name == ".." {
            continue;
        }
        if entries.len() >= MAX_ENTRIES {
            continue;
        }
        let attrs = item.metadata();
        let kind = kind_of(&attrs);
        entries.push(SftpEntry {
            path: join_path(&abs, &name),
            kind,
            size: attrs.size,
            mtime: attrs.mtime,
            permissions: attrs.permissions,
            mode_str: attrs.permissions.map(mode_str),
            lossy_name: is_lossy(&name),
            name,
        });
    }
    let truncated = total_seen > entries.len() + 2;
    sort_entries(&mut entries);

    Ok(SftpListing {
        path: abs,
        entries,
        truncated,
        total_seen,
    })
}

pub async fn read(sftp: &SftpSession, path: &str) -> Result<SftpFileContent, String> {
    let meta = sftp
        .metadata(path.to_string())
        .await
        .map_err(|e| format!("stat {path}: {e}"))?;
    let size = meta.size.unwrap_or(0);
    if size > MAX_EDIT_BYTES {
        return Err(format!(
            "{path} is {:.1} MB. Porta opens remote files up to {} MB — use the terminal for \
             anything larger.",
            size as f64 / (1024.0 * 1024.0),
            MAX_EDIT_BYTES / (1024 * 1024)
        ));
    }

    let bytes = sftp
        .read(path.to_string())
        .await
        .map_err(|e| format!("read {path}: {e}"))?;

    // Refuse rather than lossily decode: round-tripping U+FFFD back through
    // save would silently corrupt the file.
    match String::from_utf8(bytes) {
        Ok(content) => Ok(SftpFileContent {
            path: path.to_string(),
            content,
            size,
            mtime: meta.mtime,
            permissions: meta.permissions,
            binary: false,
        }),
        Err(_) => Ok(SftpFileContent {
            path: path.to_string(),
            content: String::new(),
            size,
            mtime: meta.mtime,
            permissions: meta.permissions,
            binary: true,
        }),
    }
}

/// Write `content` back, via a temp file and two renames.
///
/// Never truncates in place. Truncating would destroy the original the moment
/// the write failed halfway — and on a file another process has open, an
/// in-place rewrite is visible to that process mid-write. Both renames use
/// *fresh* names, because rename-over-an-existing-path is not portable on
/// SFTP v3 and the `posix-rename@openssh.com` extension isn't reachable
/// through this crate's public API.
pub async fn save(
    sftp: &SftpSession,
    path: &str,
    content: &str,
    expected_mtime: Option<u32>,
) -> Result<SftpSaveOutcome, String> {
    let meta = sftp
        .metadata(path.to_string())
        .await
        .map_err(|e| format!("stat {path}: {e}"))?;

    // Only claim a conflict when both sides actually have an mtime; a server
    // that omits it must not make every save fail.
    if let (Some(expected), Some(actual)) = (expected_mtime, meta.mtime) {
        if expected != actual {
            return Ok(SftpSaveOutcome::Conflict {
                remote_mtime: meta.mtime,
            });
        }
    }

    let dir = parent_path(path);
    let base = path.rsplit('/').next().unwrap_or("file");
    let token = uuid::Uuid::new_v4();
    let tmp = join_path(&dir, &format!(".{base}.porta-{token}"));
    let backup = join_path(&dir, &format!(".{base}.porta-bak-{token}"));

    sftp.write(tmp.clone(), content.as_bytes())
        .await
        .map_err(|e| format!("write temp file: {e}"))?;

    // Preserve the original mode; a fresh file would otherwise land with the
    // server's default umask and quietly widen or narrow access.
    if let Some(mode) = meta.permissions {
        let mut attrs = russh_sftp::protocol::FileAttributes::default();
        attrs.permissions = Some(mode);
        let _ = sftp.set_metadata(tmp.clone(), attrs).await;
    }

    if let Err(e) = sftp.rename(path.to_string(), backup.clone()).await {
        let _ = sftp.remove_file(tmp).await;
        return Err(format!("move {path} aside: {e}"));
    }
    if let Err(e) = sftp.rename(tmp.clone(), path.to_string()).await {
        // Put the original back before surfacing the failure — leaving the
        // user's file parked under a dotted temp name would be far worse than
        // the failed save.
        let _ = sftp.rename(backup, path.to_string()).await;
        let _ = sftp.remove_file(tmp).await;
        return Err(format!("replace {path}: {e}"));
    }
    let _ = sftp.remove_file(backup).await;

    let after = sftp.metadata(path.to_string()).await.ok();
    Ok(SftpSaveOutcome::Saved {
        mtime: after.and_then(|m| m.mtime),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_str_renders_common_modes() {
        assert_eq!(mode_str(0o040755), "drwxr-xr-x");
        assert_eq!(mode_str(0o100644), "-rw-r--r--");
        assert_eq!(mode_str(0o120777), "lrwxrwxrwx");
        assert_eq!(mode_str(0o100600), "-rw-------");
    }

    #[test]
    fn mode_str_renders_special_bits() {
        // setuid with execute set, and without.
        assert_eq!(mode_str(0o104755), "-rwsr-xr-x");
        assert_eq!(mode_str(0o104644), "-rwSr--r--");
        // sticky on a directory, the /tmp case.
        assert_eq!(mode_str(0o041777), "drwxrwxrwt");
        // Sticky with the other-execute bit clear: capital T, and the missing
        // execute shows as '-' in every triad — 0o666 has no execute anywhere.
        assert_eq!(mode_str(0o041666), "drw-rw-rwT");
    }

    #[test]
    fn lossy_names_are_flagged() {
        assert!(is_lossy("br\u{FFFD}ken"));
        assert!(!is_lossy("plain.txt"));
        assert!(!is_lossy("笔记.md"));
        assert!(!is_lossy("photo 📸.png"));
    }

    #[test]
    fn join_does_not_double_the_separator() {
        assert_eq!(join_path("/", "etc"), "/etc");
        assert_eq!(join_path("/home/u", "f"), "/home/u/f");
        assert_eq!(join_path("/home/u/", "f"), "/home/u/f");
    }

    #[test]
    fn parent_stops_at_root() {
        assert_eq!(parent_path("/home/u/f"), "/home/u");
        assert_eq!(parent_path("/home"), "/");
        assert_eq!(parent_path("/"), "/");
        // A trailing slash must not produce an empty parent.
        assert_eq!(parent_path("/home/u/"), "/home");
    }

    fn entry(name: &str, kind: SftpKind) -> SftpEntry {
        SftpEntry {
            name: name.into(),
            path: join_path("/tmp", name),
            kind,
            size: None,
            mtime: None,
            permissions: None,
            mode_str: None,
            lossy_name: false,
        }
    }

    #[test]
    fn directories_lead_then_case_insensitive_name() {
        let mut e = vec![
            entry("zebra.txt", SftpKind::File),
            entry("Apple", SftpKind::Dir),
            entry("banana.txt", SftpKind::File),
            entry("aardvark", SftpKind::Dir),
        ];
        sort_entries(&mut e);
        let names: Vec<&str> = e.iter().map(|x| x.name.as_str()).collect();
        assert_eq!(names, vec!["aardvark", "Apple", "banana.txt", "zebra.txt"]);
    }
}
