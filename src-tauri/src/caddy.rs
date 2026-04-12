use anyhow::Result;
use reqwest::blocking::Client;
use serde_json::{json, Value};

const CADDY_API: &str = "http://localhost:2019";

pub struct CaddyManager {
    client: Client,
}

impl CaddyManager {
    pub fn new() -> Self {
        CaddyManager { client: Client::new() }
    }

    pub fn build_config(routes: &[(String, u16)]) -> Value {
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
        self.client.get(format!("{}/config/", CADDY_API)).send()
            .map(|r| r.status().is_success()).unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_config_empty() {
        let config = CaddyManager::build_config(&[]);
        assert!(config["apps"]["http"]["servers"]["porta"]["routes"].as_array().unwrap().is_empty());
    }

    #[test]
    fn test_build_config_one_route() {
        let config = CaddyManager::build_config(&[("api.test.test".into(), 4001)]);
        let routes = config["apps"]["http"]["servers"]["porta"]["routes"].as_array().unwrap();
        assert_eq!(routes.len(), 1);
        assert_eq!(routes[0]["match"][0]["host"][0], "api.test.test");
        assert_eq!(routes[0]["handle"][0]["upstreams"][0]["dial"], "localhost:4001");
    }
}
