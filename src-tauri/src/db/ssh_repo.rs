use anyhow::Result;
use rusqlite::params;

use super::models::SshHost;
use super::Database;

impl Database {
    pub fn insert_ssh_host(&self, h: &SshHost) -> Result<()> {
        let auth = serde_json::to_string(&h.auth)?;
        self.conn.execute(
            "INSERT INTO ssh_hosts (id, label, grp, hostname, port, username, auth_json, jump_host_id, created_at, last_used_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![h.id, h.label, h.group, h.hostname, h.port, h.username, auth, h.jump_host_id, h.created_at, h.last_used_at],
        )?;
        Ok(())
    }

    pub fn update_ssh_host(&self, h: &SshHost) -> Result<()> {
        let auth = serde_json::to_string(&h.auth)?;
        self.conn.execute(
            "UPDATE ssh_hosts SET label=?1, grp=?2, hostname=?3, port=?4, username=?5, auth_json=?6, jump_host_id=?7 WHERE id=?8",
            params![h.label, h.group, h.hostname, h.port, h.username, auth, h.jump_host_id, h.id],
        )?;
        Ok(())
    }

    pub fn delete_ssh_host(&self, id: &str) -> Result<()> {
        self.conn.execute("DELETE FROM ssh_hosts WHERE id=?1", params![id])?;
        Ok(())
    }

    pub fn list_ssh_hosts(&self) -> Result<Vec<SshHost>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, label, grp, hostname, port, username, auth_json, jump_host_id, created_at, last_used_at
             FROM ssh_hosts ORDER BY grp, label, rowid")?;
        let rows = stmt.query_map([], row_to_ssh_host)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(anyhow::Error::from)
    }

    pub fn get_ssh_host(&self, id: &str) -> Result<Option<SshHost>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, label, grp, hostname, port, username, auth_json, jump_host_id, created_at, last_used_at
             FROM ssh_hosts WHERE id=?1")?;
        let mut rows = stmt.query_map(params![id], row_to_ssh_host)?;
        match rows.next() { Some(r) => Ok(Some(r?)), None => Ok(None) }
    }

    pub fn touch_ssh_host(&self, id: &str, at: i64) -> Result<()> {
        self.conn.execute("UPDATE ssh_hosts SET last_used_at=?1 WHERE id=?2", params![at, id])?;
        Ok(())
    }
}

fn row_to_ssh_host(row: &rusqlite::Row) -> rusqlite::Result<SshHost> {
    let auth_json: String = row.get(6)?;
    Ok(SshHost {
        id: row.get(0)?,
        label: row.get(1)?,
        group: row.get(2)?,
        hostname: row.get(3)?,
        port: row.get(4)?,
        username: row.get(5)?,
        auth: serde_json::from_str(&auth_json).map_err(|e| rusqlite::Error::FromSqlConversionFailure(6, rusqlite::types::Type::Text, Box::new(e)))?,
        jump_host_id: row.get(7)?,
        created_at: row.get(8)?,
        last_used_at: row.get(9)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::models::SshAuth;

    fn sample() -> SshHost {
        SshHost {
            id: "s1".into(), label: "prod-web".into(), group: Some("Production".into()),
            hostname: "1.2.3.4".into(), port: 22, username: "deploy".into(),
            auth: SshAuth::KeyFile { path: "~/.ssh/id_ed25519".into() },
            jump_host_id: None, created_at: 100, last_used_at: None,
        }
    }

    #[test]
    fn ssh_host_round_trip() {
        let db = Database::open(":memory:".into()).unwrap();
        db.insert_ssh_host(&sample()).unwrap();
        assert_eq!(db.list_ssh_hosts().unwrap().len(), 1);

        let got = db.get_ssh_host("s1").unwrap().unwrap();
        assert_eq!(got, sample());

        let mut edited = sample();
        edited.auth = SshAuth::Agent;
        edited.label = "prod-web-2".into();
        db.update_ssh_host(&edited).unwrap();
        assert_eq!(db.get_ssh_host("s1").unwrap().unwrap().auth, SshAuth::Agent);

        db.touch_ssh_host("s1", 999).unwrap();
        assert_eq!(db.get_ssh_host("s1").unwrap().unwrap().last_used_at, Some(999));

        db.delete_ssh_host("s1").unwrap();
        assert!(db.get_ssh_host("s1").unwrap().is_none());
    }
}
