//! Host-level CPU / memory / disk metrics for the Activity domain.
//!
//! A global CPU-usage sample needs two refreshes separated by at least
//! `MINIMUM_CPU_UPDATE_INTERVAL`: the first primes the per-core counters, the
//! second measures against them. A single refresh always reads 0. We do that on
//! a blocking thread so the mandated sleep never parks the async runtime.

use sysinfo::{Disks, System, MINIMUM_CPU_UPDATE_INTERVAL};

#[derive(serde::Serialize)]
pub struct SystemMetrics {
    pub cpu_pct: f32,
    pub mem_used_bytes: u64,
    pub mem_total_bytes: u64,
    pub disk_free_bytes: u64,
    pub disk_total_bytes: u64,
}

#[tauri::command]
pub async fn system_metrics() -> Result<SystemMetrics, String> {
    tokio::task::spawn_blocking(|| {
        let mut sys = System::new();
        sys.refresh_cpu_all();
        std::thread::sleep(MINIMUM_CPU_UPDATE_INTERVAL);
        sys.refresh_cpu_all();
        sys.refresh_memory();

        // Prefer the root filesystem; fall back to the largest disk so a machine
        // whose `/` isn't listed still reports something sane instead of zeros.
        let disks = Disks::new_with_refreshed_list();
        let disk = disks
            .list()
            .iter()
            .find(|d| d.mount_point() == std::path::Path::new("/"))
            .or_else(|| disks.list().iter().max_by_key(|d| d.total_space()));

        SystemMetrics {
            cpu_pct: sys.global_cpu_usage(),
            mem_used_bytes: sys.used_memory(),
            mem_total_bytes: sys.total_memory(),
            disk_free_bytes: disk.map(|d| d.available_space()).unwrap_or(0),
            disk_total_bytes: disk.map(|d| d.total_space()).unwrap_or(0),
        }
    })
    .await
    .map_err(|e| e.to_string())
}
