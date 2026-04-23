use std::collections::HashMap;
use std::io::BufRead;
use std::sync::{Mutex, OnceLock};
use std::thread;
use nix::sys::signal::{kill, Signal};
use nix::unistd::Pid;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

use crate::app_state::AppState;

fn tunnel_pids() -> &'static Mutex<HashMap<String, u32>> {
    static T: OnceLock<Mutex<HashMap<String, u32>>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(HashMap::new()))
}

fn tunnel_stopping() -> &'static Mutex<std::collections::HashSet<String>> {
    static T: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(std::collections::HashSet::new()))
}

fn find_cloudflared() -> Option<String> {
    for p in &[
        "/usr/local/bin/cloudflared",
        "/opt/homebrew/bin/cloudflared",
        "/usr/bin/cloudflared",
    ] {
        if std::path::Path::new(p).exists() {
            return Some(p.to_string());
        }
    }
    if let Ok(out) = std::process::Command::new("which").arg("cloudflared").output() {
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
pub fn check_cloudflared() -> bool {
    find_cloudflared().is_some()
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CloudflareTunnel {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub connection_count: u32,
}

/// List named tunnels available under the user's `cloudflared login` session.
/// Returns empty if cloudflared isn't installed or the user hasn't logged in.
#[tauri::command]
pub fn list_cloudflare_tunnels() -> Result<Vec<CloudflareTunnel>, String> {
    let cf = find_cloudflared().ok_or_else(|| "cloudflared not installed".to_string())?;
    let out = std::process::Command::new(&cf)
        .args(["tunnel", "list", "--output", "json"])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        if err.contains("login") || err.contains("not logged in") || err.contains("Unauthorized") {
            return Err("Not logged in. Run: cloudflared login".into());
        }
        return Err(err);
    }
    #[derive(Deserialize)]
    struct Raw {
        id: String,
        name: String,
        #[serde(default)]
        connections: Vec<serde_json::Value>,
    }
    let raw: Vec<Raw> = serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?;
    Ok(raw.into_iter()
        .map(|r| CloudflareTunnel {
            id: r.id,
            name: r.name,
            connection_count: r.connections.len() as u32,
        })
        .collect())
}

#[tauri::command]
pub fn start_tunnel(id: String, port: u16, app_handle: tauri::AppHandle) -> Result<(), String> {
    let cf = find_cloudflared().ok_or_else(|| {
        "cloudflared not installed. Run: brew install cloudflare/cloudflare/cloudflared".to_string()
    })?;

    // Look up this app's tunnel config (named vs quick mode) and kind. Static
    // apps have no process port — they're served by Caddy — so we forward the
    // tunnel to Caddy's port with the correct Host header.
    let (tunnel_name, tunnel_hostname, is_static_app, static_host) = {
        let state = app_handle.state::<AppState>();
        let db = state.db.lock().unwrap();
        let apps = db.list_apps().unwrap_or_default();
        let workspaces = db.list_workspaces().unwrap_or_default();
        let app_info = apps.into_iter().find(|a| a.id == id);
        match app_info {
            Some(a) => {
                let is_static = a.is_static();
                let host = if is_static { Some(a.resolved_host(&workspaces)) } else { None };
                (a.tunnel_name.clone(), a.tunnel_custom_hostname.clone(), is_static, host)
            }
            None => (None, None, false, None),
        }
    };

    // For static apps, point cloudflared at Caddy (443 if HTTPS certs exist, else 80)
    // and preserve the app's host header so Caddy matches the right route.
    let (effective_url, static_extra_args): (String, Vec<String>) = if is_static_app {
        let has_certs = crate::setup::certs_exist();
        let url = if has_certs { "https://localhost:443".to_string() } else { "http://localhost:80".to_string() };
        let mut extra: Vec<String> = Vec::new();
        if let Some(h) = static_host.filter(|s| !s.is_empty()) {
            extra.push("--http-host-header".into());
            extra.push(h);
        }
        if has_certs {
            // Caddy uses mkcert's CA which cloudflared doesn't trust by default.
            extra.push("--no-tls-verify".into());
        }
        (url, extra)
    } else {
        (format!("http://localhost:{}", port), Vec::new())
    };

    // Kill any existing tunnel for this app and clear stale stopping marker.
    {
        let mut pids = tunnel_pids().lock().unwrap();
        if let Some(pid) = pids.remove(&id) {
            let _ = kill(Pid::from_raw(pid as i32), Signal::SIGTERM);
        }
    }
    tunnel_stopping().lock().unwrap().remove(&id);

    let id2 = id.clone();
    let handle = app_handle.clone();
    let is_named = tunnel_name.as_ref().map(|n| !n.trim().is_empty()).unwrap_or(false);

    // For named tunnels, try to route DNS for the hostname first. Idempotent
    // enough — if the record already exists we ignore; if the zone isn't in
    // the user's CF account we surface the error up front.
    if is_named {
        if let (Some(name), Some(host)) = (
            tunnel_name.as_deref().filter(|s| !s.trim().is_empty()),
            tunnel_hostname.as_deref().filter(|s| !s.trim().is_empty()),
        ) {
            // Use --overwrite-dns so existing CNAMEs (pointing to another
            // tunnel) get re-pointed at this one. Without it, CNAMEs to a
            // different tunnel silently win and CF returns 404 / wrong origin.
            let out = std::process::Command::new(&cf)
                .args(["tunnel", "route", "dns", "--overwrite-dns", name, host])
                .output();
            if let Ok(o) = out {
                if !o.status.success() {
                    let stderr = String::from_utf8_lossy(&o.stderr).trim().to_string();
                    app_handle
                        .emit(
                            &format!("app:tunnel:{}", id),
                            serde_json::json!({
                                "active": false,
                                "url": null,
                                "error": format!("DNS route failed:\n{}", stderr)
                            }),
                        )
                        .ok();
                    return Err(format!("DNS route failed: {}", stderr));
                }
            }
        }
    }

    thread::spawn(move || {
        // Build args depending on mode.
        let mut args: Vec<String> = vec!["tunnel".into(), "--url".into(), effective_url];
        args.extend(static_extra_args);
        if is_named {
            args.push("run".into());
            args.push(tunnel_name.clone().unwrap_or_default());
        }

        let mut child = match std::process::Command::new(&cf)
            .args(&args)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                handle
                    .emit(
                        &format!("app:tunnel:{}", id2),
                        serde_json::json!({ "active": false, "url": null, "error": e.to_string() }),
                    )
                    .ok();
                return;
            }
        };

        tunnel_pids().lock().unwrap().insert(id2.clone(), child.id());

        // Capture last N stderr lines so we can surface a real error if
        // cloudflared exits non-zero (e.g. tunnel name wrong, no auth, DNS not routed).
        let stderr_buf: std::sync::Arc<std::sync::Mutex<Vec<String>>> =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));

        // cloudflared logs to stderr. We watch it to:
        // - Detect actual connection (named: "Registered tunnel connection"; quick: trycloudflare URL line)
        // - Buffer the tail for error reporting on non-zero exit
        let stderr_handle = if let Some(stderr) = child.stderr.take() {
            let id3 = id2.clone();
            let handle2 = handle.clone();
            let buf = stderr_buf.clone();
            let hostname = tunnel_hostname.clone();
            Some(thread::spawn(move || {
                let mut connected_emitted = false;
                for line in std::io::BufReader::new(stderr).lines().map_while(Result::ok) {
                    {
                        let mut b = buf.lock().unwrap();
                        b.push(line.clone());
                        if b.len() > 30 {
                            let drop = b.len() - 30;
                            b.drain(0..drop);
                        }
                    }
                    if is_named {
                        // Emit active:true only once we actually see a tunnel connection.
                        if !connected_emitted && line.contains("Registered tunnel connection") {
                            connected_emitted = true;
                            let url = hostname
                                .clone()
                                .filter(|h| !h.is_empty())
                                .map(|h| format!("https://{}", h));
                            handle2
                                .emit(
                                    &format!("app:tunnel:{}", id3),
                                    serde_json::json!({ "active": true, "url": url }),
                                )
                                .ok();
                        }
                        continue;
                    }
                    // Quick tunnel — scrape trycloudflare URL.
                    if let Some(pos) = line.find("https://") {
                        let url = line[pos..]
                            .split_whitespace()
                            .next()
                            .unwrap_or("")
                            .trim_end_matches('|')
                            .trim()
                            .to_string();
                        if url.contains("trycloudflare.com") || url.contains(".cloudflare.com") {
                            handle2
                                .emit(
                                    &format!("app:tunnel:{}", id3),
                                    serde_json::json!({ "active": true, "url": url }),
                                )
                                .ok();
                        }
                    }
                }
            }))
        } else {
            None
        };

        let status = child.wait().ok();
        // Wait for the stderr reader to drain so `stderr_buf` contains the full tail.
        if let Some(h) = stderr_handle {
            let _ = h.join();
        }

        // Tunnel ended — clean up and notify frontend.
        tunnel_pids().lock().unwrap().remove(&id2);
        let intentional = tunnel_stopping().lock().unwrap().remove(&id2);
        let exit_code = status.and_then(|s| s.code()).unwrap_or(-1);
        let err_text = if !intentional && exit_code != 0 {
            let buf = stderr_buf.lock().unwrap();
            let lines: Vec<String> = buf.iter()
                .rev()
                .filter(|l| !l.trim().is_empty())
                .take(8)
                .cloned()
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();
            if lines.is_empty() {
                Some(format!("cloudflared exited with code {}", exit_code))
            } else {
                Some(lines.join("\n"))
            }
        } else {
            None
        };
        handle
            .emit(
                &format!("app:tunnel:{}", id2),
                serde_json::json!({ "active": false, "url": null, "error": err_text }),
            )
            .ok();
    });

    Ok(())
}

#[tauri::command]
pub fn stop_tunnel(id: String) -> Result<(), String> {
    tunnel_stopping().lock().unwrap().insert(id.clone());
    if let Some(pid) = tunnel_pids().lock().unwrap().remove(&id) {
        let _ = kill(Pid::from_raw(pid as i32), Signal::SIGTERM);
    }
    Ok(())
}

/// Create a named tunnel. Wraps `cloudflared tunnel create <name>`.
#[tauri::command]
pub fn create_cloudflare_tunnel(name: String) -> Result<(), String> {
    let cf = find_cloudflared().ok_or_else(|| "cloudflared not installed".to_string())?;
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("tunnel name is required".into());
    }
    let out = std::process::Command::new(&cf)
        .args(["tunnel", "create", trimmed])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(())
}

/// Delete a named tunnel. `force` => also revokes active connections.
#[tauri::command]
pub fn delete_cloudflare_tunnel(name: String, force: bool) -> Result<(), String> {
    let cf = find_cloudflared().ok_or_else(|| "cloudflared not installed".to_string())?;
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("tunnel name is required".into());
    }
    let mut args = vec!["tunnel", "delete"];
    if force {
        args.push("-f");
    }
    args.push(trimmed);
    let out = std::process::Command::new(&cf)
        .args(&args)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(())
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TunnelDnsRoute {
    pub zone_name: String,
    pub hostname: String,
    /// UUID of the tunnel this CNAME points to.
    pub tunnel_id: String,
}

/// List all DNS CNAME records in the user's Cloudflare zones that point to
/// any cfargotunnel.com host (i.e. routes managed by Named Tunnels). Requires
/// a Cloudflare API token with Zone:Read + DNS:Read scopes.
#[tauri::command]
pub async fn list_tunnel_dns(api_token: String) -> Result<Vec<TunnelDnsRoute>, String> {
    let token = api_token.trim();
    if token.is_empty() {
        return Err("Cloudflare API token required".into());
    }
    let client = reqwest::Client::new();

    #[derive(Deserialize)]
    struct Zone {
        id: String,
        name: String,
    }
    #[derive(Deserialize)]
    struct ZonesResp {
        success: bool,
        result: Vec<Zone>,
        #[serde(default)]
        errors: Vec<serde_json::Value>,
    }

    // Fetch all zones. Simple: no pagination beyond default 50 (most users have < 50 zones).
    let zones_resp = client
        .get("https://api.cloudflare.com/client/v4/zones?per_page=50")
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !zones_resp.status().is_success() {
        return Err(format!("CF API /zones failed: {}", zones_resp.status()));
    }
    let zones: ZonesResp = zones_resp.json().await.map_err(|e| e.to_string())?;
    if !zones.success {
        return Err(format!("CF API error: {:?}", zones.errors));
    }

    #[derive(Deserialize)]
    struct DnsRecord {
        name: String,
        content: String,
        #[serde(rename = "type")]
        record_type: String,
    }
    #[derive(Deserialize)]
    struct RecordsResp {
        success: bool,
        result: Vec<DnsRecord>,
        #[serde(default)]
        errors: Vec<serde_json::Value>,
    }

    // Fetch all zones' CNAME records in parallel — sequential was slow when
    // a user has many zones on their account.
    let futs = zones.result.into_iter().map(|zone| {
        let client = client.clone();
        let token = token.to_string();
        async move {
            let url = format!(
                "https://api.cloudflare.com/client/v4/zones/{}/dns_records?type=CNAME&per_page=500",
                zone.id
            );
            let resp = match client.get(&url).bearer_auth(&token).send().await {
                Ok(r) if r.status().is_success() => r,
                _ => return Vec::<TunnelDnsRoute>::new(),
            };
            let body: RecordsResp = match resp.json().await {
                Ok(v) => v,
                Err(_) => return Vec::new(),
            };
            if !body.success {
                return Vec::new();
            }
            body.result
                .into_iter()
                .filter(|rec| rec.record_type == "CNAME")
                .filter_map(|rec| {
                    rec.content.strip_suffix(".cfargotunnel.com").map(|tid| TunnelDnsRoute {
                        zone_name: zone.name.clone(),
                        hostname: rec.name,
                        tunnel_id: tid.to_string(),
                    })
                })
                .collect()
        }
    });
    let per_zone: Vec<Vec<TunnelDnsRoute>> = futures_util::future::join_all(futs).await;
    Ok(per_zone.into_iter().flatten().collect())
}

/// Route a hostname to a tunnel via DNS. `overwrite` => `--overwrite-dns`.
#[tauri::command]
pub fn route_tunnel_dns(tunnel_name: String, hostname: String, overwrite: bool) -> Result<(), String> {
    let cf = find_cloudflared().ok_or_else(|| "cloudflared not installed".to_string())?;
    let t = tunnel_name.trim();
    let h = hostname.trim();
    if t.is_empty() || h.is_empty() {
        return Err("tunnel name and hostname are required".into());
    }
    let mut args = vec!["tunnel", "route", "dns"];
    if overwrite {
        args.push("--overwrite-dns");
    }
    args.push(t);
    args.push(h);
    let out = std::process::Command::new(&cf)
        .args(&args)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(())
}

/// Persist just the tunnel config for an app — used when the user clicks
/// Connect without having pressed Save first. Keeps the Connect flow to one
/// click instead of "save, then connect".
#[tauri::command]
pub fn set_tunnel_config(
    id: String,
    tunnel_provider: Option<String>,
    tunnel_name: Option<String>,
    tunnel_custom_hostname: Option<String>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let state = app_handle.state::<AppState>();
    let db = state.db.lock().unwrap();
    db.conn.execute(
        "UPDATE apps SET tunnel_provider = ?1, tunnel_name = ?2, tunnel_custom_hostname = ?3 WHERE id = ?4",
        rusqlite::params![tunnel_provider, tunnel_name, tunnel_custom_hostname, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
