use anyhow::Result;
use reqwest::blocking::Client;
use serde_json::{json, Value};
use std::collections::BTreeMap;

use crate::db::models::{BasicAuth, Route};

const CADDY_API: &str = "http://localhost:2019";

/// Porta's wake server (see `wake_server.rs`). When an app is asleep its port is
/// dead, so Caddy's reverse_proxy dial fails (a handler *error*, distinct from a
/// 5xx the upstream itself returns). We register a server-level `errors` route
/// that proxies those failures here; the wake server identifies the app by Host,
/// starts it, and 307-redirects back so the retried request hits the live app.
pub const WAKE_ADDR: &str = "127.0.0.1:2021";

/// Server-level `errors` block: route dial failures to the wake server. Always
/// installed — the wake server returns a clean 502 for non-sleep apps, so this
/// is a no-op for them and only changes behavior for auto-sleep apps.
fn wake_errors_block() -> Value {
    json!({
        "routes": [{
            "handle": [{
                "handler": "reverse_proxy",
                "upstreams": [{ "dial": WAKE_ADDR }]
            }]
        }]
    })
}

pub struct CaddyManager {
    client: Client,
}

impl Default for CaddyManager {
    fn default() -> Self {
        Self::new()
    }
}

/// Caddy `authentication` handler with bcrypt-hashed http_basic credentials.
/// Prepended ahead of the upstream handler so requests are challenged before
/// reaching the app.
///
/// Caddy's JSON config expects the bcrypt hash **base64-encoded** — the Go
/// struct field is `[]byte` and Go decodes with `base64.StdEncoding` before
/// calling `bcrypt.CompareHashAndPassword`. Sending the raw `$2b$12$…` hash
/// makes Caddy reject every login (it tries to base64-decode the `$` chars)
/// and the prompt never appears via the tunnel because the route effectively
/// always returns 401 with no challenge surfaced.
fn auth_handler(auth: &BasicAuth) -> Value {
    use base64::Engine;
    let encoded = base64::engine::general_purpose::STANDARD.encode(auth.password_hash.as_bytes());
    json!({
        "handler": "authentication",
        "providers": {
            "http_basic": {
                "hash": { "algorithm": "bcrypt" },
                "accounts": [{
                    "username": auth.username,
                    "password": encoded
                }],
                "realm": "Porta"
            }
        }
    })
}

/// Logger name used in `logging.logs.<name>` for per-app access logs. Caddy's
/// `access_logger_names` directive on a route picks this up.
fn logger_name(app_id: &str) -> String {
    // Caddy logger names should be safe ASCII.
    let safe: String = app_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    format!("porta_app_{}", safe)
}

/// Path on disk for an app's access log (line-delimited JSON).
pub fn access_log_path(app_id: &str) -> std::path::PathBuf {
    crate::porta_dir().join("access-logs").join(format!("{}.log", app_id))
}

/// The `request_body` handler that fronts every route. Its `max_size` is a hard
/// limit: Caddy returns 413 for bodies larger than this. It doubles as the cap
/// on how much of the body is captured into the access log for the Traffic
/// Inspector, so per-app overrides let upload-heavy apps raise it. `0` disables
/// the limit (Caddy treats `max_size: 0` as unlimited).
fn request_body_handler(max: u64) -> Value {
    json!({
        "handler": "request_body",
        "max_size": max,
    })
}

/// Build a single Caddy `routes` entry for one of our Route variants.
/// `default_max` is the global `proxy_max_body_bytes` applied to any route
/// whose app didn't set a per-app `max_upload_bytes` override.
fn route_to_json(route: &Route, default_max: u64) -> Value {
    match route {
        Route::ReverseProxy { host, port, auth, app_id, max_body } => {
            let mut handlers: Vec<Value> = Vec::new();
            handlers.push(request_body_handler(max_body.unwrap_or(default_max)));
            if let Some(a) = auth {
                handlers.push(auth_handler(a));
            }
            handlers.push(json!({
                "handler": "reverse_proxy",
                "upstreams": [{ "dial": format!("localhost:{}", port) }]
            }));
            let _ = app_id; // Routing to per-app loggers is done at server level
                            // via `logs.logger_names` (host → logger name), not per-route.
            json!({ "match": [{ "host": [host] }], "handle": handlers })
        }
        Route::FileServer { host, root, auth, app_id, max_body } => {
            let mut handlers: Vec<Value> = Vec::new();
            handlers.push(request_body_handler(max_body.unwrap_or(default_max)));
            if let Some(a) = auth {
                handlers.push(auth_handler(a));
            }
            // `vars.root` sets the root that file_server reads from.
            handlers.push(json!({ "handler": "vars", "root": root }));
            handlers.push(json!({ "handler": "file_server" }));
            let _ = app_id;
            json!({ "match": [{ "host": [host] }], "handle": handlers })
        }
        Route::AliasReverseProxy { host, port, rewrite_host_to, app_id, max_body } => {
            let mut handlers: Vec<Value> = Vec::new();
            handlers.push(request_body_handler(max_body.unwrap_or(default_max)));

            let mut proxy = json!({
                "handler": "reverse_proxy",
                "upstreams": [{ "dial": format!("localhost:{}", port) }],
            });
            if let Some(local_root) = rewrite_host_to.as_deref() {
                // Rewrite Host so the upstream sees `<sub>.<local_root>` even
                // when the request arrives at `<sub>.<alias_root>`. We use
                // Caddy's host-label placeholder: labels are reversed (label.0
                // is the TLD), so the wildcard label index is
                // total_labels - 1 = number_of_dots_in_alias.
                let label_index = host.matches('.').count();
                let host_template = format!("{{http.request.host.labels.{}}}.{}", label_index, local_root);
                proxy["headers"] = json!({
                    "request": {
                        "set": { "Host": [host_template] }
                    }
                });
            }
            handlers.push(proxy);
            let _ = app_id;
            json!({ "match": [{ "host": [host] }], "handle": handlers })
        }
    }
}

/// Walk routes, collect (logger_name, app_id, hosts) tuples, and build:
///   - the `logging.logs.*` block (one logger per app, file writer + json encoder)
///   - the per-server `logs` block mapping hostnames → logger names
fn collect_loggers(routes: &[Route]) -> (Value, Value) {
    // app_id → (logger_name, hosts)
    let mut per_app: BTreeMap<String, (String, Vec<String>)> = BTreeMap::new();
    for r in routes {
        let (host, app_id) = match r {
            Route::ReverseProxy { host, app_id, .. } => (host.clone(), app_id.clone()),
            Route::FileServer { host, app_id, .. } => (host.clone(), app_id.clone()),
            Route::AliasReverseProxy { host, app_id, .. } => (host.clone(), app_id.clone()),
        };
        if let Some(id) = app_id {
            let entry = per_app.entry(id.clone()).or_insert_with(|| (logger_name(&id), Vec::new()));
            if !entry.1.contains(&host) {
                entry.1.push(host);
            }
        }
    }

    // Make sure access log directory exists so Caddy can open the file.
    let log_dir = crate::porta_dir().join("access-logs");
    let _ = std::fs::create_dir_all(&log_dir);

    // logs section under `apps.http.servers.<srv>.logs`. Caddy expects a
    // `logger_names` map of host → logger name OR (newer) host → [names].
    let mut server_logs = serde_json::Map::new();
    let mut logger_names_map = serde_json::Map::new();
    let mut default_logger_seen = false;
    for (logger, hosts) in per_app.values() {
        for host in hosts {
            logger_names_map.insert(host.clone(), Value::String(logger.clone()));
        }
        default_logger_seen = true;
    }
    if default_logger_seen {
        server_logs.insert("logger_names".into(), Value::Object(logger_names_map));
    }

    // logging.logs.* — one logger per app pointing at its file.
    let mut loggers_obj = serde_json::Map::new();
    for (id, (logger, _hosts)) in &per_app {
        let path = access_log_path(id);
        loggers_obj.insert(logger.clone(), json!({
            "encoder": { "format": "json" },
            "writer": {
                "output": "file",
                "filename": path.to_string_lossy(),
                // Caddy daemon runs as root (needs :443/:80) but the Tauri
                // app reads these files as the user. Default file mode is
                // 0600 → EACCES → Traffic Inspector stuck on "Waiting for
                // traffic…". 0644 lets the user read while only root writes.
                "mode": "0644",
                // Caddy rotates internally; cap each file at 5 MB and keep 3
                // backups so a chatty app can't fill the disk.
                "roll": true,
                "roll_size_mb": 5,
                "roll_keep": 3,
                "roll_keep_days": 7,
            },
            "level": "INFO",
            // Scope this sink to only this app's access sub-logger.
            // "http.log.access" (without suffix) would match ALL apps' access
            // events because Caddy broadcasts on that prefix; the per-app
            // sub-logger name (appended by logger_names routing) isolates it.
            "include": [format!("http.log.access.{}", logger)],
        }));
    }

    let server_logs_val = if server_logs.is_empty() { Value::Null } else { Value::Object(server_logs) };
    let loggers_val = if loggers_obj.is_empty() { Value::Null } else { Value::Object(loggers_obj) };
    (server_logs_val, loggers_val)
}

impl CaddyManager {
    pub fn new() -> Self {
        let client = Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap_or_default();
        CaddyManager { client }
    }

    pub fn build_config(routes: &[Route]) -> Value {
        let has_certs = crate::setup::certs_exist();
        let base = crate::porta_dir();
        let cert_file = base.join("certs").join("test.pem").to_string_lossy().to_string();
        let key_file = base.join("certs").join("test-key.pem").to_string_lossy().to_string();

        let default_max = crate::commands::proxy_limits::current_default_max_upload_bytes();
        let route_json: Vec<Value> = routes.iter().map(|r| route_to_json(r, default_max)).collect();
        let (server_logs, loggers) = collect_loggers(routes);

        let mut cfg = if has_certs {
            // HTTPS server on :443 with mkcert wildcard cert + HTTP→HTTPS redirect on :80
            let mut https_server = json!({
                "listen": [":443"],
                "routes": route_json,
                // Empty policy = use any available cert (our wildcard *.test)
                "tls_connection_policies": [{}],
                "errors": wake_errors_block()
            });
            if !server_logs.is_null() {
                https_server["logs"] = server_logs.clone();
            }
            json!({
                "apps": {
                    "http": {
                        "servers": {
                            "porta_https": https_server,
                            "porta_redirect": {
                                "listen": [":80"],
                                "routes": [{
                                    "handle": [{
                                        "handler": "static_response",
                                        "status_code": "301",
                                        "headers": {
                                            "Location": ["https://{http.request.host}{http.request.uri}"]
                                        }
                                    }]
                                }]
                            }
                        }
                    },
                    "tls": {
                        "certificates": {
                            "load_files": [{
                                "certificate": cert_file,
                                "key": key_file
                            }]
                        }
                    }
                }
            })
        } else {
            // Fallback: plain HTTP on :80
            let mut http_server = json!({ "listen": [":80"], "routes": route_json, "errors": wake_errors_block() });
            if !server_logs.is_null() {
                http_server["logs"] = server_logs.clone();
            }
            json!({
                "apps": { "http": { "servers": { "porta": http_server } } }
            })
        };

        if !loggers.is_null() {
            // Top-level `logging.logs` registers each app's logger with a file writer.
            cfg["logging"] = json!({ "logs": loggers });
        }

        cfg
    }

    pub fn reload(&self, routes: &[Route]) -> Result<()> {
        let config = Self::build_config(routes);
        let resp = self.client.post(format!("{}/load", CADDY_API))
            .header("Content-Type", "application/json")
            .json(&config).send()?;
        if !resp.status().is_success() {
            return Err(anyhow::anyhow!("Caddy reload failed: {}", resp.text().unwrap_or_default()));
        }
        Ok(())
    }

    pub fn is_running(&self) -> bool {
        self.client
            .get(format!("{}/config/", CADDY_API))
            .timeout(std::time::Duration::from_secs(2))
            .send()
            .is_ok()
    }
}

// ── Porta Relay: remote Caddy target ───────────────────────────────────────────

/// One public route Porta manages on a remote VPS Caddy. `public_host` is what
/// the outside world hits (`myapp.userdomain.com`); `local_host` is the app's
/// domain on this Mac (`myapp.workspace.test`) which we set as the `Host` header
/// so the *local* Caddy (reached back over the tunnel) routes to the right app.
#[derive(Debug, Clone)]
pub struct RemoteRouteSpec {
    pub public_host: String,
    pub local_host: String,
    pub auth: Option<BasicAuth>,
}

/// Client for a remote VPS Caddy admin API (reached over the WireGuard tunnel).
/// Unlike the local `CaddyManager` (hardcoded `localhost:2019`, mkcert certs),
/// this targets a per-host `admin_url` and manages exactly one server object,
/// `apps.http.servers.porta`, which Porta owns end to end.
pub struct RemoteCaddy {
    admin_url: String,
    client: Client,
}

impl RemoteCaddy {
    pub fn new(admin_url: String) -> Self {
        let client = Client::builder()
            .timeout(std::time::Duration::from_secs(8))
            .build()
            .unwrap_or_default();
        RemoteCaddy { admin_url, client }
    }

    /// Build the `porta` HTTP server object: listens on `:443` with automatic
    /// ACME TLS, one route per spec reverse-proxying over the tunnel to the
    /// Mac's local Caddy at `upstream_dial` (e.g. `10.0.0.2:443`). The internal
    /// hop is HTTPS against the local mkcert cert, so `insecure_skip_verify` is
    /// set — identical trust posture to how cloudflared points at local Caddy.
    pub fn build_porta_server(specs: &[RemoteRouteSpec], upstream_dial: &str) -> Value {
        let routes: Vec<Value> = specs
            .iter()
            .map(|s| {
                let mut handlers: Vec<Value> = Vec::new();
                if let Some(a) = &s.auth {
                    handlers.push(auth_handler(a));
                }
                handlers.push(json!({
                    "handler": "reverse_proxy",
                    "upstreams": [{ "dial": upstream_dial }],
                    "headers": {
                        "request": { "set": { "Host": [s.local_host] } }
                    },
                    "transport": {
                        "protocol": "http",
                        "tls": { "insecure_skip_verify": true }
                    }
                }));
                json!({ "match": [{ "host": [s.public_host] }], "handle": handlers })
            })
            .collect();

        json!({
            "listen": [":443"],
            "routes": routes,
            "automatic_https": {},
            // Route this server's access logs to the `porta_relay` logger, which
            // `put_logging` wires to a file the Mac tails over SSH (R8).
            "logs": { "default_logger_name": "porta_relay" }
        })
    }

    /// Default path for the VPS Caddy access log when the host doesn't override it.
    pub const DEFAULT_LOG_PATH: &'static str = "/var/log/caddy/porta-access.log";

    /// Configure the `porta_relay` logger on the VPS to write line-delimited JSON
    /// to `log_path`, scoped to this server's access events (R8). Merges into any
    /// existing loggers (preserving the user's) and seeds the `logging` object if
    /// it doesn't exist yet.
    pub fn put_logging(&self, log_path: &str) -> Result<()> {
        let logger = json!({
            "writer": { "output": "file", "filename": log_path },
            "encoder": { "format": "json" },
            "level": "INFO",
            "include": ["http.log.access.porta_relay"],
        });
        let logs_path = format!("{}/config/logging/logs", self.admin_url);
        let mut logs_obj = self
            .client
            .get(&logs_path)
            .send()
            .ok()
            .filter(|r| r.status().is_success())
            .and_then(|r| r.json::<Value>().ok())
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default();
        logs_obj.insert("porta_relay".to_string(), logger);
        // Prefer patching just the logs map; if the `logging` parent is absent
        // the child PUT 404s, so fall back to seeding the whole `logging` object.
        if self.put(&logs_path, &Value::Object(logs_obj.clone())).is_ok() {
            return Ok(());
        }
        self.put(&format!("{}/config/logging", self.admin_url), &json!({ "logs": logs_obj }))
    }

    /// The `:80`→`:443` redirect server Porta also owns on the VPS.
    fn redirect_server() -> Value {
        json!({
            "listen": [":80"],
            "routes": [{
                "handle": [{
                    "handler": "static_response",
                    "status_code": "301",
                    "headers": { "Location": ["https://{http.request.host}{http.request.uri}"] }
                }]
            }]
        })
    }

    /// Replace Porta's owned `porta` server wholesale (idempotent; never touches
    /// other servers in the user's config), and ensure the `:80` redirect exists.
    /// Uses `PUT` on the specific config paths so co-existing servers/routes
    /// managed by the user or CI are left intact.
    pub fn put_porta_server(&self, server: &Value) -> Result<()> {
        // Ensure the http app + servers object exists before PUTting into it.
        // A PUT to a non-existent parent path 404s, so seed servers first.
        let servers_path = format!("{}/config/apps/http/servers", self.admin_url);
        let _ = self.client.get(&servers_path).send();

        self.put(&format!("{}/config/apps/http/servers/porta", self.admin_url), server)?;
        self.put(
            &format!("{}/config/apps/http/servers/porta_redirect", self.admin_url),
            &Self::redirect_server(),
        )?;
        Ok(())
    }

    /// Remove Porta's servers from the VPS (used when the last route is
    /// unexposed). Best-effort: a missing path is not an error.
    pub fn delete_porta_server(&self) -> Result<()> {
        for name in ["porta", "porta_redirect"] {
            let url = format!("{}/config/apps/http/servers/{}", self.admin_url, name);
            let _ = self.client.delete(&url).send();
        }
        Ok(())
    }

    /// Fetch the live `porta` server object from the VPS (for drift detection).
    /// Returns `Ok(None)` when the server doesn't exist yet (404/null).
    pub fn get_porta_server(&self) -> Result<Option<Value>> {
        let url = format!("{}/config/apps/http/servers/porta", self.admin_url);
        let resp = self.client.get(&url).send()?;
        if !resp.status().is_success() {
            return Ok(None);
        }
        let v: Value = resp.json().unwrap_or(Value::Null);
        if v.is_null() {
            Ok(None)
        } else {
            Ok(Some(v))
        }
    }

    fn put(&self, url: &str, body: &Value) -> Result<()> {
        let resp = self
            .client
            .put(url)
            .header("Content-Type", "application/json")
            .json(body)
            .send()?;
        if !resp.status().is_success() {
            return Err(anyhow::anyhow!(
                "Caddy PUT {} failed: {}",
                url,
                resp.text().unwrap_or_default()
            ));
        }
        Ok(())
    }

    pub fn reachable(&self) -> bool {
        self.client
            .get(format!("{}/config/", self.admin_url))
            .timeout(std::time::Duration::from_secs(3))
            .send()
            .map(|r| r.status().is_success())
            .unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_config_empty_http() {
        // Without certs, should produce HTTP-only config
        let config = CaddyManager::build_config(&[]);
        // Either http or https server key exists
        let servers = &config["apps"]["http"]["servers"];
        assert!(servers.is_object());
    }

    #[test]
    fn test_build_config_one_route_http() {
        let config = CaddyManager::build_config(&[Route::ReverseProxy {
            host: "api.test.test".into(),
            port: 4001,
            auth: None,
            app_id: None,
            max_body: None,
        }]);
        // In HTTP mode, routes land in "porta" server
        let servers = &config["apps"]["http"]["servers"];
        // Check at least one server has a route with the right host
        let as_obj = servers.as_object().unwrap();
        let found = as_obj.values().any(|srv| {
            srv["routes"].as_array().is_some_and(|routes| {
                routes.iter().any(|r| {
                    r["match"][0]["host"][0] == "api.test.test"
                })
            })
        });
        assert!(found);
    }

    #[test]
    fn test_build_config_static_route_uses_file_server() {
        let config = CaddyManager::build_config(&[Route::FileServer {
            host: "site.test".into(),
            root: "/tmp/site".into(),
            auth: None,
            app_id: None,
            max_body: None,
        }]);
        let servers = &config["apps"]["http"]["servers"];
        let as_obj = servers.as_object().unwrap();
        let found = as_obj.values().any(|srv| {
            srv["routes"].as_array().is_some_and(|routes| {
                routes.iter().any(|r| {
                    let handlers: Vec<_> = r["handle"].as_array().unwrap().iter()
                        .map(|h| h["handler"].as_str().unwrap_or(""))
                        .collect();
                    handlers.contains(&"file_server") && r["match"][0]["host"][0] == "site.test"
                })
            })
        });
        assert!(found, "expected a file_server handler for static route");
    }

    #[test]
    fn test_build_config_basic_auth_prepended_before_proxy() {
        let config = CaddyManager::build_config(&[Route::ReverseProxy {
            host: "secret.test".into(),
            port: 4001,
            auth: Some(BasicAuth {
                username: "admin".into(),
                password_hash: "$2b$12$abcdef".into(),
            }),
            app_id: None,
            max_body: None,
        }]);
        let servers = &config["apps"]["http"]["servers"];
        let route = servers.as_object().unwrap()
            .values()
            .find_map(|srv| srv["routes"].as_array().and_then(|rs| rs.iter().find(|r| {
                r["match"][0]["host"][0] == "secret.test"
            })))
            .expect("route present");
        let handlers = route["handle"].as_array().unwrap();
        // request_body capture is prepended; auth must come before reverse_proxy.
        assert_eq!(handlers[0]["handler"], "request_body");
        assert_eq!(handlers[1]["handler"], "authentication");
        assert_eq!(handlers[2]["handler"], "reverse_proxy");
        let acct = &handlers[1]["providers"]["http_basic"]["accounts"][0];
        assert_eq!(acct["username"], "admin");
        // Caddy expects the bcrypt hash as base64. JDJiJDEyJGFiY2RlZg== is
        // base64("$2b$12$abcdef") — verify we're encoding rather than passing
        // the raw $2b$… string (which Caddy would silently fail to decode).
        assert_eq!(acct["password"], "JDJiJDEyJGFiY2RlZg==");
        assert_eq!(handlers[1]["providers"]["http_basic"]["hash"]["algorithm"], "bcrypt");
    }

    #[test]
    fn test_build_config_attaches_per_app_logger() {
        let config = CaddyManager::build_config(&[Route::ReverseProxy {
            host: "api.test.test".into(),
            port: 4001,
            auth: None,
            app_id: Some("app-abc".into()),
            max_body: None,
        }]);
        let logger = "porta_app_app-abc";
        // logging.logs.<logger> must exist and be wired to a file writer.
        let logs = &config["logging"]["logs"][logger];
        assert!(logs.is_object(), "expected logger {logger} present");
        assert_eq!(logs["encoder"]["format"], "json");
        assert_eq!(logs["writer"]["output"], "file");
        // The server (not the route) maps host → logger via `logs.logger_names`.
        // Routes themselves don't accept a `logs` field in Caddy.
        let servers = config["apps"]["http"]["servers"].as_object().unwrap();
        let server = servers.values()
            .find(|s| s["logs"]["logger_names"]["api.test.test"].is_string())
            .expect("server with logger_names entry");
        assert_eq!(server["logs"]["logger_names"]["api.test.test"], logger);
    }

    #[test]
    fn test_alias_route_with_host_rewrite() {
        // *.nasrulgunawan.com has 2 dots, so the wildcard label index is 2:
        // {http.request.host.labels.2} extracts the leftmost subdomain.
        let config = CaddyManager::build_config(&[Route::AliasReverseProxy {
            host: "*.nasrulgunawan.com".into(),
            port: 3007,
            rewrite_host_to: Some("grandado.test".into()),
            app_id: Some("nexus".into()),
            max_body: None,
        }]);
        let servers = config["apps"]["http"]["servers"].as_object().unwrap();
        let route = servers.values()
            .find_map(|s| s["routes"].as_array().and_then(|rs| rs.iter().find(|r| {
                r["match"][0]["host"][0] == "*.nasrulgunawan.com"
            })))
            .expect("alias route present");
        let handlers = route["handle"].as_array().unwrap();
        // request_body comes first (body capture), reverse_proxy second.
        assert_eq!(handlers[0]["handler"], "request_body");
        assert_eq!(handlers[1]["handler"], "reverse_proxy");
        assert_eq!(handlers[1]["upstreams"][0]["dial"], "localhost:3007");
        assert_eq!(
            handlers[1]["headers"]["request"]["set"]["Host"][0],
            "{http.request.host.labels.2}.grandado.test"
        );
    }

    #[test]
    fn test_remote_porta_server_dials_local_caddy_over_tunnel() {
        let server = RemoteCaddy::build_porta_server(
            &[RemoteRouteSpec {
                public_host: "myapp.example.com".into(),
                local_host: "myapp.workspace.test".into(),
                auth: None,
            }],
            "10.0.0.2:443",
        );
        assert_eq!(server["listen"][0], ":443");
        assert!(server.get("automatic_https").is_some(), "ACME automation expected");
        let route = &server["routes"][0];
        assert_eq!(route["match"][0]["host"][0], "myapp.example.com");
        let proxy = route["handle"].as_array().unwrap().iter()
            .find(|h| h["handler"] == "reverse_proxy").unwrap();
        assert_eq!(proxy["upstreams"][0]["dial"], "10.0.0.2:443");
        // Host header rewritten to the LOCAL domain so local Caddy routes it.
        assert_eq!(proxy["headers"]["request"]["set"]["Host"][0], "myapp.workspace.test");
        assert_eq!(proxy["transport"]["tls"]["insecure_skip_verify"], true);
        // Access logging is routed to the porta_relay logger (R8).
        assert_eq!(server["logs"]["default_logger_name"], "porta_relay");
    }

    #[test]
    fn test_remote_porta_server_prepends_basic_auth() {
        let server = RemoteCaddy::build_porta_server(
            &[RemoteRouteSpec {
                public_host: "secret.example.com".into(),
                local_host: "secret.workspace.test".into(),
                auth: Some(BasicAuth { username: "admin".into(), password_hash: "$2b$12$abcdef".into() }),
            }],
            "10.0.0.2:443",
        );
        let handlers = server["routes"][0]["handle"].as_array().unwrap();
        assert_eq!(handlers[0]["handler"], "authentication");
        assert_eq!(handlers[1]["handler"], "reverse_proxy");
    }

    #[test]
    fn test_alias_route_without_rewrite_skips_header_directive() {
        let config = CaddyManager::build_config(&[Route::AliasReverseProxy {
            host: "tunnel.example.com".into(),
            port: 4000,
            rewrite_host_to: None,
            app_id: None,
            max_body: None,
        }]);
        let servers = config["apps"]["http"]["servers"].as_object().unwrap();
        let route = servers.values()
            .find_map(|s| s["routes"].as_array().and_then(|rs| rs.iter().find(|r| {
                r["match"][0]["host"][0] == "tunnel.example.com"
            })))
            .expect("alias route present");
        let proxy = &route["handle"][1];
        assert_eq!(proxy["handler"], "reverse_proxy");
        assert!(
            proxy.get("headers").is_none(),
            "no rewrite → no headers directive expected, got {proxy}"
        );
    }
}
