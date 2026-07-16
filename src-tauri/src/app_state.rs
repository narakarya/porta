use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use crate::caddy::CaddyManager;
use crate::db::Database;
use crate::docker_manager::DockerManager;
use crate::extensions::loader::ExtensionsState;
use crate::process_manager::ProcessManager;

pub struct AppState {
    pub db: Arc<Mutex<Database>>,
    pub processes: ProcessManager,
    pub docker: DockerManager,
    pub caddy: CaddyManager,
    pub db_path: PathBuf,
    pub extensions: ExtensionsState,
    /// One lock per app id, serializing that app's start/stop/restart. The
    /// lifecycle commands run off the main thread now, so two ops on the same
    /// app (a Start clicked while a Stop's `docker compose down` is still
    /// running) would otherwise interleave `down`/`up -d` on one project. The
    /// main thread used to serialize them for free; this restores that per app,
    /// while different apps still run in parallel.
    pub lifecycle_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// Serializes the port-allocate → row-insert window of `start_instance`.
    /// Picking a free port (`db.used_ports()`) and reserving it (`insert_instance`,
    /// which writes `port_registry`) happen under two separate `db` locks, so two
    /// concurrent starts could read the same free port before either reserves it,
    /// and one process then fails to bind. A single process-wide mutex closes that
    /// gap. Unlike `lifecycle_locks` this is NOT keyed per id: the racing callers
    /// are different apps/instances with different ids, so a per-id lock wouldn't
    /// make them contend. The critical section is a couple of tiny queries, so
    /// global serialization is effectively free.
    pub instance_alloc_lock: Mutex<()>,
}

impl AppState {
    /// The lifecycle lock for `id`, creating it on first use. Held (via
    /// `.lock().await`) across a whole start/stop/restart so the same app's
    /// ops queue instead of racing.
    pub fn lifecycle_lock(&self, id: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.lifecycle_locks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(id.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }
}
