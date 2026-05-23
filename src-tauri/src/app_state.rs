use std::path::PathBuf;
use std::sync::Mutex;

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
}
