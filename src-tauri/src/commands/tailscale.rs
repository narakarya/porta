use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

use crate::app_state::AppState;
use crate::db::{Database, models::Route};

/// Per-app assigned tailnet HTTPS port so repeated start/stop is idempotent and
/// disambiguates multiple apps served on the same host. Not persisted — we
/// reconcile against `tailscale serve status` at runtime.
fn active_serves() -> &'static Mutex<HashMap<String, u16>> {
    static T: OnceLock<Mutex<HashMap<String, u16>>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Per-static-app runtime alias: maps app_id → tailnet hostname. Injected into
/// Caddy routes as additional FileServer hosts so static apps respond correctly
/// when reached via their ts.net URL (Tailscale Serve can't rewrite Host header,
/// so Caddy must match the tailnet hostname directly).
fn static_aliases() -> &'static Mutex<HashMap<String, String>> {
    static T: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Build extra Caddy routes for each static app currently served via Tailscale.
/// Called from sync_caddy so the tailnet hostnames get matched alongside normal
/// .test routes. Non-static apps don't need this — their Tailscale Serve points
/// directly at the app's local port, bypassing Caddy.
pub fn static_alias_routes(db: &Database) -> Vec<Route> {
    let apps = match db.list_apps() {
        Ok(a) => a,
        Err(_) => return Vec::new(),
    };
    let aliases = static_aliases().lock().unwrap();
    let mut out = Vec::new();
    for (app_id, host) in aliases.iter() {
        if let Some(app) = apps.iter().find(|a| &a.id == app_id) {
            if app.is_static() {
                out.push(Route::FileServer {
                    host: host.clone(),
                    root: app.root_dir.clone(),
                });
            }
        }
    }
    out
}

/// Re-hydrate `active_serves` from the tailscaled daemon on Porta startup.
/// Matches existing serve entries (by upstream port) to apps so Disconnect
/// works without requiring a fresh start_tailscale_serve call first.
pub fn reconcile_on_startup(db: &Database) {
    let Some(ts) = find_tailscale() else { return; };
    let Ok(out) = std::process::Command::new(&ts).args(["serve", "status", "--json"]).output() else { return; };
    let Ok(value): Result<serde_json::Value, _> = serde_json::from_slice(&out.stdout) else { return; };
    let Some(web) = value.get("Web").and_then(|w| w.as_object()) else { return; };
    let Ok(apps) = db.list_apps() else { return; };

    for (host_port, cfg) in web {
        let ts_port: u16 = match host_port.rsplit(':').next().and_then(|p| p.parse().ok()) {
            Some(p) => p,
            None => continue,
        };
        let upstream = cfg.get("Handlers").and_then(|h| h.get("/")).and_then(|h| h.get("Proxy")).and_then(|s| s.as_str()).unwrap_or("");
        // Extract upstream port from URLs like "http://127.0.0.1:3000" or "https+insecure://localhost:443".
        let upstream_port: Option<u16> = upstream.rsplit(':').next().and_then(|p| p.split('/').next()).and_then(|p| p.parse().ok());
        // Match: either the serve port matches app.port (non-static), or upstream is 443/80 (static, goes to Caddy).
        for app in &apps {
            let is_match = if app.is_static() {
                // Static apps route through Caddy — port match is on ts_port == assign_tailnet_port(app.port).
                ts_port == assign_tailnet_port(app.port) && (upstream_port == Some(443) || upstream_port == Some(80))
            } else {
                upstream_port == Some(app.port) && ts_port == assign_tailnet_port(app.port)
            };
            if is_match {
                active_serves().lock().unwrap().insert(app.id.clone(), ts_port);
            }
        }
    }
}

fn find_tailscale() -> Option<String> {
    // Prefer the App Store / GUI path since its bundled CLI often isn't on PATH.
    for p in &[
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        "/opt/homebrew/bin/tailscale",
        "/usr/local/bin/tailscale",
        "/usr/bin/tailscale",
    ] {
        if std::path::Path::new(p).exists() {
            return Some(p.to_string());
        }
    }
    if let Ok(out) = std::process::Command::new("which").arg("tailscale").output() {
        if out.status.success() {
            let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !path.is_empty() {
                return Some(path);
            }
        }
    }
    None
}

#[tauri::command]
pub fn check_tailscale() -> bool {
    find_tailscale().is_some()
}

#[derive(Debug, Serialize)]
pub struct TailscaleStatus {
    pub installed: bool,
    pub running: bool,
    pub logged_in: bool,
    /// Tailnet hostname (e.g. "my-mac.tail-1234.ts.net"), trimmed of trailing dot.
    pub host: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TsStatusJson {
    #[serde(default)]
    #[serde(rename = "BackendState")]
    backend_state: String,
    #[serde(default, rename = "Self")]
    self_node: Option<TsSelfJson>,
}

#[derive(Debug, Deserialize)]
struct TsSelfJson {
    #[serde(default, rename = "DNSName")]
    dns_name: String,
    #[serde(default, rename = "UserID")]
    user_id: i64,
}

#[tauri::command]
pub fn tailscale_status() -> TailscaleStatus {
    let ts = match find_tailscale() {
        Some(p) => p,
        None => return TailscaleStatus {
            installed: false,
            running: false,
            logged_in: false,
            host: None,
            error: None,
        },
    };

    let out = match std::process::Command::new(&ts)
        .args(["status", "--json"])
        .output()
    {
        Ok(o) => o,
        Err(e) => return TailscaleStatus {
            installed: true, running: false, logged_in: false, host: None,
            error: Some(e.to_string()),
        },
    };

    // tailscale prints warnings to stderr and JSON to stdout even when daemon
    // is stopped, so we try to parse first before deciding success.
    let parsed: Result<TsStatusJson, _> = serde_json::from_slice(&out.stdout);
    let Ok(s) = parsed else {
        return TailscaleStatus {
            installed: true,
            running: false,
            logged_in: false,
            host: None,
            error: Some(String::from_utf8_lossy(&out.stderr).trim().to_string()),
        };
    };

    let running = s.backend_state == "Running";
    let logged_in = s.self_node.as_ref().map(|n| n.user_id != 0).unwrap_or(false);
    let host = s.self_node.as_ref().and_then(|n| {
        if n.dns_name.is_empty() { None } else { Some(n.dns_name.trim_end_matches('.').to_string()) }
    });

    TailscaleStatus {
        installed: true,
        running,
        logged_in,
        host,
        error: None,
    }
}

#[derive(Debug, Serialize)]
pub struct TailscaleServeEntry {
    pub port: u16,
    pub upstream: String,
}

#[tauri::command]
pub fn list_tailscale_serves() -> Result<Vec<TailscaleServeEntry>, String> {
    let ts = find_tailscale().ok_or_else(|| "tailscale not installed".to_string())?;
    let out = std::process::Command::new(&ts)
        .args(["serve", "status", "--json"])
        .output()
        .map_err(|e| e.to_string())?;
    // Empty config returns non-zero on older versions; treat JSON parse success as authoritative.
    let value: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap_or(serde_json::Value::Null);
    let mut entries = Vec::new();
    if let Some(web) = value.get("Web").and_then(|w| w.as_object()) {
        for (host_port, cfg) in web {
            // host_port shape: "<host>:<port>"
            let port: u16 = host_port.rsplit(':').next()
                .and_then(|p| p.parse().ok())
                .unwrap_or(0);
            let upstream = cfg.get("Handlers")
                .and_then(|h| h.get("/"))
                .and_then(|h| h.get("Proxy"))
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_string();
            entries.push(TailscaleServeEntry { port, upstream });
        }
    }
    Ok(entries)
}

/// Pick an HTTPS port for a given app. We mirror the app's local port so the
/// mapping is memorable (localhost:3000 → tailnet :3000). Ports 443, 8443, 10000
/// are Tailscale's "blessed" HTTPS ports but recent versions accept any port.
fn assign_tailnet_port(app_port: u16) -> u16 {
    app_port
}

#[tauri::command]
pub fn start_tailscale_serve(id: String, port: u16, app_handle: tauri::AppHandle) -> Result<(), String> {
    let ts = find_tailscale().ok_or_else(|| "tailscale not installed".to_string())?;

    // Resolve tailnet hostname upfront — we need it both for the final URL and,
    // for static apps, for the Caddy alias route.
    let status = tailscale_status();
    let tailnet_host = match status.host.as_ref() {
        Some(h) => h.clone(),
        None => {
            let msg = "Tailscale is not running or not logged in. Run `tailscale up` first.".to_string();
            app_handle
                .emit(
                    &format!("app:tunnel:{}", id),
                    serde_json::json!({ "active": false, "url": null, "error": msg.clone() }),
                )
                .ok();
            return Err(msg);
        }
    };

    let is_static_app = {
        let state = app_handle.state::<AppState>();
        let db = state.db.lock().unwrap();
        db.list_apps().ok()
            .and_then(|apps| apps.into_iter().find(|a| a.id == id))
            .map(|a| a.is_static())
            .unwrap_or(false)
    };

    let tailnet_port = assign_tailnet_port(port);

    // For static apps: register the tailnet hostname with Caddy first, then
    // point Tailscale Serve at Caddy. Tailscale Serve doesn't rewrite Host
    // header, so Caddy must match on the ts.net hostname directly.
    let upstream = if is_static_app {
        static_aliases().lock().unwrap().insert(id.clone(), tailnet_host.clone());
        let state = app_handle.state::<AppState>();
        if let Err(e) = crate::commands::sync_caddy(&state) {
            // Rollback alias on caddy sync failure.
            static_aliases().lock().unwrap().remove(&id);
            app_handle
                .emit(
                    &format!("app:tunnel:{}", id),
                    serde_json::json!({ "active": false, "url": null, "error": e.clone() }),
                )
                .ok();
            return Err(e);
        }
        if crate::setup::certs_exist() {
            "https+insecure://localhost:443".to_string()
        } else {
            "http://localhost:80".to_string()
        }
    } else {
        format!("http://localhost:{}", port)
    };

    // Apply the serve config. `--bg` persists it in the tailscaled daemon.
    let out = std::process::Command::new(&ts)
        .args([
            "serve",
            "--bg",
            "--https",
            &tailnet_port.to_string(),
            "--set-path",
            "/",
            &upstream,
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let err_text = if !stderr.is_empty() { stderr } else { stdout };
        let hint = if err_text.contains("not logged in") || err_text.contains("NeedsLogin") {
            format!("{}\n\nRun `tailscale login` to authenticate.", err_text)
        } else if err_text.contains("daemon") {
            format!("{}\n\nStart the Tailscale app or run `tailscale up`.", err_text)
        } else {
            err_text
        };
        // Roll back static alias if we added one.
        if is_static_app {
            static_aliases().lock().unwrap().remove(&id);
            let state = app_handle.state::<AppState>();
            let _ = crate::commands::sync_caddy(&state);
        }
        app_handle
            .emit(
                &format!("app:tunnel:{}", id),
                serde_json::json!({ "active": false, "url": null, "error": hint.clone() }),
            )
            .ok();
        return Err(hint);
    }

    let url = if tailnet_port == 443 {
        format!("https://{}", tailnet_host)
    } else {
        format!("https://{}:{}", tailnet_host, tailnet_port)
    };

    active_serves().lock().unwrap().insert(id.clone(), tailnet_port);

    app_handle
        .emit(
            &format!("app:tunnel:{}", id),
            serde_json::json!({ "active": true, "url": url }),
        )
        .ok();

    Ok(())
}

#[tauri::command]
pub fn stop_tailscale_serve(id: String, app_handle: tauri::AppHandle) -> Result<(), String> {
    let ts = find_tailscale().ok_or_else(|| "tailscale not installed".to_string())?;

    let port = active_serves().lock().unwrap().remove(&id);
    // If we don't have a tracked port (e.g. app was started in a previous Porta
    // session), fall back to the app's local port — that's what we'd have assigned.
    let tailnet_port = match port {
        Some(p) => p,
        None => {
            let state = app_handle.state::<AppState>();
            let db = state.db.lock().unwrap();
            db.list_apps().ok()
                .and_then(|apps| apps.into_iter().find(|a| a.id == id))
                .map(|a| assign_tailnet_port(a.port))
                .unwrap_or(0)
        }
    };

    if tailnet_port != 0 {
        let out = std::process::Command::new(&ts)
            .args([
                "serve",
                "--https",
                &tailnet_port.to_string(),
                "--set-path",
                "/",
                "off",
            ])
            .output();
        // Best-effort: ignore "no such serve entry" style errors so Disconnect is
        // always idempotent from the user's perspective.
        if let Ok(o) = out {
            if !o.status.success() {
                let stderr = String::from_utf8_lossy(&o.stderr).to_lowercase();
                if !stderr.contains("not found") && !stderr.contains("no serve") {
                    // Surface unexpected errors so user can see them but still clear state.
                    let _ = app_handle.emit(
                        &format!("app:tunnel:{}", id),
                        serde_json::json!({
                            "active": false,
                            "url": null,
                            "error": String::from_utf8_lossy(&o.stderr).trim().to_string()
                        }),
                    );
                    return Ok(());
                }
            }
        }
    }

    // Drop the Caddy alias if this was a static app. Best-effort sync — if
    // Caddy is stopped we don't want to fail the Disconnect.
    let had_alias = static_aliases().lock().unwrap().remove(&id).is_some();
    if had_alias {
        let state = app_handle.state::<AppState>();
        let _ = crate::commands::sync_caddy(&state);
    }

    app_handle
        .emit(
            &format!("app:tunnel:{}", id),
            serde_json::json!({ "active": false, "url": null }),
        )
        .ok();
    Ok(())
}
