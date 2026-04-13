use std::collections::HashMap;
use std::io::BufRead;
use std::sync::{Mutex, OnceLock};
use std::thread;
use nix::sys::signal::{kill, Signal};
use nix::unistd::Pid;
use tauri::Emitter;

fn tunnel_pids() -> &'static Mutex<HashMap<String, u32>> {
    static T: OnceLock<Mutex<HashMap<String, u32>>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(HashMap::new()))
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

#[tauri::command]
pub fn start_tunnel(id: String, port: u16, app_handle: tauri::AppHandle) -> Result<(), String> {
    let cf = find_cloudflared().ok_or_else(|| {
        "cloudflared not installed. Run: brew install cloudflare/cloudflare/cloudflared".to_string()
    })?;

    // Kill any existing tunnel for this app
    {
        let mut pids = tunnel_pids().lock().unwrap();
        if let Some(pid) = pids.remove(&id) {
            let _ = kill(Pid::from_raw(pid as i32), Signal::SIGTERM);
        }
    }

    let id2 = id.clone();
    let handle = app_handle.clone();

    thread::spawn(move || {
        let mut child = match std::process::Command::new(&cf)
            .args(["tunnel", "--url", &format!("http://localhost:{}", port)])
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

        // cloudflared outputs the assigned URL to stderr
        if let Some(stderr) = child.stderr.take() {
            let id3 = id2.clone();
            let handle2 = handle.clone();
            thread::spawn(move || {
                for line in std::io::BufReader::new(stderr).lines().map_while(Result::ok) {
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
            });
        }

        let _ = child.wait();

        // Tunnel ended — clean up and notify frontend
        tunnel_pids().lock().unwrap().remove(&id2);
        handle
            .emit(
                &format!("app:tunnel:{}", id2),
                serde_json::json!({ "active": false, "url": null }),
            )
            .ok();
    });

    Ok(())
}

#[tauri::command]
pub fn stop_tunnel(id: String) -> Result<(), String> {
    if let Some(pid) = tunnel_pids().lock().unwrap().remove(&id) {
        let _ = kill(Pid::from_raw(pid as i32), Signal::SIGTERM);
    }
    Ok(())
}
