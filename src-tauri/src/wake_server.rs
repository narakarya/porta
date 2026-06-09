//! Transparent wake-on-request server for auto-sleep apps.
//!
//! When an app is asleep its port is dead. Caddy's reverse_proxy dial fails —
//! a handler *error* (distinct from a 5xx the upstream itself returns) — and the
//! server-level `errors` route (see `caddy::wake_errors_block`) proxies that
//! failed request here, preserving the original `Host` and URI.
//!
//! We identify the app by Host, start it if it's an eligible (auto-sleep,
//! stopped) app, wait for its port to come up, then reply `307 Temporary
//! Redirect` to the same URL. The client follows the redirect, Caddy dials the
//! now-live app, and the request is served. Net effect: the user just sees a
//! brief load while the app wakes. Works for any client that follows redirects
//! (browsers, fetch, `curl -L`).
//!
//! Non-eligible hosts (manually stopped apps, unknown hosts) get a clean 502 so
//! we don't resurrect something the user deliberately stopped.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::thread;

use tauri::Manager;
use tiny_http::{Header, Response, Server};

use crate::app_state::AppState;
use crate::commands::app_lifecycle::{start_single, wait_for_port};
use crate::db::models::{App, Workspace};

/// How long to wait for a woken app's port to accept connections before giving
/// up and returning a "still waking" error. Covers cold docker/compose starts.
const WAKE_TIMEOUT_MS: u64 = 30_000;

/// Spawn the wake server. Idempotent enough for app lifetime — binds once and
/// serves on a small worker pool so several apps can wake concurrently.
pub fn spawn(handle: tauri::AppHandle) {
    thread::spawn(move || {
        let server = match Server::http(crate::caddy::WAKE_ADDR) {
            Ok(s) => Arc::new(s),
            Err(e) => {
                eprintln!("[wake] failed to bind {}: {}", crate::caddy::WAKE_ADDR, e);
                return;
            }
        };
        // In-flight wake dedupe: only the first request for a sleeping app
        // triggers a start; concurrent requests just wait for the same port.
        let waking: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));

        // 8 workers is plenty — each blocks up to WAKE_TIMEOUT_MS while an app
        // boots, and a dev box rarely wakes more than a handful at once.
        for _ in 0..8 {
            let server = server.clone();
            let handle = handle.clone();
            let waking = waking.clone();
            thread::spawn(move || {
                for request in server.incoming_requests() {
                    handle_request(&handle, &waking, request);
                }
            });
        }
    });
}

fn handle_request(
    handle: &tauri::AppHandle,
    waking: &Arc<Mutex<HashSet<String>>>,
    request: tiny_http::Request,
) {
    // Host header drives app lookup. Caddy's reverse_proxy forwards the original
    // Host, so this is the domain the user actually hit (e.g. "myapp.test").
    let host = request
        .headers()
        .iter()
        .find(|h| h.field.equiv("host"))
        .map(|h| h.value.as_str().to_string())
        .unwrap_or_default();
    let host = host.split(':').next().unwrap_or("").trim().to_lowercase();
    let uri = request.url().to_string();

    let state = handle.state::<AppState>();
    let (apps, workspaces) = {
        let db = state.db.lock().unwrap();
        (
            db.list_apps().unwrap_or_default(),
            db.list_workspaces().unwrap_or_default(),
        )
    };

    let target = find_app_by_host(&apps, &workspaces, &host);

    // Only wake apps the idle watcher actually put to sleep (`auto_slept`). A
    // manual Stop is intentional — the app isn't idle, it's off — so it must
    // stay down on a hit. We also wake when a concurrent request already started
    // the wake (id in `waking`): the leader's `start_single` clears `auto_slept`
    // immediately, so without this a sibling request would see auto_slept=false
    // and bail out with a 502 mid-wake.
    let already_waking = target
        .as_ref()
        .is_some_and(|a| waking.lock().unwrap().contains(&a.id));
    let eligible = target.as_ref().is_some_and(|a| {
        a.auto_sleep_enabled
            && !a.is_static()
            && !a.is_proxy()
            && (a.auto_slept || already_waking)
    });

    if let (Some(app), true) = (target, eligible) {
        wake_and_redirect(handle, waking, &app, &host, &uri, request);
    } else {
        // Unknown host or a manually-stopped app — don't auto-start. Return a
        // small page rather than Caddy's raw dial error.
        let body = "<!doctype html><meta charset=utf-8><title>503</title>\
            <body style=\"font:14px system-ui;padding:3rem;color:#444\">\
            <h2>App not running</h2><p>This app is stopped.</p>";
        respond_html(request, 502, body);
    }
}

fn wake_and_redirect(
    handle: &tauri::AppHandle,
    waking: &Arc<Mutex<HashSet<String>>>,
    app: &App,
    host: &str,
    uri: &str,
    request: tiny_http::Request,
) {
    // Claim the wake. If another request already owns it, skip the start and
    // just wait on the same port below.
    let is_leader = {
        let mut set = waking.lock().unwrap();
        set.insert(app.id.clone())
    };

    if is_leader {
        // Re-read the live status: another path may have started it between our
        // snapshot and now. Only spawn when it's genuinely stopped — start_single
        // is unconditional, so calling it on a "starting" app would double-spawn.
        let state = handle.state::<AppState>();
        let current_status = state
            .db
            .lock()
            .unwrap()
            .list_apps()
            .ok()
            .and_then(|apps| apps.into_iter().find(|a| a.id == app.id))
            .map(|a| a.status)
            .unwrap_or_default();
        if current_status == "stopped" {
            if let Err(e) = start_single(handle, app, false) {
                eprintln!("[wake] start {} failed: {}", app.id, e);
                waking.lock().unwrap().remove(&app.id);
                let body = "<!doctype html><meta charset=utf-8><title>502</title>\
                    <body style=\"font:14px system-ui;padding:3rem;color:#444\">\
                    <h2>Failed to wake app</h2>";
                respond_html(request, 502, body);
                return;
            }
        }
    }

    // Block until the app's port is live (or timeout). Idempotent across the
    // concurrent waiters — they all poll the same port.
    wait_for_port(app.port, WAKE_TIMEOUT_MS);
    let up = std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], app.port)),
        std::time::Duration::from_millis(300),
    )
    .is_ok();

    if is_leader {
        waking.lock().unwrap().remove(&app.id);
    }

    if !up {
        let body = "<!doctype html><meta charset=utf-8><title>504</title>\
            <body style=\"font:14px system-ui;padding:3rem;color:#444\">\
            <h2>App is still waking up</h2><p>Reload in a moment.</p>";
        respond_html(request, 504, body);
        return;
    }

    // App is up — bounce the client back to the original URL so the retry hits
    // the live upstream through Caddy. Scheme matches Caddy's listener.
    let scheme = if crate::setup::certs_exist() { "https" } else { "http" };
    let location = format!("{}://{}{}", scheme, host, uri);
    let response = Response::empty(307)
        .with_header(Header::from_bytes(&b"Location"[..], location.as_bytes()).unwrap())
        .with_header(Header::from_bytes(&b"Cache-Control"[..], &b"no-store"[..]).unwrap());
    let _ = request.respond(response);
}

fn respond_html(request: tiny_http::Request, status: u16, body: &str) {
    let response = Response::from_string(body)
        .with_status_code(status)
        .with_header(
            Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..]).unwrap(),
        );
    let _ = request.respond(response);
}

/// Match an incoming Host against each app's Caddy route hosts. Exact match
/// first; then wildcard (`*.domain`) by suffix so multi-tenant apps wake too.
fn find_app_by_host(apps: &[App], workspaces: &[Workspace], host: &str) -> Option<App> {
    if host.is_empty() {
        return None;
    }
    // Exact match wins.
    for app in apps {
        for route in app.all_routes(workspaces) {
            if route_host(&route).eq_ignore_ascii_case(host) {
                return Some(app.clone());
            }
        }
    }
    // Wildcard fallback: `*.example.test` matches `foo.example.test`.
    for app in apps {
        for route in app.all_routes(workspaces) {
            let rh = route_host(&route);
            if let Some(suffix) = rh.strip_prefix("*.") {
                if host.ends_with(suffix)
                    && host.len() > suffix.len()
                    && host.as_bytes()[host.len() - suffix.len() - 1] == b'.'
                {
                    return Some(app.clone());
                }
            }
        }
    }
    None
}

fn route_host(route: &crate::db::models::Route) -> String {
    use crate::db::models::Route::*;
    match route {
        ReverseProxy { host, .. } => host.clone(),
        FileServer { host, .. } => host.clone(),
        AliasReverseProxy { host, .. } => host.clone(),
    }
}
