//! Idle-sleep watcher: stops auto-sleep apps that have gone quiet.
//!
//! Polls every 30s. For each `running` app with `auto_sleep_enabled`, it reads
//! new lines from the app's Caddy access log (the same per-app JSON log the
//! Traffic Inspector uses) to find the last request time. If `now - last
//! request > idle_timeout_secs`, the app is stopped and flagged `auto_slept`.
//!
//! Waking is handled separately and transparently by `wake_server` via Caddy's
//! errors route. Static/proxy apps are skipped — they have no process to sleep.

use std::collections::HashMap;
use std::thread;
use std::time::Duration;

use tauri::{Emitter, Manager};

use crate::access_log;
use crate::app_state::AppState;
use crate::db::models::App;
use crate::tray::rebuild_tray_menu;

const POLL_INTERVAL: Duration = Duration::from_secs(30);

/// Per-app idle tracking: byte offset into the access log we've consumed up to,
/// and the unix timestamp (seconds) of the most recent request we've observed.
struct Track {
    offset: u64,
    last_activity: f64,
}

pub fn spawn_idle_watcher(handle: tauri::AppHandle) {
    thread::spawn(move || {
        let mut tracking: HashMap<String, Track> = HashMap::new();

        loop {
            thread::sleep(POLL_INTERVAL);

            let state = handle.state::<AppState>();
            let apps = match state.db.lock().unwrap().list_apps() {
                Ok(a) => a,
                Err(_) => continue,
            };
            let now = chrono::Utc::now().timestamp() as f64;

            // Drop tracking for apps that are no longer eligible/running so a
            // restart begins its idle window fresh.
            let live_ids: std::collections::HashSet<&str> = apps
                .iter()
                .filter(|a| is_watchable(a))
                .map(|a| a.id.as_str())
                .collect();
            tracking.retain(|id, _| live_ids.contains(id.as_str()));

            for app in &apps {
                if !is_watchable(app) {
                    continue;
                }

                let track = tracking.entry(app.id.clone()).or_insert_with(|| Track {
                    // Skip pre-existing log lines and start the idle window now,
                    // so an app that was busy before we began watching gets a
                    // full grace period rather than sleeping instantly.
                    offset: access_log::current_offset(&app.id),
                    last_activity: now,
                });

                // Pull any new access-log entries and advance last_activity.
                if let Ok(chunk) = access_log::tail(&app.id, track.offset) {
                    track.offset = chunk.next_offset;
                    if let Some(max_ts) = chunk
                        .entries
                        .iter()
                        .map(|e| e.ts)
                        .fold(None, |acc: Option<f64>, ts| Some(acc.map_or(ts, |m| m.max(ts))))
                    {
                        if max_ts > track.last_activity {
                            track.last_activity = max_ts;
                        }
                    }
                }

                if now - track.last_activity > app.idle_timeout_secs as f64 {
                    sleep_app(&handle, app);
                    tracking.remove(&app.id);
                }
            }
        }
    });
}

/// An app the watcher should track: auto-sleep on, currently running, and has a
/// real process (not a Caddy-only static/proxy app).
fn is_watchable(app: &App) -> bool {
    app.auto_sleep_enabled
        && app.status == "running"
        && !app.is_static()
        && !app.is_proxy()
}

/// Stop an idle app and mark it as auto-slept. Mirrors the manager dispatch in
/// `stop_app`, but flags `auto_slept` and emits `app:slept:{id}` so the UI shows
/// the 💤 badge instead of a plain "stopped".
fn sleep_app(handle: &tauri::AppHandle, app: &App) {
    let state = handle.state::<AppState>();
    let id = &app.id;

    if app.is_compose() {
        let root = if app.root_dir.is_empty() { None } else { Some(app.root_dir.as_str()) };
        let file = app.compose_file.as_deref().unwrap_or("");
        state.docker.stopping.lock().unwrap().insert(id.clone());
        state.docker.compose_stop_and_wait(id, file, root).ok();
    } else if app.is_docker() {
        state.docker.stop(id).ok();
    } else if state.processes.is_running(id) {
        state.processes.stop(id).ok();
    }

    {
        let db = state.db.lock().unwrap();
        db.update_app_status(id, "stopped", None).ok();
        db.set_app_auto_slept(id, true).ok();
    }

    handle.emit(&format!("app:slept:{}", id), ()).ok();

    let tray_handle = handle.clone();
    let tray_db_path = state.db_path.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(200));
        rebuild_tray_menu(&tray_handle, &tray_db_path);
    });
}
