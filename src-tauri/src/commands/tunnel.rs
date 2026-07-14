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

/// Desired-active app ids per NAMED tunnel. A named tunnel runs exactly ONE
/// cloudflared connector serving the merged ingress of every member app —
/// Cloudflare's own model (one connector, one full ingress table). Running one
/// connector per app instead makes each app an HA replica of the same tunnel
/// with only its own ingress, so the edge forwards a hostname to whichever
/// replica answers and the wrong app (or a 404) wins. Connecting an app adds it
/// here; disconnecting removes it; `reconcile_named_tunnel` (re)starts the
/// single connector to match.
fn tunnel_members() -> &'static Mutex<HashMap<String, std::collections::HashSet<String>>> {
    static T: OnceLock<Mutex<HashMap<String, std::collections::HashSet<String>>>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(HashMap::new()))
}

/// OS pids we killed on purpose to restart/tear-down a named connector. The
/// dying connector's watcher checks its own pid here and stays silent instead
/// of emitting `active:false` (which would flicker every member's UI during a
/// membership change). Keyed by pid — NOT by tunnel name — because several
/// restarts can overlap and a name-keyed flag can't tell them apart. Always
/// consumed (removed) by the watcher on exit, so no stale entry can silence a
/// later pid-reused process.
fn restart_pids() -> &'static Mutex<std::collections::HashSet<u32>> {
    static T: OnceLock<Mutex<std::collections::HashSet<u32>>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(std::collections::HashSet::new()))
}

/// Serializes `reconcile_named_tunnel` across the whole process. Auto-start
/// fires one `start_tunnel` per app the instant each becomes ready, so three
/// apps sharing a tunnel would otherwise reconcile concurrently — each killing
/// the other's freshly-spawned connector and racing config writes. Reconciles
/// are infrequent and short, so a single global lock is simpler than per-name
/// locks and can't deadlock (no other lock is held across acquiring it).
fn reconcile_lock() -> &'static Mutex<()> {
    static L: OnceLock<Mutex<()>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(()))
}

/// Process-map key for a named tunnel's single shared connector. Prefixed so it
/// can't collide with app-id keys (bare UUIDs) or instance keys
/// (`<uuid>:<branch>`), neither of which starts with `cfd-tunnel:`.
fn tunnel_key(name: &str) -> String {
    format!("cfd-tunnel:{}", name)
}

/// SIGTERM a connector and BLOCK until the process is actually gone (SIGKILL at
/// the deadline). Spawning a replacement while the old one is still alive is
/// what strands ghost registrations: the edge keeps routing to the dying
/// replica's connections, and if it exits without completing its unregister
/// handshake those registrations linger for hours serving 502s.
fn terminate_and_wait(pid: u32, timeout: std::time::Duration) {
    let p = Pid::from_raw(pid as i32);
    let _ = kill(p, Signal::SIGTERM);
    let deadline = std::time::Instant::now() + timeout;
    loop {
        // Signal 0 = existence probe. ESRCH once the watcher thread reaps it.
        if kill(p, None).is_err() {
            return;
        }
        if std::time::Instant::now() >= deadline {
            let _ = kill(p, Signal::SIGKILL);
            // Give the watcher a beat to reap so the pid can't be ours anymore.
            std::thread::sleep(std::time::Duration::from_millis(300));
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

/// Drop every registered connection for a named tunnel at the Cloudflare edge
/// (`cloudflared tunnel cleanup`). Run AFTER our connector is confirmed dead
/// and BEFORE spawning a fresh one: crashed/killed connectors (reconcile churn,
/// force-quit, laptop sleep) leave ghost registrations behind, and the edge
/// load-balances requests across ALL of them — dead ones included — which is
/// exactly the intermittent 502 that clears on refresh. Best-effort: a live
/// connector elsewhere that gets kicked simply re-registers on its own.
///
/// `hostname_hint` picks the per-zone origincert (same mechanism as `tunnel
/// route dns`) so cleanup works when the tunnel lives in a non-default account.
fn cleanup_stale_connections(cf: &str, name: &str, hostname_hint: Option<&str>) {
    let mut cmd = std::process::Command::new(cf);
    if let Some(cert) = hostname_hint.and_then(crate::cloudflared_certs::cert_for_hostname) {
        cmd.arg("--origincert").arg(cert);
    }
    let _ = cmd.args(["tunnel", "cleanup", name]).output();
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
    // Snapshot tunnel membership before clearing so we can notify each member
    // app of a named connector we're about to kill.
    let members_by_tunnel: HashMap<String, Vec<String>> = {
        let m = tunnel_members().lock().unwrap();
        m.iter()
            .map(|(k, v)| (k.clone(), v.iter().cloned().collect()))
            .collect()
    };
    let keys: Vec<String> = {
        let mut pids = tunnel_pids().lock().unwrap();
        let keys: Vec<String> = pids.keys().cloned().collect();
        for k in &keys {
            if let Some(pid) = pids.remove(k) {
                if k.starts_with("cfd-tunnel:") {
                    // Silence the connector's watcher — we emit for its members below.
                    restart_pids().lock().unwrap().insert(pid);
                } else {
                    // Quick app/instance tunnel: its own watcher emits the final
                    // `active:false`; just suppress the error annotation.
                    tunnel_stopping().lock().unwrap().insert(k.clone());
                }
                let _ = kill(Pid::from_raw(pid as i32), Signal::SIGTERM);
            }
        }
        keys
    };
    tunnel_members().lock().unwrap().clear();
    for k in &keys {
        if let Some(name) = k.strip_prefix("cfd-tunnel:") {
            if let Some(ids) = members_by_tunnel.get(name) {
                for id in ids {
                    let _ = app_handle.emit(
                        &format!("app:tunnel:{}", id),
                        serde_json::json!({ "active": false, "url": null }),
                    );
                }
            }
        }
    }
    keys.len()
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
pub fn stop_cloudflare_for_switch(id: &str, app_handle: &tauri::AppHandle) {
    // Named tunnel member? Drop it from the shared connector and reconcile so
    // the remaining members keep serving (or the connector tears down if this
    // was the last one). No `active:false` emit — the incoming provider owns
    // this app's channel now. reconcile's teardown is silent via `restart_pids`.
    let name = {
        let state = app_handle.state::<AppState>();
        let db = state.db.lock().unwrap();
        db.list_apps()
            .unwrap_or_default()
            .into_iter()
            .find(|a| a.id == id)
            .and_then(|a| a.tunnel_name)
            .map(|n| n.trim().to_string())
            .filter(|n| !n.is_empty())
    };
    if let Some(name) = name {
        let was_member = {
            let mut m = tunnel_members().lock().unwrap();
            let present = m.get(&name).map(|s| s.contains(id)).unwrap_or(false);
            if let Some(set) = m.get_mut(&name) {
                set.remove(id);
                if set.is_empty() {
                    m.remove(&name);
                }
            }
            present
        };
        if was_member {
            let handle = app_handle.clone();
            std::thread::spawn(move || {
                let _ = reconcile_named_tunnel(handle, name);
            });
        }
        return;
    }

    // Quick tunnel keyed by app id (legacy trycloudflare path).
    tunnel_switching().lock().unwrap().insert(id.to_string());
    tunnel_stopping().lock().unwrap().insert(id.to_string());
    if let Some(pid) = tunnel_pids().lock().unwrap().remove(id) {
        let _ = kill(Pid::from_raw(pid as i32), Signal::SIGTERM);
    }
}

/// One resolved cloudflared ingress rule in a tunnel's merged config.
/// App members target local Caddy with a per-rule `httpHostHeader` so Caddy can
/// multiplex by Host; instance members target their worktree port directly (no
/// Caddy route exists for an instance) and carry no host header.
#[derive(Debug, Clone, PartialEq)]
struct IngressRule {
    public: String,
    service: String,
    host_header: Option<String>,
    no_tls_verify: bool,
}

/// A member of a named tunnel plus the event channel + URL to notify it on.
/// Apps notify on `app:tunnel:{id}`, worktree instances on `instance:tunnel:{id}`.
#[derive(Debug, Clone)]
struct MemberInfo {
    channel: String,
    url: Option<String>,
}

/// Origin cloudflared connects to for Caddy-routed rules. Uses `127.0.0.1`, not
/// `localhost`: cloudflared resolves `localhost` to `::1` first on macOS, but
/// local origins (Caddy, dev servers) commonly bind only IPv4 `127.0.0.1`, so
/// `localhost` yields "connection refused" and the public URL 502s even though
/// the tunnel itself is up. Forcing IPv4 is the robust choice for loopback.
fn caddy_service(has_certs: bool) -> &'static str {
    if has_certs {
        "https://127.0.0.1:443"
    } else {
        "http://127.0.0.1:80"
    }
}

/// Build a cloudflared ingress config from resolved rules. A trailing
/// `http_status:404` catch-all is required by cloudflared. Duplicate public
/// hostnames keep their first occurrence (cloudflared matches top-down).
///
/// HTTPS rules also set `originServerName` to the local host: the service URL
/// dials the IP `127.0.0.1` (deliberate — `localhost` resolves to `::1` first
/// and dev origins bind IPv4 only), but Go sends NO SNI for IP addresses, and
/// Caddy selects its certificate BY SNI — an SNI-less handshake gets
/// "tlsv1 alert internal error" and the tunnel 502s on every request.
/// `originServerName` restores the SNI without reintroducing DNS resolution.
fn build_ingress_yaml(rules: &[IngressRule]) -> String {
    let mut yaml = String::new();
    yaml.push_str("# Generated by Porta — do not edit manually.\n");
    yaml.push_str("# Public hostname → local origin rules for this tunnel.\n");
    yaml.push_str("ingress:\n");
    for r in rules {
        let https = r.service.starts_with("https://");
        yaml.push_str(&format!("  - hostname: {}\n", r.public));
        yaml.push_str(&format!("    service: {}\n", r.service));
        if r.host_header.is_some() || r.no_tls_verify {
            yaml.push_str("    originRequest:\n");
            if let Some(h) = &r.host_header {
                yaml.push_str(&format!("      httpHostHeader: {}\n", h));
                if https {
                    yaml.push_str(&format!("      originServerName: {}\n", h));
                }
            }
            if r.no_tls_verify {
                yaml.push_str("      noTLSVerify: true\n");
            }
        }
    }
    yaml.push_str("  - service: http_status:404\n");
    yaml
}

/// Path of the merged ingress config for a named tunnel:
/// `~/.cloudflared/porta-tunnel-<name>.yml`. Keyed by tunnel name (sanitized
/// for the filesystem) because one connector — not one per app — serves the
/// whole tunnel.
fn tunnel_config_path(name: &str) -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let dir = PathBuf::from(home).join(".cloudflared");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let safe: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect();
    Ok(dir.join(format!("porta-tunnel-{}.yml", safe)))
}

/// Resolve a named tunnel's live members into (a) who to notify + on which
/// channel and (b) the merged ingress rules, read fresh from the DB.
///
/// - App members (bare-UUID ids) still bound to THIS tunnel with ≥1 public
///   hostname contribute Caddy-routed rules (per-rule host header).
/// - Instance members (`<uuid>:<branch>` ids) contribute a single direct-to-port
///   rule at `<instance-subdomain>.<parent-public-base>`, provided the parent
///   app is bound to this tunnel and has a derivable public base.
///
/// Members that can't contribute (vanished, reconfigured, no derivable host) are
/// dropped from BOTH lists so we never notify an app the connector can't serve.
fn resolve_tunnel(app_handle: &tauri::AppHandle, name: &str) -> (Vec<MemberInfo>, Vec<IngressRule>) {
    let members: std::collections::HashSet<String> = tunnel_members()
        .lock()
        .unwrap()
        .get(name)
        .cloned()
        .unwrap_or_default();
    if members.is_empty() {
        return (Vec::new(), Vec::new());
    }
    let (apps, instances, workspaces) = {
        let state = app_handle.state::<AppState>();
        let db = state.db.lock().unwrap();
        (
            db.list_apps().unwrap_or_default(),
            db.list_instances().unwrap_or_default(),
            db.list_workspaces().unwrap_or_default(),
        )
    };
    let has_certs = crate::setup::certs_exist();
    let caddy = caddy_service(has_certs).to_string();
    let mut infos = Vec::new();
    let mut rules = Vec::new();

    for a in &apps {
        if !members.contains(&a.id) {
            continue;
        }
        if a.tunnel_name.as_deref().map(str::trim) != Some(name) {
            continue;
        }
        let pairs = a.tunnel_public_hostnames(&workspaces);
        if pairs.is_empty() {
            continue;
        }
        for (public, local) in &pairs {
            rules.push(IngressRule {
                public: public.clone(),
                service: caddy.clone(),
                host_header: Some(local.clone()),
                no_tls_verify: has_certs,
            });
        }
        let url = a
            .tunnel_custom_hostname
            .as_deref()
            .map(str::trim)
            .filter(|h| !h.is_empty())
            .map(|h| format!("https://{}", h));
        infos.push(MemberInfo {
            channel: format!("app:tunnel:{}", a.id),
            url,
        });
    }

    for inst in &instances {
        if !members.contains(&inst.id) {
            continue;
        }
        // Instance hostname is derived from its parent app's tunnel domain, so
        // the parent must be on THIS tunnel and expose a registrable base.
        let parent = match apps.iter().find(|a| a.id == inst.app_id) {
            Some(p) => p,
            None => continue,
        };
        if parent.tunnel_name.as_deref().map(str::trim) != Some(name) {
            continue;
        }
        let base = match parent.tunnel_public_base() {
            Some(b) => b,
            None => continue,
        };
        let host = format!("{}.{}", inst.subdomain, base);
        rules.push(IngressRule {
            public: host.clone(),
            // Direct to the worktree's port — instances have no Caddy route.
            service: format!("http://127.0.0.1:{}", inst.port),
            host_header: None,
            no_tls_verify: false,
        });
        infos.push(MemberInfo {
            channel: format!("instance:tunnel:{}", inst.id),
            url: Some(format!("https://{}", host)),
        });
    }

    (infos, rules)
}

/// Emit `active:true` (with each member's own public URL) for every current
/// member of a named tunnel. Called once the connector logs its first
/// registered edge connection.
fn emit_members_active(app_handle: &tauri::AppHandle, name: &str) {
    let (infos, _) = resolve_tunnel(app_handle, name);
    for info in &infos {
        app_handle
            .emit(
                &info.channel,
                serde_json::json!({ "active": true, "url": info.url }),
            )
            .ok();
    }
}

/// (Re)start the single cloudflared connector for a named tunnel so it matches
/// the current membership: merged ingress for every member app, DNS routed for
/// every hostname, exactly one running process. Tears the connector down when
/// no members remain. Serialized across the process by `reconcile_lock` so
/// concurrent connects/disconnects can't spawn duplicate connectors.
fn reconcile_named_tunnel(app_handle: tauri::AppHandle, name: String) -> Result<(), String> {
    let _guard = reconcile_lock().lock().unwrap();
    let cf = find_cloudflared().ok_or_else(|| {
        "cloudflared not installed. Run: brew install cloudflare/cloudflare/cloudflared".to_string()
    })?;
    let key = tunnel_key(&name);

    let (infos, rules) = resolve_tunnel(&app_handle, &name);

    // No servable members left → tear the connector down. Silent: `stop_tunnel`
    // / `stop_cloudflare_for_switch` already emitted for the specific member.
    // Wait for the exit and sweep the edge so a full disconnect can't leave
    // ghost registrations behind for the next connect to trip over.
    if infos.is_empty() || rules.is_empty() {
        if let Some(pid) = tunnel_pids().lock().unwrap().remove(&key) {
            restart_pids().lock().unwrap().insert(pid);
            terminate_and_wait(pid, std::time::Duration::from_secs(8));
            cleanup_stale_connections(&cf, &name, None);
        }
        tunnel_metrics_ports().lock().unwrap().remove(&name);
        return Ok(());
    }

    // Merged ingress for every member.
    let cfg_path = tunnel_config_path(&name)?;
    std::fs::write(&cfg_path, build_ingress_yaml(&rules)).map_err(|e| e.to_string())?;

    // Route DNS for every member hostname. `--overwrite-dns` re-points existing
    // CNAMEs (without it, a CNAME to a different tunnel silently wins → 404 /
    // wrong origin). Pick the cert.pem authorized for each hostname's zone so
    // routing works across zones without swapping `~/.cloudflared/cert.pem`.
    for r in &rules {
        let mut cmd = std::process::Command::new(&cf);
        if let Some(cert) = crate::cloudflared_certs::cert_for_hostname(&r.public) {
            cmd.arg("--origincert").arg(cert);
        }
        let out = cmd
            .args(["tunnel", "route", "dns", "--overwrite-dns", &name, &r.public])
            .output();
        if let Ok(o) = out {
            if !o.status.success() {
                let stderr = String::from_utf8_lossy(&o.stderr).trim().to_string();
                let err_msg = format!("DNS route failed for {}:\n{}", r.public, stderr);
                for info in &infos {
                    app_handle
                        .emit(
                            &info.channel,
                            serde_json::json!({
                                "active": false,
                                "url": null,
                                "error": err_msg.clone(),
                            }),
                        )
                        .ok();
                }
                return Err(err_msg);
            }
        }
    }

    // Replace the old connector: mark its pid as an intentional restart (so its
    // watcher stays silent), kill it and WAIT for it to fully exit, then sweep
    // stale edge registrations before spawning the fresh connector. Order
    // matters — cleanup while the new connector is up would kick its live
    // connections too, and spawning before the old one exits races both the
    // unregister handshake and the config file.
    if let Some(pid) = tunnel_pids().lock().unwrap().remove(&key) {
        restart_pids().lock().unwrap().insert(pid);
        terminate_and_wait(pid, std::time::Duration::from_secs(8));
    }
    // Even with no tracked pid, ghosts may exist from a crashed/force-quit
    // previous session (this machine had 8 dead registrations on one tunnel) —
    // sweep unconditionally so every connect starts from a clean edge.
    cleanup_stale_connections(&cf, &name, rules.first().map(|r| r.public.as_str()));
    tunnel_stopping().lock().unwrap().remove(&key);

    let metrics_port = pick_free_port();
    if let Some(mp) = metrics_port {
        tunnel_metrics_ports()
            .lock()
            .unwrap()
            .insert(name.clone(), mp);
    }

    spawn_named_connector(app_handle, cf, name, key, cfg_path, metrics_port, infos);
    Ok(())
}

/// Spawn the cloudflared process for a named tunnel's merged ingress config and
/// watch its stderr: emit `active:true` for all members on first connection,
/// and on unexpected exit report the failure to every current member. A
/// deliberate restart/teardown (pid in `restart_pids`) exits silently.
#[allow(clippy::too_many_arguments)]
fn spawn_named_connector(
    app_handle: tauri::AppHandle,
    cf: String,
    name: String,
    key: String,
    cfg_path: PathBuf,
    metrics_port: Option<u16>,
    infos: Vec<MemberInfo>,
) {
    thread::spawn(move || {
        let mut args: Vec<String> = Vec::new();
        if let Some(p) = metrics_port {
            args.push("--metrics".into());
            args.push(format!("127.0.0.1:{}", p));
        }
        args.extend([
            "--config".into(),
            cfg_path.to_string_lossy().to_string(),
            "tunnel".into(),
            "run".into(),
            name.clone(),
        ]);

        let mut child = match std::process::Command::new(&cf)
            .args(&args)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                for info in &infos {
                    app_handle
                        .emit(
                            &info.channel,
                            serde_json::json!({ "active": false, "url": null, "error": e.to_string() }),
                        )
                        .ok();
                }
                return;
            }
        };
        let my_pid = child.id();
        tunnel_pids().lock().unwrap().insert(key.clone(), my_pid);

        let stderr_buf: std::sync::Arc<std::sync::Mutex<Vec<String>>> =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let stderr_handle = if let Some(stderr) = child.stderr.take() {
            let handle2 = app_handle.clone();
            let buf = stderr_buf.clone();
            let name2 = name.clone();
            Some(thread::spawn(move || {
                let mut connected = false;
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
                    if !connected && line.contains("Registered tunnel connection") {
                        connected = true;
                        emit_members_active(&handle2, &name2);
                    }
                }
            }))
        } else {
            None
        };

        let status = child.wait().ok();
        if let Some(h) = stderr_handle {
            let _ = h.join();
        }

        // Compare-and-remove so a concurrent restart's successor pid survives.
        {
            let mut pids = tunnel_pids().lock().unwrap();
            if pids.get(&key).copied() == Some(my_pid) {
                pids.remove(&key);
            }
        }
        // Deliberate restart/teardown → stay silent; the new connector (or the
        // stop path) owns the members' channels now.
        if restart_pids().lock().unwrap().remove(&my_pid) {
            return;
        }

        // Unexpected exit (crash, auth failure, bad config). Report to every
        // current member and clear membership so a reconnect rebuilds cleanly.
        tunnel_metrics_ports().lock().unwrap().remove(&name);
        let exit_code = status.and_then(|s| s.code()).unwrap_or(-1);
        let err_text = if exit_code != 0 {
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
                let joined = lines.join("\n");
                let lower = joined.to_lowercase();
                let hint = if lower.contains("unauthorized") || lower.contains("not logged in") {
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
        // Snapshot who to notify (with correct app/instance channels) BEFORE
        // clearing membership, so a reconnect rebuilds from an empty set.
        let (infos, _) = resolve_tunnel(&app_handle, &name);
        tunnel_members().lock().unwrap().remove(&name);
        for info in &infos {
            app_handle
                .emit(
                    &info.channel,
                    serde_json::json!({ "active": false, "url": null, "error": err_text.clone() }),
                )
                .ok();
        }
    });
}

/// Host portion of a tunnel URL (`https://foo.trycloudflare.com/x` → the bare
/// hostname), for DNS probing.
fn url_host(url: &str) -> Option<String> {
    url.split("://")
        .nth(1)?
        .split('/')
        .next()
        .map(|h| h.trim().to_string())
        .filter(|h| !h.is_empty())
}

/// Emit `{active:true, url}` on `channel` only once the freshly-minted quick
/// tunnel hostname actually resolves through the SYSTEM resolver — the same
/// getaddrinfo path browsers use. trycloudflare names are created at provision
/// time; handing the URL to the user before the local resolver can see it
/// (VPN/Tailscale MagicDNS paths are the usual laggards) ends in
/// ERR_NAME_NOT_RESOLVED even though the tunnel is up. Polling here doubles as
/// a cache warm-up, so by the time the UI shows the URL, clicking it works.
/// The UI keeps its pulsing "connecting" state until this emit settles it.
///
/// If it still doesn't resolve after ~30s, emit the URL anyway (it may resolve
/// on other devices) together with an actionable warning instead of leaving
/// the user to hit a mystery browser error.
fn emit_quick_url_when_resolvable(handle: tauri::AppHandle, channel: String, url: String) {
    thread::spawn(move || {
        let host = match url_host(&url) {
            Some(h) => h,
            None => {
                handle
                    .emit(&channel, serde_json::json!({ "active": true, "url": url }))
                    .ok();
                return;
            }
        };
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        let mut resolved = false;
        loop {
            if std::net::ToSocketAddrs::to_socket_addrs(&(host.as_str(), 443u16))
                .map(|mut a| a.next().is_some())
                .unwrap_or(false)
            {
                resolved = true;
                break;
            }
            if std::time::Instant::now() >= deadline {
                break;
            }
            thread::sleep(std::time::Duration::from_secs(1));
        }
        let payload = if resolved {
            serde_json::json!({ "active": true, "url": url })
        } else {
            serde_json::json!({
                "active": true,
                "url": url,
                "error": "Tunnel is up, but the URL doesn't resolve in local DNS yet. A VPN or Tailscale MagicDNS can delay new trycloudflare hostnames — retry in a few seconds, or use a named tunnel for a stable URL.",
            })
        };
        handle.emit(&channel, payload).ok();
    });
}

fn caddy_origin_args(host_header: &str, has_certs: bool) -> (String, Vec<String>) {
    let url = if has_certs {
        "https://127.0.0.1:443".to_string()
    } else {
        "http://127.0.0.1:80".to_string()
    };
    let mut extra = vec!["--http-host-header".into(), host_header.to_string()];
    if has_certs {
        // Caddy uses mkcert's CA which cloudflared doesn't trust by default.
        extra.push("--no-tls-verify".into());
        // Dialing the IP sends no SNI (Go omits SNI for IPs) and Caddy picks
        // its cert by SNI — force the local hostname so the handshake succeeds.
        extra.push("--origin-server-name".into());
        extra.push(host_header.to_string());
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
    // Resolve the app's provider + tunnel name up front. Named vs quick take
    // completely different paths: named tunnels are shared (one connector per
    // tunnel name, merged ingress), quick tunnels are per-app trycloudflare.
    let (tunnel_name, single_host_host_header) = {
        let state = app_handle.state::<AppState>();
        let db = state.db.lock().unwrap();
        let apps = db.list_apps().unwrap_or_default();
        let workspaces = db.list_workspaces().unwrap_or_default();
        match apps.into_iter().find(|a| a.id == id) {
            Some(a) => {
                let name = a
                    .tunnel_name
                    .clone()
                    .map(|n| n.trim().to_string())
                    .filter(|n| !n.is_empty());
                (name, single_host_caddy_host(&a, &workspaces))
            }
            None => (None, None),
        }
    };

    // Providers are mutually exclusive per app: switching to Cloudflare must
    // tear down any Tailscale serve / Porta Relay for this app first. Silent (no
    // event) so it doesn't clobber the `active:true` cloudflared emits once
    // connected.
    crate::commands::tailscale::stop_tailscale_for_switch(&id, &app_handle);
    crate::commands::remote::stop_remote_for_switch(&id, &app_handle);

    // ── Named tunnel: join the shared connector for this tunnel name. ────────
    // One cloudflared process serves the MERGED ingress of every member app.
    // Running one process per app instead would register each as an HA replica
    // of the same tunnel carrying only its own ingress, so the Cloudflare edge
    // forwards a hostname to whichever replica answers first and the wrong app
    // (or a 404) wins — the "two apps on nasrulgunawan.com, only one routes"
    // bug. reconcile_named_tunnel (re)builds and restarts the single connector.
    if let Some(name) = tunnel_name {
        tunnel_members()
            .lock()
            .unwrap()
            .entry(name.clone())
            .or_default()
            .insert(id.clone());
        return reconcile_named_tunnel(app_handle, name);
    }

    // ── Quick tunnel: per-app throwaway trycloudflare tunnel. ────────────────
    let cf = find_cloudflared().ok_or_else(|| {
        "cloudflared not installed. Run: brew install cloudflare/cloudflare/cloudflared".to_string()
    })?;

    // Apps needing a Caddy handler (static, basic auth, auto-sleep wake) point
    // cloudflared at Caddy and preserve the local Host header so Caddy matches
    // the right route; otherwise forward straight to the app's port.
    let (effective_url, caddy_extra_args): (String, Vec<String>) =
        if let Some(host) = single_host_host_header {
            let has_certs = crate::setup::certs_exist();
            caddy_origin_args(&host, has_certs)
        } else {
            (format!("http://127.0.0.1:{}", port), Vec::new())
        };

    // Kill any existing quick tunnel for this app and clear stale stopping marker.
    {
        let mut pids = tunnel_pids().lock().unwrap();
        if let Some(pid) = pids.remove(&id) {
            let _ = kill(Pid::from_raw(pid as i32), Signal::SIGTERM);
        }
    }
    tunnel_stopping().lock().unwrap().remove(&id);

    let id2 = id.clone();
    let handle = app_handle.clone();

    thread::spawn(move || {
        let mut args: Vec<String> = vec!["tunnel".into(), "--url".into(), effective_url];
        args.extend(caddy_extra_args);

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
        // cloudflared exits non-zero (e.g. no auth, network failure).
        let stderr_buf: std::sync::Arc<std::sync::Mutex<Vec<String>>> =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));

        let stderr_handle = if let Some(stderr) = child.stderr.take() {
            let id3 = id2.clone();
            let handle2 = handle.clone();
            let buf = stderr_buf.clone();
            Some(thread::spawn(move || {
                let mut url_emitted = false;
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
                    // Quick tunnel — scrape trycloudflare URL. Emit at most
                    // once (the banner can repeat the URL) and only after the
                    // hostname resolves locally, so the surfaced link works.
                    if url_emitted {
                        continue;
                    }
                    if let Some(pos) = line.find("https://") {
                        let url = line[pos..]
                            .split_whitespace()
                            .next()
                            .unwrap_or("")
                            .trim_end_matches('|')
                            .trim()
                            .to_string();
                        if url.contains("trycloudflare.com") || url.contains(".cloudflare.com") {
                            url_emitted = true;
                            emit_quick_url_when_resolvable(
                                handle2.clone(),
                                format!("app:tunnel:{}", id3),
                                url,
                            );
                        }
                    }
                }
            }))
        } else {
            None
        };

        let status = child.wait().ok();
        if let Some(h) = stderr_handle {
            let _ = h.join();
        }

        // Tunnel ended — clean up and notify frontend.
        tunnel_pids().lock().unwrap().remove(&id2);
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
        // provider switch — the incoming provider already owns this channel.
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
pub fn stop_tunnel(id: String, app_handle: tauri::AppHandle) -> Result<(), String> {
    // Named tunnel member? Drop it and reconcile the shared connector: the other
    // members keep serving, or the connector tears down if this was the last.
    let name = {
        let state = app_handle.state::<AppState>();
        let db = state.db.lock().unwrap();
        db.list_apps()
            .unwrap_or_default()
            .into_iter()
            .find(|a| a.id == id)
            .and_then(|a| a.tunnel_name)
            .map(|n| n.trim().to_string())
            .filter(|n| !n.is_empty())
    };

    if let Some(name) = name {
        {
            let mut m = tunnel_members().lock().unwrap();
            if let Some(set) = m.get_mut(&name) {
                set.remove(&id);
                if set.is_empty() {
                    m.remove(&name);
                }
            }
        }
        // Emit disconnect for THIS app immediately (the connector may keep
        // running for the remaining members).
        app_handle
            .emit(
                &format!("app:tunnel:{}", id),
                serde_json::json!({ "active": false, "url": null }),
            )
            .ok();
        // Rebuild/tear-down off-thread: reconcile shells out to cloudflared.
        let handle = app_handle.clone();
        std::thread::spawn(move || {
            let _ = reconcile_named_tunnel(handle, name);
        });
        return Ok(());
    }

    // Quick tunnel / instance path keyed by app id.
    tunnel_stopping().lock().unwrap().insert(id.clone());
    if let Some(pid) = tunnel_pids().lock().unwrap().remove(&id) {
        let _ = kill(Pid::from_raw(pid as i32), Signal::SIGTERM);
    }
    Ok(())
}

// ── Per-instance quick tunnel ───────────────────────────────────────────────
//
// Worktree instances are ephemeral (spun up/torn down with the worktree), so
// named tunnels / DNS routing are intentionally unsupported here — quick
// (trycloudflare) only. `tunnel_pids`/`tunnel_stopping` above are already a
// generic `HashMap<String, _>` / `HashSet<String>` keyed by id, and instance
// ids can never collide with app ids — app ids are bare UUIDs, while instance
// ids are always `format!("{app_id}:{branch}")` (they always contain a
// colon), so a bare UUID can never equal `<uuid>:<branch>` — so we reuse
// them directly instead of adding a parallel map to `AppState`.
//
// This does NOT call into `start_tunnel_blocking` or share a helper with it.
// That function interleaves named-tunnel DNS routing, multi-host ingress-yaml
// generation, and the quick-tunnel scrape so tightly — one closure branching
// on `is_named` throughout, shared metrics-port bookkeeping, shared
// provider-switch teardown — that extracting a `spawn_quick_tunnel` piece
// both paths call would mean restructuring that closure, which risks
// changing existing app-tunnel behavior. The instance path only needs the
// "spawn `cloudflared tunnel --url <target>`, scrape the trycloudflare.com
// URL from stderr, emit, clean up on exit" slice (mirrors tunnel.rs:528-546
// as closely as possible for parity, minus the named-tunnel branch and Caddy
// host-header indirection instances don't need), so a small self-contained
// copy here is safer than a forced refactor of the shared app path.
//
// Instances also don't carry the app-level flags (`auto_sleep_enabled`,
// `basic_auth_enabled`, `is_static()`) that make the app path route through
// Caddy — the quick tunnel just forwards straight to the instance's own
// `http://localhost:<port>`, matching `start_tunnel`'s fallback branch for
// apps that need none of those features.
fn spawn_quick_tunnel_for_instance(
    app_handle: tauri::AppHandle,
    channel: String,
    key: String,
    port: u16,
) -> Result<(), String> {
    let cf = find_cloudflared().ok_or_else(|| {
        "cloudflared not installed. Run: brew install cloudflare/cloudflare/cloudflared".to_string()
    })?;

    // Kill any existing tunnel tracked under this key and clear a stale
    // "intentional stop" marker from a previous run.
    {
        let mut pids = tunnel_pids().lock().unwrap();
        if let Some(pid) = pids.remove(&key) {
            let _ = kill(Pid::from_raw(pid as i32), Signal::SIGTERM);
        }
    }
    tunnel_stopping().lock().unwrap().remove(&key);

    // Force IPv4 loopback: cloudflared resolves `localhost` to `::1` first on
    // macOS, but dev servers commonly bind only IPv4 `127.0.0.1`, so a
    // `localhost` origin yields "connection refused" and the trycloudflare URL
    // 502s even though the tunnel connected.
    let target = format!("http://127.0.0.1:{}", port);
    let key2 = key.clone();
    let channel2 = channel.clone();
    let handle = app_handle.clone();

    thread::spawn(move || {
        let mut child = match std::process::Command::new(&cf)
            .args(["tunnel", "--url", &target])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                handle
                    .emit(
                        &channel2,
                        serde_json::json!({ "active": false, "url": null, "error": e.to_string() }),
                    )
                    .ok();
                return;
            }
        };

        tunnel_pids().lock().unwrap().insert(key2.clone(), child.id());

        // Capture last N stderr lines so we can surface a real error if
        // cloudflared exits non-zero, same as the app quick-tunnel path.
        let stderr_buf: std::sync::Arc<std::sync::Mutex<Vec<String>>> =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));

        let stderr_handle = if let Some(stderr) = child.stderr.take() {
            let handle2 = handle.clone();
            let buf = stderr_buf.clone();
            let channel3 = channel2.clone();
            Some(thread::spawn(move || {
                let mut url_emitted = false;
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
                    // Quick tunnel — scrape trycloudflare URL (same detection
                    // as the app path's quick branch), emitted once and only
                    // after the hostname resolves locally.
                    if url_emitted {
                        continue;
                    }
                    if let Some(pos) = line.find("https://") {
                        let url = line[pos..]
                            .split_whitespace()
                            .next()
                            .unwrap_or("")
                            .trim_end_matches('|')
                            .trim()
                            .to_string();
                        if url.contains("trycloudflare.com") || url.contains(".cloudflare.com") {
                            url_emitted = true;
                            emit_quick_url_when_resolvable(
                                handle2.clone(),
                                channel3.clone(),
                                url,
                            );
                        }
                    }
                }
            }))
        } else {
            None
        };

        let status = child.wait().ok();
        if let Some(h) = stderr_handle {
            let _ = h.join();
        }

        tunnel_pids().lock().unwrap().remove(&key2);
        let intentional = tunnel_stopping().lock().unwrap().remove(&key2);
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
                Some(lines.join("\n"))
            }
        } else {
            None
        };

        handle
            .emit(
                &channel2,
                serde_json::json!({ "active": false, "url": null, "error": err_text }),
            )
            .ok();
    });

    Ok(())
}

/// Start a tunnel for a worktree instance. Prefers the parent app's NAMED
/// tunnel when one is configured (and the parent has a derivable public domain):
/// the instance joins that tunnel's shared connector as a member exposed at
/// `<instance-subdomain>.<parent-domain>`, routed straight to the worktree port.
/// This gives a stable URL on the user's own domain and sidesteps the frequent
/// trycloudflare provisioning/reachability flakiness. Falls back to a throwaway
/// QUICK (trycloudflare) tunnel when the parent has no named tunnel.
/// Emits `instance:tunnel:{instance_id}` with { active, url, error }.
#[tauri::command]
pub async fn start_instance_tunnel(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    instance_id: String,
) -> Result<(), String> {
    let (inst, parent_named) = {
        let db = state.db.lock().unwrap();
        let inst = db
            .list_instances()
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|i| i.id == instance_id)
            .ok_or_else(|| "instance not found".to_string())?;
        // Named tunnel is available only if the parent app has both a tunnel
        // name and a registrable base to derive the instance hostname from.
        let parent_named = db.list_apps().unwrap_or_default().into_iter().find_map(|a| {
            if a.id != inst.app_id {
                return None;
            }
            let name = a.tunnel_name.as_deref().map(str::trim).filter(|s| !s.is_empty())?;
            a.tunnel_public_base().map(|_| name.to_string())
        });
        (inst, parent_named)
    };

    if let Some(name) = parent_named {
        // Switching from a stale quick tunnel to named: kill any quick child
        // tracked under the instance id first so it can't linger. Only mark it
        // "stopping" if one actually existed, so we don't leave a stale marker
        // that would swallow a future quick tunnel's exit error.
        if let Some(pid) = tunnel_pids().lock().unwrap().remove(&inst.id) {
            tunnel_stopping().lock().unwrap().insert(inst.id.clone());
            let _ = kill(Pid::from_raw(pid as i32), Signal::SIGTERM);
        }
        tunnel_members()
            .lock()
            .unwrap()
            .entry(name.clone())
            .or_default()
            .insert(inst.id.clone());
        return tauri::async_runtime::spawn_blocking(move || reconcile_named_tunnel(app, name))
            .await
            .map_err(|e| e.to_string())?;
    }

    spawn_quick_tunnel_for_instance(
        app,
        format!("instance:tunnel:{}", inst.id),
        inst.id.clone(),
        inst.port,
    )
}

/// Stop an instance's tunnel. If it joined its parent's named tunnel, drop it
/// from that connector's membership and reconcile (the other members keep
/// serving). Otherwise kill the tracked quick cloudflared child; its watcher
/// emits the final `{ active: false }` on exit.
#[tauri::command]
pub fn stop_instance_tunnel(instance_id: String, app_handle: tauri::AppHandle) -> Result<(), String> {
    // Which named tunnel (if any) is this instance a member of? Derive from the
    // parent app's tunnel name, then confirm membership.
    let named = {
        let state = app_handle.state::<AppState>();
        let db = state.db.lock().unwrap();
        let parent_id = db
            .list_instances()
            .unwrap_or_default()
            .into_iter()
            .find(|i| i.id == instance_id)
            .map(|i| i.app_id);
        parent_id.and_then(|pid| {
            db.list_apps()
                .unwrap_or_default()
                .into_iter()
                .find(|a| a.id == pid)
                .and_then(|a| a.tunnel_name)
                .map(|n| n.trim().to_string())
                .filter(|n| !n.is_empty())
        })
    };

    if let Some(name) = named {
        let was_member = {
            let mut m = tunnel_members().lock().unwrap();
            let present = m.get(&name).map(|s| s.contains(&instance_id)).unwrap_or(false);
            if let Some(set) = m.get_mut(&name) {
                set.remove(&instance_id);
                if set.is_empty() {
                    m.remove(&name);
                }
            }
            present
        };
        if was_member {
            app_handle
                .emit(
                    &format!("instance:tunnel:{}", instance_id),
                    serde_json::json!({ "active": false, "url": null }),
                )
                .ok();
            let handle = app_handle.clone();
            std::thread::spawn(move || {
                let _ = reconcile_named_tunnel(handle, name);
            });
            return Ok(());
        }
    }

    // Quick tunnel keyed by instance id.
    tunnel_stopping().lock().unwrap().insert(instance_id.clone());
    if let Some(pid) = tunnel_pids().lock().unwrap().remove(&instance_id) {
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

        // 127.0.0.1, not localhost: cloudflared prefers ::1 for localhost but
        // Caddy/dev servers bind IPv4 only. The IP dial sends no SNI, so the
        // origin server name must be forced for Caddy's cert selection.
        assert_eq!(url, "https://127.0.0.1:443");
        assert_eq!(
            args,
            vec![
                "--http-host-header".to_string(),
                "demo.narakarya.test".to_string(),
                "--no-tls-verify".to_string(),
                "--origin-server-name".to_string(),
                "demo.narakarya.test".to_string(),
            ]
        );
    }

    fn caddy_rule(public: &str, local: &str, has_certs: bool) -> IngressRule {
        IngressRule {
            public: public.into(),
            service: caddy_service(has_certs).into(),
            host_header: Some(local.into()),
            no_tls_verify: has_certs,
        }
    }

    // The core of the shared-tunnel fix: hostnames from MULTIPLE apps all land
    // in one ingress table, each keeping its own per-rule host header, with a
    // single trailing 404 catch-all. This is what lets one connector route
    // `aus.nasrulgunawan.com` and `tgr-bwi-26.nasrulgunawan.com` to different
    // apps instead of the last-started app capturing both.
    #[test]
    fn merged_ingress_covers_every_app_hostname_with_one_catch_all() {
        let rules = vec![
            caddy_rule("aus.nasrulgunawan.com", "nexus.narakarya.test", true),
            caddy_rule("tgr-bwi-26.nasrulgunawan.com", "touring.narakarya.test", true),
        ];
        let yaml = build_ingress_yaml(&rules);

        // Both public hostnames are present…
        assert!(yaml.contains("hostname: aus.nasrulgunawan.com"));
        assert!(yaml.contains("hostname: tgr-bwi-26.nasrulgunawan.com"));
        // …each rewriting to its OWN local Caddy host (no global override)…
        assert!(yaml.contains("httpHostHeader: nexus.narakarya.test"));
        assert!(yaml.contains("httpHostHeader: touring.narakarya.test"));
        // …and there is exactly one 404 catch-all, at the end.
        assert_eq!(yaml.matches("http_status:404").count(), 1);
        assert!(yaml.trim_end().ends_with("- service: http_status:404"));
    }

    #[test]
    fn url_host_extracts_bare_hostname() {
        assert_eq!(
            url_host("https://baptist-executive.trycloudflare.com").as_deref(),
            Some("baptist-executive.trycloudflare.com")
        );
        assert_eq!(
            url_host("https://foo.trycloudflare.com/path?q=1").as_deref(),
            Some("foo.trycloudflare.com")
        );
        assert_eq!(url_host("not-a-url"), None);
        assert_eq!(url_host("https://"), None);
    }

    // Regression guard for the SNI-less 502: dialing 127.0.0.1 means Go sends
    // no SNI, Caddy can't pick a cert, and every tunneled request 502s. HTTPS
    // rules must carry originServerName; plain-HTTP rules must not.
    #[test]
    fn https_ingress_sets_origin_server_name_for_sni() {
        let yaml = build_ingress_yaml(&[caddy_rule("a.example.com", "a.narakarya.test", true)]);
        assert!(yaml.contains("originServerName: a.narakarya.test"));

        // No certs → plain HTTP to Caddy → no TLS, no SNI needed.
        let yaml = build_ingress_yaml(&[caddy_rule("a.example.com", "a.narakarya.test", false)]);
        assert!(!yaml.contains("originServerName"));

        // Instance rules dial the port directly over HTTP — no SNI either.
        let yaml = build_ingress_yaml(&[IngressRule {
            public: "feat-x.example.com".into(),
            service: "http://127.0.0.1:5311".into(),
            host_header: None,
            no_tls_verify: false,
        }]);
        assert!(!yaml.contains("originServerName"));
    }

    #[test]
    fn ingress_service_follows_cert_presence() {
        assert!(build_ingress_yaml(&[caddy_rule("a.example.com", "a.narakarya.test", true)])
            .contains("service: https://127.0.0.1:443"));
        assert!(build_ingress_yaml(&[caddy_rule("a.example.com", "a.narakarya.test", false)])
            .contains("service: http://127.0.0.1:80"));
        // noTLSVerify only when we terminate at Caddy's mkcert TLS.
        assert!(build_ingress_yaml(&[caddy_rule("a.example.com", "a.narakarya.test", true)])
            .contains("noTLSVerify: true"));
        assert!(!build_ingress_yaml(&[caddy_rule("a.example.com", "a.narakarya.test", false)])
            .contains("noTLSVerify"));
    }

    // Instance members forward straight to the worktree port with NO host header
    // (no Caddy route exists for an instance) — mixed freely with app rules in
    // the same merged table.
    #[test]
    fn instance_rule_targets_port_directly_no_host_header() {
        let app_rule = caddy_rule("aus.nasrulgunawan.com", "nexus.narakarya.test", true);
        let inst_rule = IngressRule {
            public: "feat-x.nasrulgunawan.com".into(),
            service: "http://127.0.0.1:5311".into(),
            host_header: None,
            no_tls_verify: false,
        };
        let yaml = build_ingress_yaml(&[app_rule, inst_rule]);

        assert!(yaml.contains("hostname: feat-x.nasrulgunawan.com"));
        assert!(yaml.contains("service: http://127.0.0.1:5311"));
        // The instance rule carries no originRequest block of its own; only the
        // app rule's httpHostHeader appears.
        assert_eq!(yaml.matches("httpHostHeader").count(), 1);
        assert!(yaml.contains("httpHostHeader: nexus.narakarya.test"));
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
