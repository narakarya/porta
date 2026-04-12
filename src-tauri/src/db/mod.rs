pub mod models;

use anyhow::Result;
use rusqlite::{Connection, params};
use std::collections::HashMap;
use std::path::PathBuf;
use models::{App, Service, Workspace};

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

        Ok(())
    }

    pub fn insert_workspace(&self, w: &Workspace) -> Result<()> {
        self.conn.execute(
            "INSERT INTO workspaces (id, name, domain) VALUES (?1, ?2, ?3)",
            params![w.id, w.name, w.domain],
        )?;
        Ok(())
    }

    pub fn update_workspace(&self, id: &str, name: &str, domain: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE workspaces SET name = ?1, domain = ?2 WHERE id = ?3",
            params![name, domain, id],
        )?;
        Ok(())
    }

    pub fn reorder_workspaces(&self, ids: &[String]) -> Result<()> {
        for (i, id) in ids.iter().enumerate() {
            self.conn.execute(
                "UPDATE workspaces SET position = ?1 WHERE id = ?2",
                params![i as i64, id],
            )?;
        }
        Ok(())
    }

    pub fn list_workspaces(&self) -> Result<Vec<Workspace>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, domain FROM workspaces ORDER BY position, rowid"
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(Workspace {
                id: row.get(0)?,
                name: row.get(1)?,
                domain: row.get(2)?,
                deployment: None,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(anyhow::Error::from)
    }

    pub fn delete_workspace(&self, id: &str) -> Result<()> {
        self.conn.execute("DELETE FROM workspaces WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn insert_app(&mut self, a: &App) -> Result<()> {
        let env_vars_json = serde_json::to_string(&a.env_vars).unwrap_or_else(|_| "{}".into());
        let depends_on_json = serde_json::to_string(&a.depends_on).unwrap_or_else(|_| "[]".into());
        let extra_subdomains_json = serde_json::to_string(&a.extra_subdomains).unwrap_or_else(|_| "[]".into());
        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT INTO apps (id, workspace_id, name, root_dir, port, subdomain,
                               start_command, start_command_source, status, pid,
                               env_file, auto_start, env_vars, restart_policy, max_retries,
                               health_check_path, depends_on, extra_subdomains)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
            params![
                a.id, a.workspace_id, a.name, a.root_dir, a.port,
                a.subdomain, a.start_command, a.start_command_source,
                a.status, a.pid, a.env_file, a.auto_start as i32,
                env_vars_json, a.restart_policy, a.max_retries as i32,
                a.health_check_path, depends_on_json, extra_subdomains_json
            ],
        )?;
        tx.execute(
            "INSERT INTO port_registry (port, app_id) VALUES (?1, ?2)",
            params![a.port, a.id],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn list_apps(&self) -> Result<Vec<App>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, workspace_id, name, root_dir, port, subdomain,
                    start_command, start_command_source, status, pid,
                    env_file, auto_start, env_vars, restart_policy, max_retries,
                    health_check_path, depends_on, extra_subdomains,
                    COALESCE(deploy_custom_commands, '[]')
             FROM apps ORDER BY rowid"
        )?;
        let rows = stmt.query_map([], |row| {
            let env_vars_str: String = row.get::<_, Option<String>>(12)?.unwrap_or_else(|| "{}".into());
            let env_vars: HashMap<String, String> = serde_json::from_str(&env_vars_str)
                .unwrap_or_default();
            let restart_policy: String = row.get::<_, Option<String>>(13)?
                .unwrap_or_else(|| "on-failure".into());
            let max_retries: u8 = row.get::<_, Option<i32>>(14)?.unwrap_or(3) as u8;
            let health_check_path: Option<String> = row.get(15)?;
            let depends_on_str: String = row.get::<_, Option<String>>(16)?.unwrap_or_else(|| "[]".into());
            let depends_on: Vec<String> = serde_json::from_str(&depends_on_str).unwrap_or_default();
            let extra_subdomains_str: String = row.get::<_, Option<String>>(17)?.unwrap_or_else(|| "[]".into());
            let extra_subdomains: Vec<String> = serde_json::from_str(&extra_subdomains_str).unwrap_or_default();
            let custom_cmds_str: String = row.get::<_, Option<String>>(18)?.unwrap_or_else(|| "[]".into());
            let deploy_custom_commands: Vec<models::CustomDeployCmd> = serde_json::from_str(&custom_cmds_str).unwrap_or_default();
            Ok(App {
                id: row.get(0)?,
                workspace_id: row.get(1)?,
                name: row.get(2)?,
                root_dir: row.get(3)?,
                port: row.get(4)?,
                subdomain: row.get(5)?,
                start_command: row.get(6)?,
                start_command_source: row.get(7)?,
                status: row.get(8)?,
                pid: row.get(9)?,
                env_file: row.get(10)?,
                auto_start: row.get::<_, i32>(11).map(|v| v != 0)?,
                env_vars,
                restart_policy,
                max_retries,
                health_check_path,
                depends_on,
                extra_subdomains,
                tunnel_provider: None,
                tunnel_url: None,
                tunnel_active: false,
                deploy_config_path: None,
                deploy_custom_commands,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(anyhow::Error::from)
    }

    /// Update editable app fields. Handles port_registry update if port changes.
    pub fn update_app(
        &self,
        id: &str,
        name: &str,
        port: u16,
        subdomain: Option<&str>,
        start_command: &str,
        env_file: Option<&str>,
        auto_start: bool,
        env_vars: &HashMap<String, String>,
        restart_policy: &str,
        max_retries: u8,
        health_check_path: Option<&str>,
        depends_on: &[String],
        extra_subdomains: &[String],
    ) -> Result<()> {
        let old_port: u16 = self.conn.query_row(
            "SELECT port FROM apps WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )?;

        let env_vars_json = serde_json::to_string(env_vars).unwrap_or_else(|_| "{}".into());
        let depends_on_json = serde_json::to_string(depends_on).unwrap_or_else(|_| "[]".into());
        let extra_subdomains_json = serde_json::to_string(extra_subdomains).unwrap_or_else(|_| "[]".into());

        self.conn.execute(
            "UPDATE apps SET name=?1, port=?2, subdomain=?3, start_command=?4,
                             env_file=?5, auto_start=?6, env_vars=?7,
                             restart_policy=?8, max_retries=?9,
                             health_check_path=?10, depends_on=?11, extra_subdomains=?12
             WHERE id=?13",
            params![
                name, port, subdomain, start_command, env_file,
                auto_start as i32, env_vars_json, restart_policy,
                max_retries as i32, health_check_path, depends_on_json,
                extra_subdomains_json, id
            ],
        )?;

        if old_port != port {
            self.conn.execute("DELETE FROM port_registry WHERE app_id = ?1", params![id])?;
            self.conn.execute(
                "INSERT INTO port_registry (port, app_id) VALUES (?1, ?2)",
                params![port, id],
            )?;
        }
        Ok(())
    }

    pub fn get_deploy_custom_cmds(&self, app_id: &str) -> Result<Vec<models::CustomDeployCmd>> {
        let raw: String = self.conn.query_row(
            "SELECT COALESCE(deploy_custom_commands, '[]') FROM apps WHERE id = ?1",
            params![app_id],
            |r| r.get(0),
        )?;
        Ok(serde_json::from_str(&raw).unwrap_or_default())
    }

    pub fn set_deploy_custom_cmds(
        &self,
        app_id: &str,
        cmds: &[models::CustomDeployCmd],
    ) -> Result<()> {
        let json = serde_json::to_string(cmds).unwrap_or_else(|_| "[]".into());
        self.conn.execute(
            "UPDATE apps SET deploy_custom_commands = ?1 WHERE id = ?2",
            params![json, app_id],
        )?;
        Ok(())
    }

    pub fn update_app_status(&self, id: &str, status: &str, pid: Option<u32>) -> Result<()> {
        self.conn.execute(
            "UPDATE apps SET status = ?1, pid = ?2 WHERE id = ?3",
            params![status, pid, id],
        )?;
        Ok(())
    }

    /// Update status only, leaving pid unchanged (used when transitioning starting → running).
    pub fn update_app_status_only(&self, id: &str, status: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE apps SET status = ?1 WHERE id = ?2",
            params![status, id],
        )?;
        Ok(())
    }

    pub fn delete_app(&self, id: &str) -> Result<()> {
        self.conn.execute("DELETE FROM apps WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn used_ports(&self) -> Result<Vec<u16>> {
        let mut stmt = self.conn.prepare("SELECT port FROM port_registry")?;
        let ports = stmt.query_map([], |row| row.get::<_, u16>(0))?;
        Ok(ports.filter_map(|r| r.ok()).collect())
    }

    // ── Services ──────────────────────────────────────────────────────────────

    pub fn insert_service(&self, s: &Service) -> Result<()> {
        let env_json = serde_json::to_string(&s.env_vars).unwrap_or_else(|_| "{}".into());
        let vol_json = serde_json::to_string(&s.volumes).unwrap_or_else(|_| "[]".into());
        self.conn.execute(
            "INSERT INTO services (id, name, image, tag, port, env_vars, volumes, scope, status, container_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![s.id, s.name, s.image, s.tag, s.port, env_json, vol_json, s.scope, s.status, s.container_id],
        )?;
        Ok(())
    }

    pub fn reorder_services(&self, ids: &[String]) -> Result<()> {
        for (i, id) in ids.iter().enumerate() {
            self.conn.execute(
                "UPDATE services SET position = ?1 WHERE id = ?2",
                params![i as i64, id],
            )?;
        }
        Ok(())
    }

    pub fn list_services(&self) -> Result<Vec<Service>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, image, tag, port, env_vars, volumes, scope, status, container_id
             FROM services ORDER BY position, rowid"
        )?;
        let rows = stmt.query_map([], |row| {
            let env_str: String = row.get::<_, Option<String>>(5)?.unwrap_or_else(|| "{}".into());
            let env_vars: HashMap<String, String> = serde_json::from_str(&env_str).unwrap_or_default();
            let vol_str: String = row.get::<_, Option<String>>(6)?.unwrap_or_else(|| "[]".into());
            let volumes: Vec<String> = serde_json::from_str(&vol_str).unwrap_or_default();
            Ok(Service {
                id: row.get(0)?,
                name: row.get(1)?,
                image: row.get(2)?,
                tag: row.get(3)?,
                port: row.get(4)?,
                env_vars,
                volumes,
                scope: row.get(7)?,
                status: row.get(8)?,
                container_id: row.get(9)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(anyhow::Error::from)
    }

    pub fn update_service(
        &self, id: &str, name: &str, image: &str, tag: &str,
        port: u16, env_vars: &HashMap<String, String>, volumes: &[String], scope: &str,
    ) -> Result<()> {
        let env_json = serde_json::to_string(env_vars).unwrap_or_else(|_| "{}".into());
        let vol_json = serde_json::to_string(volumes).unwrap_or_else(|_| "[]".into());
        self.conn.execute(
            "UPDATE services SET name=?1, image=?2, tag=?3, port=?4, env_vars=?5, volumes=?6, scope=?7 WHERE id=?8",
            params![name, image, tag, port, env_json, vol_json, scope, id],
        )?;
        Ok(())
    }

    pub fn update_service_status(&self, id: &str, status: &str, container_id: Option<&str>) -> Result<()> {
        self.conn.execute(
            "UPDATE services SET status=?1, container_id=?2 WHERE id=?3",
            params![status, container_id, id],
        )?;
        Ok(())
    }

    pub fn delete_service(&self, id: &str) -> Result<()> {
        self.conn.execute("DELETE FROM services WHERE id=?1", params![id])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use models::{App, Workspace};

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
            tunnel_provider: None,
            tunnel_url: None,
            tunnel_active: false,
            deploy_config_path: None,
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
            tunnel_provider: None,
            tunnel_url: None,
            tunnel_active: false,
            deploy_config_path: None,
        };
        db.insert_app(&a).unwrap();
        let list = db.list_apps().unwrap();
        assert_eq!(list[0].env_vars, env_vars);
    }
}
