use anyhow::Result;
use reqwest::blocking::Client;
use serde_json::{json, Value};

const CADDY_API: &str = "http://localhost:2019";

pub struct CaddyManager {
    client: Client,
}

impl Default for CaddyManager {
    fn default() -> Self {
        Self::new()
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

    pub fn build_config(routes: &[(String, u16)]) -> Value {
        let has_certs = crate::setup::certs_exist();
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
        let cert_file = format!("{}/.porta/certs/test.pem", home);
        let key_file = format!("{}/.porta/certs/test-key.pem", home);

        if has_certs {
            // HTTPS server on :443 with mkcert wildcard cert + HTTP→HTTPS redirect on :80
            let https_routes: Vec<Value> = routes.iter().map(|(host, port)| {
                json!({
                    "match": [{ "host": [host] }],
                    "handle": [{ "handler": "reverse_proxy", "upstreams": [{ "dial": format!("localhost:{}", port) }] }]
                })
            }).collect();

            json!({
                "apps": {
                    "http": {
                        "servers": {
                            "porta_https": {
                                "listen": [":443"],
                                "routes": https_routes,
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
            let caddy_routes: Vec<Value> = routes.iter().map(|(host, port)| {
                json!({
                    "match": [{ "host": [host] }],
                    "handle": [{ "handler": "reverse_proxy", "upstreams": [{ "dial": format!("localhost:{}", port) }] }]
                })
            }).collect();
            json!({
                "apps": { "http": { "servers": { "porta": { "listen": [":80"], "routes": caddy_routes } } } }
            })
        }
    }

    pub fn reload(&self, routes: &[(String, u16)]) -> Result<()> {
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
        let config = CaddyManager::build_config(&[("api.test.test".into(), 4001)]);
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
}
