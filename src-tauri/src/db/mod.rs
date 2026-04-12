pub mod models;

use anyhow::Result;
use rusqlite::{Connection, params};
use std::path::PathBuf;
use models::{App, Workspace};

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
        Ok(())
    }

    pub fn insert_workspace(&self, w: &Workspace) -> Result<()> {
        self.conn.execute(
            "INSERT INTO workspaces (id, name, domain) VALUES (?1, ?2, ?3)",
            params![w.id, w.name, w.domain],
        )?;
        Ok(())
    }

    pub fn list_workspaces(&self) -> Result<Vec<Workspace>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, domain FROM workspaces ORDER BY name"
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(Workspace {
                id: row.get(0)?,
                name: row.get(1)?,
                domain: row.get(2)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(anyhow::Error::from)
    }

    pub fn delete_workspace(&self, id: &str) -> Result<()> {
        self.conn.execute("DELETE FROM workspaces WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn insert_app(&mut self, a: &App) -> Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT INTO apps (id, workspace_id, name, root_dir, port, subdomain, start_command, start_command_source, status, pid)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                a.id, a.workspace_id, a.name, a.root_dir, a.port,
                a.subdomain, a.start_command, a.start_command_source,
                a.status, a.pid
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
                    start_command, start_command_source, status, pid
             FROM apps ORDER BY name"
        )?;
        let rows = stmt.query_map([], |row| {
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
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(anyhow::Error::from)
    }

    pub fn update_app_status(&self, id: &str, status: &str, pid: Option<u32>) -> Result<()> {
        self.conn.execute(
            "UPDATE apps SET status = ?1, pid = ?2 WHERE id = ?3",
            params![status, pid, id],
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
        let w = Workspace { id: "w1".into(), name: "Test".into(), domain: "test.test".into() };
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
        };
        db.insert_app(&a).unwrap();
        let ports = db.used_ports().unwrap();
        assert_eq!(ports, vec![4001]);
    }
}
