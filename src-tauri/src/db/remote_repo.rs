use anyhow::Result;
use rusqlite::params;

use super::models::{RemoteHost, RemoteRoute};
use super::Database;

impl Database {
    pub fn insert_remote_host(&self, h: &RemoteHost) -> Result<()> {
        let extra = serde_json::to_string(&h.extra_domains).unwrap_or_else(|_| "[]".into());
        self.conn.execute(
            "INSERT INTO remote_hosts (id, name, tunnel_ip, admin_port, base_domain, wg_interface, mac_tunnel_ip, created_at, public_ip, auto_dns, ssh_user, remote_log_path, extra_domains)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![h.id, h.name, h.tunnel_ip, h.admin_port, h.base_domain, h.wg_interface, h.mac_tunnel_ip, h.created_at, h.public_ip, h.auto_dns, h.ssh_user, h.remote_log_path, extra],
        )?;
        Ok(())
    }

    pub fn update_remote_host(&self, h: &RemoteHost) -> Result<()> {
        let extra = serde_json::to_string(&h.extra_domains).unwrap_or_else(|_| "[]".into());
        self.conn.execute(
            "UPDATE remote_hosts SET name=?1, tunnel_ip=?2, admin_port=?3, base_domain=?4, wg_interface=?5, mac_tunnel_ip=?6, public_ip=?7, auto_dns=?8, ssh_user=?9, remote_log_path=?10, extra_domains=?11 WHERE id=?12",
            params![h.name, h.tunnel_ip, h.admin_port, h.base_domain, h.wg_interface, h.mac_tunnel_ip, h.public_ip, h.auto_dns, h.ssh_user, h.remote_log_path, extra, h.id],
        )?;
        Ok(())
    }

    pub fn delete_remote_host(&self, id: &str) -> Result<()> {
        self.conn.execute("DELETE FROM remote_hosts WHERE id=?1", params![id])?;
        Ok(())
    }

    pub fn list_remote_hosts(&self) -> Result<Vec<RemoteHost>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, tunnel_ip, admin_port, base_domain, wg_interface, mac_tunnel_ip, created_at, public_ip, auto_dns, ssh_user, remote_log_path, extra_domains
             FROM remote_hosts ORDER BY created_at, rowid",
        )?;
        let rows = stmt.query_map([], row_to_host)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(anyhow::Error::from)
    }

    pub fn get_remote_host(&self, id: &str) -> Result<Option<RemoteHost>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, tunnel_ip, admin_port, base_domain, wg_interface, mac_tunnel_ip, created_at, public_ip, auto_dns, ssh_user, remote_log_path, extra_domains
             FROM remote_hosts WHERE id=?1",
        )?;
        let mut rows = stmt.query_map(params![id], row_to_host)?;
        match rows.next() {
            Some(r) => Ok(Some(r?)),
            None => Ok(None),
        }
    }

    pub fn insert_remote_route(&self, r: &RemoteRoute) -> Result<()> {
        self.conn.execute(
            "INSERT INTO remote_routes (id, app_id, host_id, subdomain, port, status, created_at, domain)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![r.id, r.app_id, r.host_id, r.subdomain, r.port, r.status, r.created_at, r.domain],
        )?;
        Ok(())
    }

    pub fn update_remote_route_status(&self, id: &str, status: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE remote_routes SET status=?1 WHERE id=?2",
            params![status, id],
        )?;
        Ok(())
    }

    pub fn delete_remote_route_by_app(&self, app_id: &str) -> Result<()> {
        self.conn.execute("DELETE FROM remote_routes WHERE app_id=?1", params![app_id])?;
        Ok(())
    }

    pub fn list_remote_routes(&self) -> Result<Vec<RemoteRoute>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, app_id, host_id, subdomain, port, status, created_at, domain
             FROM remote_routes ORDER BY created_at, rowid",
        )?;
        let rows = stmt.query_map([], row_to_route)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(anyhow::Error::from)
    }

    pub fn list_remote_routes_for_host(&self, host_id: &str) -> Result<Vec<RemoteRoute>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, app_id, host_id, subdomain, port, status, created_at, domain
             FROM remote_routes WHERE host_id=?1 ORDER BY created_at, rowid",
        )?;
        let rows = stmt.query_map(params![host_id], row_to_route)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(anyhow::Error::from)
    }

    pub fn get_remote_route_for_app(&self, app_id: &str) -> Result<Option<RemoteRoute>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, app_id, host_id, subdomain, port, status, created_at, domain
             FROM remote_routes WHERE app_id=?1",
        )?;
        let mut rows = stmt.query_map(params![app_id], row_to_route)?;
        match rows.next() {
            Some(r) => Ok(Some(r?)),
            None => Ok(None),
        }
    }
}

fn row_to_host(row: &rusqlite::Row) -> rusqlite::Result<RemoteHost> {
    Ok(RemoteHost {
        id: row.get(0)?,
        name: row.get(1)?,
        tunnel_ip: row.get(2)?,
        admin_port: row.get(3)?,
        base_domain: row.get(4)?,
        wg_interface: row.get(5)?,
        mac_tunnel_ip: row.get(6)?,
        created_at: row.get(7)?,
        public_ip: row.get(8)?,
        auto_dns: row.get(9)?,
        ssh_user: row.get(10)?,
        remote_log_path: row.get(11)?,
        extra_domains: serde_json::from_str(&row.get::<_, String>(12)?).unwrap_or_default(),
    })
}

fn row_to_route(row: &rusqlite::Row) -> rusqlite::Result<RemoteRoute> {
    Ok(RemoteRoute {
        id: row.get(0)?,
        app_id: row.get(1)?,
        host_id: row.get(2)?,
        subdomain: row.get(3)?,
        port: row.get(4)?,
        status: row.get(5)?,
        created_at: row.get(6)?,
        domain: row.get(7)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_remote_host_and_route_round_trip() {
        let db = Database::open(":memory:".into()).unwrap();
        let h = RemoteHost {
            id: "h1".into(), name: "vps".into(), tunnel_ip: "10.0.0.1".into(),
            admin_port: 2019, base_domain: "example.com".into(), wg_interface: None,
            mac_tunnel_ip: "10.0.0.2".into(), created_at: 0,
            extra_domains: vec!["klien-a.id".into()],
            public_ip: Some("203.0.113.5".into()), auto_dns: true,
            ssh_user: Some("deploy".into()), remote_log_path: None,
        };
        db.insert_remote_host(&h).unwrap();
        assert_eq!(db.list_remote_hosts().unwrap().len(), 1);
        let got = db.get_remote_host("h1").unwrap().unwrap();
        assert_eq!(got.base_domain, "example.com");
        assert_eq!(got.domains(), vec!["example.com", "klien-a.id"]);

        // remote_routes.app_id is a FK to apps(id); create a minimal parent row.
        db.conn.execute(
            "INSERT INTO apps (id, name, root_dir, port) VALUES ('a1', 'api', '/tmp', 9999)",
            [],
        ).unwrap();

        let r = RemoteRoute {
            id: "r1".into(), app_id: "a1".into(), host_id: "h1".into(),
            subdomain: "myapp".into(), port: 3000, status: "pending".into(), created_at: 0,
            domain: Some("klien-a.id".into()),
        };
        db.insert_remote_route(&r).unwrap();
        db.update_remote_route_status("r1", "active").unwrap();
        let got_route = db.get_remote_route_for_app("a1").unwrap().unwrap();
        assert_eq!(got_route.status, "active");
        assert_eq!(got_route.domain.as_deref(), Some("klien-a.id"));
        assert_eq!(db.list_remote_routes_for_host("h1").unwrap().len(), 1);

        db.delete_remote_route_by_app("a1").unwrap();
        assert!(db.get_remote_route_for_app("a1").unwrap().is_none());
    }
}
