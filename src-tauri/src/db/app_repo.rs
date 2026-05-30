use anyhow::Result;
use rusqlite::params;
use std::collections::HashMap;

use super::models::{self, App};
use super::Database;

impl Database {
    pub fn insert_app(&mut self, a: &App) -> Result<()> {
        let env_vars_json = serde_json::to_string(&a.env_vars).unwrap_or_else(|_| "{}".into());
        let depends_on_json = serde_json::to_string(&a.depends_on).unwrap_or_else(|_| "[]".into());
        let extra_subdomains_json = serde_json::to_string(&a.extra_subdomains).unwrap_or_else(|_| "[]".into());
        let port_bindings_json = serde_json::to_string(&a.port_bindings).unwrap_or_else(|_| "[]".into());
        let env_profiles_json = serde_json::to_string(&a.env_profiles).unwrap_or_else(|_| "[]".into());
        let docker_volumes_json = serde_json::to_string(&a.docker_volumes).unwrap_or_else(|_| "[]".into());
        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT INTO apps (id, workspace_id, name, root_dir, port, subdomain,
                               start_command, start_command_source, status, pid,
                               env_file, auto_start, env_vars, restart_policy, max_retries,
                               health_check_path, depends_on, extra_subdomains, custom_domain,
                               port_bindings, env_profiles, active_profile_id, kind,
                               docker_image, docker_container_port, docker_args, docker_volumes,
                               compose_file, network_share, tunnel_name, tunnel_custom_hostname,
                               tunnel_provider, tunnel_auto_start,
                               basic_auth_enabled, basic_auth_username, basic_auth_password_hash,
                               tunnel_alias_domain, tunnel_alias_rewrite_host)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30, ?31, ?32, ?33, ?34, ?35, ?36, ?37, ?38)",
            params![
                a.id, a.workspace_id, a.name, a.root_dir, a.port,
                a.subdomain, a.start_command, a.start_command_source,
                a.status, a.pid, a.env_file, a.auto_start as i32,
                env_vars_json, a.restart_policy, a.max_retries as i32,
                a.health_check_path, depends_on_json, extra_subdomains_json,
                a.custom_domain, port_bindings_json, env_profiles_json,
                a.active_profile_id, a.kind,
                a.docker_image, a.docker_container_port, a.docker_args, docker_volumes_json,
                a.compose_file, a.network_share as i32,
                a.tunnel_name, a.tunnel_custom_hostname,
                a.tunnel_provider, a.tunnel_auto_start as i32,
                a.basic_auth_enabled as i32, a.basic_auth_username, a.basic_auth_password_hash,
                a.tunnel_alias_domain, a.tunnel_alias_rewrite_host as i32
            ],
        )?;
        // Register primary port
        tx.execute(
            "INSERT INTO port_registry (port, app_id) VALUES (?1, ?2)",
            params![a.port, a.id],
        )?;
        // Register each binding port. INSERT OR IGNORE: bindings may share the
        // primary port or each other (same backend, multiple domains).
        for binding in &a.port_bindings {
            tx.execute(
                "INSERT OR IGNORE INTO port_registry (port, app_id) VALUES (?1, ?2)",
                params![binding.port, a.id],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn list_apps(&self) -> Result<Vec<App>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, workspace_id, name, root_dir, port, subdomain,
                    start_command, start_command_source, status, pid,
                    env_file, auto_start, env_vars, restart_policy, max_retries,
                    health_check_path, depends_on, extra_subdomains,
                    custom_domain,
                    COALESCE(port_bindings, '[]'),
                    COALESCE(env_profiles, '[]'),
                    active_profile_id,
                    COALESCE(kind, 'process'),
                    docker_image, docker_container_port, docker_args,
                    COALESCE(docker_volumes, '[]'),
                    compose_file,
                    COALESCE(network_share, 0),
                    tunnel_name, tunnel_custom_hostname,
                    tunnel_provider,
                    COALESCE(tunnel_auto_start, 0),
                    COALESCE(basic_auth_enabled, 0),
                    basic_auth_username, basic_auth_password_hash,
                    tunnel_alias_domain,
                    COALESCE(tunnel_alias_rewrite_host, 1)
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
            let custom_domain: Option<String> = row.get(18)?;
            let port_bindings_str: String = row.get::<_, Option<String>>(19)?.unwrap_or_else(|| "[]".into());
            let port_bindings: Vec<models::PortBinding> = serde_json::from_str(&port_bindings_str).unwrap_or_default();
            let env_profiles_str: String = row.get::<_, Option<String>>(20)?.unwrap_or_else(|| "[]".into());
            let env_profiles: Vec<models::EnvProfile> = serde_json::from_str(&env_profiles_str).unwrap_or_default();
            let active_profile_id: Option<String> = row.get(21)?;
            let kind: String = row.get(22)?;
            let docker_image: Option<String> = row.get(23)?;
            let docker_container_port: Option<u16> = row.get(24)?;
            let docker_args: Option<String> = row.get(25)?;
            let docker_volumes_str: String = row.get::<_, Option<String>>(26)?.unwrap_or_else(|| "[]".into());
            let docker_volumes: Vec<String> = serde_json::from_str(&docker_volumes_str).unwrap_or_default();
            let compose_file: Option<String> = row.get(27)?;
            let network_share: bool = row.get::<_, i32>(28).map(|v| v != 0).unwrap_or(false);
            let tunnel_name: Option<String> = row.get(29)?;
            let tunnel_custom_hostname: Option<String> = row.get(30)?;
            let tunnel_provider: Option<String> = row.get(31)?;
            let tunnel_auto_start: bool = row.get::<_, i32>(32).map(|v| v != 0).unwrap_or(false);
            let basic_auth_enabled: bool = row.get::<_, i32>(33).map(|v| v != 0).unwrap_or(false);
            let basic_auth_username: Option<String> = row.get(34)?;
            let basic_auth_password_hash: Option<String> = row.get(35)?;
            let basic_auth_password_set = basic_auth_password_hash.is_some();
            let tunnel_alias_domain: Option<String> = row.get(36)?;
            let tunnel_alias_rewrite_host: bool = row.get::<_, i32>(37).map(|v| v != 0).unwrap_or(true);
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
                custom_domain,
                tunnel_provider,
                tunnel_auto_start,
                tunnel_url: None,
                tunnel_active: false,
                port_bindings,
                env_profiles,
                active_profile_id,
                kind,
                docker_image,
                docker_container_port,
                docker_args,
                docker_volumes,
                compose_file,
                network_share,
                tunnel_name,
                tunnel_custom_hostname,
                basic_auth_enabled,
                basic_auth_username,
                basic_auth_password_hash,
                basic_auth_password_set,
                tunnel_alias_domain,
                tunnel_alias_rewrite_host,
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
        root_dir: Option<&str>,
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
        custom_domain: Option<&str>,
        port_bindings: &[models::PortBinding],
        env_profiles: &[models::EnvProfile],
        active_profile_id: Option<&str>,
        docker_image: Option<&str>,
        docker_container_port: Option<u16>,
        docker_args: Option<&str>,
        docker_volumes: &[String],
        compose_file: Option<&str>,
        network_share: bool,
        tunnel_name: Option<&str>,
        tunnel_custom_hostname: Option<&str>,
        basic_auth_enabled: bool,
        basic_auth_username: Option<&str>,
        // None = leave existing hash unchanged. Some = overwrite.
        basic_auth_password_hash: Option<&str>,
        tunnel_alias_domain: Option<&str>,
        tunnel_alias_rewrite_host: bool,
    ) -> Result<()> {
        let env_vars_json = serde_json::to_string(env_vars).unwrap_or_else(|_| "{}".into());
        let depends_on_json = serde_json::to_string(depends_on).unwrap_or_else(|_| "[]".into());
        let extra_subdomains_json = serde_json::to_string(extra_subdomains).unwrap_or_else(|_| "[]".into());
        let port_bindings_json = serde_json::to_string(port_bindings).unwrap_or_else(|_| "[]".into());
        let env_profiles_json = serde_json::to_string(env_profiles).unwrap_or_else(|_| "[]".into());
        let docker_volumes_json = serde_json::to_string(docker_volumes).unwrap_or_else(|_| "[]".into());

        if let Some(dir) = root_dir {
            self.conn.execute(
                "UPDATE apps SET name=?1, root_dir=?2, port=?3, subdomain=?4, start_command=?5,
                                 env_file=?6, auto_start=?7, env_vars=?8,
                                 restart_policy=?9, max_retries=?10,
                                 health_check_path=?11, depends_on=?12, extra_subdomains=?13,
                                 custom_domain=?14, port_bindings=?15,
                                 env_profiles=?16, active_profile_id=?17,
                                 docker_image=?18, docker_container_port=?19, docker_args=?20,
                                 docker_volumes=?21, compose_file=?22, network_share=?23,
                                 tunnel_name=?24, tunnel_custom_hostname=?25,
                                 basic_auth_enabled=?26, basic_auth_username=?27,
                                 tunnel_alias_domain=?28, tunnel_alias_rewrite_host=?29
                 WHERE id=?30",
                params![
                    name, dir, port, subdomain, start_command, env_file,
                    auto_start as i32, env_vars_json, restart_policy,
                    max_retries as i32, health_check_path, depends_on_json,
                    extra_subdomains_json, custom_domain, port_bindings_json,
                    env_profiles_json, active_profile_id,
                    docker_image, docker_container_port, docker_args,
                    docker_volumes_json, compose_file, network_share as i32,
                    tunnel_name, tunnel_custom_hostname,
                    basic_auth_enabled as i32, basic_auth_username,
                    tunnel_alias_domain, tunnel_alias_rewrite_host as i32,
                    id
                ],
            )?;
        } else {
            self.conn.execute(
                "UPDATE apps SET name=?1, port=?2, subdomain=?3, start_command=?4,
                                 env_file=?5, auto_start=?6, env_vars=?7,
                                 restart_policy=?8, max_retries=?9,
                                 health_check_path=?10, depends_on=?11, extra_subdomains=?12,
                                 custom_domain=?13, port_bindings=?14,
                                 env_profiles=?15, active_profile_id=?16,
                                 docker_image=?17, docker_container_port=?18, docker_args=?19,
                                 docker_volumes=?20, compose_file=?21, network_share=?22,
                                 tunnel_name=?23, tunnel_custom_hostname=?24,
                                 basic_auth_enabled=?25, basic_auth_username=?26,
                                 tunnel_alias_domain=?27, tunnel_alias_rewrite_host=?28
                 WHERE id=?29",
                params![
                    name, port, subdomain, start_command, env_file,
                    auto_start as i32, env_vars_json, restart_policy,
                    max_retries as i32, health_check_path, depends_on_json,
                    extra_subdomains_json, custom_domain, port_bindings_json,
                    env_profiles_json, active_profile_id,
                    docker_image, docker_container_port, docker_args,
                    docker_volumes_json, compose_file, network_share as i32,
                    tunnel_name, tunnel_custom_hostname,
                    basic_auth_enabled as i32, basic_auth_username,
                    tunnel_alias_domain, tunnel_alias_rewrite_host as i32,
                    id
                ],
            )?;
        }

        // Only overwrite the password hash if a new one was supplied — None means
        // "user left the field blank, keep the previous secret intact".
        if let Some(hash) = basic_auth_password_hash {
            self.conn.execute(
                "UPDATE apps SET basic_auth_password_hash=?1 WHERE id=?2",
                params![hash, id],
            )?;
        }

        // Always rebuild port_registry for this app (primary + all bindings)
        self.conn.execute("DELETE FROM port_registry WHERE app_id = ?1", params![id])?;
        self.conn.execute(
            "INSERT INTO port_registry (port, app_id) VALUES (?1, ?2)",
            params![port, id],
        )?;
        for binding in port_bindings {
            self.conn.execute(
                "INSERT OR IGNORE INTO port_registry (port, app_id) VALUES (?1, ?2)",
                params![binding.port, id],
            )?;
        }
        Ok(())
    }

    /// Single-column port update — used by `apply_port_change` after rewriting
    /// the compose file. Cheaper than the giant `update_app(...)` and avoids
    /// having to thread every other column through the IPC boundary.
    pub fn update_app_port(&self, id: &str, port: u16) -> Result<()> {
        self.conn.execute(
            "UPDATE apps SET port = ?1 WHERE id = ?2",
            params![port, id],
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
        let mut stmt = self.conn.prepare("SELECT DISTINCT port FROM port_registry")?;
        let ports = stmt.query_map([], |row| row.get::<_, u16>(0))?;
        Ok(ports.filter_map(|r| r.ok()).collect())
    }
}
