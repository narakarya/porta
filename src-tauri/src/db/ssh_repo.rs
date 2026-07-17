use anyhow::Result;
use rusqlite::params;

use super::models::{SshHost, SshKnownHost};
use super::Database;

impl Database {
    pub fn insert_ssh_host(&self, h: &SshHost) -> Result<()> {
        let auth = serde_json::to_string(&h.auth)?;
        self.conn.execute(
            "INSERT INTO ssh_hosts (id, label, grp, hostname, port, username, auth_json, jump_host_id, created_at, last_used_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![h.id, h.label, h.group, h.hostname, h.port, h.username, auth, h.jump_host_id, h.created_at, h.last_used_at],
        )?;
        self.set_host_workspaces(&h.id, &h.workspace_ids)?;
        Ok(())
    }

    pub fn update_ssh_host(&self, h: &SshHost) -> Result<()> {
        let auth = serde_json::to_string(&h.auth)?;
        self.conn.execute(
            "UPDATE ssh_hosts SET label=?1, grp=?2, hostname=?3, port=?4, username=?5, auth_json=?6, jump_host_id=?7 WHERE id=?8",
            params![h.label, h.group, h.hostname, h.port, h.username, auth, h.jump_host_id, h.id],
        )?;
        self.set_host_workspaces(&h.id, &h.workspace_ids)?;
        Ok(())
    }

    /// Replace a host's workspace attachments with `workspace_ids` (many-to-many).
    pub fn set_host_workspaces(&self, host_id: &str, workspace_ids: &[String]) -> Result<()> {
        self.conn.execute("DELETE FROM ssh_host_workspaces WHERE host_id=?1", params![host_id])?;
        for wid in workspace_ids {
            self.conn.execute(
                "INSERT OR IGNORE INTO ssh_host_workspaces (host_id, workspace_id) VALUES (?1, ?2)",
                params![host_id, wid],
            )?;
        }
        Ok(())
    }

    /// Workspace ids a host is attached to (empty = global).
    pub fn list_workspaces_for_host(&self, host_id: &str) -> Result<Vec<String>> {
        let mut stmt = self.conn.prepare(
            "SELECT workspace_id FROM ssh_host_workspaces WHERE host_id=?1 ORDER BY workspace_id")?;
        let rows = stmt.query_map(params![host_id], |r| r.get::<_, String>(0))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(anyhow::Error::from)
    }

    pub fn delete_ssh_host(&self, id: &str) -> Result<()> {
        // Explicit (not relying on FK cascade being enabled) so join rows never orphan.
        self.conn.execute("DELETE FROM ssh_host_workspaces WHERE host_id=?1", params![id])?;
        self.conn.execute("DELETE FROM ssh_hosts WHERE id=?1", params![id])?;
        Ok(())
    }

    pub fn list_ssh_hosts(&self) -> Result<Vec<SshHost>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, label, grp, hostname, port, username, auth_json, jump_host_id, created_at, last_used_at, detected_os
             FROM ssh_hosts ORDER BY grp, label, rowid")?;
        let mut hosts = stmt.query_map([], row_to_ssh_host)?
            .collect::<Result<Vec<_>, _>>()?;
        for h in &mut hosts {
            h.workspace_ids = self.list_workspaces_for_host(&h.id)?;
        }
        Ok(hosts)
    }

    pub fn get_ssh_host(&self, id: &str) -> Result<Option<SshHost>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, label, grp, hostname, port, username, auth_json, jump_host_id, created_at, last_used_at, detected_os
             FROM ssh_hosts WHERE id=?1")?;
        let mut rows = stmt.query_map(params![id], row_to_ssh_host)?;
        let mut host = match rows.next() { Some(r) => r?, None => return Ok(None) };
        drop(rows);
        drop(stmt);
        host.workspace_ids = self.list_workspaces_for_host(id)?;
        Ok(Some(host))
    }

    pub fn touch_ssh_host(&self, id: &str, at: i64) -> Result<()> {
        self.conn.execute("UPDATE ssh_hosts SET last_used_at=?1 WHERE id=?2", params![at, id])?;
        Ok(())
    }

    /// Store the remote OS detected on connect. Engine-managed (the host form
    /// never sets it, so `update_ssh_host` leaves this column untouched).
    pub fn set_detected_os(&self, id: &str, os: &str) -> Result<()> {
        self.conn.execute("UPDATE ssh_hosts SET detected_os=?1 WHERE id=?2", params![os, id])?;
        Ok(())
    }
}

use base64::Engine;
use sha2::{Digest, Sha256};

/// Outcome of comparing a freshly-observed server key fingerprint against
/// the one Porta has on file for `(host, port)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostKeyVerdict { Trusted, Unknown, Mismatch }

/// Formats a raw public key blob as an OpenSSH-style `SHA256:<base64>`
/// fingerprint (unpadded standard base64, matching `ssh-keygen -lf`).
pub fn fingerprint_sha256(key_bytes: &[u8]) -> String {
    let digest = Sha256::digest(key_bytes);
    let b64 = base64::engine::general_purpose::STANDARD_NO_PAD.encode(digest);
    format!("SHA256:{b64}")
}

impl Database {
    pub fn known_host_lookup(&self, host: &str, port: u16) -> Result<Option<SshKnownHost>> {
        let mut stmt = self.conn.prepare(
            "SELECT host, port, fingerprint, key_type, added_at FROM ssh_known_hosts WHERE host=?1 AND port=?2")?;
        let mut rows = stmt.query_map(params![host, port], |r| Ok(SshKnownHost {
            host: r.get(0)?, port: r.get(1)?, fingerprint: r.get(2)?, key_type: r.get(3)?, added_at: r.get(4)?,
        }))?;
        match rows.next() { Some(r) => Ok(Some(r?)), None => Ok(None) }
    }

    pub fn trust_known_host(&self, k: &SshKnownHost) -> Result<()> {
        self.conn.execute(
            "INSERT INTO ssh_known_hosts (host, port, fingerprint, key_type, added_at) VALUES (?1,?2,?3,?4,?5)
             ON CONFLICT(host, port) DO UPDATE SET fingerprint=?3, key_type=?4, added_at=?5",
            params![k.host, k.port, k.fingerprint, k.key_type, k.added_at])?;
        Ok(())
    }

    pub fn verify_host_key(&self, host: &str, port: u16, fingerprint: &str) -> Result<HostKeyVerdict> {
        Ok(match self.known_host_lookup(host, port)? {
            None => HostKeyVerdict::Unknown,
            Some(k) if k.fingerprint == fingerprint => HostKeyVerdict::Trusted,
            Some(_) => HostKeyVerdict::Mismatch,
        })
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
        detected_os: row.get(10)?,
        workspace_ids: Vec::new(), // populated by the caller (list/get) from the join table
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
            workspace_ids: Vec::new(), detected_os: None,
        }
    }

    #[test]
    fn set_detected_os_persists() {
        let db = Database::open(":memory:".into()).unwrap();
        db.insert_ssh_host(&sample()).unwrap();
        assert!(db.get_ssh_host("s1").unwrap().unwrap().detected_os.is_none());
        db.set_detected_os("s1", "Ubuntu 22.04").unwrap();
        assert_eq!(db.get_ssh_host("s1").unwrap().unwrap().detected_os.as_deref(), Some("Ubuntu 22.04"));
    }

    #[test]
    fn ssh_host_workspace_attachments_round_trip() {
        let db = Database::open(":memory:".into()).unwrap();
        // Parent workspace rows (ssh_host_workspaces.workspace_id FKs workspaces.id).
        db.conn.execute("INSERT INTO workspaces (id, name, domain) VALUES ('w1','A','a.test')", []).unwrap();
        db.conn.execute("INSERT INTO workspaces (id, name, domain) VALUES ('w2','B','b.test')", []).unwrap();

        let mut h = sample();
        h.workspace_ids = vec!["w1".into(), "w2".into()];
        db.insert_ssh_host(&h).unwrap();

        let got = db.get_ssh_host("s1").unwrap().unwrap();
        assert_eq!(got.workspace_ids, vec!["w1".to_string(), "w2".to_string()]);
        assert_eq!(db.list_ssh_hosts().unwrap()[0].workspace_ids, vec!["w1".to_string(), "w2".to_string()]);

        // Update replaces the set.
        let mut edited = got.clone();
        edited.workspace_ids = vec!["w2".into()];
        db.update_ssh_host(&edited).unwrap();
        assert_eq!(db.get_ssh_host("s1").unwrap().unwrap().workspace_ids, vec!["w2".to_string()]);

        // Deleting the host clears its join rows (explicit + cascade-safe).
        db.delete_ssh_host("s1").unwrap();
        assert!(db.list_workspaces_for_host("s1").unwrap().is_empty());
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

    #[test]
    fn known_host_verify_flow() {
        use crate::db::models::SshKnownHost;
        let db = Database::open(":memory:".into()).unwrap();
        assert!(matches!(db.verify_host_key("h", 22, "SHA256:aaa").unwrap(), super::HostKeyVerdict::Unknown));

        db.trust_known_host(&SshKnownHost {
            host: "h".into(), port: 22, fingerprint: "SHA256:aaa".into(),
            key_type: "ssh-ed25519".into(), added_at: 1,
        }).unwrap();

        assert!(matches!(db.verify_host_key("h", 22, "SHA256:aaa").unwrap(), super::HostKeyVerdict::Trusted));
        assert!(matches!(db.verify_host_key("h", 22, "SHA256:bbb").unwrap(), super::HostKeyVerdict::Mismatch));
    }

    #[test]
    fn trust_known_host_upsert_overwrites_existing_fingerprint() {
        use crate::db::models::SshKnownHost;
        let db = Database::open(":memory:".into()).unwrap();

        db.trust_known_host(&SshKnownHost {
            host: "h".into(), port: 22, fingerprint: "SHA256:aaa".into(),
            key_type: "ssh-ed25519".into(), added_at: 1,
        }).unwrap();
        assert!(matches!(db.verify_host_key("h", 22, "SHA256:aaa").unwrap(), super::HostKeyVerdict::Trusted));

        // Re-trusting the same (host, port) with a new fingerprint must hit
        // the ON CONFLICT(host, port) DO UPDATE branch and overwrite in
        // place, not insert a second row.
        db.trust_known_host(&SshKnownHost {
            host: "h".into(), port: 22, fingerprint: "SHA256:bbb".into(),
            key_type: "ssh-rsa".into(), added_at: 2,
        }).unwrap();

        let got = db.known_host_lookup("h", 22).unwrap().unwrap();
        assert_eq!(got.fingerprint, "SHA256:bbb");
        assert_eq!(got.key_type, "ssh-rsa");
        assert_eq!(got.added_at, 2);

        assert!(matches!(db.verify_host_key("h", 22, "SHA256:bbb").unwrap(), super::HostKeyVerdict::Trusted));
        assert!(matches!(db.verify_host_key("h", 22, "SHA256:aaa").unwrap(), super::HostKeyVerdict::Mismatch));
    }

    #[test]
    fn fingerprint_is_stable() {
        let fp = super::fingerprint_sha256(b"hello");
        assert!(fp.starts_with("SHA256:"));
        assert_eq!(fp, super::fingerprint_sha256(b"hello"));
        assert_ne!(fp, super::fingerprint_sha256(b"world"));
    }
}
