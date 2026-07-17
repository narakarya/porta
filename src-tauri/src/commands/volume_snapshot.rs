//! Snapshot named docker volumes by tar+gzip into `~/.porta/backups/auto-volumes/<app>/<ts>/`.
//!
//! Why we own this rather than relying on `docker volume export` (which
//! doesn't exist) or arbitrary backup tools: the snapshot is part of an
//! atomic update flow. Caller blocks until the snapshot completes, fails
//! the update if the snapshot fails, and uses the recorded paths to restore
//! when an auto-rollback fires.
//!
//! The snapshot itself is the canonical pattern for docker volumes:
//!   docker run --rm -v <vol>:/source:ro -v <dest>:/backup alpine
//!     tar -czf /backup/<vol>.tar.gz -C /source .
//!
//! `--rm` and a stateless alpine image keep the operation hermetic. The
//! source is mounted read-only so we can snapshot a volume that's still
//! attached to a running container without touching its bytes.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Command;

use crate::docker_manager::{docker_bin, DockerManager};

/// Files dir for volume backups, namespaced under `~/.porta/backups/`.
pub fn volume_backup_root() -> PathBuf {
    crate::backup::backup_dir().join("auto-volumes")
}

/// Per-app directory containing one subfolder per snapshot timestamp.
pub fn app_volume_dir(app_id: &str) -> PathBuf {
    volume_backup_root().join(app_id)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VolumeSnapshotEntry {
    /// The compose-level volume name as Porta sees it (e.g. `cap_db`).
    pub volume: String,
    /// The fully-qualified docker volume name (e.g. `porta-<app>_cap_db`).
    /// This is what `docker run -v` actually mounts.
    pub docker_volume: String,
    /// Absolute path to the tar.gz file produced.
    pub archive_path: String,
    /// File size of the tar.gz, in bytes.
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VolumeSnapshotResult {
    /// Timestamp identifier (`YYYYMMDD_HHMMSS`) — also the name of the
    /// containing folder under `app_volume_dir(app_id)`.
    pub timestamp: String,
    /// Snapshots that succeeded.
    pub entries: Vec<VolumeSnapshotEntry>,
    /// Volumes the caller asked us to snapshot but which weren't found
    /// in `docker volume ls` — usually means they haven't been created yet
    /// (the service has never started). We don't treat this as a failure.
    pub missing: Vec<String>,
}

/// Take read-only snapshots of the named volumes attached to a compose
/// project. `volume_basenames` are the local names from the compose file
/// (`cap_db`, not `porta-<id>_cap_db`); we resolve to fully-qualified names
/// using the standard `<project>_<name>` scheme docker compose uses.
///
/// Returns immediately with a `VolumeSnapshotResult` on success. Errors are
/// only returned for fatal conditions (couldn't create dir, docker missing).
/// Per-volume errors are caller-visible because the entry won't appear in
/// `entries`; downstream restore logic uses `entries` as the source of truth.
pub fn snapshot_compose_volumes(
    app_id: &str,
    volume_basenames: &[String],
) -> Result<VolumeSnapshotResult, String> {
    let project = DockerManager::compose_project(app_id);
    let resolved: Vec<(String, String)> = volume_basenames
        .iter()
        .map(|name| (name.clone(), format!("{}_{}", project, name)))
        .collect();
    snapshot_volumes_with_names(app_id, &resolved)
}

/// Take read-only snapshots of named docker volumes, given their fully-qualified
/// docker names directly (used for single-container docker apps where the user
/// supplies the volume name verbatim in `docker_volumes`).
pub fn snapshot_docker_volumes(
    app_id: &str,
    docker_volume_names: &[String],
) -> Result<VolumeSnapshotResult, String> {
    let resolved: Vec<(String, String)> = docker_volume_names
        .iter()
        .map(|n| (n.clone(), n.clone()))
        .collect();
    snapshot_volumes_with_names(app_id, &resolved)
}

fn snapshot_volumes_with_names(
    app_id: &str,
    volumes: &[(String, String)], // (compose-local-name, fully-qualified-docker-name)
) -> Result<VolumeSnapshotResult, String> {
    let timestamp = chrono::Utc::now().format("%Y%m%d_%H%M%S").to_string();
    let dest_dir = app_volume_dir(app_id).join(&timestamp);
    std::fs::create_dir_all(&dest_dir)
        .map_err(|e| format!("create snapshot dir: {}", e))?;

    let dest_dir_str = dest_dir
        .to_str()
        .ok_or_else(|| "snapshot dir path is not utf-8".to_string())?
        .to_string();

    // Collect existing volumes once so we can mark missing ones as `missing`
    // instead of erroring (the volume may not have been created yet).
    let existing = list_docker_volumes()?;

    let mut entries = Vec::new();
    let mut missing = Vec::new();

    for (local_name, docker_name) in volumes {
        if !existing.iter().any(|v| v == docker_name) {
            missing.push(local_name.clone());
            continue;
        }
        let archive_name = format!("{}.tar.gz", local_name);
        let archive_path = dest_dir.join(&archive_name);

        // alpine ships busybox tar — `tar -czf` writes a gzipped archive.
        // -C /source means "switch into /source before adding files" so the
        // archive contents are paths relative to the volume root, which makes
        // restore a clean tar -xzf into a fresh empty volume.
        let status = Command::new(docker_bin())
            .args([
                "run",
                "--rm",
                "-v",
                &format!("{}:/source:ro", docker_name),
                "-v",
                &format!("{}:/backup", dest_dir_str),
                "alpine:3",
                "sh",
                "-c",
                &format!("tar -czf /backup/{} -C /source .", archive_name),
            ])
            .status()
            .map_err(|e| format!("docker run for snapshot: {}", e))?;

        if !status.success() {
            // Clean up the partial file so we don't leave a corrupt archive.
            let _ = std::fs::remove_file(&archive_path);
            return Err(format!(
                "snapshot of volume `{}` failed (docker exit {})",
                docker_name,
                status.code().unwrap_or(-1)
            ));
        }

        let size_bytes = std::fs::metadata(&archive_path)
            .map(|m| m.len())
            .unwrap_or(0);

        entries.push(VolumeSnapshotEntry {
            volume: local_name.clone(),
            docker_volume: docker_name.clone(),
            archive_path: archive_path.to_string_lossy().into_owned(),
            size_bytes,
        });
    }

    Ok(VolumeSnapshotResult { timestamp, entries, missing })
}

/// Restore a previously-taken snapshot back into its volume. Caller is
/// responsible for ensuring no container has the volume open — typically
/// after `compose down` or container removal.
pub fn restore_volume_snapshot(entry: &VolumeSnapshotEntry) -> Result<(), String> {
    let archive_dir = std::path::Path::new(&entry.archive_path)
        .parent()
        .ok_or_else(|| "archive path has no parent".to_string())?;
    let archive_file = std::path::Path::new(&entry.archive_path)
        .file_name()
        .ok_or_else(|| "archive path has no filename".to_string())?;
    let archive_dir_str = archive_dir
        .to_str()
        .ok_or_else(|| "archive dir is not utf-8".to_string())?;
    let archive_file_str = archive_file
        .to_str()
        .ok_or_else(|| "archive file is not utf-8".to_string())?;

    // Wipe the volume contents first so the restored archive defines the
    // entire state — otherwise files added between snapshot and restore
    // would survive a "rollback" that's supposed to undo the upgrade.
    //
    // `find . -mindepth 1 -delete` removes everything inside the volume
    // without removing the mount point itself.
    let wipe_status = Command::new(docker_bin())
        .args([
            "run",
            "--rm",
            "-v",
            &format!("{}:/target", entry.docker_volume),
            "alpine:3",
            "sh",
            "-c",
            "find /target -mindepth 1 -delete",
        ])
        .status()
        .map_err(|e| format!("docker run for wipe: {}", e))?;
    if !wipe_status.success() {
        return Err(format!(
            "wipe of volume `{}` failed (exit {})",
            entry.docker_volume,
            wipe_status.code().unwrap_or(-1)
        ));
    }

    let restore_status = Command::new(docker_bin())
        .args([
            "run",
            "--rm",
            "-v",
            &format!("{}:/target", entry.docker_volume),
            "-v",
            &format!("{}:/backup:ro", archive_dir_str),
            "alpine:3",
            "sh",
            "-c",
            &format!("tar -xzf /backup/{} -C /target", archive_file_str),
        ])
        .status()
        .map_err(|e| format!("docker run for restore: {}", e))?;

    if !restore_status.success() {
        return Err(format!(
            "restore of volume `{}` failed (exit {})",
            entry.docker_volume,
            restore_status.code().unwrap_or(-1)
        ));
    }
    Ok(())
}

/// Keep the newest `keep` snapshot folders under `app_volume_dir(app_id)`,
/// delete the rest. Snapshot folder names are `YYYYMMDD_HHMMSS`, so the
/// lexicographic sort is also the chronological sort.
pub fn prune_old_snapshots(app_id: &str, keep: usize) -> Result<usize, String> {
    let dir = app_volume_dir(app_id);
    if !dir.exists() {
        return Ok(0);
    }
    let mut entries: Vec<_> = std::fs::read_dir(&dir)
        .map_err(|e| format!("read snapshot dir: {}", e))?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .collect();
    entries.sort_by_key(|e| e.file_name());
    entries.reverse();
    let mut removed = 0;
    for old in entries.iter().skip(keep) {
        if std::fs::remove_dir_all(old.path()).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

fn list_docker_volumes() -> Result<Vec<String>, String> {
    let out = Command::new(docker_bin())
        .args(["volume", "ls", "-q"])
        .output()
        .map_err(|e| format!("docker volume ls: {}", e))?;
    if !out.status.success() {
        return Err(format!(
            "docker volume ls exited with {}",
            out.status.code().unwrap_or(-1)
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect())
}

// ── Tauri commands ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSnapshotSummary {
    pub timestamp: String,
    pub entries: Vec<VolumeSnapshotEntry>,
    pub total_bytes: u64,
}

/// List previously-taken snapshots for an app, newest first.
#[tauri::command]
pub fn list_app_volume_snapshots(app_id: String) -> Result<Vec<AppSnapshotSummary>, String> {
    let dir = app_volume_dir(&app_id);
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut out: Vec<AppSnapshotSummary> = std::fs::read_dir(&dir)
        .map_err(|e| format!("read snapshot dir: {}", e))?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .map(|e| {
            let timestamp = e.file_name().to_string_lossy().into_owned();
            let entries: Vec<VolumeSnapshotEntry> = std::fs::read_dir(e.path())
                .map(|it| {
                    it.filter_map(|f| f.ok())
                        .filter(|f| {
                            f.path()
                                .extension()
                                .and_then(|s| s.to_str())
                                .map(|s| s == "gz")
                                .unwrap_or(false)
                        })
                        .map(|f| {
                            let archive_path = f.path().to_string_lossy().into_owned();
                            let local_name = f
                                .path()
                                .file_stem()
                                .and_then(|s| s.to_str())
                                .map(|s| s.trim_end_matches(".tar").to_string())
                                .unwrap_or_default();
                            let size_bytes = f.metadata().map(|m| m.len()).unwrap_or(0);
                            VolumeSnapshotEntry {
                                volume: local_name.clone(),
                                docker_volume: String::new(),
                                archive_path,
                                size_bytes,
                            }
                        })
                        .collect()
                })
                .unwrap_or_default();
            let total_bytes = entries.iter().map(|e| e.size_bytes).sum();
            AppSnapshotSummary { timestamp, entries, total_bytes }
        })
        .collect();
    out.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    Ok(out)
}

/// Take a fresh volume snapshot for an app on demand (outside the update flow).
///
/// Reads the app's `kind` from the DB to choose the docker vs compose snapshot
/// path — docker apps name their volumes verbatim, compose apps use local names
/// resolved against the compose project. Returns a summary of the snapshot just
/// written, shaped exactly like the entries [`list_app_volume_snapshots`] yields
/// so the frontend can prepend it to the list.
///
/// The DB read + snapshot both run on a blocking thread: `Database::open` is
/// sync and the snapshot shells out to `docker`/`tar`.
#[tauri::command]
pub async fn create_app_volume_snapshot(
    app_id: String,
    volumes: Vec<String>,
) -> Result<AppSnapshotSummary, String> {
    tokio::task::spawn_blocking(move || {
        let db_path = crate::porta_dir().join("porta.db");
        let db = crate::db::Database::open(db_path).map_err(|e| e.to_string())?;
        let app = db
            .list_apps()
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|a| a.id == app_id)
            .ok_or_else(|| format!("app {} not found", app_id))?;

        let result = if app.is_docker() {
            snapshot_docker_volumes(&app_id, &volumes)?
        } else if app.is_compose() {
            snapshot_compose_volumes(&app_id, &volumes)?
        } else {
            return Err("app has no docker volumes".to_string());
        };

        let total_bytes = result.entries.iter().map(|e| e.size_bytes).sum();
        Ok(AppSnapshotSummary {
            timestamp: result.timestamp,
            entries: result.entries,
            total_bytes,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Delete a specific snapshot folder.
#[tauri::command]
pub fn delete_app_volume_snapshot(app_id: String, timestamp: String) -> Result<(), String> {
    let dir = app_volume_dir(&app_id).join(&timestamp);
    if !dir.exists() {
        return Ok(());
    }
    std::fs::remove_dir_all(&dir).map_err(|e| format!("remove snapshot dir: {}", e))
}
