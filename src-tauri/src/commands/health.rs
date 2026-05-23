use std::collections::HashMap;
use std::net::TcpStream;
use std::time::{Duration, Instant};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::app_state::AppState;
use crate::health::HealthStatus;
use crate::commands::settings::{read_porta_config, write_porta_config};

/// Per-app health probe. The actual check (HTTP GET or TCP connect) is
/// blocking, so we offload to spawn_blocking — without that, every AppCard's
/// 10s health poll would pin a Tauri worker for up to 2s of network I/O and
/// queue everything else behind it.
#[tauri::command]
pub async fn check_app_health(state: State<'_, AppState>, id: String) -> Result<HealthStatus, String> {
    let probe = {
        let db = state.db.lock().unwrap();
        let apps = db.list_apps().map_err(|e| e.to_string())?;
        let app = apps.into_iter().find(|a| a.id == id).ok_or("App not found")?;
        if app.status != "running" {
            return Ok(HealthStatus::Unknown);
        }
        (app.port, app.health_check_path.clone())
    };
    let (port, path) = probe;
    tokio::task::spawn_blocking(move || crate::health::check_health(port, path.as_deref()))
        .await
        .map_err(|e| format!("health task failed: {}", e))
}

/// Bulk health probe. We collect the (port, path) pairs first, drop the DB
/// lock, then run all probes concurrently on the blocking pool. Sequential
/// blocking probes inside one sync command was the worst case — with 10
/// running apps it could take 20s end-to-end while holding the Tauri worker.
#[tauri::command]
pub async fn check_all_health(state: State<'_, AppState>) -> Result<HashMap<String, HealthStatus>, String> {
    let probes: Vec<(String, u16, Option<String>)> = {
        let db = state.db.lock().unwrap();
        let apps = db.list_apps().map_err(|e| e.to_string())?;
        apps.into_iter()
            .filter(|a| a.status == "running")
            .map(|a| (a.id, a.port, a.health_check_path))
            .collect()
    };

    let mut handles = Vec::with_capacity(probes.len());
    for (id, port, path) in probes {
        handles.push(tokio::task::spawn_blocking(move || {
            (id, crate::health::check_health(port, path.as_deref()))
        }));
    }

    let mut result = HashMap::new();
    for h in handles {
        if let Ok((id, status)) = h.await {
            result.insert(id, status);
        }
    }
    Ok(result)
}

// ── Per-app custom probes ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProbeKind {
    Http,
    Tcp,
    Cmd,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthProbe {
    pub kind: ProbeKind,
    pub target: String,
    pub interval_sec: u32,
    pub timeout_sec: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_http_status: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_exit_code: Option<i32>,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProbeResult {
    pub ok: bool,
    pub latency_ms: u32,
    pub message: String,
    pub checked_at: i64,
}

const PROBES_KEY: &str = "app_health_probes";

fn read_probes() -> HashMap<String, HealthProbe> {
    let cfg = read_porta_config();
    cfg.get(PROBES_KEY)
        .and_then(|v| serde_json::from_value::<HashMap<String, HealthProbe>>(v.clone()).ok())
        .unwrap_or_default()
}

fn write_probes(probes: &HashMap<String, HealthProbe>) {
    let mut cfg = read_porta_config();
    cfg[PROBES_KEY] = serde_json::to_value(probes).unwrap_or(serde_json::json!({}));
    write_porta_config(&cfg);
}

fn clamp_probe(mut p: HealthProbe) -> HealthProbe {
    p.interval_sec = p.interval_sec.clamp(1, 3600);
    p.timeout_sec = p.timeout_sec.clamp(1, 120);
    p
}

#[tauri::command]
pub fn get_app_health_probe(app_id: String) -> Option<HealthProbe> {
    read_probes().remove(&app_id)
}

#[tauri::command]
pub fn set_app_health_probe(app_id: String, probe: HealthProbe) {
    let mut probes = read_probes();
    probes.insert(app_id, clamp_probe(probe));
    write_probes(&probes);
}

#[tauri::command]
pub fn clear_app_health_probe(app_id: String) {
    let mut probes = read_probes();
    probes.remove(&app_id);
    write_probes(&probes);
}

#[tauri::command]
pub async fn run_app_health_probe(state: State<'_, AppState>, app_id: String) -> Result<ProbeResult, String> {
    // Prefer the user-configured probe; otherwise synthesize one from the
    // existing app fields so callers get a uniform result shape regardless of
    // whether the user has customized anything yet.
    let probe = read_probes().remove(&app_id);
    let probe = match probe {
        Some(p) => p,
        None => {
            let db = state.db.lock().unwrap();
            let apps = db.list_apps().map_err(|e| e.to_string())?;
            let app = apps.into_iter().find(|a| a.id == app_id).ok_or("App not found")?;
            match app.health_check_path {
                Some(path) => HealthProbe {
                    kind: ProbeKind::Http,
                    target: format!("http://localhost:{}{}", app.port, path),
                    interval_sec: 10,
                    timeout_sec: 2,
                    expected_http_status: None,
                    expected_exit_code: None,
                    enabled: true,
                },
                None => HealthProbe {
                    kind: ProbeKind::Tcp,
                    target: format!("127.0.0.1:{}", app.port),
                    interval_sec: 10,
                    timeout_sec: 2,
                    expected_http_status: None,
                    expected_exit_code: None,
                    enabled: true,
                },
            }
        }
    };

    let probe = clamp_probe(probe);
    Ok(execute_probe(probe).await)
}

async fn execute_probe(probe: HealthProbe) -> ProbeResult {
    let started = Instant::now();
    let now_ts = chrono::Utc::now().timestamp();
    match probe.kind {
        ProbeKind::Http => run_http(&probe, started, now_ts).await,
        ProbeKind::Tcp => run_tcp(&probe, started, now_ts).await,
        ProbeKind::Cmd => run_cmd(&probe, started, now_ts).await,
    }
}

async fn run_http(probe: &HealthProbe, started: Instant, now_ts: i64) -> ProbeResult {
    let target = probe.target.clone();
    let timeout = Duration::from_secs(probe.timeout_sec.max(1) as u64);
    let expected = probe.expected_http_status;

    let res = tokio::task::spawn_blocking(move || {
        let client = match reqwest::blocking::Client::builder().timeout(timeout).build() {
            Ok(c) => c,
            Err(e) => return Err(format!("client init: {}", e)),
        };
        client.get(&target).send().map_err(|e| e.to_string())
    })
    .await;

    let latency = started.elapsed().as_millis() as u32;
    match res {
        Ok(Ok(resp)) => {
            let status = resp.status().as_u16();
            let ok = match expected {
                Some(want) => status == want,
                None => (200..400).contains(&status),
            };
            ProbeResult {
                ok,
                latency_ms: latency,
                message: format!("{} {}", status, resp.status().canonical_reason().unwrap_or("")),
                checked_at: now_ts,
            }
        }
        Ok(Err(e)) => ProbeResult {
            ok: false,
            latency_ms: latency,
            message: e,
            checked_at: now_ts,
        },
        Err(e) => ProbeResult {
            ok: false,
            latency_ms: latency,
            message: format!("task: {}", e),
            checked_at: now_ts,
        },
    }
}

async fn run_tcp(probe: &HealthProbe, started: Instant, now_ts: i64) -> ProbeResult {
    let target = probe.target.clone();
    let timeout = Duration::from_secs(probe.timeout_sec.max(1) as u64);

    let res = tokio::task::spawn_blocking(move || {
        let addr = match target.to_socket_addrs_loose() {
            Some(a) => a,
            None => return Err(format!("invalid target: {}", target)),
        };
        TcpStream::connect_timeout(&addr, timeout).map(|_| ()).map_err(|e| e.to_string())
    })
    .await;

    let latency = started.elapsed().as_millis() as u32;
    match res {
        Ok(Ok(())) => ProbeResult {
            ok: true,
            latency_ms: latency,
            message: "connected".into(),
            checked_at: now_ts,
        },
        Ok(Err(e)) => ProbeResult {
            ok: false,
            latency_ms: latency,
            message: e,
            checked_at: now_ts,
        },
        Err(e) => ProbeResult {
            ok: false,
            latency_ms: latency,
            message: format!("task: {}", e),
            checked_at: now_ts,
        },
    }
}

async fn run_cmd(probe: &HealthProbe, started: Instant, now_ts: i64) -> ProbeResult {
    let target = probe.target.clone();
    let timeout = Duration::from_secs(probe.timeout_sec.max(1) as u64);
    let expected = probe.expected_exit_code.unwrap_or(0);

    let fut = async move {
        tokio::process::Command::new("sh")
            .arg("-c")
            .arg(&target)
            .output()
            .await
    };

    let res = tokio::time::timeout(timeout, fut).await;
    let latency = started.elapsed().as_millis() as u32;
    match res {
        Ok(Ok(out)) => {
            let code = out.status.code().unwrap_or(-1);
            let ok = code == expected;
            let msg = if ok {
                format!("exit {}", code)
            } else {
                let stderr = String::from_utf8_lossy(&out.stderr);
                let trimmed = stderr.trim();
                if trimmed.is_empty() {
                    format!("exit {}", code)
                } else {
                    format!("exit {} — {}", code, truncate(trimmed, 200))
                }
            };
            ProbeResult { ok, latency_ms: latency, message: msg, checked_at: now_ts }
        }
        Ok(Err(e)) => ProbeResult {
            ok: false,
            latency_ms: latency,
            message: format!("spawn: {}", e),
            checked_at: now_ts,
        },
        Err(_) => ProbeResult {
            ok: false,
            latency_ms: latency,
            message: format!("timeout after {}s", probe.timeout_sec),
            checked_at: now_ts,
        },
    }
}

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(n).collect();
        out.push('…');
        out
    }
}

// Tiny helper trait so run_tcp can accept either "host:port" or a bare
// "ip:port" string without dragging in a DNS resolver.
trait ToSocketAddrsLoose {
    fn to_socket_addrs_loose(&self) -> Option<std::net::SocketAddr>;
}

impl ToSocketAddrsLoose for String {
    fn to_socket_addrs_loose(&self) -> Option<std::net::SocketAddr> {
        use std::net::ToSocketAddrs;
        self.as_str().to_socket_addrs().ok().and_then(|mut it| it.next())
    }
}
