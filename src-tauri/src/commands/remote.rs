//! Porta Relay — expose local apps through the user's own VPS (WireGuard +
//! remote Caddy). Mirrors the Cloudflare/Tailscale backends: host inventory in
//! rusqlite, expose/unexpose that manages a single `porta` server on the VPS
//! Caddy, and status emitted on the shared `app:tunnel:{id}` channel.

use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::app_state::AppState;
use crate::caddy::{RemoteCaddy, RemoteRouteSpec};
use crate::db::models::{App, RemoteHost, RemoteRoute, Workspace};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteHostTest {
    pub reachable: bool,
    pub message: String,
}

fn now_epoch() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn admin_url(host: &RemoteHost) -> String {
    format!("http://{}:{}", host.tunnel_ip, host.admin_port)
}

fn emit_tunnel(app_handle: &AppHandle, id: &str, payload: serde_json::Value) {
    let _ = app_handle.emit(&format!("app:tunnel:{}", id), payload);
}

/// Parse the output of `wg show interfaces` (space-separated interface names)
/// and return the first one, if any.
fn parse_wg_interfaces(out: &str) -> Option<String> {
    out.split_whitespace().next().map(|s| s.to_string())
}

/// Best-effort auto-detection of the active WireGuard interface (macOS assigns
/// dynamic `utunN` names). Returns `None` if `wg` isn't installed or no tunnel
/// is up; callers fall back to the host's manual `wg_interface` field.
pub fn detect_wg_interface() -> Option<String> {
    let out = std::process::Command::new("wg")
        .args(["show", "interfaces"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    parse_wg_interfaces(&String::from_utf8_lossy(&out.stdout))
}

// ── Host inventory (R1) ─────────────────────────────────────────────────────────

#[tauri::command]
pub fn list_remote_hosts(state: State<AppState>) -> Result<Vec<RemoteHost>, String> {
    state.db.lock().unwrap().list_remote_hosts().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn add_remote_host(mut host: RemoteHost, state: State<AppState>) -> Result<RemoteHost, String> {
    if host.id.is_empty() {
        host.id = uuid::Uuid::new_v4().to_string();
    }
    if host.created_at == 0 {
        host.created_at = now_epoch();
    }
    // Auto-detect the WG interface when the user left it blank.
    if host.wg_interface.as_deref().map(str::trim).unwrap_or("").is_empty() {
        host.wg_interface = detect_wg_interface();
    }
    state.db.lock().unwrap().insert_remote_host(&host).map_err(|e| e.to_string())?;
    Ok(host)
}

#[tauri::command]
pub fn update_remote_host(host: RemoteHost, state: State<AppState>) -> Result<(), String> {
    state.db.lock().unwrap().update_remote_host(&host).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_remote_host(id: String, state: State<AppState>) -> Result<(), String> {
    state.db.lock().unwrap().delete_remote_host(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn test_remote_host(id: String, state: State<AppState>) -> Result<RemoteHostTest, String> {
    let host = state
        .db
        .lock()
        .unwrap()
        .get_remote_host(&id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Remote host not found".to_string())?;
    // TODO(spec2): also warn if the admin API is reachable from a public IP
    // (it must bind the tunnel IP only). Requires probing the public interface.
    let caddy = RemoteCaddy::new(admin_url(&host));
    if caddy.reachable() {
        Ok(RemoteHostTest {
            reachable: true,
            message: format!("Connected to Caddy admin API at {}", admin_url(&host)),
        })
    } else {
        Ok(RemoteHostTest {
            reachable: false,
            message: format!(
                "Could not reach Caddy admin API at {}. Check the WireGuard tunnel is up and Caddy's admin API is bound to {}.",
                admin_url(&host),
                host.tunnel_ip
            ),
        })
    }
}

// ── Expose / unexpose (R3) ──────────────────────────────────────────────────────

#[tauri::command]
pub fn list_remote_routes(state: State<AppState>) -> Result<Vec<RemoteRoute>, String> {
    state.db.lock().unwrap().list_remote_routes().map_err(|e| e.to_string())
}

/// Build the desired `porta` server spec list for a host from its active routes.
/// Each remote route maps to a `RemoteRouteSpec` whose `public_host` is
/// `{subdomain}.{base_domain}` and whose `local_host` is the app's on-Mac
/// hostname (so local Caddy routes it), carrying the app's basic-auth if any.
fn routes_for_host(
    host: &RemoteHost,
    routes: &[RemoteRoute],
    apps: &[App],
    workspaces: &[Workspace],
) -> Vec<RemoteRouteSpec> {
    routes
        .iter()
        .filter(|r| r.host_id == host.id)
        .filter_map(|r| {
            let app = apps.iter().find(|a| a.id == r.app_id)?;
            Some(RemoteRouteSpec {
                public_host: format!("{}.{}", r.subdomain, host.base_domain),
                local_host: app.resolved_host(workspaces),
                auth: app.route_auth(),
            })
        })
        .collect()
}

/// Push the current desired state of a host's `porta` server to its VPS Caddy.
/// Returns `Ok` only when the PUT succeeds, so callers can leave routes marked
/// `pending` (never silently partial) on failure.
fn push_host(
    host: &RemoteHost,
    routes: &[RemoteRoute],
    apps: &[App],
    workspaces: &[Workspace],
) -> Result<(), String> {
    let caddy = RemoteCaddy::new(admin_url(host));
    let specs = routes_for_host(host, routes, apps, workspaces);
    let dial = format!("{}:443", host.mac_tunnel_ip);
    if specs.is_empty() {
        // No routes left on this host — remove Porta's servers entirely.
        return caddy.delete_porta_server().map_err(|e| e.to_string());
    }
    let server = RemoteCaddy::build_porta_server(&specs, &dial);
    caddy.put_porta_server(&server).map_err(|e| e.to_string())
}

fn set_provider(state: &AppState, app_id: &str, provider: Option<&str>) {
    let db = state.db.lock().unwrap();
    let _ = db
        .conn
        .execute("UPDATE apps SET tunnel_provider = ?1 WHERE id = ?2", params![provider, app_id]);
}

#[tauri::command]
pub fn expose_remote(
    app_id: String,
    host_id: String,
    subdomain: String,
    state: State<AppState>,
    app_handle: AppHandle,
) -> Result<String, String> {
    // Providers are mutually exclusive per app: tear down any other tunnel.
    crate::commands::tunnel::stop_cloudflare_for_switch(&app_id);
    crate::commands::tailscale::stop_tailscale_for_switch(&app_id, &app_handle);

    let (host, apps, workspaces, app_port) = {
        let db = state.db.lock().unwrap();
        let host = db
            .get_remote_host(&host_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Remote host not found".to_string())?;
        let apps = db.list_apps().map_err(|e| e.to_string())?;
        let workspaces = db.list_workspaces().map_err(|e| e.to_string())?;
        let app_port = apps
            .iter()
            .find(|a| a.id == app_id)
            .map(|a| a.port)
            .ok_or_else(|| "App not found".to_string())?;
        (host, apps, workspaces, app_port)
    };

    let sub = subdomain.trim();
    if sub.is_empty() {
        return Err("Subdomain cannot be empty".to_string());
    }
    let url = format!("https://{}.{}", sub, host.base_domain);

    // Upsert the route as pending: replace any existing route for this app so a
    // retry with a different subdomain doesn't leave a stale row behind.
    let route = RemoteRoute {
        id: uuid::Uuid::new_v4().to_string(),
        app_id: app_id.clone(),
        host_id: host_id.clone(),
        subdomain: sub.to_string(),
        port: app_port,
        status: "pending".to_string(),
        created_at: now_epoch(),
    };
    {
        let db = state.db.lock().unwrap();
        db.delete_remote_route_by_app(&app_id).map_err(|e| e.to_string())?;
        db.insert_remote_route(&route).map_err(|e| e.to_string())?;
    }

    // Rebuild the whole host server from all its (now-including-this) routes.
    let all_routes = state.db.lock().unwrap().list_remote_routes_for_host(&host_id).map_err(|e| e.to_string())?;
    match push_host(&host, &all_routes, &apps, &workspaces) {
        Ok(()) => {
            state
                .db
                .lock()
                .unwrap()
                .update_remote_route_status(&route.id, "active")
                .map_err(|e| e.to_string())?;
            set_provider(&state, &app_id, Some("remote"));
            emit_tunnel(&app_handle, &app_id, serde_json::json!({ "active": true, "url": url }));
            Ok(url)
        }
        Err(e) => {
            // Leave the row `pending` as the retry anchor; surface the error.
            emit_tunnel(
                &app_handle,
                &app_id,
                serde_json::json!({ "active": false, "url": null, "error": e }),
            );
            Err(format!("Failed to push route to VPS: {}", e))
        }
    }
}

#[tauri::command]
pub fn unexpose_remote(
    app_id: String,
    state: State<AppState>,
    app_handle: AppHandle,
) -> Result<(), String> {
    let route = state
        .db
        .lock()
        .unwrap()
        .get_remote_route_for_app(&app_id)
        .map_err(|e| e.to_string())?;
    let Some(route) = route else {
        // Nothing exposed — treat as a clean no-op.
        set_provider(&state, &app_id, None);
        emit_tunnel(&app_handle, &app_id, serde_json::json!({ "active": false, "url": null }));
        return Ok(());
    };

    let (host, apps, workspaces, remaining) = {
        let db = state.db.lock().unwrap();
        let host = db
            .get_remote_host(&route.host_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Remote host not found".to_string())?;
        let apps = db.list_apps().map_err(|e| e.to_string())?;
        let workspaces = db.list_workspaces().map_err(|e| e.to_string())?;
        // Routes that will remain after we drop this app's route.
        let remaining: Vec<RemoteRoute> = db
            .list_remote_routes_for_host(&route.host_id)
            .map_err(|e| e.to_string())?
            .into_iter()
            .filter(|r| r.app_id != app_id)
            .collect();
        (host, apps, workspaces, remaining)
    };

    // Push the VPS to the post-removal state first; only drop the DB row if that
    // succeeds, so a failed VPS call keeps the row as a retry anchor.
    push_host(&host, &remaining, &apps, &workspaces)?;

    state.db.lock().unwrap().delete_remote_route_by_app(&app_id).map_err(|e| e.to_string())?;
    set_provider(&state, &app_id, None);
    emit_tunnel(&app_handle, &app_id, serde_json::json!({ "active": false, "url": null }));
    Ok(())
}

/// Silent teardown when another provider takes over this app. Removes the app's
/// remote route and re-pushes the host without emitting (the incoming provider
/// owns the `app:tunnel:{id}` channel).
pub fn stop_remote_for_switch(app_id: &str, app_handle: &AppHandle) {
    let state = app_handle.state::<AppState>();
    let route = match state.db.lock().unwrap().get_remote_route_for_app(app_id) {
        Ok(Some(r)) => r,
        _ => return,
    };
    let (host, apps, workspaces, remaining) = {
        let db = state.db.lock().unwrap();
        let host = match db.get_remote_host(&route.host_id) {
            Ok(Some(h)) => h,
            _ => return,
        };
        let apps = db.list_apps().unwrap_or_default();
        let workspaces = db.list_workspaces().unwrap_or_default();
        let remaining: Vec<RemoteRoute> = db
            .list_remote_routes_for_host(&route.host_id)
            .unwrap_or_default()
            .into_iter()
            .filter(|r| r.app_id != app_id)
            .collect();
        (host, apps, workspaces, remaining)
    };
    let _ = push_host(&host, &remaining, &apps, &workspaces);
    let _ = state.db.lock().unwrap().delete_remote_route_by_app(app_id);
    set_provider(&state, app_id, None);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_wg_interfaces() {
        assert_eq!(parse_wg_interfaces("utun6 utun7\n"), Some("utun6".to_string()));
        assert_eq!(parse_wg_interfaces(""), None);
        assert_eq!(parse_wg_interfaces("   "), None);
    }

    #[test]
    fn test_routes_for_host_maps_public_and_local_hosts() {
        let host = RemoteHost {
            id: "h1".into(), name: "vps".into(), tunnel_ip: "10.0.0.1".into(),
            admin_port: 2019, base_domain: "example.com".into(), wg_interface: None,
            mac_tunnel_ip: "10.0.0.2".into(), created_at: 0,
        };
        let ws = Workspace { id: "w1".into(), name: "W".into(), domain: "work.test".into(), deployment: None };
        let app = App {
            id: "a1".into(),
            name: "myapp".into(),
            port: 3000,
            workspace_id: Some("w1".into()),
            subdomain: Some("myapp".into()),
            ..Default::default()
        };
        let routes = vec![RemoteRoute {
            id: "r1".into(), app_id: "a1".into(), host_id: "h1".into(),
            subdomain: "public".into(), port: 3000, status: "active".into(), created_at: 0,
        }];
        let specs = routes_for_host(&host, &routes, &[app], &[ws]);
        assert_eq!(specs.len(), 1);
        assert_eq!(specs[0].public_host, "public.example.com");
        assert_eq!(specs[0].local_host, "myapp.work.test");
    }
}
