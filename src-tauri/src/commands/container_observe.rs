use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{Emitter, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use crate::app_state::AppState;
use crate::docker_manager::{docker_bin, resolve_compose_path, DockerManager};

#[derive(Default)]
pub struct LogStreams {
    inner: Arc<Mutex<HashMap<String, Child>>>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ContainerInfo {
    pub id: String,
    pub name: String,
    pub image: String,
    pub state: String,
    pub status: String,
    pub ports: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ContainerStats {
    pub cpu_pct: f64,
    pub mem_usage_bytes: u64,
    pub mem_limit_bytes: u64,
    pub mem_pct: f64,
    pub net_rx_bytes: u64,
    pub net_tx_bytes: u64,
    pub block_read_bytes: u64,
    pub block_write_bytes: u64,
}

#[derive(Serialize, Clone)]
pub struct LogLine {
    pub stream: String,
    pub text: String,
    pub ts: i64,
}

// ── parsing helpers ─────────────────────────────────────────────────────────

fn parse_pct(s: &str) -> f64 {
    s.trim().trim_end_matches('%').trim().parse::<f64>().unwrap_or(0.0)
}

fn parse_size(s: &str) -> u64 {
    let s = s.trim();
    if s.is_empty() || s == "--" || s == "-" {
        return 0;
    }
    let idx = s.find(|c: char| c.is_alphabetic()).unwrap_or(s.len());
    let (num_str, unit) = (&s[..idx], &s[idx..]);
    let num: f64 = num_str.trim().parse().unwrap_or(0.0);
    let mult: f64 = match unit.trim() {
        "" | "B" => 1.0,
        "kB" | "KB" | "k" => 1_000.0,
        "MB" | "M" => 1_000_000.0,
        "GB" | "G" => 1_000_000_000.0,
        "TB" | "T" => 1_000_000_000_000.0,
        "KiB" => 1024.0,
        "MiB" => 1024.0 * 1024.0,
        "GiB" => 1024.0_f64.powi(3),
        "TiB" => 1024.0_f64.powi(4),
        _ => 1.0,
    };
    (num * mult) as u64
}

/// "1.2GB / 5GB" → (usage, limit)
fn parse_pair(s: &str) -> (u64, u64) {
    let mut parts = s.split('/');
    let a = parts.next().map(parse_size).unwrap_or(0);
    let b = parts.next().map(parse_size).unwrap_or(0);
    (a, b)
}

// ── containers_for_app ──────────────────────────────────────────────────────

#[derive(Deserialize)]
struct ComposePsLine {
    #[serde(rename = "ID", default)]
    id: String,
    #[serde(rename = "Name", default)]
    name: String,
    #[serde(rename = "Image", default)]
    image: String,
    #[serde(rename = "State", default)]
    state: String,
    #[serde(rename = "Status", default)]
    status: String,
    #[serde(rename = "Publishers", default)]
    publishers: serde_json::Value,
    #[serde(rename = "Ports", default)]
    ports: String,
}

fn ports_from_publishers(v: &serde_json::Value) -> String {
    if let Some(arr) = v.as_array() {
        let parts: Vec<String> = arr
            .iter()
            .filter_map(|p| {
                let host = p.get("PublishedPort").and_then(|x| x.as_u64()).unwrap_or(0);
                let target = p.get("TargetPort").and_then(|x| x.as_u64()).unwrap_or(0);
                let proto = p.get("Protocol").and_then(|x| x.as_str()).unwrap_or("tcp");
                if host == 0 && target == 0 {
                    return None;
                }
                if host == 0 {
                    Some(format!("{}/{}", target, proto))
                } else {
                    Some(format!("{}:{}/{}", host, target, proto))
                }
            })
            .collect();
        return parts.join(", ");
    }
    String::new()
}

#[tauri::command]
pub async fn containers_for_app(
    state: State<'_, AppState>,
    app_id: String,
) -> Result<Vec<ContainerInfo>, String> {
    // Look up the app to determine compose_file + root_dir.
    let (compose_file, root_dir) = {
        let db = state.db.lock().unwrap();
        let apps = db.list_apps().map_err(|e| e.to_string())?;
        let app = apps
            .into_iter()
            .find(|a| a.id == app_id)
            .ok_or_else(|| format!("app {} not found", app_id))?;
        (app.compose_file.clone(), app.root_dir.clone())
    };

    let project = DockerManager::compose_project(&app_id);

    // Prefer `docker compose ps` from the app's compose dir for stable output;
    // fall back to plain `docker ps` filtered by project label.
    let mut out_lines: Vec<ContainerInfo> = Vec::new();

    if let Some(cf) = compose_file.as_deref() {
        let file_path = resolve_compose_path(cf, Some(root_dir.as_str()));
        let work_dir = std::path::Path::new(&file_path)
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| std::path::PathBuf::from("."));

        let output = Command::new(docker_bin())
            .args([
                "compose",
                "-p",
                &project,
                "-f",
                &file_path,
                "ps",
                "--all",
                "--format",
                "json",
            ])
            .current_dir(&work_dir)
            .output()
            .await
            .map_err(|e| format!("docker compose ps: {e}"))?;

        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            // Newer compose emits NDJSON, older emits a JSON array — handle both.
            let trimmed = stdout.trim();
            if trimmed.starts_with('[') {
                if let Ok(arr) = serde_json::from_str::<Vec<ComposePsLine>>(trimmed) {
                    for c in arr {
                        out_lines.push(ContainerInfo {
                            id: c.id,
                            name: c.name,
                            image: c.image,
                            state: c.state,
                            status: c.status,
                            ports: if !c.ports.is_empty() {
                                c.ports
                            } else {
                                ports_from_publishers(&c.publishers)
                            },
                        });
                    }
                }
            } else {
                for line in trimmed.lines() {
                    let line = line.trim();
                    if line.is_empty() {
                        continue;
                    }
                    if let Ok(c) = serde_json::from_str::<ComposePsLine>(line) {
                        out_lines.push(ContainerInfo {
                            id: c.id,
                            name: c.name,
                            image: c.image,
                            state: c.state,
                            status: c.status,
                            ports: if !c.ports.is_empty() {
                                c.ports
                            } else {
                                ports_from_publishers(&c.publishers)
                            },
                        });
                    }
                }
            }
        }
    }

    // Fallback / non-compose docker apps: list by project label, then by Porta's
    // single-container naming convention.
    if out_lines.is_empty() {
        let label = format!("label=com.docker.compose.project={}", project);
        let output = Command::new(docker_bin())
            .args([
                "ps",
                "-a",
                "--filter",
                &label,
                "--format",
                "{{json .}}",
            ])
            .output()
            .await
            .map_err(|e| format!("docker ps: {e}"))?;
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines() {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                    out_lines.push(ContainerInfo {
                        id: v.get("ID").and_then(|x| x.as_str()).unwrap_or("").into(),
                        name: v.get("Names").and_then(|x| x.as_str()).unwrap_or("").into(),
                        image: v.get("Image").and_then(|x| x.as_str()).unwrap_or("").into(),
                        state: v.get("State").and_then(|x| x.as_str()).unwrap_or("").into(),
                        status: v.get("Status").and_then(|x| x.as_str()).unwrap_or("").into(),
                        ports: v.get("Ports").and_then(|x| x.as_str()).unwrap_or("").into(),
                    });
                }
            }
        }

        // Single-container docker app.
        if out_lines.is_empty() {
            let name = DockerManager::container_name(&app_id);
            let output = Command::new(docker_bin())
                .args(["ps", "-a", "--filter", &format!("name=^{}$", name), "--format", "{{json .}}"])
                .output()
                .await
                .map_err(|e| format!("docker ps: {e}"))?;
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                for line in stdout.lines() {
                    let line = line.trim();
                    if line.is_empty() { continue; }
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                        out_lines.push(ContainerInfo {
                            id: v.get("ID").and_then(|x| x.as_str()).unwrap_or("").into(),
                            name: v.get("Names").and_then(|x| x.as_str()).unwrap_or("").into(),
                            image: v.get("Image").and_then(|x| x.as_str()).unwrap_or("").into(),
                            state: v.get("State").and_then(|x| x.as_str()).unwrap_or("").into(),
                            status: v.get("Status").and_then(|x| x.as_str()).unwrap_or("").into(),
                            ports: v.get("Ports").and_then(|x| x.as_str()).unwrap_or("").into(),
                        });
                    }
                }
            }
        }
    }

    Ok(out_lines)
}

// ── container_stats ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn container_stats(container_name: String) -> Result<ContainerStats, String> {
    let output = Command::new(docker_bin())
        .args([
            "stats",
            "--no-stream",
            "--format",
            "{{json .}}",
            &container_name,
        ])
        .output()
        .await
        .map_err(|e| format!("docker stats: {e}"))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout.lines().next().unwrap_or("").trim();
    if line.is_empty() {
        return Err(format!("no stats for {}", container_name));
    }
    let v: serde_json::Value = serde_json::from_str(line).map_err(|e| e.to_string())?;

    let cpu = v.get("CPUPerc").and_then(|x| x.as_str()).unwrap_or("0%");
    let mem_pct = v.get("MemPerc").and_then(|x| x.as_str()).unwrap_or("0%");
    let mem_usage = v.get("MemUsage").and_then(|x| x.as_str()).unwrap_or("0B / 0B");
    let net = v.get("NetIO").and_then(|x| x.as_str()).unwrap_or("0B / 0B");
    let block = v.get("BlockIO").and_then(|x| x.as_str()).unwrap_or("0B / 0B");

    let (mem_u, mem_l) = parse_pair(mem_usage);
    let (rx, tx) = parse_pair(net);
    let (br, bw) = parse_pair(block);

    Ok(ContainerStats {
        cpu_pct: parse_pct(cpu),
        mem_usage_bytes: mem_u,
        mem_limit_bytes: mem_l,
        mem_pct: parse_pct(mem_pct),
        net_rx_bytes: rx,
        net_tx_bytes: tx,
        block_read_bytes: br,
        block_write_bytes: bw,
    })
}

// ── log streaming ───────────────────────────────────────────────────────────

#[tauri::command]
pub async fn start_container_logs(
    app: tauri::AppHandle,
    state: State<'_, LogStreams>,
    container_name: String,
    tail: u32,
) -> Result<String, String> {
    let stream_id = format!(
        "{}-{}",
        container_name.replace(|c: char| !c.is_ascii_alphanumeric(), "_"),
        chrono::Utc::now().timestamp_millis()
    );
    let event_name = format!("container-log:{}", stream_id);

    let mut child = Command::new(docker_bin())
        .args([
            "logs",
            "--tail",
            &tail.to_string(),
            "-f",
            "--timestamps",
            &container_name,
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("docker logs: {e}"))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    if let Some(out) = stdout {
        let app_h = app.clone();
        let ev = event_name.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(out).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let _ = app_h.emit(
                    &ev,
                    LogLine {
                        stream: "stdout".into(),
                        text: line,
                        ts: chrono::Utc::now().timestamp_millis(),
                    },
                );
            }
        });
    }
    if let Some(err) = stderr {
        let app_h = app.clone();
        let ev = event_name.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(err).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let _ = app_h.emit(
                    &ev,
                    LogLine {
                        stream: "stderr".into(),
                        text: line,
                        ts: chrono::Utc::now().timestamp_millis(),
                    },
                );
            }
        });
    }

    state
        .inner
        .lock()
        .await
        .insert(stream_id.clone(), child);

    Ok(stream_id)
}

#[tauri::command]
pub async fn stop_container_logs(
    state: State<'_, LogStreams>,
    stream_id: String,
) -> Result<(), String> {
    let mut map = state.inner.lock().await;
    if let Some(mut child) = map.remove(&stream_id) {
        let _ = child.kill().await;
    }
    Ok(())
}
