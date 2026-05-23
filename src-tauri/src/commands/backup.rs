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

#[tauri::command]
pub fn list_backups() -> Vec<String> {
    let dir = backup::backup_dir();
    std::fs::read_dir(&dir)
        .map(|entries| {
            let mut names: Vec<String> = entries
                .filter_map(|e| e.ok())
                .filter(|e| e.path().extension().is_some_and(|x| x == "db"))
                .map(|e| e.file_name().to_string_lossy().to_string())
                .collect();
            names.sort();
            names.reverse();
            names
        })
        .unwrap_or_default()
}

#[tauri::command]
pub fn restore_backup(state: State<AppState>, filename: String) -> Result<(), String> {
    let backup_path = backup::backup_dir().join(&filename);
    std::fs::copy(&backup_path, &state.db_path).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn export_full_backup(state: State<AppState>, dest_path: String) -> Result<(), String> {
    // Flush WAL into the main .db file BEFORE copying so the export
    // reflects every committed write — including ones still living in
    // the WAL. Without this, recent edits would silently be missing.
    {
        let db = state.db.lock().unwrap();
        let _ = db.conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
    }
    backup::auto_backup(&state.db_path).ok();
    std::fs::copy(&state.db_path, &dest_path).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn import_full_backup(state: State<AppState>, src_path: String) -> Result<(), String> {
    backup::auto_backup(&state.db_path).ok();

    // Hold the lock for the whole swap so nothing else can write to the
    // DB while we replace the underlying file.
    let mut guard = state.db.lock().map_err(|e| e.to_string())?;

    // Flush our own WAL first so the safety auto_backup just took has
    // every committed write, then drop the live connection by replacing
    // it with an in-memory one. Dropping releases the WAL lock and the
    // fd against `state.db_path` so we can overwrite the file cleanly.
    let _ = guard.conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
    *guard = Database::open_in_memory().map_err(|e| e.to_string())?;

    let copy_result = std::fs::copy(&src_path, &state.db_path).map_err(|e| e.to_string());

    // Whether the copy succeeded or failed, the imported file (or the
    // old file if copy errored) is now the only on-disk state. Strip
    // sidecar WAL/SHM so SQLite opens fresh — without this the imported
    // data gets reverted by stale WAL recovery on next open.
    cleanup_wal_sidecars(&state.db_path);

    // Reopen against the on-disk file so the running app can continue
    // using state.db without requiring restart for in-process commands.
    // (UI still recommends restart so subscribers / process state reset.)
    *guard = Database::open(state.db_path.clone()).map_err(|e| e.to_string())?;

    copy_result.map(|_| ())
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
