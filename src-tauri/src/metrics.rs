use std::collections::HashMap;
use std::thread;
use std::time::Duration;

use sysinfo::{Pid, ProcessesToUpdate, System};
use tauri::{Emitter, Manager};

use crate::app_state::AppState;
use crate::docker_manager::DockerManager;

/// Spawn a background thread that polls CPU/memory for all running app processes
/// every 2 seconds and emits `app:metrics:{id}` events to the frontend.
pub fn spawn_metrics_poller(app: tauri::AppHandle) {
    thread::spawn(move || {
        let mut sys = System::new();

        loop {
            thread::sleep(Duration::from_secs(2));

            let state = app.state::<AppState>();
            // Get pid→app_id mapping from ProcessManager + DB (covers apps surviving Porta restart)
            let mut pid_map: HashMap<String, u32> = state.processes.pids().into_iter().collect();
            let docker_ids: Vec<String> = state.docker.active_ids();

            // Snapshot the DB list with the lock held only for the call itself —
            // the lock drops at the end of this let statement, so iteration below
            // doesn't block concurrent start/stop/update commands.
            let db_apps = state.db.lock().unwrap().list_apps().ok();
            if let Some(db_apps) = db_apps {
                for a in &db_apps {
                    if a.status == "running" && !a.is_docker() {
                        if let Some(pid) = a.pid {
                            pid_map.entry(a.id.clone()).or_insert(pid);
                        }
                    }
                }
            }

            // Docker apps — pull stats from `docker stats --no-stream`.
            for app_id in &docker_ids {
                if let Some((cpu, mem)) = DockerManager::stats(app_id) {
                    let payload = serde_json::json!({
                        "cpu": (cpu * 10.0).round() / 10.0,
                        "mem_mb": (mem as f64 / 1_048_576.0).round() as u64,
                    });
                    app.emit(&format!("app:metrics:{}", app_id), payload).ok();
                }
            }

            if pid_map.is_empty() {
                continue;
            }

            // Refresh process info for the PIDs we care about
            let pids_to_update: Vec<Pid> = pid_map.values()
                .map(|&p| Pid::from_u32(p))
                .collect();
            sys.refresh_processes(ProcessesToUpdate::Some(&pids_to_update), true);

            for (app_id, pid) in &pid_map {
                // Collect metrics for the process and all its children (e.g. node spawned by shell)
                let (cpu, mem) = collect_tree_metrics(&sys, Pid::from_u32(*pid));

                if cpu > 0.0 || mem > 0 {
                    let payload = serde_json::json!({
                        "cpu": (cpu * 10.0).round() / 10.0,  // 1 decimal place
                        "mem_mb": (mem as f64 / 1_048_576.0).round() as u64,
                    });
                    app.emit(&format!("app:metrics:{}", app_id), payload).ok();
                }
            }
        }
    });
}

/// Sum CPU and memory usage for a process and all its descendants.
fn collect_tree_metrics(sys: &System, root_pid: Pid) -> (f32, u64) {
    let mut total_cpu: f32 = 0.0;
    let mut total_mem: u64 = 0;

    // Collect root process
    if let Some(proc) = sys.process(root_pid) {
        total_cpu += proc.cpu_usage();
        total_mem += proc.memory();
    }

    // Collect all descendant processes (children, grandchildren, etc.)
    for (_, proc) in sys.processes() {
        if is_descendant_of(sys, proc.pid(), root_pid) {
            total_cpu += proc.cpu_usage();
            total_mem += proc.memory();
        }
    }

    (total_cpu, total_mem)
}

/// Check if `pid` is a descendant of `ancestor` by walking the parent chain.
fn is_descendant_of(sys: &System, pid: Pid, ancestor: Pid) -> bool {
    let mut current = pid;
    for _ in 0..20 {  // depth limit to avoid infinite loops
        if let Some(proc) = sys.process(current) {
            if let Some(parent) = proc.parent() {
                if parent == ancestor {
                    return true;
                }
                if parent == current {
                    return false;  // self-referencing
                }
                current = parent;
            } else {
                return false;
            }
        } else {
            return false;
        }
    }
    false
}
