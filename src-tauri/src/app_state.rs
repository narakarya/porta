use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use crate::caddy::CaddyManager;
use crate::db::Database;
use crate::docker_manager::DockerManager;
use crate::extensions::loader::ExtensionsState;
use crate::process_manager::ProcessManager;

pub struct AppState {
    pub db: Mutex<Database>,
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
