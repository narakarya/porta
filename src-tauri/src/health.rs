use serde::{Deserialize, Serialize};
use std::net::TcpStream;
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum HealthStatus {
    Healthy,
    Unhealthy,
    Unknown,
}

/// Perform a health check against a local app.
///
/// If `path` is provided, issues an HTTP GET to `http://localhost:{port}{path}`
/// and considers any 2xx or 3xx response as healthy. 3xx counts because many
/// self-hosted apps (Plausible, Sentry, Livebook, NocoDB) redirect anonymous
/// requests to `/login` from `/` — the redirect itself proves the app is up.
///
/// If `path` is `None`, falls back to a raw TCP connect check on the port.
pub fn check_health(port: u16, path: Option<&str>) -> HealthStatus {
    match path {
        Some(p) => check_http(port, p),
        None => check_tcp(port),
    }
}

fn check_http(port: u16, path: &str) -> HealthStatus {
    let url = format!("http://localhost:{}{}", port, path);
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .redirect(reqwest::redirect::Policy::none())
        .build();
    let client = match client {
        Ok(c) => c,
        Err(_) => return HealthStatus::Unknown,
    };
    match client.get(&url).send() {
        Ok(resp) => {
            let status = resp.status().as_u16();
            if (200..400).contains(&status) {
                HealthStatus::Healthy
            } else {
                HealthStatus::Unhealthy
            }
        }
        Err(_) => HealthStatus::Unhealthy,
    }
}

fn check_tcp(port: u16) -> HealthStatus {
    let addr = format!("127.0.0.1:{}", port);
    match TcpStream::connect_timeout(
        &addr.parse().unwrap(),
        Duration::from_secs(2),
    ) {
        Ok(_) => HealthStatus::Healthy,
        Err(_) => HealthStatus::Unhealthy,
    }
}
