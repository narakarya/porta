use anyhow::Result;
use reqwest::blocking::Client;
use serde_json::{json, Value};

use crate::db::models::Route;

const CADDY_API: &str = "http://localhost:2019";

pub struct CaddyManager {
    client: Client,
}

impl Default for CaddyManager {
    fn default() -> Self {
        Self::new()
    }
}

/// Build a single Caddy `routes` entry for one of our Route variants.
fn route_to_json(route: &Route) -> Value {
    match route {
        Route::ReverseProxy { host, port } => json!({
            "match": [{ "host": [host] }],
            "handle": [{
                "handler": "reverse_proxy",
                "upstreams": [{ "dial": format!("localhost:{}", port) }]
            }]
        }),
        Route::FileServer { host, root } => json!({
            "match": [{ "host": [host] }],
            "handle": [
                // `vars.root` sets the root that file_server reads from.
                { "handler": "vars", "root": root },
                { "handler": "file_server" }
            ]
        }),
    }
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

        let route_json: Vec<Value> = routes.iter().map(route_to_json).collect();

        if has_certs {
            // HTTPS server on :443 with mkcert wildcard cert + HTTP→HTTPS redirect on :80
            json!({
                "apps": {
                    "http": {
                        "servers": {
                            "porta_https": {
                                "listen": [":443"],
                                "routes": route_json,
                                // Empty policy = use any available cert (our wildcard *.test)
                                "tls_connection_policies": [{}]
                            },
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
            json!({
                "apps": { "http": { "servers": { "porta": { "listen": [":80"], "routes": route_json } } } }
            })
        }
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
        }]);
        // In HTTP mode, routes land in "porta" server
        let servers = &config["apps"]["http"]["servers"];
        // Check at least one server has a route with the right host
        let as_obj = servers.as_object().unwrap();
        let found = as_obj.values().any(|srv| {
            srv["routes"].as_array().map_or(false, |routes| {
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
        }]);
        let servers = &config["apps"]["http"]["servers"];
        let as_obj = servers.as_object().unwrap();
        let found = as_obj.values().any(|srv| {
            srv["routes"].as_array().map_or(false, |routes| {
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
}
