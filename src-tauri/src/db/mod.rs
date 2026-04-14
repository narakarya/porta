pub mod models;

mod workspace_repo;
mod app_repo;
mod service_repo;

use anyhow::Result;
use rusqlite::Connection;
use std::path::PathBuf;

pub struct Database {
    pub(crate) conn: Connection,
}

impl Database {
    pub fn open(path: PathBuf) -> Result<Self> {
        let conn = Connection::open(path)?;
        let db = Database { conn };
        db.migrate()?;
        Ok(db)
    }

    fn migrate(&self) -> Result<()> {
        self.conn.execute_batch("
            PRAGMA journal_mode=WAL;

            CREATE TABLE IF NOT EXISTS workspaces (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                domain TEXT NOT NULL UNIQUE
            );

            CREATE TABLE IF NOT EXISTS apps (
                id TEXT PRIMARY KEY,
                workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
                name TEXT NOT NULL,
                root_dir TEXT NOT NULL,
                port INTEGER NOT NULL UNIQUE,
                subdomain TEXT,
                start_command TEXT NOT NULL DEFAULT '',
                start_command_source TEXT NOT NULL DEFAULT 'manual',
                status TEXT NOT NULL DEFAULT 'stopped',
                pid INTEGER
            );

            CREATE TABLE IF NOT EXISTS port_registry (
                port INTEGER PRIMARY KEY,
                app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE
            );
        ")?;

        self.conn.execute_batch("
            CREATE TABLE IF NOT EXISTS services (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                image TEXT NOT NULL,
                tag TEXT NOT NULL DEFAULT 'latest',
                port INTEGER NOT NULL,
                env_vars TEXT NOT NULL DEFAULT '{}',
                scope TEXT NOT NULL DEFAULT 'global',
                status TEXT NOT NULL DEFAULT 'stopped',
                container_id TEXT
            );
        ")?;

        // Non-destructive additions
        let _ = self.conn.execute("ALTER TABLE services ADD COLUMN volumes TEXT NOT NULL DEFAULT '[]'", []);
        let _ = self.conn.execute("ALTER TABLE workspaces ADD COLUMN position INTEGER NOT NULL DEFAULT 0", []);
        let _ = self.conn.execute("ALTER TABLE services ADD COLUMN position INTEGER NOT NULL DEFAULT 0", []);

        // Non-destructive additions for existing databases (errors = column already exists)
        let _ = self.conn.execute("ALTER TABLE apps ADD COLUMN env_file TEXT", []);
        let _ = self.conn.execute("ALTER TABLE apps ADD COLUMN auto_start INTEGER NOT NULL DEFAULT 0", []);
        // v0.2 additions
        let _ = self.conn.execute("ALTER TABLE apps ADD COLUMN env_vars TEXT NOT NULL DEFAULT '{}'", []);
        let _ = self.conn.execute("ALTER TABLE apps ADD COLUMN restart_policy TEXT NOT NULL DEFAULT 'on-failure'", []);
        let _ = self.conn.execute("ALTER TABLE apps ADD COLUMN max_retries INTEGER NOT NULL DEFAULT 3", []);
        // dependency graph
        let _ = self.conn.execute("ALTER TABLE apps ADD COLUMN health_check_path TEXT", []);
        let _ = self.conn.execute("ALTER TABLE apps ADD COLUMN depends_on TEXT NOT NULL DEFAULT '[]'", []);
        // multiple subdomains per app
        let _ = self.conn.execute("ALTER TABLE apps ADD COLUMN extra_subdomains TEXT NOT NULL DEFAULT '[]'", []);
        // deploy custom commands
        let _ = self.conn.execute("ALTER TABLE apps ADD COLUMN deploy_custom_commands TEXT NOT NULL DEFAULT '[]'", []);
        // custom domain per app (overrides workspace domain)
        let _ = self.conn.execute("ALTER TABLE apps ADD COLUMN custom_domain TEXT", []);
        // multi-port bindings
        let _ = self.conn.execute("ALTER TABLE apps ADD COLUMN port_bindings TEXT NOT NULL DEFAULT '[]'", []);
        // environment profiles
        let _ = self.conn.execute("ALTER TABLE apps ADD COLUMN env_profiles TEXT NOT NULL DEFAULT '[]'", []);
        let _ = self.conn.execute("ALTER TABLE apps ADD COLUMN active_profile_id TEXT", []);

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use models::{App, Workspace};
    use std::collections::HashMap;

    fn in_memory_db() -> Database {
        Database::open(":memory:".into()).unwrap()
    }

    #[test]
    fn test_migrate_creates_tables() {
        let db = in_memory_db();
        let count: i64 = db.conn.query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('workspaces','apps','port_registry')",
            [], |r| r.get(0)
        ).unwrap();
        assert_eq!(count, 3);
    }

    #[test]
    fn test_insert_and_list_workspace() {
        let db = in_memory_db();
        let w = Workspace { id: "w1".into(), name: "Test".into(), domain: "test.test".into(), deployment: None };
        db.insert_workspace(&w).unwrap();
        let list = db.list_workspaces().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].domain, "test.test");
    }

    #[test]
    fn test_insert_app_registers_port() {
        let mut db = in_memory_db();
        let a = App {
            id: "a1".into(), workspace_id: None, name: "api".into(),
            root_dir: "/tmp".into(), port: 4001, subdomain: None,
            start_command: "mix phx.server".into(),
            start_command_source: "auto".into(),
            status: "stopped".into(), pid: None,
            env_file: None, auto_start: false,
            env_vars: HashMap::new(),
            restart_policy: "on-failure".into(),
            max_retries: 3,
            health_check_path: None,
            depends_on: vec![],
            extra_subdomains: vec![],
            custom_domain: None,
            tunnel_provider: None,
            tunnel_url: None,
            tunnel_active: false,
            deploy_config_path: None,
            deploy_custom_commands: vec![],
            port_bindings: vec![],
            env_profiles: vec![],
            active_profile_id: None,
        };
        db.insert_app(&a).unwrap();
        let ports = db.used_ports().unwrap();
        assert_eq!(ports, vec![4001]);
    }

    #[test]
    fn test_env_vars_round_trip() {
        let mut db = in_memory_db();
        let mut env_vars = HashMap::new();
        env_vars.insert("FOO".into(), "bar".into());
        env_vars.insert("SECRET".into(), "1234".into());
        let a = App {
            id: "a2".into(), workspace_id: None, name: "web".into(),
            root_dir: "/tmp".into(), port: 4002, subdomain: None,
            start_command: "npm run dev".into(),
            start_command_source: "auto".into(),
            status: "stopped".into(), pid: None,
            env_file: None, auto_start: false,
            env_vars: env_vars.clone(),
            restart_policy: "on-failure".into(),
            max_retries: 3,
            health_check_path: None,
            depends_on: vec![],
            extra_subdomains: vec![],
            custom_domain: None,
            tunnel_provider: None,
            tunnel_url: None,
            tunnel_active: false,
            deploy_config_path: None,
            deploy_custom_commands: vec![],
            port_bindings: vec![],
            env_profiles: vec![],
            active_profile_id: None,
        };
        db.insert_app(&a).unwrap();
        let list = db.list_apps().unwrap();
        assert_eq!(list[0].env_vars, env_vars);
    }
}
