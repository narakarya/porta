pub mod app_state;
pub mod auto_detect;
pub mod auto_start;
pub mod backup;
pub mod caddy;
pub mod commands;
pub mod db;
pub mod dns;
pub mod port_check;
pub mod port_scanner;
pub mod process_manager;
pub mod compose_parser;
pub mod health;
pub mod porta_config;
pub mod metrics;
pub mod setup;
pub mod tray;

use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use nix::sys::signal::kill;
use nix::unistd::Pid;

/// Returns the Porta data directory: `~/.porta` for release, `~/.porta-dev` for debug builds.
pub fn porta_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    if cfg!(debug_assertions) {
        PathBuf::from(home).join(".porta-dev")
    } else {
        PathBuf::from(home).join(".porta")
    }
}

use tauri::Manager;
use tauri_plugin_autostart::MacosLauncher;

use caddy::CaddyManager;
use commands::AppState;
use commands::settings::{read_porta_config, write_porta_config};
use db::Database;
use process_manager::ProcessManager;

// ── Window state persistence ─────────────────────────────────────────────────

/// Flag to prevent saving window state during the initial restore.
static RESTORING_WINDOW: AtomicBool = AtomicBool::new(false);

fn save_window_state(window: &tauri::Window) {
    if RESTORING_WINDOW.load(Ordering::Relaxed) {
        return;
    }
    if let (Ok(pos), Ok(size)) = (window.outer_position(), window.inner_size()) {
        let mut cfg = read_porta_config();
        cfg["window"] = serde_json::json!({
            "x": pos.x,
            "y": pos.y,
            "width": size.width,
            "height": size.height,
        });
        write_porta_config(&cfg);
    }
}

fn restore_window_state(window: &tauri::WebviewWindow) {
    let cfg = read_porta_config();
    if let Some(w) = cfg.get("window") {
        let x = w.get("x").and_then(serde_json::Value::as_i64);
        let y = w.get("y").and_then(serde_json::Value::as_i64);
        let width = w.get("width").and_then(serde_json::Value::as_u64);
        let height = w.get("height").and_then(serde_json::Value::as_u64);

        RESTORING_WINDOW.store(true, Ordering::Relaxed);

        if let (Some(x), Some(y)) = (x, y) {
            use tauri::PhysicalPosition;
            let _ = window.set_position(PhysicalPosition::new(x as i32, y as i32));
        }
        if let (Some(w), Some(h)) = (width, height) {
            use tauri::PhysicalSize;
            let _ = window.set_size(PhysicalSize::new(w as u32, h as u32));
        }

        RESTORING_WINDOW.store(false, Ordering::Relaxed);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let base = porta_dir();
    std::fs::create_dir_all(&base).expect("failed to create porta data dir");
    let db_path = base.join("porta.db");

    let db = Database::open(db_path.clone()).expect("failed to open database");

    // Mark apps as stopped if their recorded PID is no longer alive.
    // This fixes stale "running" state after Porta crashes or is force-quit.
    if let Ok(apps) = db.list_apps() {
        for app in apps.iter().filter(|a| a.status == "running") {
            let alive = app.pid.is_some_and(|pid| {
                // kill(pid, 0) = existence check — Ok if process is alive
                kill(Pid::from_raw(pid as i32), None).is_ok()
            });
            if !alive {
                db.update_app_status(&app.id, "stopped", None).ok();
            }
        }
    }

    let state = AppState {
        db: Mutex::new(db),
        processes: ProcessManager::new(),
        caddy: CaddyManager::new(),
        db_path: db_path.clone(),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .manage(state)
        .setup(|app| {
            if let Some(w) = app.get_webview_window("main") {
                restore_window_state(&w);
            }
            tray::setup_tray(app)?;
            auto_start::spawn_auto_start(app);
            metrics::spawn_metrics_poller(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::check_setup,
            commands::run_setup,
            commands::start_caddy,
            commands::reload_caddy,
            commands::list_workspaces,
            commands::add_workspace,
            commands::update_workspace,
            commands::delete_workspace,
            commands::reorder_workspaces,
            commands::list_apps,
            commands::detect_start_command,
            commands::next_available_port,
            commands::add_app,
            commands::update_app,
            commands::delete_app,
            commands::save_file,
            commands::reveal_in_finder,
            commands::open_in_editor,
            commands::start_app,
            commands::stop_app,
            commands::restart_app,
            commands::kill_app,
            commands::kill_port_holder,
            commands::kill_pid,
            commands::get_app_logs,
            commands::mark_app_stopped,
            commands::mark_app_ready,
            commands::export_data,
            commands::import_data,
            commands::list_backups,
            commands::restore_backup,
            commands::export_full_backup,
            commands::import_full_backup,
            commands::get_porta_env,
            commands::get_notifications_enabled,
            commands::set_notifications_enabled,
            commands::caddy_status,
            commands::list_available_commands,
            commands::check_kamal,
            commands::kamal_run,
            commands::install_kamal,
            commands::parse_kamal_accessories,
            commands::add_deploy_custom_cmd,
            commands::update_deploy_custom_cmd,
            commands::delete_deploy_custom_cmd,
            commands::regenerate_certs,
            commands::terminal_open,
            commands::terminal_write,
            commands::terminal_resize,
            commands::terminal_close,
            commands::list_services,
            commands::add_service,
            commands::update_service,
            commands::delete_service,
            commands::reorder_services,
            commands::start_service,
            commands::stop_service,
            commands::check_cloudflared,
            commands::start_tunnel,
            commands::stop_tunnel,
            commands::get_launch_at_login,
            commands::set_launch_at_login,
            commands::git_sync_check,
            commands::git_sync_get_repo,
            commands::git_sync_set_repo,
            commands::git_sync_test,
            commands::git_sync_push,
            commands::git_sync_pull,
            commands::git_sync_disconnect,
            commands::check_port_available,
            commands::check_app_health,
            commands::check_all_health,
            commands::start_workspace_apps,
            commands::stop_workspace_apps,
            commands::parse_docker_compose,
            commands::export_porta_config,
            commands::import_porta_config,
        ])
        .on_window_event(|window, event| {
            use std::sync::OnceLock;
            use std::time::{Duration, Instant};

            static DEBOUNCE_HANDLE: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();

            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    // Save final state before hiding
                    save_window_state(window);
                    // Hide instead of quit — tray keeps the app alive
                    api.prevent_close();
                    let _ = window.hide();
                }
                tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
                    // Debounce: schedule a save 500ms after the last move/resize event
                    let mutex = DEBOUNCE_HANDLE.get_or_init(|| Mutex::new(None));
                    let now = Instant::now();
                    if let Ok(mut last) = mutex.lock() {
                        *last = Some(now);
                    }
                    let win = window.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_millis(500));
                        let should_save = mutex
                            .lock()
                            .ok()
                            .and_then(|g| *g)
                            .map(|t| now >= t) // only save if no newer event arrived
                            .unwrap_or(false);
                        if should_save {
                            save_window_state(&win);
                        }
                    });
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                app.state::<AppState>().processes.stop_all();
            }
        });
}
