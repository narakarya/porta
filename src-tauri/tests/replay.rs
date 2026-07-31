//! `send_replay` against a real socket.
//!
//! The unit tests can only check the header deny-list as data. What actually
//! matters is what leaves the process: that the captured `Content-Length` does
//! not travel beside an edited body, that `Authorization` does, that the port
//! reaches the server at all (reqwest's DNS override drops the one in the
//! address), and that a redirect is reported rather than followed. So this
//! stands up a stub server and reads what it received.

use std::collections::HashMap;
use std::sync::mpsc;
use std::thread;

use porta_lib::commands::{send_replay, ReplayRequest, Target};

/// What the stub server saw, handed back over a channel.
struct Received {
    method: String,
    url: String,
    headers: HashMap<String, String>,
    body: String,
}

/// Serve exactly one request with `status`/`resp_body`, then report it.
fn stub_server(status: u16, resp_body: &'static str) -> (u16, mpsc::Receiver<Received>) {
    let server = tiny_http::Server::http("127.0.0.1:0").expect("bind stub server");
    let port = server.server_addr().to_ip().unwrap().port();
    let (tx, rx) = mpsc::channel();

    thread::spawn(move || {
        let Ok(mut request) = server.recv() else { return };
        let mut body = String::new();
        let _ = request.as_reader().read_to_string(&mut body);
        let headers = request
            .headers()
            .iter()
            .map(|h| (h.field.as_str().as_str().to_ascii_lowercase(), h.value.as_str().to_string()))
            .collect();
        let received = Received {
            method: request.method().as_str().to_string(),
            url: request.url().to_string(),
            headers,
            body,
        };
        let response = tiny_http::Response::from_string(resp_body)
            .with_status_code(status)
            .with_header(
                tiny_http::Header::from_bytes(&b"X-Stub"[..], &b"yes"[..]).unwrap(),
            );
        let _ = request.respond(response);
        let _ = tx.send(received);
    });

    (port, rx)
}

fn request(port: u16, headers: HashMap<String, Vec<String>>, body: Option<&str>) -> (Target, ReplayRequest) {
    (
        Target {
            scheme: "http",
            addr: ([127, 0, 0, 1], port).into(),
        },
        ReplayRequest {
            method: "POST".into(),
            host: "api.demo.test".into(),
            uri: "/webhooks/stripe?retry=1".into(),
            headers,
            body: body.map(str::to_string),
        },
    )
}

#[tokio::test]
async fn replays_the_request_and_reports_what_came_back() {
    let (port, rx) = stub_server(201, r#"{"ok":true}"#);
    let mut headers = HashMap::new();
    headers.insert("Authorization".into(), vec!["Bearer sk_test_123".into()]);
    headers.insert("Content-Type".into(), vec!["application/json".into()]);
    // Stale framing from the capture: the body below is a different length, so
    // forwarding this would truncate the request or hang the server.
    headers.insert("Content-Length".into(), vec!["9999".into()]);
    headers.insert("Host".into(), vec!["somewhere.else.test".into()]);

    let (target, req) = request(port, headers, Some(r#"{"amount":4200}"#));
    let resp = send_replay(target, req).await.expect("replay should succeed");

    assert_eq!(resp.status, 201);
    assert_eq!(resp.body, r#"{"ok":true}"#);
    assert!(!resp.body_truncated);
    assert_eq!(resp.headers.get("x-stub").map(Vec::as_slice), Some(&["yes".to_string()][..]));

    let got = rx.recv().expect("stub server should have handled a request");
    assert_eq!(got.method, "POST");
    // Query string included — a webhook retry usually rides on one.
    assert_eq!(got.url, "/webhooks/stripe?retry=1");
    assert_eq!(got.body, r#"{"amount":4200}"#);

    // Identity travels.
    assert_eq!(got.headers.get("authorization").map(String::as_str), Some("Bearer sk_test_123"));
    assert_eq!(got.headers.get("content-type").map(String::as_str), Some("application/json"));
    // Framing is recomputed, not copied.
    assert_eq!(got.headers.get("content-length").map(String::as_str), Some("15"));
    // Host comes from the URL, so the request still routes to the right app —
    // and carries the port, since that is the only place reqwest reads it from.
    assert_eq!(
        got.headers.get("host").map(String::as_str),
        Some(format!("api.demo.test:{port}").as_str())
    );
}

#[tokio::test]
async fn a_redirect_is_reported_not_followed() {
    let (port, rx) = stub_server(302, "");
    let (target, req) = request(port, HashMap::new(), None);

    let resp = send_replay(target, req).await.expect("replay should succeed");

    assert_eq!(resp.status, 302, "a replay shows what the app answered");
    // One request served: the stub only handles one, and a followed redirect
    // would have needed a second.
    assert!(rx.recv().is_ok());
}

#[tokio::test]
async fn a_dead_upstream_says_so_in_words() {
    // Port 1 on loopback: nothing listens, and binding it needs root.
    let target = Target { scheme: "http", addr: ([127, 0, 0, 1], 1).into() };
    let req = ReplayRequest {
        method: "GET".into(),
        host: "api.demo.test".into(),
        uri: "/".into(),
        headers: HashMap::new(),
        body: None,
    };

    let err = send_replay(target, req).await.unwrap_err();
    assert!(err.contains("Caddy"), "unhelpful error: {err}");
}

/// Manual smoke test against the machine's own Caddy — TLS, the mkcert root and
/// host matching are all real here, none of which a stub can stand in for.
/// Ignored by default: it needs a running Porta with an app on that hostname.
///
///   PORTA_REPLAY_HOST=myapp.workspace.test \
///     cargo test --test replay -- --ignored --nocapture
#[tokio::test]
#[ignore]
async fn replays_through_the_real_local_caddy() {
    let host = std::env::var("PORTA_REPLAY_HOST").expect("set PORTA_REPLAY_HOST");
    let port: u16 = std::env::var("PORTA_REPLAY_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(443);

    let target = Target { scheme: "https", addr: ([127, 0, 0, 1], port).into() };
    let req = ReplayRequest {
        method: "GET".into(),
        host: host.clone(),
        uri: "/".into(),
        headers: HashMap::new(),
        body: None,
    };

    let resp = send_replay(target, req).await.expect("replay through Caddy");
    println!("{host} → {} in {:.1}ms", resp.status, resp.duration_ms);
    // Any HTTP answer proves the route matched; 0 would mean we never got one.
    assert!(resp.status > 0);
}

#[tokio::test]
async fn a_request_without_a_host_is_rejected_before_dialling() {
    let target = Target { scheme: "http", addr: ([127, 0, 0, 1], 1).into() };
    let req = ReplayRequest {
        method: "GET".into(),
        host: "  ".into(),
        uri: "/".into(),
        headers: HashMap::new(),
        body: None,
    };

    assert!(send_replay(target, req).await.unwrap_err().contains("no host"));
}
