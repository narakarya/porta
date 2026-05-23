use anyhow::Result;
use rusqlite::params;

use super::models::Workspace;
use super::Database;

impl Database {
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
}
