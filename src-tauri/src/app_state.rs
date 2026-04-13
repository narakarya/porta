use std::path::PathBuf;
use std::sync::Mutex;

use crate::caddy::CaddyManager;
use crate::db::Database;
use crate::process_manager::ProcessManager;

pub struct AppState {
    pub db: Mutex<Database>,
    pub processes: ProcessManager,
    pub caddy: CaddyManager,
    pub db_path: PathBuf,
}
