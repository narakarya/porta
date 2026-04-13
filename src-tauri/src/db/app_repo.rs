use anyhow::Result;
use rusqlite::params;
use std::collections::HashMap;

use super::models::{self, App, CustomDeployCmd};
use super::Database;

impl Database {
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
    #[allow(clippy::too_many_arguments)]
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

    pub fn get_deploy_custom_cmds(&self, app_id: &str) -> Result<Vec<CustomDeployCmd>> {
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
        cmds: &[CustomDeployCmd],
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
}
