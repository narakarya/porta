use crate::sync::LockExt;
use std::path::Path;
use std::time::Duration;

use chrono::{Datelike, Local, TimeZone, Timelike, Weekday};
use serde::{Deserialize, Serialize};
use tauri::{Manager, State};

use crate::app_state::AppState;
use crate::backup;
use crate::commands::settings::{read_porta_config, write_porta_config};
use crate::db::Database;

/// Remove `<db>.db-wal` and `<db>.db-shm` sidecar files. Required after
/// overwriting the main `.db` file — otherwise SQLite recovers from the
/// old WAL on next open and undoes the imported data.
fn cleanup_wal_sidecars(db_path: &Path) {
    if let Some(parent) = db_path.parent() {
        if let Some(stem) = db_path.file_name().and_then(|n| n.to_str()) {
            let _ = std::fs::remove_file(parent.join(format!("{}-wal", stem)));
            let _ = std::fs::remove_file(parent.join(format!("{}-shm", stem)));
        }
    }
}

#[derive(Debug, Serialize)]
pub struct BackupEntry {
    pub filename: String,
    pub path: String,
    pub size_bytes: u64,
    /// Epoch seconds. Parsed from the `YYYYMMDD_HHMMSS.db` name (which is UTC),
    /// falling back to the file's mtime for anything not matching.
    pub created_at: Option<i64>,
    /// What's actually inside — the number that tells you whether this is the
    /// snapshot from before you deleted something.
    pub app_count: Option<u32>,
    pub workspace_count: Option<u32>,
}

/// `20260727_041003.db` → epoch seconds. The stamp is written in UTC by
/// [`crate::backup::auto_backup`].
fn parse_stamp(filename: &str) -> Option<i64> {
    let stem = filename.strip_suffix(".db")?;
    let dt = chrono::NaiveDateTime::parse_from_str(stem, "%Y%m%d_%H%M%S").ok()?;
    Some(dt.and_utc().timestamp())
}

/// Row counts from a snapshot, read-only and best-effort. A snapshot from an
/// older schema (or a half-written file) just reports `None` rather than
/// failing the whole listing.
fn snapshot_counts(path: &Path) -> (Option<u32>, Option<u32>) {
    let Ok(conn) = rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) else {
        return (None, None);
    };
    let count = |table: &str| -> Option<u32> {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .ok()
    };
    (count("apps"), count("workspaces"))
}

#[tauri::command]
pub fn list_backups() -> Vec<BackupEntry> {
    let dir = backup::backup_dir();
    let Ok(entries) = std::fs::read_dir(&dir) else { return Vec::new() };

    let mut out: Vec<BackupEntry> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().is_some_and(|x| x == "db"))
        .map(|e| {
            let path = e.path();
            let filename = e.file_name().to_string_lossy().to_string();
            let meta = e.metadata().ok();
            let created_at = parse_stamp(&filename).or_else(|| {
                meta.as_ref()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64)
            });
            let (app_count, workspace_count) = snapshot_counts(&path);
            BackupEntry {
                filename,
                path: path.to_string_lossy().to_string(),
                size_bytes: meta.map(|m| m.len()).unwrap_or(0),
                created_at,
                app_count,
                workspace_count,
            }
        })
        .collect();

    // Newest first. Sort on the parsed timestamp rather than the name so a
    // hand-dropped file still lands in the right place.
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(b.filename.cmp(&a.filename)));
    out
}

/// Absolute path of the snapshots folder, so the UI can offer "show in Finder".
#[tauri::command]
pub fn backup_dir_path() -> String {
    backup::backup_dir().to_string_lossy().to_string()
}

/// Swap `src` in as the live database.
///
/// The delicate part is that a restore is not a file copy. `state.db` holds an
/// open WAL-mode connection: overwriting `<db>` underneath it leaves `<db>-wal`
/// and `<db>-shm` describing the *old* file, and the next open replays that WAL
/// straight over the restored bytes — the restore silently evaporates, which is
/// exactly what "Restored! Reload to apply" used to mean in practice.
///
/// So: checkpoint and drop the live connection, copy, delete the sidecars, then
/// reopen against the new file.
fn swap_in_database(state: &AppState, src: &Path) -> Result<(), String> {
    let mut guard = state.db.lock().map_err(|e| e.to_string())?;

    let _ = guard.conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
    // Dropping the live connection (by replacing it) releases the WAL lock and
    // the fd on `state.db_path` so the file can be overwritten cleanly.
    *guard = Database::open_in_memory().map_err(|e| e.to_string())?;

    let copy_result = std::fs::copy(src, &state.db_path).map_err(|e| e.to_string());

    // Whether or not the copy landed, the on-disk file is now the only state.
    cleanup_wal_sidecars(&state.db_path);

    *guard = Database::open(state.db_path.clone()).map_err(|e| e.to_string())?;

    copy_result.map(|_| ())
}

#[tauri::command]
pub fn restore_backup(state: State<AppState>, filename: String) -> Result<(), String> {
    let backup_path = backup::backup_dir().join(&filename);
    if !backup_path.is_file() {
        return Err(format!("backup not found: {}", backup_path.display()));
    }
    // Snapshot where we are before rolling back, so a restore is itself
    // undoable — picking the wrong snapshot shouldn't be a one-way door.
    backup::auto_backup_state(&state).ok();
    swap_in_database(&state, &backup_path)
}

#[tauri::command]
pub fn export_full_backup(state: State<AppState>, dest_path: String) -> Result<(), String> {
    // Flush WAL into the main .db file BEFORE copying so the export
    // reflects every committed write — including ones still living in
    // the WAL. Without this, recent edits would silently be missing.
    {
        let db = state.db.lock_or_recover();
        let _ = db.conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
    }
    backup::auto_backup(&state.db_path).ok();
    std::fs::copy(&state.db_path, &dest_path).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn import_full_backup(state: State<AppState>, src_path: String) -> Result<(), String> {
    // Checkpointed, so the safety snapshot carries every committed write
    // rather than whatever last happened to land in the main file.
    backup::auto_backup_state(&state).ok();
    swap_in_database(&state, Path::new(&src_path))
}

#[tauri::command]
pub fn get_porta_env() -> String {
    if cfg!(debug_assertions) { "dev".into() } else { "prod".into() }
}

// ── Scheduler ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ScheduleFreq {
    Hourly,
    Daily,
    Weekly,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupSchedule {
    pub enabled: bool,
    pub frequency: ScheduleFreq,
    pub hour: u8,
    pub minute: u8,
    /// Mon=0 .. Sun=6 (used only for Weekly)
    pub day_of_week: u8,
    pub retain_count: u32,
    pub last_run_at: Option<i64>,
    pub next_run_at: Option<i64>,
}

impl Default for BackupSchedule {
    fn default() -> Self {
        BackupSchedule {
            enabled: false,
            frequency: ScheduleFreq::Daily,
            hour: 3,
            minute: 0,
            day_of_week: 0,
            retain_count: 10,
            last_run_at: None,
            next_run_at: None,
        }
    }
}

const CONFIG_KEY: &str = "backup_schedule";

fn load_schedule() -> BackupSchedule {
    let cfg = read_porta_config();
    cfg.get(CONFIG_KEY)
        .and_then(|v| serde_json::from_value::<BackupSchedule>(v.clone()).ok())
        .unwrap_or_default()
}

fn save_schedule(s: &BackupSchedule) {
    let mut cfg = read_porta_config();
    cfg[CONFIG_KEY] = serde_json::to_value(s).unwrap_or(serde_json::Value::Null);
    write_porta_config(&cfg);
}

/// Calculate the next run timestamp (unix seconds) given a schedule and a
/// "now" reference. Pure function so it's trivially testable.
fn compute_next_run(s: &BackupSchedule, now_unix: i64) -> Option<i64> {
    let now = Local.timestamp_opt(now_unix, 0).single()?;
    match s.frequency {
        ScheduleFreq::Hourly => {
            // Next occurrence of `:minute` from now.
            let mut candidate = now
                .with_minute(s.minute.min(59) as u32)?
                .with_second(0)?
                .with_nanosecond(0)?;
            if candidate <= now {
                candidate += chrono::Duration::hours(1);
            }
            Some(candidate.timestamp())
        }
        ScheduleFreq::Daily => {
            let target_today = now
                .with_hour(s.hour.min(23) as u32)?
                .with_minute(s.minute.min(59) as u32)?
                .with_second(0)?
                .with_nanosecond(0)?;
            let candidate = if target_today <= now {
                target_today + chrono::Duration::days(1)
            } else {
                target_today
            };
            Some(candidate.timestamp())
        }
        ScheduleFreq::Weekly => {
            // Mon=0 .. Sun=6 in our convention
            let target_dow = s.day_of_week.min(6) as i64;
            let now_dow = match now.weekday() {
                Weekday::Mon => 0i64,
                Weekday::Tue => 1,
                Weekday::Wed => 2,
                Weekday::Thu => 3,
                Weekday::Fri => 4,
                Weekday::Sat => 5,
                Weekday::Sun => 6,
            };
            let mut days_ahead = (target_dow - now_dow).rem_euclid(7);
            let target_today = now
                .with_hour(s.hour.min(23) as u32)?
                .with_minute(s.minute.min(59) as u32)?
                .with_second(0)?
                .with_nanosecond(0)?;
            if days_ahead == 0 && target_today <= now {
                days_ahead = 7;
            }
            let candidate = target_today + chrono::Duration::days(days_ahead);
            Some(candidate.timestamp())
        }
    }
}

/// Apply retention: keep newest `retain_count` `.db` snapshots, delete the rest.
fn apply_retention(retain_count: u32) {
    let dir = backup::backup_dir();
    let mut entries: Vec<_> = match std::fs::read_dir(&dir) {
        Ok(it) => it
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().is_some_and(|x| x == "db"))
            .collect(),
        Err(_) => return,
    };
    // Filenames embed `YYYYMMDD_HHMMSS` so lexicographic sort == chronological.
    entries.sort_by_key(|e| e.file_name());
    entries.reverse();
    for old in entries.iter().skip(retain_count as usize) {
        let _ = std::fs::remove_file(old.path());
    }
}

#[tauri::command]
pub fn get_backup_schedule() -> BackupSchedule {
    load_schedule()
}

#[tauri::command]
pub fn set_backup_schedule(schedule: BackupSchedule) {
    let mut s = schedule;
    let now = chrono::Utc::now().timestamp();
    s.next_run_at = if s.enabled { compute_next_run(&s, now) } else { None };
    save_schedule(&s);
}

#[tauri::command]
pub fn next_backup_at() -> Option<i64> {
    load_schedule().next_run_at
}

/// Manual trigger that mirrors the scheduler's behaviour: runs a backup,
/// updates last_run_at + next_run_at, and applies retention.
#[tauri::command]
pub fn run_backup_now_via_schedule(state: State<AppState>) -> Result<(), String> {
    {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        let _ = db.conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
    }
    backup::auto_backup(&state.db_path).map_err(|e| e.to_string())?;

    let mut s = load_schedule();
    let now = chrono::Utc::now().timestamp();
    s.last_run_at = Some(now);
    if s.enabled {
        s.next_run_at = compute_next_run(&s, now);
    }
    apply_retention(s.retain_count.max(1));
    save_schedule(&s);
    Ok(())
}

/// Spawn the background scheduler. Wakes every 60s; if `enabled` and
/// `now >= next_run_at`, runs a backup and recomputes `next_run_at`.
pub fn spawn_backup_scheduler(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Initial settle delay so we don't race app boot.
        tokio::time::sleep(Duration::from_secs(10)).await;

        // Make sure next_run_at exists if a schedule is enabled but the field
        // is None (e.g. legacy config from before this feature).
        {
            let mut s = load_schedule();
            if s.enabled && s.next_run_at.is_none() {
                let now = chrono::Utc::now().timestamp();
                s.next_run_at = compute_next_run(&s, now);
                save_schedule(&s);
            }
        }

        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;

            let s = load_schedule();
            if !s.enabled {
                continue;
            }
            let now = chrono::Utc::now().timestamp();
            let due = s.next_run_at.map(|t| now >= t).unwrap_or(false);
            if !due {
                continue;
            }

            let state = app.state::<AppState>();
            // Flush WAL so the snapshot has all committed writes.
            if let Ok(db) = state.db.lock() {
                let _ = db.conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
            }
            if let Err(e) = backup::auto_backup(&state.db_path) {
                eprintln!("scheduled backup failed: {e}");
                // Skip retention/last_run update on failure; try again next tick.
                continue;
            }

            apply_retention(s.retain_count.max(1));

            let mut updated = load_schedule();
            updated.last_run_at = Some(now);
            updated.next_run_at = compute_next_run(&updated, now);
            save_schedule(&updated);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDateTime;

    fn ts(date: &str, time: &str) -> i64 {
        let dt = NaiveDateTime::parse_from_str(
            &format!("{date} {time}"),
            "%Y-%m-%d %H:%M:%S",
        )
        .unwrap();
        Local.from_local_datetime(&dt).single().unwrap().timestamp()
    }

    #[test]
    fn test_compute_next_run_daily_today_future() {
        let s = BackupSchedule {
            enabled: true,
            frequency: ScheduleFreq::Daily,
            hour: 23,
            minute: 30,
            day_of_week: 0,
            retain_count: 10,
            last_run_at: None,
            next_run_at: None,
        };
        let now = ts("2025-01-15", "10:00:00");
        let next = compute_next_run(&s, now).unwrap();
        let next_dt = Local.timestamp_opt(next, 0).single().unwrap();
        assert_eq!(next_dt.hour(), 23);
        assert_eq!(next_dt.minute(), 30);
        assert_eq!(next_dt.day(), 15);
    }

    #[test]
    fn test_compute_next_run_daily_already_past() {
        let s = BackupSchedule {
            enabled: true,
            frequency: ScheduleFreq::Daily,
            hour: 3,
            minute: 0,
            day_of_week: 0,
            retain_count: 10,
            last_run_at: None,
            next_run_at: None,
        };
        let now = ts("2025-01-15", "10:00:00");
        let next = compute_next_run(&s, now).unwrap();
        let next_dt = Local.timestamp_opt(next, 0).single().unwrap();
        assert_eq!(next_dt.day(), 16); // tomorrow
        assert_eq!(next_dt.hour(), 3);
    }

    #[test]
    fn test_compute_next_run_hourly() {
        let s = BackupSchedule {
            enabled: true,
            frequency: ScheduleFreq::Hourly,
            hour: 0,
            minute: 15,
            day_of_week: 0,
            retain_count: 10,
            last_run_at: None,
            next_run_at: None,
        };
        let now = ts("2025-01-15", "10:00:00");
        let next = compute_next_run(&s, now).unwrap();
        let next_dt = Local.timestamp_opt(next, 0).single().unwrap();
        assert_eq!(next_dt.hour(), 10);
        assert_eq!(next_dt.minute(), 15);
    }

    #[test]
    fn test_compute_next_run_weekly_same_day_future() {
        // 2025-01-15 is a Wednesday (Mon=0 -> Wed=2)
        let s = BackupSchedule {
            enabled: true,
            frequency: ScheduleFreq::Weekly,
            hour: 23,
            minute: 0,
            day_of_week: 2, // Wednesday
            retain_count: 10,
            last_run_at: None,
            next_run_at: None,
        };
        let now = ts("2025-01-15", "10:00:00");
        let next = compute_next_run(&s, now).unwrap();
        let next_dt = Local.timestamp_opt(next, 0).single().unwrap();
        assert_eq!(next_dt.day(), 15); // same Wed, later that day
        assert_eq!(next_dt.hour(), 23);
    }

    #[test]
    fn test_compute_next_run_weekly_same_day_past_rolls_to_next_week() {
        let s = BackupSchedule {
            enabled: true,
            frequency: ScheduleFreq::Weekly,
            hour: 3,
            minute: 0,
            day_of_week: 2, // Wednesday
            retain_count: 10,
            last_run_at: None,
            next_run_at: None,
        };
        let now = ts("2025-01-15", "10:00:00"); // Wed 10am, target Wed 3am already passed
        let next = compute_next_run(&s, now).unwrap();
        let next_dt = Local.timestamp_opt(next, 0).single().unwrap();
        assert_eq!(next_dt.day(), 22); // next Wed
    }

    #[test]
    fn test_default_schedule() {
        let s = BackupSchedule::default();
        assert!(!s.enabled);
        assert_eq!(s.retain_count, 10);
        assert!(matches!(s.frequency, ScheduleFreq::Daily));
    }
}
