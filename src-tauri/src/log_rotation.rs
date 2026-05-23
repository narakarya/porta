//! Per-app log rotation. Logs in `~/.porta/logs/<app_id>.log` are written by
//! `process_manager` in append mode (O_APPEND), so truncating the file in place
//! is safe — subsequent writes go to the new (shorter) EOF without reopening
//! the FD on the writer's side.

use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

pub const DEFAULT_MAX_LOG_BYTES: u64 = 5 * 1024 * 1024; // 5 MB per app

#[derive(Debug, Default, serde::Serialize)]
pub struct RotateSummary {
    pub files_rotated: u32,
    pub bytes_freed: u64,
}

/// If `path` is larger than `max_bytes`, keep only the last `max_bytes`
/// (snapped to the next line boundary) and rewrite the file in place.
/// Returns bytes freed (0 if no rotation needed).
pub fn rotate_log(path: &Path, max_bytes: u64) -> std::io::Result<u64> {
    let metadata = std::fs::metadata(path)?;
    let size = metadata.len();
    if size <= max_bytes {
        return Ok(0);
    }

    // Read the tail of the file.
    let skip = size - max_bytes;
    let mut file = std::fs::File::open(path)?;
    file.seek(SeekFrom::Start(skip))?;
    let mut tail: Vec<u8> = Vec::with_capacity(max_bytes as usize);
    file.read_to_end(&mut tail)?;
    drop(file);

    // Snap to next newline so the rotated file doesn't start mid-line.
    if let Some(pos) = tail.iter().position(|&b| b == b'\n') {
        tail.drain(..=pos);
    }

    let header = format!(
        "── Porta log rotated (was {} bytes, kept last {} bytes) ──\n",
        size,
        tail.len()
    );

    // Truncate + rewrite. Append-mode writers held by process_manager will
    // continue appending past this new EOF — any lines they emitted between
    // our read and this truncate are dropped (acceptable trade-off).
    let mut out = std::fs::OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(path)?;
    out.write_all(header.as_bytes())?;
    out.write_all(&tail)?;
    out.flush()?;

    Ok(size - tail.len() as u64 - header.len() as u64)
}

/// Rotate every `*.log` file in `logs_dir` that exceeds `max_bytes`.
pub fn rotate_all(logs_dir: &Path, max_bytes: u64) -> std::io::Result<RotateSummary> {
    let mut summary = RotateSummary::default();
    if !logs_dir.is_dir() {
        return Ok(summary);
    }
    for entry in std::fs::read_dir(logs_dir)? {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("log") {
            continue;
        }
        match rotate_log(&path, max_bytes) {
            Ok(0) => {}
            Ok(freed) => {
                summary.files_rotated += 1;
                summary.bytes_freed += freed;
            }
            Err(e) => {
                eprintln!("[log_rotation] failed to rotate {}: {}", path.display(), e);
            }
        }
    }
    Ok(summary)
}

/// Truncate a single log file to 0 bytes. Returns the number of bytes freed.
pub fn clear_log_file(path: &Path) -> std::io::Result<u64> {
    let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    std::fs::write(path, b"")?;
    Ok(size)
}

#[derive(Debug, Default, serde::Serialize)]
pub struct ClearSummary {
    pub files_cleared: u32,
    pub bytes_freed: u64,
}

/// Clear every `*.log` file in `logs_dir`.
pub fn clear_all(logs_dir: &Path) -> std::io::Result<ClearSummary> {
    let mut summary = ClearSummary::default();
    if !logs_dir.is_dir() {
        return Ok(summary);
    }
    for entry in std::fs::read_dir(logs_dir)? {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("log") {
            continue;
        }
        if let Ok(freed) = clear_log_file(&path) {
            summary.files_cleared += 1;
            summary.bytes_freed += freed;
        }
    }
    Ok(summary)
}

/// (`app_id`, `size_bytes`) for every log file in `logs_dir`.
pub fn log_sizes(logs_dir: &Path) -> Vec<(String, u64)> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(logs_dir) else { return out };
    for entry in entries.flatten() {
        let path: PathBuf = entry.path();
        if !path.is_file() {
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("log") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else { continue };
        let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        out.push((stem.to_string(), size));
    }
    out.sort_by(|a, b| b.1.cmp(&a.1));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn tmpdir() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn rotate_skips_under_cap() {
        let dir = tmpdir();
        let p = dir.path().join("a.log");
        std::fs::write(&p, "tiny\n").unwrap();
        let freed = rotate_log(&p, 1024).unwrap();
        assert_eq!(freed, 0);
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "tiny\n");
    }

    #[test]
    fn rotate_keeps_tail_lines() {
        let dir = tmpdir();
        let p = dir.path().join("a.log");
        let mut f = std::fs::File::create(&p).unwrap();
        for i in 0..10_000 {
            writeln!(f, "line {i:06}").unwrap();
        }
        drop(f);
        let original = std::fs::metadata(&p).unwrap().len();

        let freed = rotate_log(&p, 1024).unwrap();
        assert!(freed > 0);

        let after = std::fs::read_to_string(&p).unwrap();
        // Tail should contain the latest lines, not earliest.
        assert!(after.contains("line 009999"));
        assert!(!after.contains("line 000000"));
        // Has rotation header.
        assert!(after.starts_with("── Porta log rotated"));
        // Final size should be near (but not exceeding by much) the cap +
        // header length.
        assert!(std::fs::metadata(&p).unwrap().len() < original);
    }

    #[test]
    fn clear_truncates_to_zero() {
        let dir = tmpdir();
        let p = dir.path().join("a.log");
        std::fs::write(&p, "abc\n").unwrap();
        let freed = clear_log_file(&p).unwrap();
        assert_eq!(freed, 4);
        assert_eq!(std::fs::metadata(&p).unwrap().len(), 0);
    }

    #[test]
    fn rotate_all_only_log_files() {
        let dir = tmpdir();
        std::fs::write(dir.path().join("a.log"), vec![b'x'; 4096]).unwrap();
        std::fs::write(dir.path().join("b.log"), vec![b'y'; 4096]).unwrap();
        std::fs::write(dir.path().join("ignore.txt"), vec![b'z'; 4096]).unwrap();
        let summary = rotate_all(dir.path(), 100).unwrap();
        assert_eq!(summary.files_rotated, 2);
        assert!(summary.bytes_freed > 0);
        // .txt untouched
        assert_eq!(std::fs::metadata(dir.path().join("ignore.txt")).unwrap().len(), 4096);
    }

    #[test]
    fn log_sizes_returns_app_ids_sorted_desc() {
        let dir = tmpdir();
        std::fs::write(dir.path().join("small.log"), b"a").unwrap();
        std::fs::write(dir.path().join("big.log"), vec![b'a'; 100]).unwrap();
        std::fs::write(dir.path().join("not-a-log.txt"), b"x").unwrap();
        let sizes = log_sizes(dir.path());
        assert_eq!(sizes.len(), 2);
        assert_eq!(sizes[0].0, "big");
        assert_eq!(sizes[1].0, "small");
    }
}
