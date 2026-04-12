pub mod auto_detect;
pub mod backup;
pub mod caddy;
pub mod commands;
pub mod db;
pub mod dns;
pub mod port_scanner;
pub mod process_manager;
pub mod setup;

use std::sync::Mutex;
use nix::sys::signal::kill;
use nix::unistd::Pid;

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};
use tauri_plugin_autostart::MacosLauncher;

use caddy::CaddyManager;
use commands::AppState;
use db::Database;
use process_manager::ProcessManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let db_path = {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
        std::path::PathBuf::from(home).join(".porta").join("porta.db")
    };

    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent).expect("failed to create ~/.porta");
    }

    let db = Database::open(db_path.clone()).expect("failed to open database");

    // Mark apps as stopped if their recorded PID is no longer alive.
    // This fixes stale "running" state after Porta crashes or is force-quit.
    if let Ok(apps) = db.list_apps() {
        for app in apps.iter().filter(|a| a.status == "running") {
            let alive = app.pid.map_or(false, |pid| {
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
            let show =
                MenuItem::with_id(app, "show", "Open Dashboard", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Porta", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(app, &[&show, &sep, &quit])?;

            TrayIconBuilder::with_id("porta-main")
                .menu(&menu)
                .icon(app.default_window_icon().unwrap().clone())
                .on_menu_event(|app: &tauri::AppHandle, event: tauri::menu::MenuEvent| {
                    let id = event.id.as_ref();
                    if id == "show" {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    } else if id == "quit" {
                        app.state::<AppState>().processes.stop_all();
                        app.exit(0);
                    } else if let Some(app_id) = id.strip_prefix("toggle-") {
                        let app_id = app_id.to_string();
                        let handle = app.clone();
                        let db_path = app.state::<AppState>().db_path.clone();
                        std::thread::spawn(move || {
                            // Read current status from a fresh DB connection
                            let Ok(db) = crate::db::Database::open(db_path.clone()) else { return };
                            let Ok(apps) = db.list_apps() else { return };
                            let Some(app_data) = apps.iter().find(|a| a.id == app_id).cloned() else { return };

                            if app_data.status == "running" {
                                let state = handle.state::<AppState>();
                                state.processes.stop(&app_id).ok();
                                state.db.lock().unwrap().update_app_status(&app_id, "stopped", None).ok();
                                handle.emit(&format!("app:exit:{}", app_id), 0i32).ok();
                            } else {
                                // Can't fully start without app context — show dashboard
                                if let Some(w) = handle.get_webview_window("main") {
                                    let _ = w.show();
                                    let _ = w.set_focus();
                                }
                            }

                            std::thread::sleep(std::time::Duration::from_millis(250));
                            commands::rebuild_tray_menu(&handle, &db_path);
                        });
                    }
                })
                .on_tray_icon_event(|tray: &tauri::tray::TrayIcon, event: TrayIconEvent| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                })
                .build(app)?;

            // Auto-start apps flagged with auto_start = true
            let auto_start_apps = {
                let state = app.state::<AppState>();
                let db = state.db.lock().unwrap();
                db.list_apps()
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|a| a.auto_start && !a.start_command.is_empty())
                    .collect::<Vec<_>>()
            };

            for app_data in auto_start_apps {
                let handle = app.handle().clone();
                let state = app.state::<AppState>();

                let log_id = app_data.id.clone();
                let log_handle = handle.clone();
                let on_log = move |line: String| {
                    log_handle.emit(&format!("app:log:{}", log_id), line).ok();
                };

                let exit_id = app_data.id.clone();
                let exit_handle = handle.clone();
                let exit_name = app_data.name.clone();
                let on_exit = move |code: i32, is_stop: bool| {
                    let reported = if is_stop { 0 } else { code };
                    exit_handle.emit(&format!("app:exit:{}", exit_id), reported).ok();
                    if code != 0 && !is_stop {
                        commands::notify_crash(&exit_handle, &exit_name, code);
                    }
                };

                match state.processes.start(
                    &app_data.id,
                    &app_data.start_command,
                    std::path::Path::new(&app_data.root_dir),
                    app_data.port,
                    app_data.env_file.as_deref(),
                    &app_data.env_vars,
                    false, // truncate_log: Porta boot — preserve previous run logs
                    on_log,
                    on_exit,
                ) {
                    Ok(pid) => {
                        state
                            .db
                            .lock()
                            .unwrap()
                            .update_app_status(&app_data.id, "starting", Some(pid))
                            .ok();
                        commands::spawn_port_watcher(handle.clone(), app_data.id.clone(), app_data.port, app_data.name.clone());
                    }
                    Err(e) => {
                        eprintln!("auto-start failed for {}: {}", app_data.name, e);
                    }
                }
            }

            // Rebuild tray after auto-starting all apps
            let tray_db_path = app.state::<AppState>().db_path.clone();
            let tray_handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(500));
                commands::rebuild_tray_menu(&tray_handle, &tray_db_path);
            });

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
            commands::get_notifications_enabled,
            commands::set_notifications_enabled,
            commands::caddy_status,
            commands::detect_gdrive_path,
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
            commands::set_gdrive_credentials,
            commands::get_gdrive_credentials,
            commands::gdrive_connect,
            commands::gdrive_status,
            commands::gdrive_disconnect,
            commands::gdrive_sync,
            commands::check_cloudflared,
            commands::start_tunnel,
            commands::stop_tunnel,
            commands::get_launch_at_login,
            commands::set_launch_at_login,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Hide instead of quit — tray keeps the app alive
                api.prevent_close();
                let _ = window.hide();
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
