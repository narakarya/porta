use tauri::{Emitter, Manager, State};

use crate::app_state::AppState;
use crate::db::models::Route;
use crate::setup::SetupStatus;

/// Called once on startup. If Caddy is already running with the old broadcast
/// include filter ("http.log.access" without a per-app sub-logger suffix), all
/// access logs contain mixed cross-app data and must be wiped before we push
/// the new per-app config.
pub fn startup_caddy_sync(app: &tauri::AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        if !state.caddy.is_running() {
            return;
        }
        if caddy_has_legacy_broadcast_log_config() {
            // Wipe all access logs — they contain mixed cross-app data from the
            // old broadcast include filter.
            let log_dir = crate::porta_dir().join("access-logs");
            if let Ok(entries) = std::fs::read_dir(&log_dir) {
                for entry in entries.flatten() {
                    let p = entry.path();
                    if p.extension().is_some_and(|e| e == "log") {
                        let _ = std::fs::write(&p, "");
                    }
                }
            }
        }
        sync_caddy(&state).ok();
    });
}

/// Returns true when the live Caddy config still uses the old broadcast include
/// pattern (`"http.log.access"` without a per-app sub-logger suffix).
fn caddy_has_legacy_broadcast_log_config() -> bool {
    let Ok(resp) = reqwest::blocking::Client::new()
        .get(format!(
            "http://{}/config/logging/logs",
            crate::caddy::CaddyProfile::current().admin
        ))
        .timeout(std::time::Duration::from_secs(3))
        .send()
    else {
        return false;
    };
    let Ok(text) = resp.text() else { return false };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return false;
    };
    let Some(obj) = v.as_object() else { return false };
    for (_, logger) in obj {
        if let Some(includes) = logger.get("include").and_then(|i| i.as_array()) {
            for inc in includes {
                if inc.as_str() == Some("http.log.access") {
                    return true;
                }
            }
        }
    }
    false
}

/// Collect all unique domains that need SSL certs: workspace domains + app custom domains.
fn all_domains(state: &AppState) -> Result<Vec<String>, String> {
    let db = state.db.lock().unwrap();
    let mut domains: Vec<String> = db
        .list_workspaces()
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|w| w.domain)
        .collect();
    // Add any app-level custom domains + binding custom domains
    let apps = db.list_apps().map_err(|e| e.to_string())?;
    for app in &apps {
        if let Some(ref cd) = app.custom_domain {
            if !cd.is_empty() && !domains.contains(cd) {
                domains.push(cd.clone());
            }
        }
        for binding in &app.port_bindings {
            if let Some(ref cd) = binding.custom_domain {
                if !cd.is_empty() && !domains.contains(cd) {
                    domains.push(cd.clone());
                }
            }
        }
    }
    Ok(domains)
}

pub(crate) fn sync_caddy(state: &AppState) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    let workspaces = db.list_workspaces().map_err(|e| e.to_string())?;
    let apps = db.list_apps().map_err(|e| e.to_string())?;
    let mut routes: Vec<Route> = apps
        .iter()
        .flat_map(|a| a.all_routes(&workspaces))
        .collect();
    // Append tailnet aliases for static apps currently served via Tailscale —
    // these let Caddy match requests coming in on `<machine>.<tailnet>.ts.net`.
    routes.extend(crate::commands::static_alias_routes(&db));

    // Worktree instances: one reverse-proxy per active instance. Host is
    // <instance.subdomain>.<parent app's effective domain>. Skip "stopped"
    // instances so a crashed/stopped instance's route disappears on next sync.
    for inst in db.list_instances().map_err(|e| e.to_string())? {
        if inst.status == "stopped" {
            continue;
        }
        let Some(app) = apps.iter().find(|a| a.id == inst.app_id) else {
            continue;
        };
        let host = format!("{}.{}", inst.subdomain, app.effective_domain(&workspaces));
        routes.push(Route::ReverseProxy {
            host,
            port: inst.port,
            auth: None,
            app_id: Some(inst.app_id.clone()),
            max_body: app.max_upload_bytes,
        });
    }

    // Collect all domains that need certs (workspace + app custom_domain + binding custom_domains)
    let mut domains: Vec<String> = workspaces.iter().map(|w| w.domain.clone()).collect();
    for app in &apps {
        if let Some(ref cd) = app.custom_domain {
            if !cd.is_empty() && !domains.contains(cd) {
                domains.push(cd.clone());
            }
        }
        for binding in &app.port_bindings {
            if let Some(ref cd) = binding.custom_domain {
                if !cd.is_empty() && !domains.contains(cd) {
                    domains.push(cd.clone());
                }
            }
        }
    }
    drop(db);

    // Regenerate certs if mkcert is available — ensures new custom domains get covered
    if crate::setup::certs_exist() {
        crate::setup::generate_certs(&domains).ok();
    }

    state.caddy.reload(&routes).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn check_setup() -> SetupStatus {
    crate::setup::check()
}

/// Silently try to start Caddy without running the full wizard.
/// Runs on a background thread so the UI doesn't freeze during the wait.
#[tauri::command]
pub async fn start_caddy(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::setup::start_caddy(&|_| {}).map_err(|e| e.to_string())?;
        let state = app.state::<AppState>();
        sync_caddy(&state).ok();
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Runs the full setup wizard on a background thread so the WebView stays
/// responsive — otherwise the multi-minute Homebrew installs block the main
/// thread and the `setup:step` / `setup:log` events never paint until the end.
#[tauri::command]
pub async fn run_setup(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let domains = all_domains(&state)?;
        crate::setup::run_full_setup(
            &domains,
            &|step_key| { app.emit("setup:step", step_key).ok(); },
            &|line|     { app.emit("setup:log",  line).ok(); },
        )
        .map_err(|e| e.to_string())?;
        sync_caddy(&state).ok();
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Returns whether Caddy is currently running (listens on 443).
#[tauri::command]
pub fn caddy_status() -> bool {
    crate::setup::check().caddy_running
}

/// Public Tauri command — lets the frontend trigger a Caddy config reload.
#[tauri::command]
pub fn reload_caddy(state: State<AppState>) -> Result<(), String> {
    sync_caddy(&state)
}

/// Re-generate wildcard SSL certificates for all workspace domains.
#[tauri::command]
pub fn regenerate_certs(state: State<AppState>) -> Result<(), String> {
    let domains = all_domains(&state)?;
    crate::setup::generate_certs(&domains).map_err(|e| e.to_string())?;
    sync_caddy(&state).ok();
    Ok(())
}
