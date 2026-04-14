use std::collections::HashMap;
use std::thread;
use std::time::Duration;

use sysinfo::{Pid, ProcessesToUpdate, System};
use tauri::{Emitter, Manager};

use crate::app_state::AppState;

/// Spawn a background thread that polls CPU/memory for all running app processes
/// every 2 seconds and emits `app:metrics:{id}` events to the frontend.
pub fn spawn_metrics_poller(app: tauri::AppHandle) {
    thread::spawn(move || {
        let mut sys = System::new();

        loop {
            thread::sleep(Duration::from_secs(2));

            // Get current pid→app_id mapping from ProcessManager
            let state = app.state::<AppState>();
            let pid_map: HashMap<String, u32> = {
                let pids = state.processes.pids();
                pids
            };

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
