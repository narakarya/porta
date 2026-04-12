pub mod auto_detect;
pub mod backup;
pub mod caddy;
pub mod commands;
pub mod db;
pub mod dns;
pub mod port_scanner;
pub mod process_manager;
pub mod settings;
pub mod setup;

use std::sync::Mutex;
use nix::sys::signal::kill;
use nix::unistd::Pid;

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    Manager,
};

use caddy::CaddyManager;
use commands::AppState;
use db::Database;
use process_manager::ProcessManager;
use settings::Settings;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let db_path = {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
        std::path::PathBuf::from(home).join(".porta").join("porta.db")
    };

    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent).expect("failed to create ~/.porta");
    }

    let settings_path = db_path.parent().unwrap().join("settings.json");
    let loaded_settings = Settings::load(&settings_path);

    let db = Database::open(db_path.clone()).expect("failed to open database");

    // Mark apps as stopped if their recorded PID is no longer alive.
    if let Ok(apps) = db.list_apps() {
        for app in apps.iter().filter(|a| a.status == "running") {
            let alive = app.pid.map_or(false, |pid| {
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
        settings: Mutex::new(loaded_settings),
        settings_path,
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .setup(|app| {
            let show =
                MenuItem::with_id(app, "show", "Open Dashboard", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Porta", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(app, &[&show, &sep, &quit])?;

            TrayIconBuilder::new()
                .menu(&menu)
                .icon(app.default_window_icon().unwrap().clone())
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => {
                        app.state::<AppState>().processes.stop_all();
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
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
            let auto_start_ids: Vec<String> = {
                let state = app.state::<AppState>();
                let db = state.db.lock().unwrap();
                db.list_apps()
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|a| a.auto_start && !a.start_command.is_empty())
                    .map(|a| a.id)
                    .collect()
            };

            for id in auto_start_ids {
                let handle = app.handle().clone();
                // Remove from stopping set in case of stale state
                app.state::<AppState>().processes.stopping.lock().unwrap().remove(&id);
                if let Err(e) = commands::start_app_internal(handle, id.clone(), 0) {
                    eprintln!("auto-start failed for {}: {}", id, e);
                }
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
            commands::list_apps,
            commands::detect_start_command,
            commands::next_available_port,
            commands::add_app,
            commands::update_app,
            commands::delete_app,
            commands::save_file,
            commands::reveal_in_finder,
            commands::open_in_editor,
            commands::open_in_terminal,
            commands::start_app,
            commands::stop_app,
            commands::kill_app,
            commands::kill_port_holder,
            commands::kill_pid,
            commands::mark_app_stopped,
            commands::mark_app_ready,
            commands::get_notifications_enabled,
            commands::set_notifications_enabled,
            commands::export_data,
            commands::import_data,
            commands::list_backups,
            commands::restore_backup,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
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
