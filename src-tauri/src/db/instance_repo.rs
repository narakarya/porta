use crate::db::models::AppInstance;
use crate::db::Database;
use anyhow::Result;
use rusqlite::params;

impl Database {
    pub fn insert_instance(&mut self, i: &AppInstance) -> Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT INTO app_instances
                (id, app_id, worktree_path, branch, subdomain, port, pid, status)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                i.id, i.app_id, i.worktree_path, i.branch,
                i.subdomain, i.port, i.pid, i.status
            ],
        )?;
        // Register the instance port under the app_id so used_ports() avoids it.
        // Composite PK (port, app_id) permits multiple ports per app_id.
        tx.execute(
            "INSERT OR IGNORE INTO port_registry (port, app_id) VALUES (?1, ?2)",
            params![i.port, i.app_id],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn list_instances(&self) -> Result<Vec<AppInstance>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, app_id, worktree_path, branch, subdomain, port, pid, status
             FROM app_instances ORDER BY rowid",
        )?;
        let rows = stmt.query_map([], Self::map_instance)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(anyhow::Error::from)
    }

    pub fn list_instances_for(&self, app_id: &str) -> Result<Vec<AppInstance>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, app_id, worktree_path, branch, subdomain, port, pid, status
             FROM app_instances WHERE app_id = ?1 ORDER BY rowid",
        )?;
        let rows = stmt.query_map(params![app_id], Self::map_instance)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(anyhow::Error::from)
    }

    pub fn update_instance_status(&self, id: &str, status: &str, pid: Option<u32>) -> Result<()> {
        self.conn.execute(
            "UPDATE app_instances SET status = ?1, pid = ?2 WHERE id = ?3",
            params![status, pid, id],
        )?;
        Ok(())
    }

    pub fn delete_instance(&mut self, id: &str) -> Result<()> {
        let tx = self.conn.transaction()?;
        // Free the port: remove exactly this instance's (port, app_id) row,
        // leaving the app's primary port and sibling instances untouched.
        tx.execute(
            "DELETE FROM port_registry
             WHERE app_id = (SELECT app_id FROM app_instances WHERE id = ?1)
               AND port   = (SELECT port   FROM app_instances WHERE id = ?1)",
            params![id],
        )?;
        tx.execute("DELETE FROM app_instances WHERE id = ?1", params![id])?;
        tx.commit()?;
        Ok(())
    }

    fn map_instance(row: &rusqlite::Row) -> rusqlite::Result<AppInstance> {
        Ok(AppInstance {
            id: row.get(0)?,
            app_id: row.get(1)?,
            worktree_path: row.get(2)?,
            branch: row.get(3)?,
            subdomain: row.get(4)?,
            port: row.get(5)?,
            pid: row.get(6)?,
            status: row.get(7)?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed_app(db: &Database, app_id: &str) {
        // app_instances.app_id has an FK to apps(id); insert a minimal app row.
        db.conn.execute(
            "INSERT INTO apps (id, name, root_dir, port) VALUES (?1, 'a', '/tmp', 4001)",
            params![app_id],
        ).unwrap();
    }

    fn instance(id: &str, app_id: &str, port: u16) -> AppInstance {
        AppInstance {
            id: id.into(), app_id: app_id.into(), worktree_path: "/wt".into(),
            branch: "feature/x".into(), subdomain: "a-feature-x".into(),
            port, pid: None, status: "starting".into(),
        }
    }

    #[test]
    fn insert_list_update_delete_roundtrip() {
        let mut db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        seed_app(&db, "app1");

        db.insert_instance(&instance("app1:feature-x", "app1", 5001)).unwrap();
        assert_eq!(db.list_instances().unwrap().len(), 1);
        assert!(db.used_ports().unwrap().contains(&5001));

        db.update_instance_status("app1:feature-x", "running", Some(999)).unwrap();
        let got = db.list_instances_for("app1").unwrap();
        assert_eq!(got[0].status, "running");
        assert_eq!(got[0].pid, Some(999));

        db.delete_instance("app1:feature-x").unwrap();
        assert!(db.list_instances().unwrap().is_empty());
        assert!(!db.used_ports().unwrap().contains(&5001));
    }
}
