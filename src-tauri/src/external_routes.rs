//! Routes other tools hand to Porta's Caddy.
//!
//! A tool that runs dev apps itself (Kodera, …) drops one JSON file per tool
//! into `<porta_dir>/external/` (`~/.porta/external/kodera.json` for the
//! release build), written atomically (tmp + rename):
//!
//! ```json
//! {"version":1,"source":"Kodera","routes":[{"host":"shop.test","subdomains":true,"port":4010}]}
//! ```
//!
//! `subdomains: true` also routes `*.host` (one label, like every Caddy and
//! certificate wildcard). The app listens on plain HTTP at `127.0.0.1:port`.
//! An empty `routes` array or a missing file means no routes.
//!
//! Every Caddy sync ([`crate::commands::sync_caddy`]) reads the directory and
//! appends these routes after Porta's own, because `POST /load` replaces the
//! whole config. Porta's apps win a shared host: the external one is skipped
//! and logged. Bad files or entries are skipped and logged, never fatal.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::db::models::Route;

pub const CHANGED_EVENT: &str = "external-routes:changed";
const POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(2);

pub fn external_dir() -> PathBuf {
    crate::porta_dir().join("external")
}

/// One valid route from a tool's file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ExternalRoute {
    /// Display name of the tool (`source` in the file, else the file stem).
    pub source: String,
    /// File name inside the external dir, e.g. `kodera.json`.
    pub file: String,
    pub host: String,
    pub subdomains: bool,
    pub port: u16,
}

impl ExternalRoute {
    /// Host patterns this route asks Caddy to match: `host`, plus `*.host`.
    pub fn patterns(&self) -> Vec<String> {
        let mut p = vec![self.host.clone()];
        if self.subdomains {
            p.push(format!("*.{}", self.host));
        }
        p
    }
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Loaded {
    pub routes: Vec<ExternalRoute>,
    /// Skipped files/entries, one human-readable line each.
    pub warnings: Vec<String>,
}

#[derive(Deserialize)]
struct RawFile {
    version: Option<u64>,
    source: Option<String>,
    #[serde(default)]
    routes: Option<Vec<serde_json::Value>>,
}

#[derive(Deserialize)]
struct RawRoute {
    host: String,
    #[serde(default)]
    subdomains: bool,
    port: u16,
}

/// Lowercase, drop a trailing dot, and check it's a plain DNS name with at
/// least two labels (`shop.test`, not `test`, `*.shop.test` or `a b.test`).
/// Strict on purpose: these names end up as mkcert SANs, and one bad name
/// would fail the certificate for every Porta app.
pub fn normalize_host(raw: &str) -> Option<String> {
    let host = raw.trim().trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty() || host.len() > 253 || !host.contains('.') {
        return None;
    }
    let label_ok = |l: &str| {
        !l.is_empty()
            && l.len() <= 63
            && !l.starts_with('-')
            && !l.ends_with('-')
            && l.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    };
    host.split('.').all(label_ok).then_some(host)
}

/// Parse one tool file. Returns the valid routes and a warning per skipped
/// entry (or one for the whole file when it can't be used at all).
pub fn parse_file(file: &str, contents: &str) -> (Vec<ExternalRoute>, Vec<String>) {
    let mut warnings = Vec::new();
    let raw: RawFile = match serde_json::from_str(contents) {
        Ok(r) => r,
        Err(e) => return (vec![], vec![format!("{file}: invalid ({e}), skipped")]),
    };
    match raw.version {
        Some(1) => {}
        Some(v) => return (vec![], vec![format!("{file}: unsupported version {v}, skipped")]),
        None => return (vec![], vec![format!("{file}: missing \"version\", skipped")]),
    }
    let stem = file.strip_suffix(".json").unwrap_or(file).to_string();
    let source = raw
        .source
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or(stem);

    let mut routes = Vec::new();
    for (i, entry) in raw.routes.unwrap_or_default().into_iter().enumerate() {
        let r: RawRoute = match serde_json::from_value(entry) {
            Ok(r) => r,
            Err(e) => {
                warnings.push(format!("{file}: route {i} is invalid ({e}), skipped"));
                continue;
            }
        };
        let Some(host) = normalize_host(&r.host) else {
            warnings.push(format!("{file}: route {i} has an invalid host {:?}, skipped", r.host));
            continue;
        };
        if r.port == 0 {
            warnings.push(format!("{file}: route {i} ({host}) has port 0, skipped"));
            continue;
        }
        routes.push(ExternalRoute {
            source: source.clone(),
            file: file.to_string(),
            host,
            subdomains: r.subdomains,
            port: r.port,
        });
    }
    (routes, warnings)
}

/// The tool files in `dir`: `*.json`, no dotfiles (an in-flight tmp file),
/// sorted by name so "first file wins" is stable.
fn json_files(dir: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| {
                    let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
                    !name.starts_with('.') && name.ends_with(".json") && p.is_file()
                })
                .collect()
        })
        .unwrap_or_default();
    files.sort();
    files
}

/// Read every tool file in `dir` (created when missing).
pub fn load_dir(dir: &Path) -> Loaded {
    let _ = std::fs::create_dir_all(dir);
    let mut out = Loaded::default();
    for path in json_files(dir) {
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("?").to_string();
        match std::fs::read_to_string(&path) {
            Ok(text) => {
                let (routes, warnings) = parse_file(&name, &text);
                out.routes.extend(routes);
                out.warnings.extend(warnings);
            }
            Err(e) => out.warnings.push(format!("{name}: unreadable ({e}), skipped")),
        }
    }
    out
}

pub fn load() -> Loaded {
    load_dir(&external_dir())
}

/// Does Caddy host pattern `pattern` match `name`? Exact, or a `*.` wildcard
/// covering exactly one label (Caddy's semantics). `name` may itself be a
/// wildcard pattern, then only an identical pattern matches it.
fn host_matches(pattern: &str, name: &str) -> bool {
    if pattern == name {
        return true;
    }
    match pattern.strip_prefix("*.") {
        Some(suffix) if !name.starts_with("*.") => name
            .strip_suffix(suffix)
            .and_then(|head| head.strip_suffix('.'))
            .is_some_and(|label| !label.is_empty() && !label.contains('.')),
        _ => false,
    }
}

fn route_host(r: &Route) -> &str {
    match r {
        Route::ReverseProxy { host, .. }
        | Route::FileServer { host, .. }
        | Route::AliasReverseProxy { host, .. } => host,
    }
}

/// An external route and which of its host patterns didn't make it into
/// Caddy (taken by a Porta app, or by an earlier tool file).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ExternalEntry {
    #[serde(flatten)]
    pub route: ExternalRoute,
    pub skipped: Vec<String>,
}

#[derive(Debug, Default, Clone)]
pub struct Merged {
    /// Caddy routes to append after Porta's own.
    pub routes: Vec<Route>,
    pub entries: Vec<ExternalEntry>,
    /// One log line per skipped host pattern.
    pub conflicts: Vec<String>,
}

/// Turn external routes into Caddy routes, skipping any host pattern Porta's
/// own routes already match (Porta wins) or an earlier external route took.
/// A Porta host *under* an external wildcard (`admin.shop.test` vs
/// `*.shop.test`) isn't a conflict: Porta's routes come first in the Caddy
/// route list, so the specific host keeps going to Porta's app.
pub fn merge(porta: &[Route], external: &[ExternalRoute]) -> Merged {
    let porta_hosts: Vec<String> = porta.iter().map(|r| route_host(r).to_ascii_lowercase()).collect();
    let mut taken: HashMap<String, String> = HashMap::new(); // pattern → owning source
    let mut out = Merged::default();
    for ext in external {
        let mut skipped = Vec::new();
        for pattern in ext.patterns() {
            let porta_owner = porta_hosts.iter().find(|h| host_matches(h, &pattern));
            if let Some(h) = porta_owner {
                let why = if *h == pattern { String::new() } else { format!(" (via {h})") };
                out.conflicts.push(format!(
                    "{} ({}): {pattern} is served by a Porta app{why}; external route skipped",
                    ext.source, ext.file
                ));
                skipped.push(pattern);
                continue;
            }
            if let Some(owner) = taken.get(&pattern) {
                out.conflicts.push(format!(
                    "{} ({}): {pattern} is already routed by {owner}; skipped",
                    ext.source, ext.file
                ));
                skipped.push(pattern);
                continue;
            }
            taken.insert(pattern.clone(), ext.source.clone());
            out.routes.push(Route::ReverseProxy {
                host: pattern,
                port: ext.port,
                auth: None,
                app_id: None,
                max_body: None,
            });
        }
        out.entries.push(ExternalEntry { route: ext.clone(), skipped });
    }
    out
}

/// SANs the `*.test` certificate needs for these routes: `host`, `*.host`.
pub fn cert_names(routes: &[ExternalRoute]) -> Vec<String> {
    let mut seen = HashSet::new();
    routes
        .iter()
        .flat_map(|r| r.patterns())
        .filter(|n| seen.insert(n.clone()))
        .collect()
}

/// Print warnings/conflicts only when they differ from the last print, so a
/// sync on every app start/stop doesn't repeat the same lines forever.
pub fn log_if_changed(warnings: &[String], conflicts: &[String]) {
    static LAST: Mutex<Option<Vec<String>>> = Mutex::new(None);
    let lines: Vec<String> = warnings.iter().chain(conflicts).cloned().collect();
    let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
    if last.as_ref() == Some(&lines) {
        return;
    }
    for l in &lines {
        eprintln!("[porta] external routes: {l}");
    }
    *last = Some(lines);
}

/// Names + contents of the tool files: cheap (a few small files) and catches
/// an atomic rename that keeps size and mtime.
fn fingerprint(dir: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    json_files(dir)
        .into_iter()
        .map(|p| {
            let bytes = std::fs::read(&p).unwrap_or_default();
            (p, bytes)
        })
        .collect()
}

/// Poll the external dir and re-sync Caddy when a tool file appears, changes
/// or goes away. The startup sync covers the initial state. Polling, not
/// FSEvents: one tiny directory every 2 s, and no extra dependency.
pub fn spawn_watcher(app: tauri::AppHandle) {
    use tauri::{Emitter, Manager};
    std::thread::spawn(move || {
        let dir = external_dir();
        let _ = std::fs::create_dir_all(&dir);
        let mut last = fingerprint(&dir);
        loop {
            std::thread::sleep(POLL_INTERVAL);
            let now = fingerprint(&dir);
            if now == last {
                continue;
            }
            last = now;
            let state = app.state::<crate::app_state::AppState>();
            if let Err(e) = crate::commands::sync_caddy(&state) {
                eprintln!("[porta] external routes changed, Caddy sync failed: {e}");
            }
            let _ = app.emit(CHANGED_EVENT, ());
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proxy(host: &str, port: u16) -> Route {
        Route::ReverseProxy { host: host.into(), port, auth: None, app_id: Some("a".into()), max_body: None }
    }

    fn ext(host: &str, subdomains: bool, port: u16) -> ExternalRoute {
        ExternalRoute { source: "Kodera".into(), file: "kodera.json".into(), host: host.into(), subdomains, port }
    }

    fn hosts(routes: &[Route]) -> Vec<(String, u16)> {
        routes
            .iter()
            .map(|r| match r {
                Route::ReverseProxy { host, port, .. } => (host.clone(), *port),
                _ => panic!("external routes are plain reverse proxies"),
            })
            .collect()
    }

    #[test]
    fn parses_the_contract_example() {
        let (routes, warnings) = parse_file(
            "kodera.json",
            r#"{"version":1,"source":"Kodera","routes":[{"host":"shop.test","subdomains":true,"port":4010}]}"#,
        );
        assert!(warnings.is_empty(), "{warnings:?}");
        assert_eq!(routes, vec![ext("shop.test", true, 4010)]);
    }

    #[test]
    fn empty_or_missing_routes_mean_none() {
        for body in [r#"{"version":1,"source":"Kodera","routes":[]}"#, r#"{"version":1}"#] {
            let (routes, warnings) = parse_file("kodera.json", body);
            assert!(routes.is_empty() && warnings.is_empty(), "{body}");
        }
    }

    #[test]
    fn source_defaults_to_the_file_stem_and_subdomains_to_false() {
        let (routes, _) = parse_file("other.json", r#"{"version":1,"routes":[{"host":"Blog.Test.","port":5000}]}"#);
        assert_eq!(routes[0].source, "other");
        assert_eq!(routes[0].host, "blog.test");
        assert!(!routes[0].subdomains);
    }

    #[test]
    fn bad_files_are_skipped_whole() {
        for (body, needle) in [
            ("{not json", "invalid ("),
            (r#"{"routes":[]}"#, "missing \"version\""),
            (r#"{"version":2,"routes":[{"host":"a.test","port":1}]}"#, "unsupported version 2"),
            (r#"{"version":1,"routes":{"host":"a.test"}}"#, "invalid ("),
        ] {
            let (routes, warnings) = parse_file("k.json", body);
            assert!(routes.is_empty(), "{body}");
            assert_eq!(warnings.len(), 1, "{body}");
            assert!(warnings[0].contains(needle), "{body}: {warnings:?}");
        }
    }

    #[test]
    fn bad_entries_are_skipped_and_good_ones_kept() {
        let (routes, warnings) = parse_file(
            "kodera.json",
            r#"{"version":1,"routes":[
                {"host":"ok.test","port":4000},
                {"host":"*.wild.test","port":4001},
                {"host":"test","port":4002},
                {"host":"sp ace.test","port":4003},
                {"host":"-dash.test","port":4004},
                {"host":"zero.test","port":0},
                {"host":"big.test","port":70000},
                {"host":"noport.test"},
                "garbage",
                {"host":"also-ok.test","port":4009,"subdomains":true}
            ]}"#,
        );
        assert_eq!(
            routes.iter().map(|r| r.host.as_str()).collect::<Vec<_>>(),
            vec!["ok.test", "also-ok.test"]
        );
        assert_eq!(warnings.len(), 8, "{warnings:?}");
    }

    #[test]
    fn load_dir_reads_json_files_in_name_order_and_ignores_others() {
        let dir = tempfile::tempdir().unwrap();
        let ext_dir = dir.path().join("external");
        std::fs::create_dir_all(&ext_dir).unwrap();
        std::fs::write(ext_dir.join("b.json"), r#"{"version":1,"source":"B","routes":[{"host":"b.test","port":2}]}"#).unwrap();
        std::fs::write(ext_dir.join("a.json"), r#"{"version":1,"source":"A","routes":[{"host":"a.test","port":1}]}"#).unwrap();
        std::fs::write(ext_dir.join(".kodera.json.tmp"), "{").unwrap();
        std::fs::write(ext_dir.join(".hidden.json"), "{").unwrap();
        std::fs::write(ext_dir.join("notes.txt"), "hi").unwrap();
        std::fs::write(ext_dir.join("broken.json"), "{").unwrap();

        let loaded = load_dir(&ext_dir);
        assert_eq!(loaded.routes.iter().map(|r| r.source.as_str()).collect::<Vec<_>>(), vec!["A", "B"]);
        assert_eq!(loaded.warnings.len(), 1);
        assert!(loaded.warnings[0].starts_with("broken.json"));
    }

    #[test]
    fn load_dir_creates_a_missing_dir() {
        let dir = tempfile::tempdir().unwrap();
        let ext_dir = dir.path().join("external");
        assert_eq!(load_dir(&ext_dir), Loaded::default());
        assert!(ext_dir.is_dir());
    }

    #[test]
    fn merge_adds_host_and_wildcard_as_plain_proxies() {
        let m = merge(&[proxy("uq.test", 4000)], &[ext("shop.test", true, 4010), ext("blog.test", false, 4020)]);
        assert!(m.conflicts.is_empty());
        assert_eq!(
            hosts(&m.routes),
            vec![("shop.test".into(), 4010), ("*.shop.test".into(), 4010), ("blog.test".into(), 4020)]
        );
        for r in &m.routes {
            let Route::ReverseProxy { auth, app_id, max_body, .. } = r else { unreachable!() };
            assert!(auth.is_none() && app_id.is_none() && max_body.is_none());
        }
    }

    #[test]
    fn porta_wins_an_exact_host() {
        let m = merge(&[proxy("shop.test", 4000)], &[ext("shop.test", true, 4010)]);
        // The apex is Porta's; the wildcard is still free.
        assert_eq!(hosts(&m.routes), vec![("*.shop.test".into(), 4010)]);
        assert_eq!(m.entries[0].skipped, vec!["shop.test".to_string()]);
        assert_eq!(m.conflicts.len(), 1);
        assert!(m.conflicts[0].contains("shop.test is served by a Porta app"), "{:?}", m.conflicts);
    }

    #[test]
    fn porta_wins_an_identical_wildcard_and_a_covering_one() {
        let m = merge(
            &[proxy("*.shop.test", 4000), Route::AliasReverseProxy {
                host: "*.blog.test".into(), port: 4001, rewrite_host_to: None, app_id: None, max_body: None,
            }],
            &[ext("shop.test", true, 4010), ext("www.blog.test", false, 4020)],
        );
        assert_eq!(hosts(&m.routes), vec![("shop.test".into(), 4010)]);
        assert_eq!(m.entries[0].skipped, vec!["*.shop.test".to_string()]);
        assert_eq!(m.entries[1].skipped, vec!["www.blog.test".to_string()]);
        assert!(m.conflicts[1].contains("(via *.blog.test)"), "{:?}", m.conflicts);
    }

    #[test]
    fn a_porta_host_under_an_external_wildcard_is_not_a_conflict() {
        // Porta's own admin.shop.test comes first in Caddy's route list.
        let m = merge(&[proxy("admin.shop.test", 4000)], &[ext("shop.test", true, 4010)]);
        assert!(m.conflicts.is_empty());
        assert_eq!(m.routes.len(), 2);
    }

    #[test]
    fn host_match_is_case_insensitive_against_porta_hosts() {
        let m = merge(&[proxy("Shop.Test", 4000)], &[ext("shop.test", false, 4010)]);
        assert!(m.routes.is_empty());
    }

    #[test]
    fn the_first_external_route_wins_a_shared_host() {
        let mut other = ext("shop.test", false, 5000);
        other.source = "Other".into();
        other.file = "other.json".into();
        let m = merge(&[], &[ext("shop.test", true, 4010), other]);
        assert_eq!(hosts(&m.routes), vec![("shop.test".into(), 4010), ("*.shop.test".into(), 4010)]);
        assert_eq!(m.entries[1].skipped, vec!["shop.test".to_string()]);
        assert!(m.conflicts[0].contains("already routed by Kodera"));
    }

    #[test]
    fn host_matches_follows_caddy_wildcards() {
        assert!(host_matches("a.test", "a.test"));
        assert!(host_matches("*.shop.test", "admin.shop.test"));
        assert!(!host_matches("*.shop.test", "shop.test"));
        assert!(!host_matches("*.shop.test", "a.b.shop.test"));
        assert!(!host_matches("*.shop.test", "xshop.test"));
        assert!(!host_matches("*.test", "*.shop.test"));
        assert!(!host_matches("shop.test", "*.shop.test"));
    }

    #[test]
    fn cert_names_cover_host_and_wildcard_once() {
        let names = cert_names(&[ext("shop.test", true, 1), ext("blog.test", false, 2), ext("shop.test", true, 3)]);
        assert_eq!(names, vec!["shop.test", "*.shop.test", "blog.test"]);
    }

    #[test]
    fn external_routes_land_in_the_caddy_config_after_porta_routes() {
        let mut routes = vec![proxy("uq.test", 4000)];
        routes.extend(merge(&routes, &[ext("shop.test", true, 4010)]).routes);
        let cfg = crate::caddy::CaddyManager::build_config(&routes);
        let server = cfg["apps"]["http"]["servers"]
            .as_object()
            .unwrap()
            .values()
            .find(|s| s["routes"].as_array().is_some_and(|r| r.len() == 3))
            .expect("server with 3 routes");
        let r = server["routes"].as_array().unwrap();
        assert_eq!(r[0]["match"][0]["host"][0], "uq.test");
        assert_eq!(r[1]["match"][0]["host"][0], "shop.test");
        assert_eq!(r[2]["match"][0]["host"][0], "*.shop.test");
        let proxy = r[2]["handle"].as_array().unwrap().iter().find(|h| h["handler"] == "reverse_proxy").unwrap();
        assert_eq!(proxy["upstreams"][0]["dial"], "127.0.0.1:4010");
        assert!(proxy.get("headers").is_none(), "Host must be preserved");
    }
}
