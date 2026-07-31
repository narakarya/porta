//! Re-issue a captured request against the app that received it.
//!
//! The Traffic Inspector already holds everything a request was — method, URI,
//! headers, body — but until now the only way to make one happen again was to
//! ask whoever sent it. That is fine for a browser and useless for a webhook,
//! where the sender is Stripe and re-triggering means going back to their
//! dashboard for every attempt.
//!
//! Replays go back through the local Caddy rather than straight at the app's
//! port. That keeps the path identical to the original — basic auth, TLS,
//! proxy headers, waking an auto-slept app — and means the replay lands in the
//! access log too, so it shows up in the inspector like any other request.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// Headers that describe one hop rather than the message, plus the two the
/// client must compute for itself. Forwarding a captured `Content-Length`
/// beside an edited body is how a replay silently truncates; forwarding
/// `Host` fights the one derived from the URL.
const DROPPED_HEADERS: [&str; 10] = [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "content-length",
    "host",
];

/// Enough to read an API response in the panel without holding a video file in
/// memory because someone replayed a download.
const MAX_BODY_BYTES: usize = 256 * 1024;

const TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Deserialize)]
pub struct ReplayRequest {
    pub method: String,
    /// The hostname the request was sent to — `myapp.workspace.test`. Doubles
    /// as the routing key: Caddy picks the app off the Host header.
    pub host: String,
    /// Path plus query string, as captured.
    pub uri: String,
    pub headers: HashMap<String, Vec<String>>,
    pub body: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ReplayResponse {
    pub status: u16,
    pub duration_ms: f64,
    pub headers: HashMap<String, Vec<String>>,
    pub body: String,
    /// The response was longer than `MAX_BODY_BYTES` and `body` is its head.
    pub body_truncated: bool,
}

/// Where a replay is sent. Production is always the local Caddy over HTTPS;
/// the parameter exists so the request-building can be exercised against a
/// plain stub server in `tests/replay.rs`.
pub struct Target {
    pub scheme: &'static str,
    pub addr: SocketAddr,
}

#[tauri::command]
pub async fn replay_request(req: ReplayRequest) -> Result<ReplayResponse, String> {
    let target = Target {
        scheme: "https",
        addr: SocketAddr::from(([127, 0, 0, 1], caddy_https_port()?)),
    };
    send_replay(target, req).await
}

pub async fn send_replay(target: Target, req: ReplayRequest) -> Result<ReplayResponse, String> {
    if req.host.trim().is_empty() {
        return Err("request has no host to replay against".into());
    }

    let client = reqwest::Client::builder()
        // Pin the hostname to loopback instead of trusting DNS. A `.test` name
        // resolves here anyway via dnsmasq, but a config carrying a real public
        // domain would otherwise replay against production.
        //
        // The port in this address is ignored — reqwest resolves names, not
        // ports — so the URL below has to carry it.
        .resolve(&req.host, target.addr)
        // Loopback-only traffic whose certificate comes from a machine-local
        // mkcert root that reqwest's bundled trust store does not carry.
        .danger_accept_invalid_certs(true)
        // Report what the app answered, not what it redirected to.
        .redirect(reqwest::redirect::Policy::none())
        .timeout(TIMEOUT)
        .build()
        .map_err(|e| format!("could not build replay client: {e}"))?;

    let method = reqwest::Method::from_bytes(req.method.trim().as_bytes())
        .map_err(|_| format!("invalid HTTP method: {}", req.method))?;
    let path = if req.uri.is_empty() { "/" } else { req.uri.as_str() };
    // Explicit port: Caddy's host matcher strips it before matching, and SNI
    // carries the bare hostname, so the app still sees the original routing.
    let url = format!("{}://{}:{}{}", target.scheme, req.host, target.addr.port(), path);

    let mut builder = client.request(method, &url);
    for (name, values) in &req.headers {
        if DROPPED_HEADERS.contains(&name.to_ascii_lowercase().as_str()) {
            continue;
        }
        for value in values {
            builder = builder.header(name, value);
        }
    }
    if let Some(body) = req.body {
        builder = builder.body(body);
    }

    let started = Instant::now();
    let resp = builder
        .send()
        .await
        .map_err(|e| format!("replay failed: {}", replay_error(&e)))?;
    let status = resp.status().as_u16();
    let headers = collect_headers(resp.headers());
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("could not read the response: {e}"))?;
    let duration_ms = started.elapsed().as_secs_f64() * 1000.0;

    let body_truncated = bytes.len() > MAX_BODY_BYTES;
    let head = &bytes[..bytes.len().min(MAX_BODY_BYTES)];

    Ok(ReplayResponse {
        status,
        duration_ms,
        headers,
        body: String::from_utf8_lossy(head).into_owned(),
        body_truncated,
    })
}

/// The port the local Caddy serves HTTPS on. Debug builds run their own Caddy
/// on a high port so they cannot collide with the `:443` daemon.
fn caddy_https_port() -> Result<u16, String> {
    let listen = crate::caddy::CaddyProfile::current().https;
    listen
        .trim_start_matches(':')
        .parse()
        .map_err(|_| format!("cannot read Caddy's HTTPS port from {listen:?}"))
}

fn collect_headers(headers: &reqwest::header::HeaderMap) -> HashMap<String, Vec<String>> {
    let mut out: HashMap<String, Vec<String>> = HashMap::new();
    for (name, value) in headers {
        let Ok(text) = value.to_str() else { continue };
        out.entry(name.as_str().to_string())
            .or_default()
            .push(text.to_string());
    }
    out
}

/// reqwest's Display stops at "error sending request", which reads as a bug in
/// Porta rather than a dead Caddy. Name the two failures a replay actually hits.
fn replay_error(e: &reqwest::Error) -> String {
    if e.is_connect() {
        return "could not reach the local proxy — is Caddy running?".into();
    }
    if e.is_timeout() {
        return format!("the app did not answer within {}s", TIMEOUT.as_secs());
    }
    e.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caddy_port_parses_for_this_build() {
        // PROD is :443, DEV :8443 — either way it must be a number.
        assert!(caddy_https_port().unwrap() > 0);
    }

    #[test]
    fn hop_by_hop_headers_are_dropped_case_insensitively() {
        for name in ["Content-Length", "HOST", "Transfer-Encoding", "connection"] {
            assert!(
                DROPPED_HEADERS.contains(&name.to_ascii_lowercase().as_str()),
                "{name} should not be forwarded"
            );
        }
        // Everything that identifies the caller must survive, or a replay of an
        // authenticated request 401s.
        for name in ["Authorization", "Cookie", "X-Hub-Signature-256", "Content-Type"] {
            assert!(!DROPPED_HEADERS.contains(&name.to_ascii_lowercase().as_str()));
        }
    }
}
