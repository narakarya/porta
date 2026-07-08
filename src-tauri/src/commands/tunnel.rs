use nix::sys::signal::{kill, Signal};
use nix::unistd::Pid;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::BufRead;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::thread;
use tauri::{Emitter, Manager};

use crate::app_state::AppState;
use crate::db::models::App;

fn tunnel_pids() -> &'static Mutex<HashMap<String, u32>> {
    static T: OnceLock<Mutex<HashMap<String, u32>>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Metrics endpoint port per tunnel name. Populated when `start_tunnel`
/// successfully spawns cloudflared with `--metrics 127.0.0.1:<port>`. The UI
/// scrapes Prometheus text from `http://127.0.0.1:<port>/metrics` via
/// `tunnel_metrics`.
fn tunnel_metrics_ports() -> &'static Mutex<HashMap<String, u16>> {
    static T: OnceLock<Mutex<HashMap<String, u16>>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Pick a free TCP port by binding to :0 and immediately dropping the listener.
/// Briefly racy but cloudflared retries on EADDRINUSE so this is fine in
/// practice. Falls back to 0 (cloudflared picks one but we won't know which).
fn pick_free_port() -> Option<u16> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").ok()?;
    let port = listener.local_addr().ok()?.port();
    drop(listener);
    Some(port)
}

/// How many cloudflared tunnel processes Porta is currently managing. Used by
/// the tray menu to decide whether "Disconnect all tunnels" is worth showing.
pub fn active_cloudflared_count() -> usize {
    tunnel_pids().lock().unwrap().len()
}

/// Stop every cloudflared tunnel Porta started. Returns the count stopped.
pub fn stop_all_cloudflared_tunnels(app_handle: &tauri::AppHandle) -> usize {
    let ids: Vec<String> = {
        let mut pids = tunnel_pids().lock().unwrap();
        let ids: Vec<String> = pids.keys().cloned().collect();
        for id in &ids {
            if let Some(pid) = pids.remove(id) {
                let _ = kill(Pid::from_raw(pid as i32), Signal::SIGTERM);
            }
            tunnel_stopping().lock().unwrap().insert(id.clone());
        }
        ids
    };
    for id in &ids {
        let _ = app_handle.emit(
            &format!("app:tunnel:{}", id),
            serde_json::json!({ "active": false, "url": null }),
        );
    }
    ids.len()
}

fn tunnel_stopping() -> &'static Mutex<std::collections::HashSet<String>> {
    static T: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(std::collections::HashSet::new()))
}

/// App ids whose cloudflared is being torn down as part of switching to the
/// OTHER provider. Both providers emit on the same `app:tunnel:{id}` channel,
/// so the dying connector's final `active:false` would clobber the incoming
/// provider's `active:true`. Marking the id here tells the watcher to stay
/// silent on exit — the new provider owns the channel now.
fn tunnel_switching() -> &'static Mutex<std::collections::HashSet<String>> {
    static T: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(std::collections::HashSet::new()))
}

/// Tear down this app's cloudflared tunnel because the user is switching to a
/// different provider. Like `stop_tunnel`, but suppresses the watcher's
/// `active:false` emit so it can't race ahead of the new provider's
/// `active:true`. Safe no-op when no cloudflared is running for the id.
pub fn stop_cloudflare_for_switch(id: &str) {
    tunnel_switching().lock().unwrap().insert(id.to_string());
    tunnel_stopping().lock().unwrap().insert(id.to_string());
    if let Some(pid) = tunnel_pids().lock().unwrap().remove(id) {
        let _ = kill(Pid::from_raw(pid as i32), Signal::SIGTERM);
    }
}

/// Generate `~/.cloudflared/porta-<app-id>.yml` listing every (public → local)
/// hostname pair this app should expose. Returns the config path so we can pass
/// it to `cloudflared --config <path> tunnel run`.
///
/// All public hostnames forward to local Caddy (443 if certs exist, else 80)
/// with the original Host header rewritten to the matching local Caddy host so
/// Caddy can route to the right upstream — process port, port_binding port, or
/// static file_server.
fn write_tunnel_ingress_config(
    app: &App,
    workspaces: &[crate::db::models::Workspace],
) -> Result<PathBuf, String> {
    let pairs = app.tunnel_public_hostnames(workspaces);
    if pairs.is_empty() {
        return Err("No public hostnames to expose".into());
    }

    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let dir = PathBuf::from(home).join(".cloudflared");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("porta-{}.yml", app.id));

    let has_certs = crate::setup::certs_exist();
    let service = if has_certs {
        "https://localhost:443"
    } else {
        "http://localhost:80"
    };

    let mut yaml = String::new();
    yaml.push_str("# Generated by Porta — do not edit manually.\n");
    yaml.push_str("# Public hostname → local Caddy host pairs for this app's tunnel.\n");
    yaml.push_str("ingress:\n");
    for (public, local) in &pairs {
        yaml.push_str(&format!("  - hostname: {}\n", public));
        yaml.push_str(&format!("    service: {}\n", service));
        yaml.push_str("    originRequest:\n");
        yaml.push_str(&format!("      httpHostHeader: {}\n", local));
        if has_certs {
            yaml.push_str("      noTLSVerify: true\n");
        }
    }
    yaml.push_str("  - service: http_status:404\n");

    std::fs::write(&path, yaml).map_err(|e| e.to_string())?;
    Ok(path)
}

fn caddy_origin_args(host_header: &str, has_certs: bool) -> (String, Vec<String>) {
    let url = if has_certs {
        "https://localhost:443".to_string()
    } else {
        "http://localhost:80".to_string()
    };
    let mut extra = vec!["--http-host-header".into(), host_header.to_string()];
    if has_certs {
        // Caddy uses mkcert's CA which cloudflared doesn't trust by default.
        extra.push("--no-tls-verify".into());
    }
    (url, extra)
}

fn single_host_caddy_host(
    app: &App,
    workspaces: &[crate::db::models::Workspace],
) -> Option<String> {
    // Auto-sleep wake-on-request lives in Caddy's reverse_proxy error route.
    // Basic auth and static serving are also Caddy handlers.
    if !(app.is_static() || app.auto_sleep_enabled || app.basic_auth_enabled) {
        return None;
    }

    Some(
        app.tunnel_public_hostnames(workspaces)
            .first()
            .map(|(_, local)| local.clone())
            .unwrap_or_else(|| app.resolved_host(workspaces)),
    )
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
    if let Ok(out) = std::process::Command::new("which")
        .arg("cloudflared")
        .output()
    {
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
///
/// `cloudflared tunnel list` hits the CF API (often 1–3s). We push it onto the
/// blocking pool so the Tauri command worker thread is freed for other IPC
/// while we wait — without this, opening Settings → Tunnels can starve other
/// IPC calls (DNS list, status polling) until cloudflared returns.
#[tauri::command]
pub async fn list_cloudflare_tunnels() -> Result<Vec<CloudflareTunnel>, String> {
    tauri::async_runtime::spawn_blocking(|| -> Result<Vec<CloudflareTunnel>, String> {
        let cf = find_cloudflared().ok_or_else(|| "cloudflared not installed".to_string())?;
        let out = std::process::Command::new(&cf)
            .args(["tunnel", "list", "--output", "json"])
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
            if err.contains("login")
                || err.contains("not logged in")
                || err.contains("Unauthorized")
            {
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
        Ok(raw
            .into_iter()
            .map(|r| CloudflareTunnel {
                id: r.id,
                name: r.name,
                connection_count: r.connections.len() as u32,
            })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn start_tunnel(
    id: String,
    port: u16,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    // Push the synchronous prep (DB lookup, `cloudflared tunnel route dns …`
    // calls, child spawn) onto a blocking worker so the UI thread doesn't see
    // a macOS beachball cursor while cloudflared talks to Cloudflare's API.
    tauri::async_runtime::spawn_blocking(move || start_tunnel_blocking(id, port, app_handle))
        .await
        .map_err(|e| e.to_string())?
}

fn start_tunnel_blocking(
    id: String,
    port: u16,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let cf = find_cloudflared().ok_or_else(|| {
        "cloudflared not installed. Run: brew install cloudflare/cloudflare/cloudflared".to_string()
    })?;

    // Look up this app's tunnel config and derive every (public → local)
    // hostname pair. Static apps have no process port — they're served by
    // Caddy — so we forward the tunnel to Caddy's port with the correct Host
    // header. Multi-host apps (extras / port_bindings) always go through Caddy
    // because Caddy is what multiplexes by Host.
    let (tunnel_name, tunnel_hostname, single_host_host_header, public_pairs, ingress_config_path) = {
        let state = app_handle.state::<AppState>();
        let db = state.db.lock().unwrap();
        let apps = db.list_apps().unwrap_or_default();
        let workspaces = db.list_workspaces().unwrap_or_default();
        let app_info = apps.into_iter().find(|a| a.id == id);
        match app_info {
            Some(a) => {
                let host = single_host_caddy_host(&a, &workspaces);
                let pairs = a.tunnel_public_hostnames(&workspaces);
                // Only emit a config when there's more than one host — single
                // host stays on the legacy `--url` path so we don't change
                // wire behavior for users who never used multi-host, except
                // features that require Caddy are routed there below.
                let cfg_path =
                    if pairs.len() > 1 {
                        match write_tunnel_ingress_config(&a, &workspaces) {
                            Ok(p) => Some(p),
                            Err(e) => {
                                app_handle.emit(
                                &format!("app:tunnel:{}", id),
                                serde_json::json!({
                                    "active": false,
                                    "url": null,
                                    "error": format!("Failed to write ingress config: {}", e),
                                }),
                            ).ok();
                                return Err(e);
                            }
                        }
                    } else {
                        None
                    };
                (
                    a.tunnel_name.clone(),
                    a.tunnel_custom_hostname.clone(),
                    host,
                    pairs,
                    cfg_path,
                )
            }
            None => (None, None, None, Vec::new(), None),
        }
    };

    // For single-host apps that need a Caddy handler (static, basic auth, or
    // auto-sleep wake), point cloudflared at Caddy and preserve the local Host
    // header so Caddy matches the right route. With ingress_config_path, host
    // header is per-rule in the yml — these CLI args are unused there.
    let (effective_url, caddy_extra_args): (String, Vec<String>) =
        if let Some(host) = single_host_host_header {
            let has_certs = crate::setup::certs_exist();
            caddy_origin_args(&host, has_certs)
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

    // Providers are mutually exclusive per app: switching to Cloudflare must
    // tear down any Tailscale serve for this app first. Silent (no event) so it
    // doesn't clobber the `active:true` cloudflared emits once connected.
    crate::commands::tailscale::stop_tailscale_for_switch(&id, &app_handle);
    crate::commands::remote::stop_remote_for_switch(&id, &app_handle);

    let id2 = id.clone();
    let handle = app_handle.clone();
    let is_named = tunnel_name
        .as_ref()
        .map(|n| !n.trim().is_empty())
        .unwrap_or(false);

    // For named tunnels, route DNS for every public hostname before starting.
    // Idempotent — `--overwrite-dns` re-points existing CNAMEs (without it,
    // CNAMEs to a different tunnel silently win and CF returns 404 / wrong
    // origin). If the zone isn't in the user's CF account we surface the
    // error up front before spawning cloudflared.
    if is_named {
        if let Some(name) = tunnel_name.as_deref().filter(|s| !s.trim().is_empty()) {
            // Multi-host: route every pair. Single-host: legacy single record.
            // pairs is empty when tunnel_custom_hostname isn't set — we'd hit
            // the `tunnel_hostname.is_none()` branch below.
            let hostnames_to_route: Vec<String> = if !public_pairs.is_empty() {
                public_pairs.iter().map(|(p, _)| p.clone()).collect()
            } else if let Some(h) = tunnel_hostname.as_deref().filter(|s| !s.trim().is_empty()) {
                vec![h.to_string()]
            } else {
                Vec::new()
            };

            for host in &hostnames_to_route {
                // Pick the cert.pem authorized for this hostname's zone so
                // routing works across zones without the user manually
                // swapping `~/.cloudflared/cert.pem` between starts. Falls
                // back to the default cert if no per-zone one is registered.
                let mut cmd = std::process::Command::new(&cf);
                if let Some(cert) = crate::cloudflared_certs::cert_for_hostname(host) {
                    cmd.arg("--origincert").arg(cert);
                }
                let out = cmd
                    .args(["tunnel", "route", "dns", "--overwrite-dns", name, host])
                    .output();
                if let Ok(o) = out {
                    if !o.status.success() {
                        let stderr = String::from_utf8_lossy(&o.stderr).trim().to_string();
                        let err_msg = format!("DNS route failed for {}:\n{}", host, stderr);
                        app_handle
                            .emit(
                                &format!("app:tunnel:{}", id),
                                serde_json::json!({
                                    "active": false,
                                    "url": null,
                                    "error": err_msg.clone(),
                                }),
                            )
                            .ok();
                        return Err(err_msg);
                    }
                }
            }
        }
    }

    // Pick a metrics port up front so the UI can scrape Prometheus stats. We
    // bind :0, capture the port, then pass it to cloudflared via the global
    // `--metrics` flag (must come before the `tunnel` subcommand). If we can't
    // get a port we just skip — metrics simply won't be available.
    let metrics_port = pick_free_port();
    if let (Some(port), Some(name)) = (
        metrics_port,
        tunnel_name.as_deref().filter(|s| !s.trim().is_empty()),
    ) {
        tunnel_metrics_ports()
            .lock()
            .unwrap()
            .insert(name.to_string(), port);
    }

    thread::spawn(move || {
        // Build args depending on mode.
        // - Multi-host named: `--config <yml> tunnel run <name>` — ingress
        //   from yml routes each public hostname to Caddy with its own host
        //   header. No `--url` (would override ingress).
        // - Single-host named or quick: legacy `tunnel --url ... [run <name>]`.
        let mut prefix: Vec<String> = Vec::new();
        if let Some(port) = metrics_port {
            prefix.push("--metrics".into());
            prefix.push(format!("127.0.0.1:{}", port));
        }
        let args: Vec<String> = if let Some(cfg) = ingress_config_path.as_ref() {
            let mut a = prefix.clone();
            a.extend([
                "--config".into(),
                cfg.to_string_lossy().to_string(),
                "tunnel".into(),
                "run".into(),
                tunnel_name.clone().unwrap_or_default(),
            ]);
            a
        } else {
            let mut a = prefix.clone();
            a.extend(["tunnel".into(), "--url".into(), effective_url]);
            a.extend(caddy_extra_args);
            if is_named {
                a.push("run".into());
                a.push(tunnel_name.clone().unwrap_or_default());
            }
            a
        };

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

        tunnel_pids()
            .lock()
            .unwrap()
            .insert(id2.clone(), child.id());

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
                for line in std::io::BufReader::new(stderr)
                    .lines()
                    .map_while(Result::ok)
                {
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
        if let Some(name) = tunnel_name.as_deref().filter(|s| !s.trim().is_empty()) {
            tunnel_metrics_ports().lock().unwrap().remove(name);
        }
        let intentional = tunnel_stopping().lock().unwrap().remove(&id2);
        let exit_code = status.and_then(|s| s.code()).unwrap_or(-1);
        let err_text = if !intentional && exit_code != 0 {
            let buf = stderr_buf.lock().unwrap();
            let lines: Vec<String> = buf
                .iter()
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
                // Annotate specific failure modes with a one-line hint so the
                // UI error box tells the user what to try next.
                let joined = lines.join("\n");
                let lower = joined.to_lowercase();
                let hint = if lower.contains("trycloudflare")
                    && (lower.contains("deadline exceeded")
                        || lower.contains("timeout")
                        || lower.contains("context deadline"))
                {
                    Some("\n\nCan't reach api.trycloudflare.com. If you're on Tailscale, check whether an Exit Node or DNS override is blocking outbound HTTPS. Switching to a Named tunnel avoids this entirely.")
                } else if lower.contains("unauthorized") || lower.contains("not logged in") {
                    Some("\n\nRun `cloudflared login` to authenticate.")
                } else if lower.contains("failed to connect to") {
                    Some("\n\nNetwork error. Check your internet connection.")
                } else {
                    None
                };
                Some(match hint {
                    Some(h) => format!("{}{}", joined, h),
                    None => joined,
                })
            }
        } else {
            None
        };
        // Suppress the final emit when this connector is dying as part of a
        // provider switch — the incoming provider already owns this channel and
        // an `active:false` here would flip the UI back to disconnected.
        let switching = tunnel_switching().lock().unwrap().remove(&id2);
        if !switching {
            handle
                .emit(
                    &format!("app:tunnel:{}", id2),
                    serde_json::json!({ "active": false, "url": null, "error": err_text }),
                )
                .ok();
        }
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
pub async fn create_cloudflare_tunnel(name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
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
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::models::App;
    use std::collections::HashMap;

    fn test_app() -> App {
        App {
            id: "app-1".into(),
            workspace_id: None,
            name: "demo".into(),
            root_dir: "/tmp/demo".into(),
            port: 3000,
            subdomain: None,
            start_command: "npm run dev".into(),
            start_command_source: "manual".into(),
            status: "stopped".into(),
            pid: None,
            env_file: None,
            auto_start: false,
            kind: "process".into(),
            docker_image: None,
            docker_container_port: None,
            docker_args: None,
            docker_volumes: vec![],
            compose_file: None,
            network_share: false,
            tunnel_name: None,
            tunnel_custom_hostname: None,
            env_vars: HashMap::new(),
            restart_policy: "on-failure".into(),
            max_retries: 3,
            health_check_path: None,
            depends_on: vec![],
            extra_subdomains: vec![],
            custom_domain: None,
            tunnel_provider: None,
            tunnel_auto_start: false,
            tunnel_url: None,
            tunnel_active: false,
            port_bindings: vec![],
            env_profiles: vec![],
            active_profile_id: None,
            basic_auth_enabled: false,
            basic_auth_username: None,
            basic_auth_password_hash: None,
            basic_auth_password_set: false,
            host_auth_overrides: vec![],
            tunnel_alias_domain: None,
            tunnel_alias_rewrite_host: true,
            auto_sleep_enabled: false,
            idle_timeout_secs: 1800,
            auto_slept: false,
            max_upload_bytes: None,
        }
    }

    #[test]
    fn single_host_tunnel_stays_direct_without_caddy_features() {
        let app = test_app();
        assert_eq!(single_host_caddy_host(&app, &[]), None);
    }

    #[test]
    fn auto_sleep_single_host_tunnel_routes_through_caddy() {
        let mut app = test_app();
        app.auto_sleep_enabled = true;
        app.tunnel_custom_hostname = Some("demo.example.com".into());

        assert_eq!(
            single_host_caddy_host(&app, &[]).as_deref(),
            Some("demo.narakarya.test")
        );
    }

    #[test]
    fn caddy_origin_sets_host_header_and_tls_skip() {
        let (url, args) = caddy_origin_args("demo.narakarya.test", true);

        assert_eq!(url, "https://localhost:443");
        assert_eq!(
            args,
            vec![
                "--http-host-header".to_string(),
                "demo.narakarya.test".to_string(),
                "--no-tls-verify".to_string(),
            ]
        );
    }
}

/// Delete a named tunnel. `force` => also revokes active connections.
#[tauri::command]
pub async fn delete_cloudflare_tunnel(name: String, force: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
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
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TunnelDnsRoute {
    pub zone_name: String,
    pub hostname: String,
    /// UUID of the tunnel this CNAME points to.
    pub tunnel_id: String,
    /// Cloudflare zone id — needed so the UI can call `cf_dns_delete_record`
    /// without doing another zone lookup just to remove a single route.
    pub zone_id: String,
    /// DNS record id of the CNAME — pairs with `zone_id` for deletion.
    pub record_id: String,
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
        id: String,
        name: String,
        content: String,
        #[serde(rename = "type")]
        record_type: String,
    }
    #[derive(Deserialize)]
    struct RecordsResp {
        success: bool,
        result: Vec<DnsRecord>,
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
                    rec.content
                        .strip_suffix(".cfargotunnel.com")
                        .map(|tid| TunnelDnsRoute {
                            zone_name: zone.name.clone(),
                            hostname: rec.name,
                            tunnel_id: tid.to_string(),
                            zone_id: zone.id.clone(),
                            record_id: rec.id,
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
pub async fn route_tunnel_dns(
    tunnel_name: String,
    hostname: String,
    overwrite: bool,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
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
        let mut cmd = std::process::Command::new(&cf);
        if let Some(cert) = crate::cloudflared_certs::cert_for_hostname(h) {
            cmd.arg("--origincert").arg(cert);
        }
        let out = cmd.args(&args).output().map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
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
    tunnel_auto_start: Option<bool>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let state = app_handle.state::<AppState>();
    let db = state.db.lock().unwrap();
    // Only update auto_start if explicitly provided, so callers that just want
    // to set provider/hostname don't reset the user's auto-start preference.
    if let Some(auto) = tunnel_auto_start {
        db.conn.execute(
            "UPDATE apps SET tunnel_provider = ?1, tunnel_name = ?2, tunnel_custom_hostname = ?3, tunnel_auto_start = ?4 WHERE id = ?5",
            rusqlite::params![tunnel_provider, tunnel_name, tunnel_custom_hostname, auto as i32, id],
        )
    } else {
        db.conn.execute(
            "UPDATE apps SET tunnel_provider = ?1, tunnel_name = ?2, tunnel_custom_hostname = ?3 WHERE id = ?4",
            rusqlite::params![tunnel_provider, tunnel_name, tunnel_custom_hostname, id],
        )
    }
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ── Per-zone origin certs ───────────────────────────────────────────────────
//
// Cloudflare's `cert.pem` is account-scoped and (commonly) zone-scoped: a user
// who logs in once for `narakarya.com` can't `tunnel route dns` for
// `nasrulgunawan.com` with the same cert. Porta keeps a sidecar collection at
// `~/.cloudflared/porta-certs/<zone>.pem` and selects the right one when
// invoking cloudflared, so apps in different zones run side-by-side without
// the user manually swapping `cert.pem` between starts.

#[tauri::command]
pub fn list_cloudflare_zone_certs() -> Vec<crate::cloudflared_certs::ZoneCert> {
    crate::cloudflared_certs::list_zone_certs()
}

/// Copy a `cert.pem` (typically the user's freshly-issued one at
/// `~/.cloudflared/cert.pem` after `cloudflared login`) into the per-zone
/// store. Source is left in place so the user's default cloudflared CLI keeps
/// working unchanged.
#[tauri::command]
pub fn import_cloudflare_zone_cert(zone: String, source_path: String) -> Result<String, String> {
    let src = std::path::PathBuf::from(source_path);
    let dest = crate::cloudflared_certs::import_cert(&zone, &src)?;
    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
pub fn delete_cloudflare_zone_cert(zone: String) -> Result<(), String> {
    crate::cloudflared_certs::delete_zone_cert(&zone)
}

/// Preview the registrable domain (eTLD+1) Porta will use as the zone key
/// for a given hostname. Used by the UI so users can see which cert file
/// will be picked before they import.
#[tauri::command]
pub fn preview_zone_for_hostname(hostname: String) -> Option<String> {
    crate::cloudflared_certs::zone_for_hostname(&hostname)
}

// ── Tunnel metrics ──────────────────────────────────────────────────────────
//
// cloudflared exposes Prometheus metrics when run with `--metrics 127.0.0.1:N`.
// Porta picks a free port at start time and remembers it per tunnel name; the
// frontend calls `tunnel_metrics` to scrape + parse the relevant counters and
// histograms. Only a tiny subset is surfaced — enough for a one-line stats
// display per tunnel without recreating Grafana.

#[derive(Debug, Serialize)]
pub struct TunnelMetrics {
    pub requests_total: u64,
    pub errors_total: u64,
    pub active_connections: u32,
    pub response_latency_p50_ms: f64,
    pub response_latency_p99_ms: f64,
}

/// Tagged failure variant for "tunnel running but no `--metrics` flag" — the
/// UI shows a "restart to enable metrics" hint instead of an opaque network
/// error. Other failures (tunnel not running, scrape failed, parse error) all
/// flow through the generic Err branch.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TunnelMetricsError {
    NotEnabled { tunnel_name: String },
    NotRunning { tunnel_name: String },
    Scrape { message: String },
}

impl std::fmt::Display for TunnelMetricsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotEnabled { tunnel_name } => write!(
                f,
                "Metrics not enabled for tunnel '{}'. Restart the tunnel from Porta to expose Prometheus metrics.",
                tunnel_name
            ),
            Self::NotRunning { tunnel_name } => {
                write!(f, "Tunnel '{}' isn't running.", tunnel_name)
            }
            Self::Scrape { message } => write!(f, "Failed to scrape metrics: {}", message),
        }
    }
}

/// Parse a Prometheus text-format payload and extract the metrics we care
/// about. Hand-rolled rather than pulling in `prometheus-parse` to avoid the
/// extra dep — we only need a few well-known names. Histograms use
/// cumulative `_bucket` lines; we walk them in order to find the smallest
/// `le` whose cumulative count >= p_target * total.
fn parse_cloudflared_metrics(text: &str) -> TunnelMetrics {
    let mut requests_total: u64 = 0;
    let mut errors_total: u64 = 0;
    let mut active_connections: u32 = 0;
    // Histogram bucket accumulators.
    let mut buckets: Vec<(f64, f64)> = Vec::new(); // (le, cumulative_count)
    let mut hist_count: f64 = 0.0;
    let mut hist_sum: f64 = 0.0;

    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        // A line looks like: `name{labels} value` or `name value`.
        let (head, value_str) = match line.rsplit_once(' ') {
            Some(parts) => parts,
            None => continue,
        };
        let value: f64 = match value_str.parse() {
            Ok(v) => v,
            Err(_) => continue,
        };
        // Strip labels for name-prefix matching.
        let metric_name = match head.find('{') {
            Some(i) => &head[..i],
            None => head,
        };
        let labels = match (head.find('{'), head.rfind('}')) {
            (Some(i), Some(j)) if j > i => &head[i + 1..j],
            _ => "",
        };

        match metric_name {
            "cloudflared_tunnel_request_count" => {
                requests_total = requests_total.saturating_add(value as u64);
            }
            "cloudflared_tunnel_response_by_code" => {
                // Only sum 5xx as errors. The label looks like `status_code="500"` or similar.
                if labels.split(',').any(|kv| {
                    let kv = kv.trim();
                    let v = kv
                        .split_once('=')
                        .map(|(_, v)| v.trim_matches('"'))
                        .unwrap_or("");
                    v.starts_with('5') && v.len() == 3
                }) {
                    errors_total = errors_total.saturating_add(value as u64);
                }
            }
            "cloudflared_tunnel_active_streams" => {
                active_connections = active_connections.saturating_add(value as u32);
            }
            "cloudflared_tunnel_response_latency_seconds_bucket" => {
                // Bucket label has `le="0.5"`.
                if let Some(le_part) = labels
                    .split(',')
                    .find(|s| s.trim_start().starts_with("le="))
                {
                    if let Some(eq) = le_part.find('=') {
                        let raw = le_part[eq + 1..].trim().trim_matches('"');
                        if raw == "+Inf" {
                            buckets.push((f64::INFINITY, value));
                        } else if let Ok(le) = raw.parse::<f64>() {
                            buckets.push((le, value));
                        }
                    }
                }
            }
            "cloudflared_tunnel_response_latency_seconds_count" => {
                hist_count = value;
            }
            "cloudflared_tunnel_response_latency_seconds_sum" => {
                hist_sum = value;
            }
            _ => {}
        }
    }

    // Compute approximate p50 / p99 from cumulative buckets. Returns 0.0 if
    // we don't have enough data yet (zero requests or no buckets).
    fn quantile(buckets: &[(f64, f64)], total: f64, q: f64) -> f64 {
        if total <= 0.0 || buckets.is_empty() {
            return 0.0;
        }
        let target = q * total;
        let mut sorted = buckets.to_vec();
        sorted.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
        for (le, count) in &sorted {
            if *count >= target {
                if le.is_infinite() {
                    // Fall back to the largest finite bucket boundary.
                    return sorted
                        .iter()
                        .rev()
                        .find(|(b, _)| b.is_finite())
                        .map(|(b, _)| *b)
                        .unwrap_or(0.0);
                }
                return *le;
            }
        }
        0.0
    }

    let p50_s = quantile(&buckets, hist_count, 0.50);
    let p99_s = quantile(&buckets, hist_count, 0.99);
    // Sanity fallback: if we have a count but no useful buckets, derive a
    // mean-ish latency from sum/count so the UI at least shows something.
    let mean_ms = if hist_count > 0.0 {
        (hist_sum / hist_count) * 1000.0
    } else {
        0.0
    };

    TunnelMetrics {
        requests_total,
        errors_total,
        active_connections,
        response_latency_p50_ms: if p50_s > 0.0 { p50_s * 1000.0 } else { mean_ms },
        response_latency_p99_ms: if p99_s > 0.0 { p99_s * 1000.0 } else { mean_ms },
    }
}

#[tauri::command]
pub async fn tunnel_metrics(tunnel_name: String) -> Result<TunnelMetrics, TunnelMetricsError> {
    let name = tunnel_name.trim().to_string();
    if name.is_empty() {
        return Err(TunnelMetricsError::Scrape {
            message: "tunnel name is required".into(),
        });
    }

    let port = tunnel_metrics_ports().lock().unwrap().get(&name).copied();
    let port = match port {
        Some(p) => p,
        None => {
            // Differentiate "not running" vs "running but pre-metrics start".
            // We don't track tunnel_name → app_id directly, so just say
            // not_enabled — UI hint is "restart to enable" which covers both.
            return Err(TunnelMetricsError::NotEnabled { tunnel_name: name });
        }
    };

    let url = format!("http://127.0.0.1:{}/metrics", port);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .map_err(|e| TunnelMetricsError::Scrape {
            message: e.to_string(),
        })?;
    let resp = client.get(&url).send().await.map_err(|e| {
        // Connection refused → tunnel exited or never bound the port.
        // Surface as not_running so the UI prompts a restart.
        let msg = e.to_string();
        if msg.contains("connection refused") || msg.contains("ConnectionRefused") {
            TunnelMetricsError::NotRunning {
                tunnel_name: name.clone(),
            }
        } else {
            TunnelMetricsError::Scrape { message: msg }
        }
    })?;
    if !resp.status().is_success() {
        return Err(TunnelMetricsError::Scrape {
            message: format!("HTTP {}", resp.status()),
        });
    }
    let text = resp.text().await.map_err(|e| TunnelMetricsError::Scrape {
        message: e.to_string(),
    })?;
    Ok(parse_cloudflared_metrics(&text))
}
