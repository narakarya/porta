use std::collections::HashMap;
use std::io::BufRead;
use std::path::PathBuf;
use std::thread;
use tauri::Emitter;
use tauri::State;

use crate::app_state::AppState;

fn find_docker() -> String {
    for p in &["/usr/local/bin/docker", "/opt/homebrew/bin/docker", "/usr/bin/docker"] {
        if std::path::Path::new(p).exists() {
            return p.to_string();
        }
    }
    "docker".to_string()
}

fn docker_container_running(container_name: &str) -> bool {
    std::process::Command::new(find_docker())
        .args(["inspect", "--format={{.State.Running}}", container_name])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "true")
        .unwrap_or(false)
}

#[tauri::command]
pub fn list_services(state: State<AppState>) -> Result<Vec<crate::db::models::Service>, String> {
    let mut services = state.db.lock().unwrap().list_services().map_err(|e| e.to_string())?;

    // Reconcile: mark containers stale if they're no longer running in Docker
    let stale_ids: Vec<String> = services.iter()
        .filter(|s| s.status == "running")
        .filter(|s| !docker_container_running(&format!("porta-{}", s.id)))
        .map(|s| s.id.clone())
        .collect();

    if !stale_ids.is_empty() {
        let db = state.db.lock().unwrap();
        for id in &stale_ids {
            db.update_service_status(id, "stopped", None).ok();
        }
    }

    for svc in services.iter_mut() {
        if stale_ids.contains(&svc.id) {
            svc.status = "stopped".to_string();
            svc.container_id = None;
        }
    }

    Ok(services)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn add_service(
    name: String, image: String, tag: String, port: u16,
    env_vars: HashMap<String, String>, volumes: Vec<String>, scope: String,
    state: State<AppState>,
) -> Result<crate::db::models::Service, String> {
    let svc = crate::db::models::Service {
        id: uuid::Uuid::new_v4().to_string(),
        name, image, tag, port, env_vars, volumes, scope,
        status: "stopped".to_string(),
        container_id: None,
    };
    state.db.lock().unwrap().insert_service(&svc).map_err(|e| e.to_string())?;
    Ok(svc)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn update_service(
    id: String, name: String, image: String, tag: String, port: u16,
    env_vars: HashMap<String, String>, volumes: Vec<String>, scope: String,
    state: State<AppState>,
) -> Result<crate::db::models::Service, String> {
    state.db.lock().unwrap()
        .update_service(&id, &name, &image, &tag, port, &env_vars, &volumes, &scope)
        .map_err(|e| e.to_string())?;
    state.db.lock().unwrap().list_services()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|s| s.id == id)
        .ok_or_else(|| "Service not found after update".to_string())
}

#[tauri::command]
pub fn delete_service(id: String, state: State<AppState>) -> Result<(), String> {
    let container_name = format!("porta-{}", id);
    let _ = std::process::Command::new(find_docker())
        .args(["stop", &container_name])
        .output();

    state.db.lock().unwrap().delete_service(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn reorder_services(state: State<AppState>, ids: Vec<String>) -> Result<(), String> {
    state.db.lock().unwrap().reorder_services(&ids).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn start_service(
    id: String,
    state: State<AppState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let svc = state.db.lock().unwrap().list_services()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|s| s.id == id)
        .ok_or_else(|| "Service not found".to_string())?;

    state.db.lock().unwrap()
        .update_service_status(&id, "pulling", None)
        .map_err(|e| e.to_string())?;

    let db_path = state.db_path.clone();

    thread::spawn(move || {
        let docker = find_docker();

        let emit_status = |status: &str, container_id: Option<&str>| {
            app_handle.emit(&format!("service:status:{}", id), serde_json::json!({
                "status": status,
                "container_id": container_id
            })).ok();
        };
        let emit_log = |line: &str| {
            app_handle.emit(&format!("service:log:{}", id), line).ok();
        };

        let fail = |_reason: &str, db_path: &PathBuf, id: &str| {
            if let Ok(db) = crate::db::Database::open(db_path.clone()) {
                db.update_service_status(id, "stopped", None).ok();
            }
        };

        // ── 1. Pull image ────────────────────────────────────────────────────
        emit_status("pulling", None);
        let image_ref = format!("{}:{}", svc.image, svc.tag);
        emit_log(&format!("Pulling {}...", image_ref));

        let mut pull = match std::process::Command::new(&docker)
            .args(["pull", &image_ref])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                emit_log(&format!("[err] Cannot start docker: {e}. Is Docker Desktop running?"));
                emit_status("stopped", None);
                fail("spawn pull", &db_path, &id);
                return;
            }
        };

        if let Some(stdout) = pull.stdout.take() {
            for line in std::io::BufReader::new(stdout).lines().map_while(Result::ok) {
                emit_log(&line);
            }
        }
        if let Some(stderr) = pull.stderr.take() {
            for line in std::io::BufReader::new(stderr).lines().map_while(Result::ok) {
                if !line.trim().is_empty() { emit_log(&format!("[err] {line}")); }
            }
        }
        match pull.wait() {
            Ok(s) if !s.success() => {
                emit_log(&format!("[err] docker pull exited {}", s.code().unwrap_or(-1)));
                emit_status("stopped", None);
                fail("pull failed", &db_path, &id);
                return;
            }
            Err(e) => {
                emit_log(&format!("[err] {e}"));
                emit_status("stopped", None);
                fail("pull wait", &db_path, &id);
                return;
            }
            _ => {}
        }

        // ── 2. Run container ─────────────────────────────────────────────────
        emit_status("starting", None);
        let container_name = format!("porta-{}", id);

        let _ = std::process::Command::new(&docker)
            .args(["rm", "-f", &container_name])
            .output();

        let mut run_args: Vec<String> = vec![
            "run".into(), "-d".into(),
            "--name".into(), container_name.clone(),
            "-p".into(), format!("{}:{}", svc.port, svc.port),
        ];
        for (k, v) in &svc.env_vars {
            run_args.push("-e".into());
            run_args.push(format!("{k}={v}"));
        }
        for vol in &svc.volumes {
            if !vol.trim().is_empty() {
                run_args.push("-v".into());
                run_args.push(vol.clone());
            }
        }
        run_args.push(image_ref.clone());

        let run_out = std::process::Command::new(&docker)
            .args(&run_args)
            .output();

        let container_id = match run_out {
            Err(e) => {
                emit_log(&format!("[err] docker run: {e}"));
                emit_status("stopped", None);
                fail("run error", &db_path, &id);
                return;
            }
            Ok(o) if !o.status.success() => {
                let msg = String::from_utf8_lossy(&o.stderr).trim().to_string();
                emit_log(&format!("[err] {msg}"));
                emit_status("stopped", None);
                fail("run failed", &db_path, &id);
                return;
            }
            Ok(o) => {
                let full_id = String::from_utf8_lossy(&o.stdout).trim().to_string();
                full_id[..full_id.len().min(12)].to_string()
            }
        };

        if let Ok(db) = crate::db::Database::open(db_path.clone()) {
            db.update_service_status(&id, "running", Some(&container_id)).ok();
        }
        emit_log(&format!("Container started ({container_id})"));
        emit_status("running", Some(&container_id));

        // ── 3. Stream container logs ─────────────────────────────────────────
        let mut logs = match std::process::Command::new(&docker)
            .args(["logs", "-f", &container_name])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
        {
            Ok(c) => c,
            Err(_) => return,
        };

        let stdout = logs.stdout.take();
        let stderr = logs.stderr.take();

        let id2 = id.clone();
        let handle2 = app_handle.clone();
        if let Some(out) = stdout {
            thread::spawn(move || {
                for line in std::io::BufReader::new(out).lines().map_while(Result::ok) {
                    handle2.emit(&format!("service:log:{}", id2), &line).ok();
                }
            });
        }
        let id3 = id.clone();
        let handle3 = app_handle.clone();
        if let Some(err) = stderr {
            thread::spawn(move || {
                for line in std::io::BufReader::new(err).lines().map_while(Result::ok) {
                    handle3.emit(&format!("service:log:{}", id3), format!("[err] {line}")).ok();
                }
            });
        }

        let _ = logs.wait();
        if let Ok(db) = crate::db::Database::open(db_path) {
            db.update_service_status(&id, "stopped", None).ok();
        }
        app_handle.emit(&format!("service:status:{}", id), serde_json::json!({
            "status": "stopped",
            "container_id": null
        })).ok();
    });

    Ok(())
}

#[tauri::command]
pub fn stop_service(id: String, state: State<AppState>) -> Result<(), String> {
    let container_name = format!("porta-{}", id);

    let _ = std::process::Command::new(find_docker())
        .args(["stop", &container_name])
        .output();

    state.db.lock().unwrap()
        .update_service_status(&id, "stopped", None)
        .map_err(|e| e.to_string())
}
