use anyhow::Result;
use rusqlite::params;

use super::models::{SshForwardKind, SshPortForward};
use super::Database;

const COLS: &str = "id, host_id, kind, label, bind_address, local_port, remote_host, remote_port, \
                    auto_start, created_at";

impl Database {
    pub fn insert_ssh_forward(&self, f: &SshPortForward) -> Result<()> {
        self.conn.execute(
            "INSERT INTO ssh_port_forwards (id, host_id, kind, label, bind_address, local_port, remote_host, remote_port, auto_start, created_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![
                f.id,
                f.host_id,
                f.kind.as_str(),
                f.label,
                f.bind_address,
                f.local_port,
                f.remote_host,
                f.remote_port,
                f.auto_start,
                f.created_at
            ],
        )?;
        Ok(())
    }

    /// `host_id` and `created_at` are deliberately not updatable — a forward
    /// cannot move between hosts, and rewriting its creation time on every edit
    /// would scramble list ordering.
    pub fn update_ssh_forward(&self, f: &SshPortForward) -> Result<()> {
        self.conn.execute(
            "UPDATE ssh_port_forwards
             SET kind=?2, label=?3, bind_address=?4, local_port=?5, remote_host=?6,
                 remote_port=?7, auto_start=?8
             WHERE id=?1",
            params![
                f.id,
                f.kind.as_str(),
                f.label,
                f.bind_address,
                f.local_port,
                f.remote_host,
                f.remote_port,
                f.auto_start
            ],
        )?;
        Ok(())
    }

    pub fn delete_ssh_forward(&self, id: &str) -> Result<()> {
        self.conn
            .execute("DELETE FROM ssh_port_forwards WHERE id=?1", params![id])?;
        Ok(())
    }

    pub fn list_ssh_forwards_for_host(&self, host_id: &str) -> Result<Vec<SshPortForward>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {COLS} FROM ssh_port_forwards WHERE host_id=?1 ORDER BY created_at, rowid"
        ))?;
        let rows = stmt.query_map(params![host_id], row_to_forward)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(anyhow::Error::from)
    }

    pub fn get_ssh_forward(&self, id: &str) -> Result<Option<SshPortForward>> {
        let mut stmt = self
            .conn
            .prepare(&format!("SELECT {COLS} FROM ssh_port_forwards WHERE id=?1"))?;
        let mut rows = stmt.query_map(params![id], row_to_forward)?;
        match rows.next() {
            Some(r) => Ok(Some(r?)),
            None => Ok(None),
        }
    }
}

fn row_to_forward(row: &rusqlite::Row) -> rusqlite::Result<SshPortForward> {
    let kind: String = row.get(2)?;
    Ok(SshPortForward {
        id: row.get(0)?,
        host_id: row.get(1)?,
        kind: SshForwardKind::from_db(&kind),
        label: row.get(3)?,
        bind_address: row.get(4)?,
        local_port: row.get(5)?,
        remote_host: row.get(6)?,
        remote_port: row.get(7)?,
        auto_start: row.get(8)?,
        created_at: row.get(9)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::models::SshAuth;
    use crate::db::models::SshHost;

    fn host() -> SshHost {
        SshHost {
            id: "h1".into(),
            label: "prod".into(),
            group: None,
            hostname: "prod.test".into(),
            port: 22,
            username: "deploy".into(),
            auth: SshAuth::Agent,
            jump_host_id: None,
            created_at: 1,
            last_used_at: None,
            workspace_ids: vec![],
            detected_os: None,
        }
    }

    fn forward(id: &str, host_id: &str) -> SshPortForward {
        SshPortForward {
            id: id.into(),
            host_id: host_id.into(),
            kind: SshForwardKind::Local,
            label: Some("db".into()),
            bind_address: "127.0.0.1".into(),
            local_port: 15432,
            remote_host: "127.0.0.1".into(),
            remote_port: 5432,
            auto_start: true,
            created_at: 10,
        }
    }

    fn db() -> Database {
        let db = Database::open(":memory:".into()).unwrap();
        db.insert_ssh_host(&host()).unwrap();
        db
    }

    #[test]
    fn round_trip() {
        let db = db();
        db.insert_ssh_forward(&forward("f1", "h1")).unwrap();
        assert_eq!(db.get_ssh_forward("f1").unwrap().unwrap(), forward("f1", "h1"));

        let mut edited = forward("f1", "h1");
        edited.local_port = 0;
        edited.label = None;
        edited.auto_start = false;
        edited.kind = SshForwardKind::Dynamic;
        db.update_ssh_forward(&edited).unwrap();
        assert_eq!(db.get_ssh_forward("f1").unwrap().unwrap(), edited);

        db.delete_ssh_forward("f1").unwrap();
        assert!(db.get_ssh_forward("f1").unwrap().is_none());
    }

    #[test]
    fn list_is_scoped_to_one_host() {
        let db = db();
        let mut other = host();
        other.id = "h2".into();
        other.label = "staging".into();
        db.insert_ssh_host(&other).unwrap();

        db.insert_ssh_forward(&forward("f1", "h1")).unwrap();
        db.insert_ssh_forward(&forward("f2", "h2")).unwrap();

        let got = db.list_ssh_forwards_for_host("h1").unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].id, "f1");
    }

    #[test]
    fn deleting_a_host_takes_its_forwards() {
        // Foreign keys are off process-wide, so the ON DELETE CASCADE in the
        // DDL is documentation. This asserts the explicit DELETE in
        // `delete_ssh_host` — without it the rows orphan and reappear the next
        // time a host is created with a recycled id.
        let db = db();
        db.insert_ssh_forward(&forward("f1", "h1")).unwrap();
        db.delete_ssh_host("h1").unwrap();
        assert!(db.list_ssh_forwards_for_host("h1").unwrap().is_empty());
    }

    #[test]
    fn unknown_kind_falls_back_to_local() {
        // A row written by a newer build must not make the host unlistable.
        let db = db();
        db.insert_ssh_forward(&forward("f1", "h1")).unwrap();
        db.conn
            .execute("UPDATE ssh_port_forwards SET kind='quantum' WHERE id='f1'", [])
            .unwrap();
        assert_eq!(
            db.get_ssh_forward("f1").unwrap().unwrap().kind,
            SshForwardKind::Local
        );
    }

    #[test]
    fn serde_defaults_cover_missing_fields() {
        // Guards the #[serde(default)] contract: a payload from an older
        // frontend build (or a hand-written one) must still deserialize.
        let json = r#"{
            "id": "f1", "host_id": "h1", "local_port": 0,
            "remote_host": "127.0.0.1", "remote_port": 5432, "created_at": 0
        }"#;
        let f: SshPortForward = serde_json::from_str(json).unwrap();
        assert_eq!(f.kind, SshForwardKind::Local);
        assert_eq!(f.bind_address, "127.0.0.1");
        assert!(!f.auto_start);
        assert_eq!(f.label, None);
    }
}
