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

/// Outcome of the startup HTTP readiness probe on `/` used to gate `app:ready`
/// for apps that have no configured `health_check_path`.
#[derive(Debug, PartialEq, Eq)]
pub enum HttpProbe {
    /// The server returned an HTTP response of any status (2xx…5xx) — it is
    /// serving, so the app is ready.
    Responded,
    /// The port accepts a raw TCP connect but doesn't speak HTTP: a fresh
    /// connection is refused/reset or the reply isn't parseable as HTTP. That
    /// is not ready for Porta's HTTP/HTTPS routing and must keep polling.
    NotHttp,
    /// Connected but no usable HTTP response yet (timeout) — the server is
    /// likely still booting; the caller should keep polling.
    Pending,
}

/// Probe `http://localhost:{port}/` once with a short timeout to decide whether
/// an app that already accepts TCP is actually serving HTTP. Gates the
/// `app:ready` signal so the Open button / "is ready" notification don't fire
/// before the server can answer a request. Any HTTP status counts as serving;
/// redirects are not followed (a 3xx is itself proof the app responded).
pub fn probe_http_root(port: u16) -> HttpProbe {
    let url = format!("http://localhost:{}/", port);
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .redirect(reqwest::redirect::Policy::none())
        .build();
    let client = match client {
        Ok(c) => c,
        // Can't build a client — don't declare non-HTTP; let the caller retry.
        Err(_) => return HttpProbe::Pending,
    };
    match client.get(&url).send() {
        Ok(_) => HttpProbe::Responded,
        Err(e) => {
            if e.is_timeout() {
                // Accepted the connection but hasn't replied in time — a
                // still-booting HTTP server behaves like this. Retry.
                HttpProbe::Pending
            } else {
                // Refused / reset / protocol error on a port that just accepted
                // a raw TCP connect → not an HTTP server.
                HttpProbe::NotHttp
            }
        }
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
