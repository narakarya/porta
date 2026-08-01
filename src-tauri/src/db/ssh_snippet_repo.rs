use anyhow::Result;
use rusqlite::params;

use super::models::SshSnippet;
use super::Database;

const COLS: &str = "id, label, command, host_id, created_at, last_used_at";

impl Database {
    pub fn insert_ssh_snippet(&self, s: &SshSnippet) -> Result<()> {
        self.conn.execute(
            "INSERT INTO ssh_snippets (id, label, command, host_id, created_at, last_used_at)
             VALUES (?1,?2,?3,?4,?5,?6)",
            params![s.id, s.label, s.command, s.host_id, s.created_at, s.last_used_at],
        )?;
        Ok(())
    }

    /// `created_at` and `last_used_at` are not updatable — an edit shouldn't
    /// reorder the list or fake usage the snippet never had.
    pub fn update_ssh_snippet(&self, s: &SshSnippet) -> Result<()> {
        self.conn.execute(
            "UPDATE ssh_snippets SET label=?2, command=?3, host_id=?4 WHERE id=?1",
            params![s.id, s.label, s.command, s.host_id],
        )?;
        Ok(())
    }

    pub fn delete_ssh_snippet(&self, id: &str) -> Result<()> {
        self.conn
            .execute("DELETE FROM ssh_snippets WHERE id=?1", params![id])?;
        Ok(())
    }

    /// Every snippet, globals first then host-scoped, each group most-recently
    /// used first. The frontend filters by host; ordering lives here so the
    /// picker and the manager can't disagree about it.
    pub fn list_ssh_snippets(&self) -> Result<Vec<SshSnippet>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {COLS} FROM ssh_snippets
             ORDER BY host_id IS NOT NULL, last_used_at DESC NULLS LAST, label, rowid"
        ))?;
        let rows = stmt.query_map([], row_to_snippet)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(anyhow::Error::from)
    }

    pub fn touch_ssh_snippet(&self, id: &str, at: i64) -> Result<()> {
        self.conn.execute(
            "UPDATE ssh_snippets SET last_used_at=?2 WHERE id=?1",
            params![id, at],
        )?;
        Ok(())
    }
}

fn row_to_snippet(row: &rusqlite::Row) -> rusqlite::Result<SshSnippet> {
    Ok(SshSnippet {
        id: row.get(0)?,
        label: row.get(1)?,
        command: row.get(2)?,
        host_id: row.get(3)?,
        created_at: row.get(4)?,
        last_used_at: row.get(5)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::models::{SshAuth, SshHost};

    fn host(id: &str) -> SshHost {
        SshHost {
            id: id.into(),
            label: id.into(),
            group: None,
            hostname: format!("{id}.test"),
            port: 22,
            username: "u".into(),
            auth: SshAuth::Agent,
            jump_host_id: None,
            created_at: 1,
            last_used_at: None,
            workspace_ids: vec![],
            detected_os: None,
        }
    }

    fn snippet(id: &str, label: &str, host_id: Option<&str>) -> SshSnippet {
        SshSnippet {
            id: id.into(),
            label: label.into(),
            command: "systemctl status nginx".into(),
            host_id: host_id.map(str::to_string),
            created_at: 10,
            last_used_at: None,
        }
    }

    #[test]
    fn round_trip() {
        let db = Database::open(":memory:".into()).unwrap();
        db.insert_ssh_snippet(&snippet("s1", "nginx", None)).unwrap();
        assert_eq!(db.list_ssh_snippets().unwrap(), vec![snippet("s1", "nginx", None)]);

        let mut edited = snippet("s1", "nginx status", None);
        edited.command = "journalctl -u nginx -n 100".into();
        db.update_ssh_snippet(&edited).unwrap();
        assert_eq!(db.list_ssh_snippets().unwrap()[0], edited);

        db.delete_ssh_snippet("s1").unwrap();
        assert!(db.list_ssh_snippets().unwrap().is_empty());
    }

    #[test]
    fn globals_lead_and_recent_wins_inside_a_group() {
        let db = Database::open(":memory:".into()).unwrap();
        db.insert_ssh_host(&host("h1")).unwrap();
        db.insert_ssh_snippet(&snippet("g1", "alpha", None)).unwrap();
        db.insert_ssh_snippet(&snippet("g2", "beta", None)).unwrap();
        db.insert_ssh_snippet(&snippet("s1", "scoped", Some("h1"))).unwrap();

        // Untouched: alphabetical within the global group, scoped last.
        let ids: Vec<String> = db.list_ssh_snippets().unwrap().into_iter().map(|s| s.id).collect();
        assert_eq!(ids, vec!["g1", "g2", "s1"]);

        // Using `beta` floats it above `alpha` without disturbing the grouping.
        db.touch_ssh_snippet("g2", 99).unwrap();
        let ids: Vec<String> = db.list_ssh_snippets().unwrap().into_iter().map(|s| s.id).collect();
        assert_eq!(ids, vec!["g2", "g1", "s1"]);
    }

    #[test]
    fn deleting_a_host_takes_its_snippets_but_spares_globals() {
        let db = Database::open(":memory:".into()).unwrap();
        db.insert_ssh_host(&host("h1")).unwrap();
        db.insert_ssh_snippet(&snippet("g1", "global", None)).unwrap();
        db.insert_ssh_snippet(&snippet("s1", "scoped", Some("h1"))).unwrap();

        db.delete_ssh_host("h1").unwrap();
        let ids: Vec<String> = db.list_ssh_snippets().unwrap().into_iter().map(|s| s.id).collect();
        assert_eq!(ids, vec!["g1"], "a host-scoped snippet must not outlive its host");
    }
}
