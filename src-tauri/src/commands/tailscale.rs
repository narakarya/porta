use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

use crate::app_state::AppState;
use crate::db::{Database, models::Route};

/// Categorize a Tailscale CLI error message into an actionable hint. Callers
/// already have the raw stderr; this adds a one-line suggestion so the UI can
/// render a direct fix button without re-parsing on the frontend.
fn annotate_ts_error(raw: &str) -> String {
    let lower = raw.to_lowercase();
    if lower.contains("funnel") && (lower.contains("not enabled") || lower.contains("not allowed") || lower.contains("node attr") || lower.contains("policy")) {
        return format!(
            "{}\n\nFunnel isn't enabled on this tailnet. Enable it at:\n  https://login.tailscale.com/admin/settings/features",
            raw
        );
    }
    if lower.contains("not logged in") || lower.contains("needslogin") || lower.contains("logged out") {
        return format!("{}\n\nRun `tailscale login` or open the Tailscale app to authenticate.", raw);
    }
    if lower.contains("connect to local tailscaled") || lower.contains("daemon") || lower.contains("no such file or directory") {
        return format!("{}\n\nTailscale daemon isn't running. Open the Tailscale app or run `tailscale up`.", raw);
    }
    if lower.contains("no such serve") || lower.contains("not found") {
        // Idempotent-ish — surface a gentler phrasing.
        return "No matching serve entry (already removed).".into();
    }
    raw.to_string()
}

/// Per-app tracking: (tailnet HTTPS port, is_funnel). `is_funnel=true` means
/// this was started via `tailscale funnel` (public), so Disconnect must use
/// `funnel off` rather than `serve off`. Not persisted — reconciled from the
/// daemon at runtime.
fn active_serves() -> &'static Mutex<HashMap<String, (u16, bool)>> {
    static T: OnceLock<Mutex<HashMap<String, (u16, bool)>>> = OnceLock::new();
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
/// Caddy routes for any Tailscale-served app whose tailnet hostname is
/// registered as an alias. Static apps emit a FileServer; everything else gets
/// a ReverseProxy. Both carry the app's auth, so basic-auth on a Tailscale
/// path is enforced by Caddy just like the Cloudflare and local paths.
///
/// Tailscale Serve does not rewrite the Host header, so Caddy must match on
/// the `<machine>.<tailnet>.ts.net` hostname directly.
pub fn static_alias_routes(db: &Database) -> Vec<Route> {
    let apps = match db.list_apps() {
        Ok(a) => a,
        Err(_) => return Vec::new(),
    };
    let aliases = static_aliases().lock().unwrap();
    let mut out = Vec::new();
    for (app_id, host) in aliases.iter() {
        if let Some(app) = apps.iter().find(|a| &a.id == app_id) {
            let auth = app.route_auth();
            if app.is_static() {
                out.push(Route::FileServer {
                    host: host.clone(),
                    root: app.root_dir.clone(),
                    auth,
                    app_id: Some(app.id.clone()),
                });
            } else {
                out.push(Route::ReverseProxy {
                    host: host.clone(),
                    port: app.port,
                    auth,
                    app_id: Some(app.id.clone()),
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
                // Startup reconciliation can't tell apart serve vs funnel from
                // `serve status --json` alone; default to serve and accept that
                // a mislabeled entry for Funnel still stops correctly because
                // `serve --https=<port> off` removes funnel entries too.
                active_serves().lock().unwrap().insert(app.id.clone(), (ts_port, false));
            }
        }
    }
}

/// All plausible Tailscale CLI locations in priority order. Homebrew/standalone
/// first because its daemon is accessible via `/var/run/tailscaled.sock` — the
/// App Store binary at `.app/Contents/MacOS/Tailscale` talks to the GUI app
/// via XPC and can report "Stopped" when invoked from another process even if
/// the user is actually connected.
fn candidate_paths() -> Vec<String> {
    let mut out: Vec<String> = vec![
        "/opt/homebrew/bin/tailscale".into(),
        "/usr/local/bin/tailscale".into(),
        "/usr/bin/tailscale".into(),
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale".into(),
    ];
    // Whatever `which` returns also goes on the list (deduped) in case the user
    // installed to a non-standard prefix.
    if let Ok(o) = std::process::Command::new("which").arg("tailscale").output() {
        if o.status.success() {
            let p = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if !p.is_empty() && !out.contains(&p) {
                out.insert(0, p);
            }
        }
    }
    out.retain(|p| std::path::Path::new(p).exists());
    out
}

fn find_tailscale() -> Option<String> {
    let cached = active_binary().lock().unwrap().clone();
    if let Some(p) = cached {
        if std::path::Path::new(&p).exists() {
            return Some(p);
        }
    }
    // First-time (or stale cache): try each candidate, prefer one whose status
    // actually reports Running. Falls back to first-found if none are Running.
    let candidates = candidate_paths();
    let mut fallback: Option<String> = candidates.first().cloned();
    for path in &candidates {
        if let Ok(out) = std::process::Command::new(path)
            .args(["status", "--json"])
            .output()
        {
            if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&out.stdout) {
                let state = v.get("BackendState").and_then(|s| s.as_str()).unwrap_or("");
                if state == "Running" {
                    *active_binary().lock().unwrap() = Some(path.clone());
                    return Some(path.clone());
                }
                // Still a real Tailscale binary even if not Running — keep as fallback.
                if !state.is_empty() {
                    fallback = Some(path.clone());
                }
            }
        }
    }
    if let Some(ref p) = fallback {
        *active_binary().lock().unwrap() = Some(p.clone());
    }
    fallback
}

/// Cached binary choice so subsequent start/stop calls hit the same daemon
/// the status check validated. Cleared on status errors so a re-pick happens
/// if the preferred binary goes away.
fn active_binary() -> &'static Mutex<Option<String>> {
    static T: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(None))
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
    pub funnel: bool,
}

fn parse_web_entries(value: &serde_json::Value, funnel: bool) -> Vec<TailscaleServeEntry> {
    let mut entries = Vec::new();
    if let Some(web) = value.get("Web").and_then(|w| w.as_object()) {
        for (host_port, cfg) in web {
            let port: u16 = host_port.rsplit(':').next()
                .and_then(|p| p.parse().ok())
                .unwrap_or(0);
            let upstream = cfg.get("Handlers")
                .and_then(|h| h.get("/"))
                .and_then(|h| h.get("Proxy"))
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_string();
            entries.push(TailscaleServeEntry { port, upstream, funnel });
        }
    }
    entries
}

#[tauri::command]
pub fn list_tailscale_serves() -> Result<Vec<TailscaleServeEntry>, String> {
    let ts = find_tailscale().ok_or_else(|| "tailscale not installed".to_string())?;
    // `serve status --json` returns BOTH serve and funnel entries; funnel flag is
    // encoded via the separate `funnel status --json` call — we merge the two.
    let serve_out = std::process::Command::new(&ts)
        .args(["serve", "status", "--json"])
        .output()
        .map_err(|e| e.to_string())?;
    let funnel_out = std::process::Command::new(&ts)
        .args(["funnel", "status", "--json"])
        .output()
        .ok();

    let serve_value: serde_json::Value = serde_json::from_slice(&serve_out.stdout).unwrap_or(serde_json::Value::Null);
    let funnel_value: serde_json::Value = funnel_out
        .as_ref()
        .and_then(|o| serde_json::from_slice(&o.stdout).ok())
        .unwrap_or(serde_json::Value::Null);

    // Build a set of (host, port) pairs that are funnel-backed so we can tag them.
    let mut funnel_keys: std::collections::HashSet<String> = std::collections::HashSet::new();
    if let Some(web) = funnel_value.get("Web").and_then(|w| w.as_object()) {
        for k in web.keys() {
            funnel_keys.insert(k.clone());
        }
    }

    let mut entries = parse_web_entries(&serve_value, false);
    for e in &mut entries {
        // Match against any funnel host:port suffix ending with the same port —
        // hostnames always match the same node, so the port discriminator is
        // enough in practice.
        if funnel_keys.iter().any(|k| k.rsplit(':').next().and_then(|p| p.parse::<u16>().ok()) == Some(e.port)) {
            e.funnel = true;
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
pub async fn start_tailscale_serve(
    id: String,
    port: u16,
    funnel: Option<bool>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    // Run on a background thread — `tailscale serve/funnel --bg` talks to the
    // local daemon and on Funnel can take several seconds, which would block
    // the Tauri runtime and turn the cursor into a macOS beachball.
    tauri::async_runtime::spawn_blocking(move || {
        let use_funnel = funnel.unwrap_or(false);
        let ts = find_tailscale().ok_or_else(|| "tailscale not installed".to_string())?;

        // Resolve tailnet hostname upfront — we need it both for the final URL and,
        // for static apps, for the Caddy alias route.
        let status = tailscale_status();
        let tailnet_host = match status.host.as_ref() {
            Some(h) => h.clone(),
            None => {
                let msg = annotate_ts_error("Tailscale is not running or not logged in.");
                app_handle
                    .emit(
                        &format!("app:tunnel:{}", id),
                        serde_json::json!({ "active": false, "url": null, "error": msg.clone() }),
                    )
                    .ok();
                return Err(msg);
            }
        };

        // Static apps must always go through Caddy (file_server is a Caddy
        // handler). Non-static apps go through Caddy only when we need a
        // Caddy-level handler in front of them — currently that's basic auth.
        // Going through Caddy adds an extra hop, so we keep the direct path
        // when no Caddy feature is in play.
        let route_through_caddy = {
            let state = app_handle.state::<AppState>();
            let db = state.db.lock().unwrap();
            let app = db.list_apps().ok()
                .and_then(|apps| apps.into_iter().find(|a| a.id == id));
            let is_static = app.as_ref().map(|a| a.is_static()).unwrap_or(false);
            let needs_caddy_handler = app.as_ref().map(|a| a.basic_auth_enabled).unwrap_or(false);
            is_static || needs_caddy_handler
        };

        let tailnet_port = assign_tailnet_port(port);

        // When traffic must traverse Caddy (static apps, or apps with basic auth):
        // register the tailnet hostname as a Caddy alias route, then point
        // Tailscale Serve at Caddy. Tailscale Serve doesn't rewrite Host header,
        // so Caddy must match on the ts.net hostname directly.
        let upstream = if route_through_caddy {
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

        // Apply the serve/funnel config. `--bg` persists it in the tailscaled daemon.
        // Funnel exposes publicly; serve is tailnet-only. Same flag surface otherwise.
        let subcommand = if use_funnel { "funnel" } else { "serve" };
        let out = std::process::Command::new(&ts)
            .args([
                subcommand,
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
            let hint = annotate_ts_error(&err_text);
            // Roll back tailnet alias if we registered one.
            if route_through_caddy {
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

        active_serves().lock().unwrap().insert(id.clone(), (tailnet_port, use_funnel));

        app_handle
            .emit(
                &format!("app:tunnel:{}", id),
                serde_json::json!({ "active": true, "url": url }),
            )
            .ok();

        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn stop_tailscale_serve(id: String, app_handle: tauri::AppHandle) -> Result<(), String> {
    // Mirror start_tailscale_serve: the `tailscale serve … off` invocation is
    // a subprocess + daemon round-trip, so push it off the runtime thread.
    tauri::async_runtime::spawn_blocking(move || {
        let ts = find_tailscale().ok_or_else(|| "tailscale not installed".to_string())?;

        let tracked = active_serves().lock().unwrap().remove(&id);
        // If we don't have a tracked port (e.g. app was started in a previous Porta
        // session), fall back to the app's local port — that's what we'd have assigned.
        let (tailnet_port, was_funnel) = match tracked {
            Some((p, f)) => (p, f),
            None => {
                let state = app_handle.state::<AppState>();
                let db = state.db.lock().unwrap();
                let port = db.list_apps().ok()
                    .and_then(|apps| apps.into_iter().find(|a| a.id == id))
                    .map(|a| assign_tailnet_port(a.port))
                    .unwrap_or(0);
                (port, false)
            }
        };

        if tailnet_port != 0 {
            let subcommand = if was_funnel { "funnel" } else { "serve" };
            let out = std::process::Command::new(&ts)
                .args([
                    subcommand,
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
    })
    .await
    .map_err(|e| e.to_string())?
}

/// How many Porta-managed Tailscale serves are currently tracked. Used by the
/// tray menu to decide whether to surface a "Disconnect all" action.
pub fn active_serve_count() -> usize {
    active_serves().lock().unwrap().len()
}

/// Check if a tunnel URL is actually reachable. Returns true if we got ANY
/// HTTP response (including 4xx/5xx from the upstream app), false only on
/// network-level failure like timeout or DNS error. Used by the UI to surface
/// "tunnel dead" vs "app returning an error" — the first needs a Reconnect,
/// the second is the app's own business.
///
/// GET rather than HEAD because many dev servers (Next.js, Vite, Rails,
/// Cloudflare Quick Tunnels anti-abuse pages) respond poorly to HEAD even
/// when GET works fine. We use `Range: bytes=0-0` so we only pull 1 byte.
#[tauri::command]
pub async fn check_tunnel_reachable(url: String) -> bool {
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::limited(3))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    // Any response at all — even 502/503 — means the tunnel pipe is alive.
    // Only true network failure should flag "not responding".
    client
        .get(&url)
        .header("Range", "bytes=0-0")
        .send()
        .await
        .is_ok()
}

/// Stop every serve/funnel entry that Porta is tracking. Unlike
/// reset_tailscale_serves this leaves manually-configured entries the user set
/// up outside Porta alone — safer default when the user just wants to
/// disconnect their apps without nuking their whole serve config.
#[tauri::command]
pub fn stop_all_porta_tailscale_serves(app_handle: tauri::AppHandle) -> Result<(), String> {
    let ts = find_tailscale().ok_or_else(|| "tailscale not installed".to_string())?;

    let tracked: Vec<(String, u16, bool)> = {
        let map = active_serves().lock().unwrap();
        map.iter().map(|(id, (port, funnel))| (id.clone(), *port, *funnel)).collect()
    };

    for (id, port, was_funnel) in &tracked {
        let subcommand = if *was_funnel { "funnel" } else { "serve" };
        let _ = std::process::Command::new(&ts)
            .args([subcommand, "--https", &port.to_string(), "--set-path", "/", "off"])
            .output();
        // Clear from map regardless of result — if the daemon no longer knows
        // about this entry, we still want to forget it so the UI doesn't
        // claim it's active.
        active_serves().lock().unwrap().remove(id);
        let _ = app_handle.emit(
            &format!("app:tunnel:{}", id),
            serde_json::json!({ "active": false, "url": null }),
        );
    }

    // Drop all static-app Caddy aliases and re-sync once at the end.
    let had_aliases = {
        let mut aliases = static_aliases().lock().unwrap();
        let any = !aliases.is_empty();
        aliases.clear();
        any
    };
    if had_aliases {
        let state = app_handle.state::<AppState>();
        let _ = crate::commands::sync_caddy(&state);
    }
    Ok(())
}

/// Wipe ALL Tailscale Serve and Funnel config from the daemon. Used from the
/// global Settings page as an escape hatch when state gets weird.
#[tauri::command]
pub fn reset_tailscale_serves(app_handle: tauri::AppHandle) -> Result<(), String> {
    let ts = find_tailscale().ok_or_else(|| "tailscale not installed".to_string())?;
    // Best-effort both — `reset` on one doesn't clear the other.
    let _ = std::process::Command::new(&ts).args(["serve", "reset"]).output();
    let _ = std::process::Command::new(&ts).args(["funnel", "reset"]).output();

    // Collect app IDs we need to notify about, under lock, then release before emit.
    let ids: Vec<String> = {
        let mut map = active_serves().lock().unwrap();
        let ids = map.keys().cloned().collect();
        map.clear();
        ids
    };
    let static_ids: Vec<String> = {
        let mut map = static_aliases().lock().unwrap();
        let ids = map.keys().cloned().collect();
        map.clear();
        ids
    };
    if !static_ids.is_empty() {
        let state = app_handle.state::<AppState>();
        let _ = crate::commands::sync_caddy(&state);
    }
    for id in ids.iter().chain(static_ids.iter()) {
        let _ = app_handle.emit(
            &format!("app:tunnel:{}", id),
            serde_json::json!({ "active": false, "url": null }),
        );
    }
    Ok(())
}

/// Poll `tailscale serve/funnel status` every N seconds. When an entry appears
/// or disappears out-of-band (user ran `tailscale serve` from a terminal, or
/// removed one manually), emit `app:tunnel:{id}` so the UI stays in sync
/// without the user clicking Refresh.
pub fn spawn_tailscale_poller(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        // Track what we last told the frontend so we only emit on transitions.
        // Maps app_id → (active, url). If the value changes, we emit.
        let mut last_state: HashMap<String, (bool, Option<String>)> = HashMap::new();

        loop {
            std::thread::sleep(std::time::Duration::from_secs(15));

            // Skip work when tailscale isn't installed — avoids spawning a Command every 15s on machines without it.
            if find_tailscale().is_none() {
                continue;
            }

            let status = tailscale_status();
            let host = match status.host.as_ref() {
                Some(h) if status.running && status.logged_in => h.clone(),
                _ => {
                    // Daemon down or not logged in — mark anything we previously
                    // reported active as inactive.
                    let previously_active: Vec<String> = last_state
                        .iter()
                        .filter(|(_, (active, _))| *active)
                        .map(|(id, _)| id.clone())
                        .collect();
                    for id in previously_active {
                        last_state.insert(id.clone(), (false, None));
                        let _ = app.emit(
                            &format!("app:tunnel:{}", id),
                            serde_json::json!({ "active": false, "url": null }),
                        );
                    }
                    continue;
                }
            };

            let serves = match list_tailscale_serves() {
                Ok(s) => s,
                Err(_) => continue,
            };

            let state = app.state::<AppState>();
            let apps = match state.db.lock().unwrap().list_apps() {
                Ok(a) => a,
                Err(_) => continue,
            };

            // Build the current picture: for each app, is it being served? with what URL?
            let mut current: HashMap<String, (bool, Option<String>)> = HashMap::new();
            for app_row in &apps {
                let serving = serves.iter().find(|s| s.port == assign_tailnet_port(app_row.port));
                let url = serving.map(|s| {
                    if s.port == 443 { format!("https://{}", host) } else { format!("https://{}:{}", host, s.port) }
                });
                current.insert(app_row.id.clone(), (serving.is_some(), url));
            }

            // Diff and emit. Only changed apps get notified to avoid event spam.
            for (id, (active, url)) in &current {
                let prev = last_state.get(id).cloned().unwrap_or((false, None));
                if &prev != &(*active, url.clone()) {
                    let _ = app.emit(
                        &format!("app:tunnel:{}", id),
                        serde_json::json!({ "active": *active, "url": url }),
                    );
                }
            }
            last_state = current;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn annotate_funnel_disabled() {
        let raw = "Error: Funnel is not enabled for this tailnet (policy rejected)";
        let out = annotate_ts_error(raw);
        assert!(out.contains("admin/settings/features"), "got: {out}");
        assert!(out.starts_with(raw), "raw message should be preserved prefix");
    }

    #[test]
    fn annotate_not_logged_in() {
        let raw = "tailscale: not logged in, run `tailscale up`";
        let out = annotate_ts_error(raw);
        assert!(out.contains("tailscale login"), "got: {out}");
    }

    #[test]
    fn annotate_daemon_down() {
        let raw = "failed to connect to local tailscaled";
        let out = annotate_ts_error(raw);
        assert!(out.contains("daemon"), "got: {out}");
        assert!(out.contains("tailscale up"), "got: {out}");
    }

    #[test]
    fn annotate_already_removed() {
        let out = annotate_ts_error("error: no such serve entry found");
        assert_eq!(out, "No matching serve entry (already removed).");
    }

    #[test]
    fn annotate_passthrough_generic() {
        let raw = "Something weird happened";
        assert_eq!(annotate_ts_error(raw), raw);
    }

    #[test]
    fn parse_web_entries_empty() {
        let v: serde_json::Value = serde_json::from_str(r#"{"Web": {}}"#).unwrap();
        let entries = parse_web_entries(&v, false);
        assert!(entries.is_empty());
    }

    #[test]
    fn parse_web_entries_single() {
        let v: serde_json::Value = serde_json::from_str(
            r#"{"Web": {"host.example.com:443": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:3000"}}}}}"#
        ).unwrap();
        let entries = parse_web_entries(&v, false);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].port, 443);
        assert_eq!(entries[0].upstream, "http://127.0.0.1:3000");
        assert!(!entries[0].funnel);
    }

    #[test]
    fn parse_web_entries_multi_with_funnel_flag() {
        let v: serde_json::Value = serde_json::from_str(
            r#"{"Web": {
                "host.example.com:443": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:3000"}}},
                "host.example.com:8443": {"Handlers": {"/": {"Proxy": "https+insecure://localhost:443"}}}
            }}"#
        ).unwrap();
        let entries = parse_web_entries(&v, true);
        assert_eq!(entries.len(), 2);
        // All entries get funnel=true because the flag was passed.
        assert!(entries.iter().all(|e| e.funnel));
        let ports: std::collections::HashSet<u16> = entries.iter().map(|e| e.port).collect();
        assert!(ports.contains(&443) && ports.contains(&8443));
    }

    #[test]
    fn parse_web_entries_null_value() {
        // `tailscale serve status --json` may return a top-level null when no
        // config exists on some versions — verify we handle it gracefully.
        let entries = parse_web_entries(&serde_json::Value::Null, false);
        assert!(entries.is_empty());
    }

    #[test]
    fn parse_web_entries_missing_handler() {
        // Malformed entry (no Handlers./ key) — upstream should be empty, still parsed.
        let v: serde_json::Value = serde_json::from_str(
            r#"{"Web": {"host.example.com:443": {}}}"#
        ).unwrap();
        let entries = parse_web_entries(&v, false);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].upstream, "");
    }
}
