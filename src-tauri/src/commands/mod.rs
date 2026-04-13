use std::path::Path;

use crate::db::Database;

pub use crate::app_state::AppState;

mod terminal;
pub use terminal::*;

mod settings;
pub use settings::*;

mod gdrive;
pub use gdrive::*;

mod deploy;
pub use deploy::*;

mod tunnel;
pub use tunnel::*;

mod service;
pub use service::*;

mod setup;
pub use setup::*;

mod workspace;
pub use workspace::*;

mod app_files;
pub use app_files::*;

mod backup;
pub use backup::*;

mod app_lifecycle;
pub use app_lifecycle::*;

mod app;
pub use app::*;

// ── Dynamic tray menu (per-app start/stop) ────────────────────────────────────

/// Rebuild the system tray menu to reflect current app status.
/// Opens a fresh DB connection to avoid holding locks.
pub fn rebuild_tray_menu(app: &tauri::AppHandle, db_path: &Path) {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};

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
