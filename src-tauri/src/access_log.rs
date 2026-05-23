//! Per-app HTTP access log parsing.
//!
//! Caddy writes line-delimited JSON to `~/.porta/access-logs/<app_id>.log` (one
//! logger per app, see `caddy::collect_loggers`). This module reads new lines
//! since a given byte offset and parses them into `AccessLogEntry` records the
//! Traffic Inspector UI consumes.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// Resolved on-disk path for an app's access log file.
pub fn log_path(app_id: &str) -> PathBuf {
    crate::caddy::access_log_path(app_id)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AccessLogEntry {
    pub ts: f64,
    pub method: String,
    pub host: String,
    pub uri: String,
    pub status: u16,
    pub duration_ms: f64,
    pub remote_ip: String,
    pub req_headers: HashMap<String, Vec<String>>,
    pub resp_headers: HashMap<String, Vec<String>>,
    pub req_body: Option<String>,
    pub resp_size_bytes: u64,
}

#[derive(Debug, Serialize, Clone)]
pub struct AccessLogChunk {
    pub entries: Vec<AccessLogEntry>,
    pub next_offset: u64,
}

/// Parse one Caddy JSON access log line.
///
/// Caddy's access log shape (v2.7+):
/// ```json
/// {
///   "ts": 1700000000.123,
///   "msg": "handled request",
///   "request": { "method": "GET", "host": "x.test",
///                "uri": "/foo?bar=1", "remote_ip": "1.2.3.4",
///                "headers": {"User-Agent": ["curl/8"]} },
///   "duration": 0.012,
///   "status": 200,
///   "size": 123,
///   "resp_headers": {"Content-Type": ["text/html"]},
///   "request_body": "...optional captured body..."
/// }
/// ```
pub fn parse_line(line: &str) -> Option<AccessLogEntry> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    let req = v.get("request")?;

    let method = req.get("method").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let host = req.get("host").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let uri = req.get("uri").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let remote_ip = req
        .get("remote_ip")
        .or_else(|| req.get("client_ip"))
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();

    let req_headers = headers_map(req.get("headers"));
    let resp_headers = headers_map(v.get("resp_headers"));

    let ts = v.get("ts").and_then(|x| x.as_f64()).unwrap_or(0.0);
    let status = v
        .get("status")
        .and_then(|x| x.as_u64())
        .map(|n| n as u16)
        .unwrap_or(0);
    let duration_seconds = v.get("duration").and_then(|x| x.as_f64()).unwrap_or(0.0);
    let resp_size_bytes = v.get("size").and_then(|x| x.as_u64()).unwrap_or(0);

    // Caddy may embed `request_body` either as a string (when the body is
    // valid utf-8 text) or as a base64 blob. We expose only printable utf-8
    // — binary blobs surface as `None` and the UI shows "<binary>".
    let req_body = match v.get("request_body") {
        Some(serde_json::Value::String(s)) => {
            if s.is_empty() {
                None
            } else if s.chars().all(|c| !c.is_control() || c == '\n' || c == '\r' || c == '\t') {
                Some(s.clone())
            } else {
                None
            }
        }
        _ => None,
    };

    Some(AccessLogEntry {
        ts,
        method,
        host,
        uri,
        status,
        duration_ms: duration_seconds * 1000.0,
        remote_ip,
        req_headers,
        resp_headers,
        req_body,
        resp_size_bytes,
    })
}

fn headers_map(v: Option<&serde_json::Value>) -> HashMap<String, Vec<String>> {
    let mut out = HashMap::new();
    let Some(obj) = v.and_then(|x| x.as_object()) else {
        return out;
    };
    for (k, val) in obj {
        let vs = match val {
            serde_json::Value::Array(arr) => arr
                .iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect(),
            serde_json::Value::String(s) => vec![s.clone()],
            _ => vec![],
        };
        out.insert(k.clone(), vs);
    }
    out
}

/// Read all complete lines added since `from_offset`.  Partial trailing lines
/// (no terminating `\n`) are not consumed — `next_offset` rewinds to the start
/// of the partial line so the next poll picks them up once Caddy finishes
/// writing.
pub fn tail(app_id: &str, from_offset: u64) -> std::io::Result<AccessLogChunk> {
    let path = log_path(app_id);
    if !path.exists() {
        return Ok(AccessLogChunk { entries: Vec::new(), next_offset: 0 });
    }

    let mut file = File::open(&path)?;
    let len = file.metadata()?.len();

    // If the log was truncated (clear) or rotated, start from 0.
    let effective_offset = if from_offset > len { 0 } else { from_offset };
    file.seek(SeekFrom::Start(effective_offset))?;

    let mut reader = BufReader::new(file);
    let mut buf = Vec::new();
    reader.read_to_end(&mut buf)?;

    let mut entries = Vec::new();
    let mut consumed: u64 = 0;
    for chunk in buf.split_inclusive(|b| *b == b'\n') {
        if !chunk.ends_with(b"\n") {
            // Partial line — leave it for the next poll.
            break;
        }
        consumed += chunk.len() as u64;
        let line = std::str::from_utf8(&chunk[..chunk.len() - 1]).unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        if let Some(entry) = parse_line(line) {
            entries.push(entry);
        }
    }

    Ok(AccessLogChunk {
        entries,
        next_offset: effective_offset + consumed,
    })
}

/// Truncate the access log file (Clear button in the UI).
pub fn clear(app_id: &str) -> std::io::Result<()> {
    let path = log_path(app_id);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // Recreate as zero-length so existing file handles see EOF.
    let _ = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&path)?;
    Ok(())
}

/// Read just the current EOF offset (used by `live_access_log_start` to skip
/// pre-existing lines so live tail only shows new traffic).
pub fn current_offset(app_id: &str) -> u64 {
    let path = log_path(app_id);
    std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_line_basic_get() {
        let line = r#"{"ts":1700000000.5,"request":{"method":"GET","host":"x.test","uri":"/foo?bar=1","remote_ip":"1.2.3.4","headers":{"User-Agent":["curl/8"]}},"resp_headers":{"Content-Type":["text/html"]},"duration":0.0125,"status":200,"size":123}"#;
        let e = parse_line(line).expect("parses");
        assert_eq!(e.method, "GET");
        assert_eq!(e.host, "x.test");
        assert_eq!(e.uri, "/foo?bar=1");
        assert_eq!(e.status, 200);
        assert_eq!(e.remote_ip, "1.2.3.4");
        assert!((e.duration_ms - 12.5).abs() < 0.0001);
        assert_eq!(e.resp_size_bytes, 123);
        assert_eq!(e.req_headers.get("User-Agent").unwrap()[0], "curl/8");
        assert_eq!(e.resp_headers.get("Content-Type").unwrap()[0], "text/html");
        assert!(e.req_body.is_none());
    }

    #[test]
    fn parse_line_with_request_body() {
        let line = r#"{"ts":1.0,"request":{"method":"POST","host":"hook.test","uri":"/","remote_ip":"::1","headers":{}},"resp_headers":{},"duration":0.01,"status":204,"size":0,"request_body":"{\"event\":\"ping\"}"}"#;
        let e = parse_line(line).expect("parses");
        assert_eq!(e.method, "POST");
        assert_eq!(e.req_body.as_deref(), Some("{\"event\":\"ping\"}"));
    }

    #[test]
    fn parse_line_drops_binary_body() {
        let line = "{\"ts\":1.0,\"request\":{\"method\":\"POST\",\"host\":\"h\",\"uri\":\"/\",\"remote_ip\":\"\",\"headers\":{}},\"resp_headers\":{},\"duration\":0.0,\"status\":200,\"size\":0,\"request_body\":\"\\u0001\\u0002binary\"}";
        let e = parse_line(line).expect("parses");
        assert!(e.req_body.is_none());
    }

    #[test]
    fn tail_handles_partial_lines() {
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("HOME", dir.path());
        // The two log lines below match the JSON shape parse_line consumes.
        let app_id = "test-app";
        let path = log_path(app_id);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();

        let line = r#"{"ts":1.0,"request":{"method":"GET","host":"h","uri":"/","remote_ip":"","headers":{}},"resp_headers":{},"duration":0.0,"status":200,"size":0}"#;
        let mut content = String::new();
        content.push_str(line);
        content.push('\n');
        content.push_str(line); // partial — no trailing newline
        std::fs::write(&path, &content).unwrap();

        let chunk = tail(app_id, 0).unwrap();
        assert_eq!(chunk.entries.len(), 1);
        // Next offset should point at the start of the partial line.
        assert_eq!(chunk.next_offset, (line.len() + 1) as u64);

        // Append the missing newline + tail again from the saved offset.
        let mut content2 = content.clone();
        content2.push('\n');
        std::fs::write(&path, &content2).unwrap();
        let chunk2 = tail(app_id, chunk.next_offset).unwrap();
        assert_eq!(chunk2.entries.len(), 1);
    }
}
