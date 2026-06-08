//! Native macOS application menu (the bar next to the Apple logo).
//!
//! Tauri installs a sensible default menu, but a default menu can't be
//! extended — so to put "Check for Updates…" under "About" we replace it with
//! our own. Replacing the menu means we are responsible for re-creating the
//! standard **Edit** (cut/copy/paste/select-all) and **Window** submenus too;
//! without them, those shortcuts stop working inside the webview (terminal &
//! text inputs would lose ⌘C/⌘V).
//!
//! The menu handler can't call the updater directly — the update lifecycle
//! lives in the frontend (`src/lib/updater.ts`, which drives the JS
//! `plugin-updater`). So menu clicks just focus the window and emit an event
//! the webview listens for.

use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager};

pub fn setup_app_menu(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let check_updates =
        MenuItem::with_id(app, "check-updates", "Check for Updates…", true, None::<&str>)?;
    let settings =
        MenuItem::with_id(app, "open-settings", "Settings…", true, Some("CmdOrCtrl+,"))?;

    // App submenu — "Check for Updates…" sits directly under About, as asked.
    let app_menu = Submenu::with_items(
        app,
        "Porta",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("About Porta"), Some(AboutMetadata::default()))?,
            &check_updates,
            &PredefinedMenuItem::separator(app)?,
            &settings,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    // Edit submenu — re-created so copy/paste/select-all keep working.
    //
    // Undo/Redo are deliberately OMITTED: the predefined items own the ⌘Z / ⌘⇧Z
    // key equivalents, and macOS routes those through the menu (the native
    // `undo:` action) *before* the keystroke ever reaches the webview. That
    // swallows ⌘Z so our JS editors never see it — and the native action is
    // useless for React-controlled inputs anyway. Dropping them lets ⌘Z fall
    // through to the webview, where CodeMirror and the env editor handle history
    // themselves. Plain text fields keep WebKit's built-in ⌘Z.
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    // Window submenu — standard macOS window controls.
    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    let menu = Menu::with_items(app, &[&app_menu, &edit_menu, &window_menu])?;
    app.set_menu(menu)?;

    app.on_menu_event(|app: &tauri::AppHandle, event: tauri::menu::MenuEvent| {
        let id = event.id.as_ref();
        if id == "check-updates" || id == "open-settings" {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }
        match id {
            // Manual check — frontend runs it non-silently so "you're up to
            // date" still gives feedback rather than a dead click.
            "check-updates" => {
                let _ = app.emit("menu://check-for-updates", ());
            }
            "open-settings" => {
                let _ = app.emit("menu://open-settings", ());
            }
            _ => {}
        }
    });

    Ok(())
}
