use anyhow::Result;
use rusqlite::params;
use std::collections::HashMap;

use super::models::Service;
use super::Database;

impl Database {
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

    #[allow(clippy::too_many_arguments)]
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
