pub mod access_log;
pub mod app_state;
pub mod auto_detect;
pub mod auto_start;
pub mod backup;
pub mod caddy;
pub mod cloudflared_certs;
pub mod commands;
pub mod db;
pub mod dns;
pub mod extensions;
pub mod port_check;
pub mod port_scanner;
pub mod process_manager;
pub mod docker_manager;
pub mod compose_parser;
pub mod health;
pub mod idle_sleep;
pub mod log_rotation;
pub mod porta_config;
pub mod menu;
pub mod metrics;
pub mod setup;
pub mod ssh;
pub mod tray;
pub mod wake_server;

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

    let docker_mgr = docker_manager::DockerManager::new();

    // Mark apps as stopped if their recorded PID/container is no longer alive.
    // This fixes stale "running" state after Porta crashes or is force-quit.
    // For docker apps whose containers are still running, adopt them so stop/metrics work.
    if let Ok(apps) = db.list_apps() {
        for app in apps.iter().filter(|a| a.status == "running") {
            let alive = if app.is_compose() {
                // Any container still running under this compose project means it's alive.
                let project = docker_manager::DockerManager::compose_project(&app.id);
                std::process::Command::new(docker_manager::docker_bin())
                    .args(["ps", "-q", "-f", &format!("label=com.docker.compose.project={}", project)])
                    .output()
                    .ok()
                    .map(|o| !o.stdout.is_empty())
                    .unwrap_or(false)
            } else if app.is_static() || app.is_proxy() {
                // No process to check — Caddy serves these as long as it's up.
                // Keep them flagged "running" across Porta restarts.
                true
            } else if app.is_docker() {
                let name = docker_manager::DockerManager::container_name(&app.id);
                std::process::Command::new(docker_manager::docker_bin())
                    .args(["inspect", "-f", "{{.State.Running}}", &name])
                    .output()
                    .ok()
                    .and_then(|o| {
                        if o.status.success() {
                            Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
                        } else {
                            None
                        }
                    })
                    .map(|s| s == "true")
                    .unwrap_or(false)
            } else {
                app.pid.is_some_and(|pid| {
                    kill(Pid::from_raw(pid as i32), None).is_ok()
                })
            };
            if alive {
                if app.is_docker() || app.is_compose() {
                    docker_mgr.adopt(&app.id);
                }
            } else {
                db.update_app_status(&app.id, "stopped", None).ok();
            }
        }
    }

    // Worktree instances are plain child processes that never survive a Porta
    // restart, so any row still flagged "running"/"starting" is stale. Mark them
    // "stopped"; the boot-time startup_caddy_sync then rebuilds Caddy without
    // their routes (sync_caddy skips "stopped" instances).
    if let Ok(instances) = db.list_instances() {
        for inst in instances
            .iter()
            .filter(|i| i.status == "running" || i.status == "starting")
        {
            db.update_instance_status_only(&inst.id, "stopped").ok();
        }
    }

    // Re-hydrate Tailscale Serve tracking from tailscaled so Disconnect works
    // after a Porta restart. No-op if tailscale isn't installed/running.
    commands::reconcile_on_startup(&db);

    let state = AppState {
        db: Mutex::new(db),
        processes: ProcessManager::new(),
        docker: docker_mgr,
        caddy: CaddyManager::new(),
        db_path: db_path.clone(),
        extensions: Mutex::new(vec![]),
        lifecycle_locks: Mutex::new(std::collections::HashMap::new()),
        instance_alloc_lock: Mutex::new(()),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(state)
        .manage(commands::container_observe::LogStreams::default())
        .manage(commands::access_log::AccessLogStreams::default())
        .manage(commands::remote::RemoteLogStreams::default())
        .setup(|app| {
            if let Some(w) = app.get_webview_window("main") {
                restore_window_state(&w);
            }
            tray::setup_tray(app)?;
            menu::setup_app_menu(app)?;
            auto_start::spawn_auto_start(app);
            metrics::spawn_metrics_poller(app.handle().clone());
            commands::spawn_git_poller(app.handle().clone());
            commands::spawn_tailscale_poller(app.handle().clone());
            commands::spawn_backup_scheduler(app.handle().clone());
            commands::spawn_log_rotation_task();
            // Transparent wake-on-request server + idle watcher for auto-sleep apps.
            wake_server::spawn(app.handle().clone());
            idle_sleep::spawn_idle_watcher(app.handle().clone());
            commands::startup_caddy_sync(app.handle());
            // Load installed extensions into AppState
            {
                let s = app.state::<AppState>();
                let db = s.db.lock().unwrap();
                extensions::loader::startup_load_extensions(&s.extensions, &db);
            }
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
            commands::set_app_auto_sleep,
            commands::set_app_max_upload_bytes,
            commands::delete_app,
            commands::save_file,
            commands::reveal_in_finder,
            commands::open_external_url,
            commands::open_in_editor,
            commands::list_app_config_files,
            commands::read_config_file,
            commands::write_config_file,
            commands::create_config_from_template,
            commands::git_status,
            commands::git_fetch,
            commands::git_pull,
            commands::git_push,
            commands::git_branches,
            commands::git_switch_branch,
            commands::get_git_autofetch_enabled,
            commands::set_git_autofetch_enabled,
            commands::get_git_autofetch_interval_secs,
            commands::set_git_autofetch_interval_secs,
            commands::git_worktree_list,
            commands::list_instances,
            commands::start_instance,
            commands::stop_instance,
            commands::kill_instance,
            commands::remove_instance,
            commands::start_app,
            commands::stop_app,
            commands::restart_app,
            commands::kill_app,
            commands::kill_port_holder,
            commands::kill_pid,
            commands::get_app_logs,
            commands::mark_app_stopped,
            commands::mark_app_ready,
            commands::list_backups,
            commands::restore_backup,
            commands::export_full_backup,
            commands::import_full_backup,
            commands::get_porta_env,
            commands::get_backup_schedule,
            commands::set_backup_schedule,
            commands::next_backup_at,
            commands::run_backup_now_via_schedule,
            commands::get_notifications_enabled,
            commands::set_notifications_enabled,
            commands::get_notification_permission_state,
            commands::request_notification_permission_access,
            commands::send_test_notification,
            commands::get_image_update_notify_enabled,
            commands::set_image_update_notify_enabled,
            commands::notify_image_updates_found,
            commands::get_cf_api_token,
            commands::set_cf_api_token,
            commands::caddy_status,
            commands::list_available_commands,
            commands::detect_app_tags,
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
            commands::list_service_templates,
            commands::save_service_template,
            commands::delete_service_template,
            commands::check_cloudflared,
            commands::list_cloudflare_tunnels,
            commands::create_cloudflare_tunnel,
            commands::delete_cloudflare_tunnel,
            commands::route_tunnel_dns,
            commands::list_tunnel_dns,
            commands::cf_access_get_app,
            commands::cf_access_list_apps,
            commands::cf_access_protect,
            commands::cf_access_unprotect,
            commands::cf_dns_list_zones,
            commands::cf_dns_list_records,
            commands::cf_dns_create_record,
            commands::cf_dns_update_record,
            commands::cf_dns_delete_record,
            commands::cf_dns_diff_zone_vs_local,
            commands::tunnel_metrics,
            commands::cf_zone_get_settings,
            commands::cf_zone_set_setting,
            commands::cf_zone_purge_all,
            commands::cf_zone_purge_hosts,
            commands::cf_zone_purge_files,
            commands::cf_email_routing_status,
            commands::cf_email_routing_enable,
            commands::cf_email_list_addresses,
            commands::cf_email_create_address,
            commands::cf_email_delete_address,
            commands::cf_email_list_rules,
            commands::cf_email_create_rule,
            commands::cf_email_delete_rule,
            commands::cf_email_set_catchall,
            commands::list_cloudflare_zone_certs,
            commands::import_cloudflare_zone_cert,
            commands::delete_cloudflare_zone_cert,
            commands::preview_zone_for_hostname,
            commands::set_tunnel_config,
            commands::start_tunnel,
            commands::stop_tunnel,
            commands::start_instance_tunnel,
            commands::stop_instance_tunnel,
            commands::check_tailscale,
            commands::tailscale_status,
            commands::list_tailscale_serves,
            commands::start_tailscale_serve,
            commands::stop_tailscale_serve,
            commands::reset_tailscale_serves,
            commands::stop_all_porta_tailscale_serves,
            commands::check_tunnel_reachable,
            commands::list_remote_hosts,
            commands::add_remote_host,
            commands::update_remote_host,
            commands::delete_remote_host,
            commands::test_remote_host,
            commands::list_remote_routes,
            commands::expose_remote,
            commands::unexpose_remote,
            commands::wg_status,
            commands::remote_diff,
            commands::remote_push_host,
            commands::remote_remove_foreign,
            commands::remote_log_tail,
            commands::remote_log_live_start,
            commands::remote_log_live_stop,
            commands::get_launch_at_login,
            commands::set_launch_at_login,
            commands::check_port_available,
            commands::find_free_port,
            commands::who_uses_port,
            commands::suggest_alternative_port,
            commands::apply_port_change,
            commands::check_app_health,
            commands::check_all_health,
            commands::get_app_health_probe,
            commands::set_app_health_probe,
            commands::clear_app_health_probe,
            commands::run_app_health_probe,
            commands::start_workspace_apps,
            commands::stop_workspace_apps,
            commands::parse_docker_compose,
            commands::parse_compose_string,
            commands::save_compose_yaml,
            commands::load_compose_yaml,
            commands::update_compose_image_tag,
            commands::update_compose_image_for,
            commands::check_app_image_updates,
            commands::update_app_images,
            commands::classify_image_update,
            commands::list_app_volume_snapshots,
            commands::delete_app_volume_snapshot,
            commands::system_disk_usage,
            commands::list_docker_images,
            commands::app_disk_usage,
            commands::prune_dangling_images,
            commands::prune_unused_images,
            commands::prune_app_old_images,
            commands::export_porta_config,
            commands::import_porta_config,
            commands::containers_for_app,
            commands::container_stats,
            commands::start_container_logs,
            commands::stop_container_logs,
            commands::app_logs_disk_usage,
            commands::rotate_app_logs,
            commands::clear_app_log_file,
            commands::clear_all_app_logs,
            commands::get_max_log_bytes,
            commands::set_max_log_bytes,
            commands::get_default_max_upload_bytes,
            commands::set_default_max_upload_bytes,
            commands::tail_access_log,
            commands::clear_access_log,
            commands::live_access_log_start,
            commands::live_access_log_stop,
            // Extensions
            commands::list_extensions,
            commands::get_extensions_for_app,
            commands::rescan_extensions,
            commands::install_extension_from_folder,
            commands::install_extension_from_github,
            commands::update_extension,
            commands::set_extension_enabled_cmd,
            commands::set_extension_source_cmd,
            commands::uninstall_extension_cmd,
            commands::extension_shell_run,
            commands::extension_shell_spawn,
            commands::extension_storage_get,
            commands::extension_storage_set,
            commands::extension_storage_remove,
            commands::extension_storage_keys,
            commands::read_extension_file,
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
                let state = app.state::<AppState>();
                state.processes.stop_all();
                state.docker.stop_all();
            }
        });
}
