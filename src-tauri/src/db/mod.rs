pub mod models;

mod workspace_repo;
mod app_repo;
mod service_repo;
mod remote_repo;
mod instance_repo;
mod ssh_repo;
pub use ssh_repo::{fingerprint_sha256, HostKeyVerdict};

use anyhow::Result;
use rusqlite::Connection;
use std::path::PathBuf;

pub struct Database {
    pub(crate) conn: Connection,
}

impl Database {
    pub fn open(path: PathBuf) -> Result<Self> {
        let conn = Connection::open(path)?;
        let db = Database { conn };
        db.migrate()?;
        Ok(db)
    }

    /// Open a fresh in-memory SQLite. Used as a placeholder during import
    /// so the previous file-backed connection can be dropped (releasing its
    /// fd & WAL lock) before we overwrite the on-disk DB.
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        Ok(Database { conn })
    }

    pub(crate) fn migrate(&self) -> Result<()> {
        self.conn.execute_batch("
            PRAGMA journal_mode=WAL;

            CREATE TABLE IF NOT EXISTS workspaces (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                domain TEXT NOT NULL UNIQUE
            );

            CREATE TABLE IF NOT EXISTS apps (
                id TEXT PRIMARY KEY,
                workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
                name TEXT NOT NULL,
                root_dir TEXT NOT NULL,
                port INTEGER NOT NULL UNIQUE,
                subdomain TEXT,
                start_command TEXT NOT NULL DEFAULT '',
                start_command_source TEXT NOT NULL DEFAULT 'manual',
                status TEXT NOT NULL DEFAULT 'stopped',
                pid INTEGER
            );

            CREATE TABLE IF NOT EXISTS port_registry (
                port INTEGER NOT NULL,
                app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
                PRIMARY KEY (port, app_id)
            );
        ")?;

        // Migrate existing port_registry from PRIMARY KEY (port) to composite
        // PRIMARY KEY (port, app_id). This allows the same port to appear in
        // multiple bindings (e.g. one app exposing the same backend on several
        // domains for cookie-isolation testing).
        let old_schema: bool = self.conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='port_registry'",
                [],
                |r| r.get::<_, String>(0),
            )
            .map(|sql| sql.contains("port INTEGER PRIMARY KEY"))
            .unwrap_or(false);
        if old_schema {
            self.conn.execute_batch("
                CREATE TABLE port_registry_new (
                    port INTEGER NOT NULL,
                    app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
                    PRIMARY KEY (port, app_id)
                );
                INSERT OR IGNORE INTO port_registry_new (port, app_id)
                    SELECT port, app_id FROM port_registry;
                DROP TABLE port_registry;
                ALTER TABLE port_registry_new RENAME TO port_registry;
            ")?;
        }

        self.conn.execute_batch("
            CREATE TABLE IF NOT EXISTS services (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                image TEXT NOT NULL,
                tag TEXT NOT NULL DEFAULT 'latest',
                port INTEGER NOT NULL,
                env_vars TEXT NOT NULL DEFAULT '{}',
                scope TEXT NOT NULL DEFAULT 'global',
                status TEXT NOT NULL DEFAULT 'stopped',
                container_id TEXT
            );
        ")?;

        // Non-destructive additions
        let _ = self.conn.execute("ALTER TABLE services ADD COLUMN volumes TEXT NOT NULL DEFAULT '[]'", []);
        let _ = self.conn.execute("ALTER TABLE workspaces ADD COLUMN position INTEGER NOT NULL DEFAULT 0", []);
        let _ = self.conn.execute("ALTER TABLE services ADD COLUMN position INTEGER NOT NULL DEFAULT 0", []);
        let _ = self.conn.execute("ALTER TABLE apps ADD COLUMN position INTEGER NOT NULL DEFAULT 0", []);

        // Non-destructive additions for existing databases (errors = column already exists)
        let _ = self.conn.execute("ALTER TABLE apps ADD COLUMN env_file TEXT", []);
        let _ = self.conn.execute("ALTER TABLE apps ADD COLUMN auto_start INTEGER NOT NULL DEFAULT 0", []);
        // v0.2 additions
        let _ = self.conn.execute("ALTER TABLE apps ADD COLUMN env_vars TEXT NOT NULL DEFAULT '{}'", []);
        let _ = self.conn.execute("ALTER TABLE apps ADD COLUMN restart_policy TEXT NOT NULL DEFAULT 'on-failure'", []);
        let _ = self.conn.execute("ALTER TABLE apps ADD COLUMN max_retries INTEGER NOT NULL DEFAULT 3", []);
        // dependency graph
        let _ = self.conn.execute("ALTER TABLE apps ADD COLUMN health_check_path TEXT", []);
        let _ = self.conn.execute("ALTER TABLE apps ADD COLUMN depends_on TEXT NOT NULL DEFAULT '[]'", []);
        // multiple subdomains per app
        let _ = self.conn.execute("ALTER TABLE apps ADD COLUMN extra_subdomains TEXT NOT NULL DEFAULT '[]'", []);
        // deploy custom commands
        let _ = self.conn.execute("ALTER TABLE apps ADD COLUMN deploy_custom_commands TEXT NOT NULL DEFAULT '[]'", []);
        // custom domain per app (overrides workspace domain)
        let _ = self.conn.execute("ALTER TABLE apps ADD COLUMN custom_domain TEXT", []);
        // multi-port bindings
        let _ = self.conn.execute("ALTER TABLE apps ADD COLUMN port_bindings TEXT NOT NULL DEFAULT '[]'", []);
        // environment profiles
        let _ = self.conn.execute("ALTER TABLE apps ADD COLUMN env_profiles TEXT NOT NULL DEFAULT '[]'", []);
        let _ = self.conn.execute("ALTER TABLE apps ADD COLUMN active_profile_id TEXT", []);
        // app kind: "process" (spawn start_command) or "static" (Caddy file_server)
        let _ = self.conn.execute("ALTER TABLE apps ADD COLUMN kind TEXT NOT NULL DEFAULT 'process'", []);
        // docker support
        let _ = self.conn.execute("ALTER TABLE apps ADD COLUMN docker_image TEXT", []);
        let _ = self.conn.execute("ALTER TABLE apps ADD COLUMN docker_container_port INTEGER", []);
        let _ = self.conn.execute("ALTER TABLE apps ADD COLUMN docker_args TEXT", []);
        let _ = self.conn.execute("ALTER TABLE apps ADD COLUMN docker_volumes TEXT NOT NULL DEFAULT '[]'", []);
        let _ = self.conn.execute("ALTER TABLE apps ADD COLUMN compose_file TEXT", []);
        let _ = self.conn.execute("ALTER TABLE apps ADD COLUMN network_share INTEGER NOT NULL DEFAULT 0", []);
        let _ = self.conn.execute("ALTER TABLE apps ADD COLUMN tunnel_name TEXT", []);
        let _ = self.conn.execute("ALTER TABLE apps ADD COLUMN tunnel_custom_hostname TEXT", []);
        // Tunnel provider: "cloudflare" | "tailscale" | NULL. Nullable to distinguish
        // "user hasn't chosen a provider" from either option.
        let _ = self.conn.execute("ALTER TABLE apps ADD COLUMN tunnel_provider TEXT", []);
        // When true, starting the app also starts its configured tunnel.
        let _ = self.conn.execute("ALTER TABLE apps ADD COLUMN tunnel_auto_start INTEGER NOT NULL DEFAULT 0", []);
        // Backfill existing rows that already have a Cloudflare tunnel configured
        // but predate the provider column, so the UI shows the correct selection.
        let _ = self.conn.execute(
            "UPDATE apps SET tunnel_provider = 'cloudflare' WHERE tunnel_provider IS NULL AND tunnel_name IS NOT NULL AND tunnel_name != ''",
            [],
        );

        // Per-app HTTP Basic Auth (Caddy authentication handler). Hash is bcrypt;
        // plaintext password never touches the DB.
        let _ = self.conn.execute("ALTER TABLE apps ADD COLUMN basic_auth_enabled INTEGER NOT NULL DEFAULT 0", []);
        let _ = self.conn.execute("ALTER TABLE apps ADD COLUMN basic_auth_username TEXT", []);
        let _ = self.conn.execute("ALTER TABLE apps ADD COLUMN basic_auth_password_hash TEXT", []);
        // Per-host overrides of the Basic Auth default (JSON array of
        // HostAuthOverride). Lets one app protect only some of its hosts, or
        // use distinct credentials per host.
        let _ = self.conn.execute("ALTER TABLE apps ADD COLUMN host_auth_overrides TEXT NOT NULL DEFAULT '[]'", []);

        // Public alias domain — exposes the app at an alternative hostname
        // pattern (e.g. "*.nasrulgunawan.com") with optional Host-header
        // rewrite back to the local domain so multi-tenant apps that match
        // tenant by hostname don't break behind a tunnel.
        let _ = self.conn.execute("ALTER TABLE apps ADD COLUMN tunnel_alias_domain TEXT", []);
        let _ = self.conn.execute("ALTER TABLE apps ADD COLUMN tunnel_alias_rewrite_host INTEGER NOT NULL DEFAULT 1", []);

        // Auto-sleep: stop the app after `idle_timeout_secs` without HTTP
        // traffic, then transparently wake it on the next request (Caddy errors
        // route → wake server). `auto_slept` distinguishes an idle-induced sleep
        // from a manual stop so the UI can badge it and the watcher can resume.
        let _ = self.conn.execute("ALTER TABLE apps ADD COLUMN auto_sleep_enabled INTEGER NOT NULL DEFAULT 0", []);
        let _ = self.conn.execute("ALTER TABLE apps ADD COLUMN idle_timeout_secs INTEGER NOT NULL DEFAULT 1800", []);
        let _ = self.conn.execute("ALTER TABLE apps ADD COLUMN auto_slept INTEGER NOT NULL DEFAULT 0", []);

        // Per-app max request body size (bytes) for Caddy's `request_body`
        // handler. NULL inherits the global `proxy_max_body_bytes` default; 0
        // means unlimited. Lets upload-heavy apps override the proxy's body cap.
        let _ = self.conn.execute("ALTER TABLE apps ADD COLUMN max_upload_bytes INTEGER", []);

        // Extension registry
        self.conn.execute_batch("
            CREATE TABLE IF NOT EXISTS extensions (
                id TEXT PRIMARY KEY,
                path TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                installed_at INTEGER NOT NULL DEFAULT 0
            );
        ")?;
        // Remote install source (GitHub url/ref); NULL for local-folder installs.
        let _ = self.conn.execute("ALTER TABLE extensions ADD COLUMN source TEXT", []);

        // Per-worktree app instances (multi-instance runner).
        self.conn.execute_batch("
            CREATE TABLE IF NOT EXISTS app_instances (
                id TEXT PRIMARY KEY,
                app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
                worktree_path TEXT NOT NULL,
                branch TEXT NOT NULL,
                subdomain TEXT NOT NULL,
                port INTEGER NOT NULL,
                pid INTEGER,
                status TEXT NOT NULL DEFAULT 'stopped'
            );
        ")?;

        // Porta Relay: user-owned VPS hosts (WireGuard + remote Caddy) and the
        // public routes Porta manages on them. `tunnel_ip` is the VPS's WG IP
        // (admin API + public host reach); `mac_tunnel_ip` is this Mac's WG IP
        // (the upstream Caddy dials back over the tunnel). `wg_interface` NULL
        // means auto-detect via `wg show interfaces`.
        self.conn.execute_batch("
            CREATE TABLE IF NOT EXISTS remote_hosts (
                id            TEXT PRIMARY KEY,
                name          TEXT NOT NULL,
                tunnel_ip     TEXT NOT NULL,
                admin_port    INTEGER NOT NULL DEFAULT 2019,
                base_domain   TEXT NOT NULL,
                wg_interface  TEXT,
                mac_tunnel_ip TEXT NOT NULL,
                created_at    INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS remote_routes (
                id         TEXT PRIMARY KEY,
                app_id     TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
                host_id    TEXT NOT NULL REFERENCES remote_hosts(id) ON DELETE CASCADE,
                subdomain  TEXT NOT NULL,
                port       INTEGER NOT NULL,
                status     TEXT NOT NULL DEFAULT 'active',
                created_at INTEGER NOT NULL DEFAULT 0
            );
        ")?;

        // Porta Relay Spec 3: public IP for Cloudflare A records (R6), an opt-in
        // auto-DNS flag, and SSH details for tailing the VPS Caddy access log (R8).
        let _ = self.conn.execute("ALTER TABLE remote_hosts ADD COLUMN public_ip TEXT", []);
        let _ = self.conn.execute("ALTER TABLE remote_hosts ADD COLUMN auto_dns INTEGER NOT NULL DEFAULT 0", []);
        let _ = self.conn.execute("ALTER TABLE remote_hosts ADD COLUMN ssh_user TEXT", []);
        let _ = self.conn.execute("ALTER TABLE remote_hosts ADD COLUMN remote_log_path TEXT", []);

        // Multi-domain: a host can serve several domains (all pointing at the VPS).
        // `base_domain` stays the primary/default; `extra_domains` is a JSON array
        // of additional ones. A route records which `domain` it was exposed on
        // (NULL = the host's base_domain, for rows created before this column).
        let _ = self.conn.execute("ALTER TABLE remote_hosts ADD COLUMN extra_domains TEXT NOT NULL DEFAULT '[]'", []);
        let _ = self.conn.execute("ALTER TABLE remote_routes ADD COLUMN domain TEXT", []);

        self.conn.execute_batch("
            CREATE TABLE IF NOT EXISTS ssh_hosts (
                id           TEXT PRIMARY KEY,
                label        TEXT NOT NULL,
                grp          TEXT,
                hostname     TEXT NOT NULL,
                port         INTEGER NOT NULL DEFAULT 22,
                username     TEXT NOT NULL,
                auth_json    TEXT NOT NULL,
                jump_host_id TEXT,
                created_at   INTEGER NOT NULL DEFAULT 0,
                last_used_at INTEGER
            );
        ")?;

        // Trusted SSH server host keys (SHA256 fingerprints), keyed by
        // (host, port) — mirrors OpenSSH's known_hosts so we can detect a
        // changed/mismatched key on reconnect.
        self.conn.execute_batch("
            CREATE TABLE IF NOT EXISTS ssh_known_hosts (
                host        TEXT NOT NULL,
                port        INTEGER NOT NULL DEFAULT 22,
                fingerprint TEXT NOT NULL,
                key_type    TEXT NOT NULL,
                added_at    INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (host, port)
            );
        ")?;

        // Many-to-many: which workspaces an SSH host is attached to. A host with
        // no rows here is "global". Cascades so deleting a host or workspace
        // clears its links.
        self.conn.execute_batch("
            CREATE TABLE IF NOT EXISTS ssh_host_workspaces (
                host_id      TEXT NOT NULL REFERENCES ssh_hosts(id) ON DELETE CASCADE,
                workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
                PRIMARY KEY (host_id, workspace_id)
            );
        ")?;

        // Remote OS detected on connect (added after the initial ssh_hosts table
        // shipped, so ALTER for existing installs; ignored if already present).
        let _ = self.conn.execute("ALTER TABLE ssh_hosts ADD COLUMN detected_os TEXT", []);

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use models::{App, Workspace};
    use std::collections::HashMap;

    fn in_memory_db() -> Database {
        Database::open(":memory:".into()).unwrap()
    }

    #[test]
    fn test_migrate_creates_tables() {
        let db = in_memory_db();
        let count: i64 = db.conn.query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('workspaces','apps','port_registry')",
            [], |r| r.get(0)
        ).unwrap();
        assert_eq!(count, 3);
    }

    #[test]
    fn test_insert_and_list_workspace() {
        let db = in_memory_db();
        let w = Workspace { id: "w1".into(), name: "Test".into(), domain: "test.test".into(), deployment: None };
        db.insert_workspace(&w).unwrap();
        let list = db.list_workspaces().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].domain, "test.test");
    }

    #[test]
    fn test_insert_app_registers_port() {
        let mut db = in_memory_db();
        let a = App {
            id: "a1".into(), workspace_id: None, name: "api".into(),
            root_dir: "/tmp".into(), port: 4001, subdomain: None,
            start_command: "mix phx.server".into(),
            start_command_source: "auto".into(),
            status: "stopped".into(), pid: None,
            env_file: None, auto_start: false,
            env_vars: HashMap::new(),
            restart_policy: "on-failure".into(),
            max_retries: 3,
            health_check_path: None,
            depends_on: vec![],
            extra_subdomains: vec![],
            custom_domain: None,
            kind: "process".into(),
            tunnel_provider: None,
            tunnel_auto_start: false,
            tunnel_url: None,
            tunnel_active: false,
            port_bindings: vec![],
            env_profiles: vec![],
            active_profile_id: None,
            basic_auth_enabled: false,
            basic_auth_username: None,
            basic_auth_password_hash: None,
            basic_auth_password_set: false,
            host_auth_overrides: vec![],
            tunnel_alias_domain: None,
            tunnel_alias_rewrite_host: true, auto_sleep_enabled: false, idle_timeout_secs: 1800, auto_slept: false, max_upload_bytes: None,
            docker_image: None,
            docker_container_port: None,
            docker_args: None,
            docker_volumes: vec![],
            compose_file: None,
            network_share: false,
            tunnel_name: None,
            tunnel_custom_hostname: None,
        };
        db.insert_app(&a).unwrap();
        let ports = db.used_ports().unwrap();
        assert_eq!(ports, vec![4001]);
    }

    #[test]
    fn test_insert_app_with_binding_sharing_primary_port() {
        // Same backend port reachable via multiple domains (cookie isolation
        // testing) must not trip port_registry's PRIMARY KEY.
        let mut db = in_memory_db();
        let a = App {
            id: "a3".into(), workspace_id: None, name: "api".into(),
            root_dir: "/tmp".into(), port: 4003, subdomain: None,
            start_command: "node server.js".into(),
            start_command_source: "manual".into(),
            status: "stopped".into(), pid: None,
            env_file: None, auto_start: false,
            env_vars: HashMap::new(),
            restart_policy: "on-failure".into(),
            max_retries: 3,
            health_check_path: None,
            depends_on: vec![],
            extra_subdomains: vec![],
            custom_domain: None,
            kind: "process".into(),
            tunnel_provider: None,
            tunnel_auto_start: false,
            tunnel_url: None,
            tunnel_active: false,
            port_bindings: vec![
                models::PortBinding {
                    id: "b1".into(),
                    label: "tenant-a".into(),
                    port: 4003,
                    subdomain: Some("tenant-a".into()),
                    custom_domain: None,
                },
                models::PortBinding {
                    id: "b2".into(),
                    label: "tenant-b".into(),
                    port: 4003,
                    subdomain: Some("tenant-b".into()),
                    custom_domain: None,
                },
            ],
            env_profiles: vec![],
            active_profile_id: None,
            basic_auth_enabled: false,
            basic_auth_username: None,
            basic_auth_password_hash: None,
            basic_auth_password_set: false,
            host_auth_overrides: vec![],
            tunnel_alias_domain: None,
            tunnel_alias_rewrite_host: true, auto_sleep_enabled: false, idle_timeout_secs: 1800, auto_slept: false, max_upload_bytes: None,
            docker_image: None,
            docker_container_port: None,
            docker_args: None,
            docker_volumes: vec![],
            compose_file: None,
            network_share: false,
            tunnel_name: None,
            tunnel_custom_hostname: None,
        };
        db.insert_app(&a).unwrap();
        let ports = db.used_ports().unwrap();
        assert_eq!(ports, vec![4003]); // DISTINCT collapses duplicates
    }

    #[test]
    fn test_env_vars_round_trip() {
        let mut db = in_memory_db();
        let mut env_vars = HashMap::new();
        env_vars.insert("FOO".into(), "bar".into());
        env_vars.insert("SECRET".into(), "1234".into());
        let a = App {
            id: "a2".into(), workspace_id: None, name: "web".into(),
            root_dir: "/tmp".into(), port: 4002, subdomain: None,
            start_command: "npm run dev".into(),
            start_command_source: "auto".into(),
            status: "stopped".into(), pid: None,
            env_file: None, auto_start: false,
            env_vars: env_vars.clone(),
            restart_policy: "on-failure".into(),
            max_retries: 3,
            health_check_path: None,
            depends_on: vec![],
            extra_subdomains: vec![],
            custom_domain: None,
            kind: "process".into(),
            tunnel_provider: None,
            tunnel_auto_start: false,
            tunnel_url: None,
            tunnel_active: false,
            port_bindings: vec![],
            env_profiles: vec![],
            active_profile_id: None,
            basic_auth_enabled: false,
            basic_auth_username: None,
            basic_auth_password_hash: None,
            basic_auth_password_set: false,
            host_auth_overrides: vec![],
            tunnel_alias_domain: None,
            tunnel_alias_rewrite_host: true, auto_sleep_enabled: false, idle_timeout_secs: 1800, auto_slept: false, max_upload_bytes: None,
            docker_image: None,
            docker_container_port: None,
            docker_args: None,
            docker_volumes: vec![],
            compose_file: None,
            network_share: false,
            tunnel_name: None,
            tunnel_custom_hostname: None,
        };
        db.insert_app(&a).unwrap();
        let list = db.list_apps().unwrap();
        assert_eq!(list[0].env_vars, env_vars);
    }
}
