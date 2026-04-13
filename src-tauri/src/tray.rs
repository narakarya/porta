use std::path::Path;

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};

use crate::app_state::AppState;
use crate::db::Database;

/// Rebuild the system tray menu to reflect current app status.
/// Opens a fresh DB connection to avoid holding locks.
pub fn rebuild_tray_menu(app: &tauri::AppHandle, db_path: &Path) {
    let Ok(db) = Database::open(db_path.to_path_buf()) else { return };
    let Ok(workspaces) = db.list_workspaces() else { return };
    let Ok(apps) = db.list_apps() else { return };
    let Some(tray) = app.tray_by_id("porta-main") else { return };

    let Ok(menu) = Menu::new(app) else { return };

    let Ok(show) = MenuItem::with_id(app, "show", "Open Dashboard", true, None::<&str>) else {
        return;
    };
    menu.append(&show).ok();

    if !apps.is_empty() {
        let Ok(sep) = PredefinedMenuItem::separator(app) else { return };
        menu.append(&sep).ok();

        for app_data in &apps {
            let ws_name = workspaces
                .iter()
                .find(|w| Some(&w.id) == app_data.workspace_id.as_ref())
                .map(|w| w.name.as_str())
                .unwrap_or("Global");
            let dot = if app_data.status == "running" { "●" } else { "○" };
            let label = format!("{} {}  [{}]", dot, app_data.name, ws_name);
            if let Ok(item) = MenuItem::with_id(
                app,
                format!("toggle-{}", app_data.id),
                label,
                true,
                None::<&str>,
            ) {
                menu.append(&item).ok();
            }
        }
    }

    let Ok(sep2) = PredefinedMenuItem::separator(app) else { return };
    menu.append(&sep2).ok();
    let Ok(quit) = MenuItem::with_id(app, "quit", "Quit Porta", true, None::<&str>) else {
        return;
    };
    menu.append(&quit).ok();

    tray.set_menu(Some(menu)).ok();
}

/// Set up the system tray icon, menu, and event handlers.
pub fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let show = MenuItem::with_id(app, "show", "Open Dashboard", true, None::<&str>)?;
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
