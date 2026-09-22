use crate::sync::LockExt;
use std::collections::HashSet;
use std::io::Write as _;
use std::time::{Duration, Instant};

use tauri::{Emitter, Manager};

use crate::app_state::AppState;
use crate::db;
use crate::docker_manager::DockerManager;
use crate::process_manager::log_file_path;

const DOCKER_AUTO_START_TIMEOUT: Duration = Duration::from_secs(120);
const DOCKER_AUTO_START_FAST_POLL: Duration = Duration::from_secs(2);
const DOCKER_AUTO_START_SLOW_POLL: Duration = Duration::from_secs(5);
const DOCKER_AUTO_START_FAST_WINDOW: Duration = Duration::from_secs(30);

/// The apps eligible for auto-start, in stored order.
///
/// This used to topologically sort by `depends_on` ("Start After"), which is
/// gone from the UI: the ordering was invisible, only reachable via a
/// docker-compose import, and a single slow dependency stalled every app behind
/// it for up to 30s. Auto-start now just walks the list.
pub fn auto_start_apps(all_apps: Vec<db::models::App>) -> Vec<db::models::App> {
    all_apps
        .into_iter()
        .filter(|a| a.auto_start && (!a.start_command.is_empty() || a.is_docker() || a.is_compose()))
        .collect()
}

fn wait_for_docker_engine(timeout: Duration) -> bool {
    let started = Instant::now();
    loop {
        if DockerManager::is_engine_ready() {
            return true;
        }
        if started.elapsed() >= timeout {
            return false;
        }
        let poll = if started.elapsed() < DOCKER_AUTO_START_FAST_WINDOW {
            DOCKER_AUTO_START_FAST_POLL
        } else {
            DOCKER_AUTO_START_SLOW_POLL
        };
        std::thread::sleep(poll);
    }
}

fn append_auto_start_note(app_id: &str, message: &str) {
    let log_path = log_file_path(app_id);
    if let Some(parent) = log_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
    {
        let _ = writeln!(file, "── {message} ──");
    }
}

/// How long to keep waiting for the daemon, after auto-start has given up on
/// it, purely to reconcile Docker/Compose statuses. OrbStack can take minutes
/// to come up after login on a loaded machine; a status that is wrong for
/// that long is annoying, one that is wrong forever is the bug this fixes.
const DOCKER_ADOPT_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// Bring the DB in line with what the daemon says is running, for every
/// Docker and Compose app, and register the running ones with the manager so
/// Stop/metrics work on them. Returns the ids found running.
///
/// Both directions are corrected: a container that is Up makes its app
/// `running` even if the DB said `stopped` (the orphaned-stack case), and an
/// app the DB thought was running with no container becomes `stopped`. When
/// the daemon cannot be asked, nothing is written — an unknown answer is not
/// "nothing is running" — and the caller decides whether to retry.
///
/// Late corrections are announced with the same events a start or exit
/// would produce, since the frontend's store only reacts to those.
pub(crate) fn adopt_docker_apps(handle: &tauri::AppHandle) -> Option<HashSet<String>> {
    let running = match DockerManager::running_app_ids() {
        Ok(ids) => ids,
        Err(e) => {
            eprintln!("docker adoption: daemon not reachable, leaving statuses as they are ({e})");
            return None;
        }
    };
    let state = handle.state::<AppState>();
    let apps = state.db.lock_or_recover().list_apps().unwrap_or_default();
    let mut adopted = HashSet::new();
    for app_data in apps.iter().filter(|a| a.is_docker() || a.is_compose()) {
        let is_up = running.contains(&app_data.id);
        let was_running = app_data.status == "running" || app_data.status == "starting";
        if is_up {
            state.docker.adopt(&app_data.id);
            adopted.insert(app_data.id.clone());
            if !was_running {
                state
                    .db
                    .lock_or_recover()
                    .update_app_status(&app_data.id, "running", None)
                    .ok();
                handle.emit(&format!("app:ready:{}", app_data.id), ()).ok();
            }
        } else if was_running {
            state
                .db
                .lock_or_recover()
                .update_app_status(&app_data.id, "stopped", None)
                .ok();
            handle.emit(&format!("app:exit:{}", app_data.id), 0).ok();
        }
    }
    Some(adopted)
}

/// Spawn a background thread that auto-starts apps flagged with `auto_start = true`.
/// Porta finishes setup immediately while this runs in the background.
pub fn spawn_auto_start(app: &tauri::App) {
    let (apps_to_start, has_docker_apps) = {
        let state = app.state::<AppState>();
        let db = state.db.lock_or_recover();
        let all = db.list_apps().unwrap_or_default();
        let has_docker_apps = all.iter().any(|a| a.is_docker() || a.is_compose());
        (auto_start_apps(all), has_docker_apps)
    };

    let tray_db_path = app.state::<AppState>().db_path.clone();
    let auto_start_handle = app.handle().clone();
    std::thread::spawn(move || {
        // Pick up whatever outlived the last Porta run before deciding what to
        // start. Without this, an app whose tmux session survived an update
        // would be launched a second time against a port the first copy still
        // holds — and the DB snapshot above is too old to notice, since
        // adoption is what marks those apps running again.
        let adopted = crate::commands::app_lifecycle::adopt_running_apps(&auto_start_handle);

        let start = |app_data: &db::models::App| {
            if let Err(e) = crate::commands::app_lifecycle::start_single(
                &auto_start_handle,
                app_data,
                false,
                false,
            ) {
                eprintln!("auto-start failed for {}: {}", app_data.name, e);
                append_auto_start_note(&app_data.id, &format!("Auto-start failed: {e}"));
            }
        };

        // Process-backed apps first: they do not depend on the daemon, so a
        // slow OrbStack must not hold them up.
        for app_data in apps_to_start
            .iter()
            .filter(|a| !a.is_docker() && !a.is_compose())
        {
            if adopted.contains(&app_data.id) {
                continue;
            }
            // Skip apps that are already running (survived from previous session)
            if app_data.status == "running" {
                continue;
            }
            start(app_data);
        }

        // Docker/Compose: wait for the daemon once, reconcile every such app
        // against it, then auto-start only the ones that are not already up.
        // The reconciliation is the authority here, not the DB snapshot: the
        // snapshot may say "running" for a container that is gone, or
        // "stopped" for a stack that survived the last Porta run.
        if has_docker_apps {
            let docker_apps: Vec<&db::models::App> = apps_to_start
                .iter()
                .filter(|a| a.is_docker() || a.is_compose())
                .collect();
            let ready = wait_for_docker_engine(DOCKER_AUTO_START_TIMEOUT);
            let docker_adopted = if ready {
                adopt_docker_apps(&auto_start_handle)
            } else {
                None
            };
            match docker_adopted {
                Some(docker_adopted) => {
                    for app_data in docker_apps {
                        if !docker_adopted.contains(&app_data.id) {
                            start(app_data);
                        }
                    }
                }
                None => {
                    for app_data in &docker_apps {
                        append_auto_start_note(
                            &app_data.id,
                            "Auto-start skipped because Docker/OrbStack was not ready",
                        );
                    }
                    // Auto-start has given up, but the statuses still need
                    // correcting once the daemon does come up.
                    let handle = auto_start_handle.clone();
                    std::thread::spawn(move || {
                        if wait_for_docker_engine(DOCKER_ADOPT_TIMEOUT) {
                            adopt_docker_apps(&handle);
                        }
                    });
                }
            }
        }

        std::thread::sleep(std::time::Duration::from_millis(500));
        crate::tray::rebuild_tray_menu(&auto_start_handle, &tray_db_path);
    });
}
