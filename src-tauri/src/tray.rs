use std::path::Path;

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};

use crate::app_state::AppState;
use crate::db::Database;

pub fn rebuild_tray_menu(app: &tauri::AppHandle, db_path: &Path) {
    let Ok(db) = Database::open(db_path.to_path_buf()) else { return };
    let Ok(workspaces) = db.list_workspaces() else { return };
    let Ok(apps) = db.list_apps() else { return };
    let Some(tray) = app.tray_by_id("porta-main") else { return };

    let Ok(menu) = Menu::new(app) else { return };

    // Header
    let running_count = apps.iter().filter(|a| a.status == "running").count();
    let total = apps.len();
    let header_label = if total == 0 {
        "Porta — No apps".to_string()
    } else {
        format!("Porta — {}/{} running", running_count, total)
    };
    if let Ok(header) = MenuItem::with_id(app, "header", &header_label, false, None::<&str>) {
        menu.append(&header).ok();
    }
    PredefinedMenuItem::separator(app).map(|s| menu.append(&s)).ok();

    // Open Dashboard
    if let Ok(show) = MenuItem::with_id(app, "show", "Open Dashboard", true, Some("CmdOrCtrl+O")) {
        menu.append(&show).ok();
    }
    PredefinedMenuItem::separator(app).map(|s| menu.append(&s)).ok();

    // Quick actions
    let has_stopped = apps.iter().any(|a| a.status == "stopped" && (!a.start_command.is_empty() || a.is_docker() || a.is_compose()));
    let has_running = apps.iter().any(|a| a.status == "running");
    if has_stopped {
        if let Ok(item) = MenuItem::with_id(app, "start-all", "▶ Start All Apps", true, None::<&str>) {
            menu.append(&item).ok();
        }
    }
    if has_running {
        if let Ok(item) = MenuItem::with_id(app, "stop-all", "■ Stop All Apps", true, None::<&str>) {
            menu.append(&item).ok();
        }
    }
    if has_stopped || has_running {
        PredefinedMenuItem::separator(app).map(|s| menu.append(&s)).ok();
    }

    // Apps grouped by workspace
    for ws in &workspaces {
        let ws_apps: Vec<_> = apps.iter().filter(|a| a.workspace_id.as_ref() == Some(&ws.id)).collect();
        if ws_apps.is_empty() { continue; }

        if let Ok(submenu) = Submenu::with_id(app, format!("ws-{}", ws.id), &ws.name, true) {
            for app_data in &ws_apps {
                let dot = if app_data.status == "running" { "🟢" } else { "⚫" };
                let label = format!("{} {} :{}", dot, app_data.name, app_data.port);
                let action = if app_data.status == "running" { "Stop" } else { "Start" };
                if let Ok(item) = MenuItem::with_id(
                    app,
                    format!("toggle-{}", app_data.id),
                    &format!("{} — {}", label, action),
                    true,
                    None::<&str>,
                ) {
                    submenu.append(&item).ok();
                }
            }
            menu.append(&submenu).ok();
        }
    }

    // Standalone apps
    let standalone: Vec<_> = apps.iter().filter(|a| a.workspace_id.is_none()).collect();
    if !standalone.is_empty() {
        if let Ok(submenu) = Submenu::with_id(app, "ws-standalone", "Standalone", true) {
            for app_data in &standalone {
                let dot = if app_data.status == "running" { "🟢" } else { "⚫" };
                let label = format!("{} {} :{}", dot, app_data.name, app_data.port);
                let action = if app_data.status == "running" { "Stop" } else { "Start" };
                if let Ok(item) = MenuItem::with_id(
                    app,
                    format!("toggle-{}", app_data.id),
                    &format!("{} — {}", label, action),
                    true,
                    None::<&str>,
                ) {
                    submenu.append(&item).ok();
                }
            }
            menu.append(&submenu).ok();
        }
    }

    PredefinedMenuItem::separator(app).map(|s| menu.append(&s)).ok();
    if let Ok(quit) = MenuItem::with_id(app, "quit", "Quit Porta", true, Some("CmdOrCtrl+Q")) {
        menu.append(&quit).ok();
    }

    tray.set_menu(Some(menu)).ok();
}

pub fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let show = MenuItem::with_id(app, "show", "Open Dashboard", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Porta", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&show, &sep, &quit])?;

    TrayIconBuilder::with_id("porta-main")
        .tooltip("Porta")
        .menu(&menu)
        .icon(app.default_window_icon().unwrap().clone())
        .on_menu_event(|app: &tauri::AppHandle, event: tauri::menu::MenuEvent| {
            let id = event.id.as_ref();
            if id == "show" || id == "header" {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            } else if id == "quit" {
                app.state::<AppState>().processes.stop_all();
                app.exit(0);
            } else if id == "start-all" {
                let handle = app.clone();
                std::thread::spawn(move || {
                    let state = handle.state::<AppState>();
                    let db = state.db.lock().unwrap();
                    let apps = db.list_apps().unwrap_or_default();
                    drop(db);
                    for app_data in apps.iter().filter(|a| a.status == "stopped" && (!a.start_command.is_empty() || a.is_docker() || a.is_compose())) {
                        crate::commands::app_lifecycle::start_single(&handle, app_data, true).ok();
                    }
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    rebuild_tray_menu(&handle, &state.db_path);
                });
            } else if id == "stop-all" {
                let state = app.state::<AppState>();
                let db = state.db.lock().unwrap();
                let apps = db.list_apps().unwrap_or_default();
                drop(db);
                for app_data in apps.iter().filter(|a| a.status == "running") {
                    if app_data.is_compose() {
                        let root = if app_data.root_dir.is_empty() { None } else { Some(app_data.root_dir.as_str()) };
                        let file = app_data.compose_file.as_deref().unwrap_or("");
                        state.docker.compose_stop(&app_data.id, file, root).ok();
                    } else if app_data.is_docker() {
                        state.docker.stop(&app_data.id).ok();
                    } else {
                        state.processes.stop(&app_data.id).ok();
                    }
                    state.db.lock().unwrap().update_app_status(&app_data.id, "stopped", None).ok();
                    app.emit(&format!("app:exit:{}", app_data.id), 0i32).ok();
                }
                rebuild_tray_menu(app, &state.db_path);
            } else if let Some(app_id) = id.strip_prefix("toggle-") {
                let app_id = app_id.to_string();
                let handle = app.clone();
                let db_path = app.state::<AppState>().db_path.clone();
                std::thread::spawn(move || {
                    let Ok(db) = crate::db::Database::open(db_path.clone()) else { return };
                    let Ok(apps) = db.list_apps() else { return };
                    let Some(app_data) = apps.iter().find(|a| a.id == app_id).cloned() else { return };

                    if app_data.status == "running" {
                        let state = handle.state::<AppState>();
                        if app_data.is_compose() {
                            let root = if app_data.root_dir.is_empty() { None } else { Some(app_data.root_dir.as_str()) };
                            let file = app_data.compose_file.as_deref().unwrap_or("");
                            state.docker.compose_stop(&app_id, file, root).ok();
                        } else if app_data.is_docker() {
                            state.docker.stop(&app_id).ok();
                        } else {
                            state.processes.stop(&app_id).ok();
                        }
                        state.db.lock().unwrap().update_app_status(&app_id, "stopped", None).ok();
                        handle.emit(&format!("app:exit:{}", app_id), 0i32).ok();
                    } else if !app_data.start_command.is_empty() || app_data.is_docker() || app_data.is_compose() {
                        crate::commands::app_lifecycle::start_single(&handle, &app_data, true).ok();
                    }

                    std::thread::sleep(std::time::Duration::from_millis(500));
                    rebuild_tray_menu(&handle, &db_path);
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

    Ok(())
}
