use serde::Serialize;
use std::net::TcpListener;
use std::process::Command;
use tauri::State;

use crate::app_state::AppState;
use crate::docker_manager::resolve_compose_path;

/// Async wrapper so the lsof+ps shell-out runs on tokio's blocking pool
/// instead of pinning a Tauri command worker. Multiple AppCards poll this
/// every 30s — making it sync would serialize all those probes through one
/// worker and stall the IPC pipeline (visible as UI lag when N apps are
/// shown).
#[tauri::command]
pub async fn check_port_available(port: u16) -> Result<crate::port_check::PortCheckResult, String> {
    tokio::task::spawn_blocking(move || crate::port_check::check_port(port))
        .await
        .map_err(|e| format!("port check task failed: {}", e))
}

/// Detailed info about the process holding a TCP port. Returned by
/// `who_uses_port` so the UI can render a "Port X is in use by <name> (PID Y)"
/// message without having to make a separate `ps` call.
#[derive(Debug, Serialize, Clone)]
pub struct PortHolder {
    pub pid: u32,
    pub process_name: String,
    pub command: String,
}

/// Try to bind 127.0.0.1:N for N in [starting_at, starting_at+max_tries).
/// Returns the first port that bind() accepts (i.e. nothing is listening on
/// it). Skips u16 overflow gracefully. Bound listener is dropped immediately;
/// the kernel may keep the port in TIME_WAIT briefly but for our purposes
/// (suggesting the next free port) that's fine.
#[tauri::command]
pub fn find_free_port(starting_at: u16, max_tries: u16) -> Option<u16> {
    let max = max_tries.max(1);
    for i in 0..max {
        let candidate = starting_at.checked_add(i)?;
        if TcpListener::bind(("127.0.0.1", candidate)).is_ok() {
            return Some(candidate);
        }
    }
    None
}

/// Look up the listener on `port`. Returns None when the port is free or when
/// `lsof` isn't reachable. macOS-only — uses `lsof -F pcn` machine-readable
/// output (one record per line, prefixed with the field type).
#[tauri::command]
pub fn who_uses_port(port: u16) -> Option<PortHolder> {
    let out = Command::new("lsof")
        .args([
            "-nP",
            &format!("-iTCP:{port}"),
            "-sTCP:LISTEN",
            "-F",
            "pcn",
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut pid: Option<u32> = None;
    let mut name: Option<String> = None;
    // `-F pcn` emits records prefixed with field type:
    //   p<pid>  c<command/process>  n<name like 127.0.0.1:3000>
    // We take the first complete (pid, command) pair we see.
    for line in stdout.lines() {
        if let Some(rest) = line.strip_prefix('p') {
            if let Ok(parsed) = rest.trim().parse::<u32>() {
                pid = Some(parsed);
            }
        } else if let Some(rest) = line.strip_prefix('c') {
            name = Some(rest.trim().to_string());
        }
        if pid.is_some() && name.is_some() {
            break;
        }
    }
    let pid = pid?;
    let process_name = name.unwrap_or_else(|| "unknown".into());
    // Resolve the full command line via `ps -o command=` so the UI can show
    // something more useful than just `node` (e.g. `node server.js`).
    let command = Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "command="])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| process_name.clone());
    Some(PortHolder { pid, process_name, command })
}

/// Convenience: scan upwards from `current_port + 1` for the next free port,
/// capped at +50 attempts. Returns `current_port` itself as fallback so
/// callers always have a value to render.
#[tauri::command]
pub fn suggest_alternative_port(current_port: u16) -> u16 {
    let start = current_port.saturating_add(1);
    find_free_port(start, 50).unwrap_or(current_port)
}

/// Edit the app's compose file in place: replace `old_port` on the host side
/// of any `ports:` mapping with `new_port`, then update the app's DB record
/// so Caddy's reverse proxy follows. String-level replace (not a YAML round
/// trip) — preserves comments/whitespace/anchors.
///
/// Matches typical port-mapping shapes inside a compose `ports:` list:
///   - "<old>:<container>"      (quoted)
///   -  <old>:<container>       (bare)
///   - "127.0.0.1:<old>:<ctr>"  (bind-host prefix)
/// Only rewrites the **host** side; container port is left alone.
#[tauri::command]
pub fn apply_port_change(
    state: State<AppState>,
    app_id: String,
    old_port: u16,
    new_port: u16,
) -> Result<(), String> {
    if old_port == new_port {
        return Ok(());
    }
    let app = {
        let db = state.db.lock().unwrap();
        let apps = db.list_apps().map_err(|e| e.to_string())?;
        apps.into_iter()
            .find(|a| a.id == app_id)
            .ok_or_else(|| format!("app {} not found", app_id))?
    };

    // ── 1. Rewrite compose file (compose apps only) ──────────────────────
    if let Some(compose_file) = app.compose_file.as_deref() {
        let root = if app.root_dir.is_empty() {
            None
        } else {
            Some(app.root_dir.as_str())
        };
        let resolved = resolve_compose_path(compose_file, root);
        let original = std::fs::read_to_string(&resolved)
            .map_err(|e| format!("read compose file {}: {}", resolved, e))?;
        let (rewritten, changes) = rewrite_compose_host_port(&original, old_port, new_port);
        if changes == 0 {
            return Err(format!(
                "no port mapping for :{} found in {}",
                old_port, resolved
            ));
        }
        std::fs::write(&resolved, rewritten)
            .map_err(|e| format!("write compose file {}: {}", resolved, e))?;
    }

    // ── 2. Update DB port column so Caddy's reverse proxy targets new_port ─
    {
        let db = state.db.lock().unwrap();
        db.update_app_port(&app_id, new_port).map_err(|e| e.to_string())?;
    }

    // ── 3. Refresh Caddy routes ──────────────────────────────────────────
    super::setup::sync_caddy(&state)?;
    Ok(())
}

/// Replace the host-side of compose port mappings that match `old`. Returns
/// the rewritten content + how many lines changed. Keeps the rest of the
/// file byte-identical (no YAML round-trip → comments survive).
///
/// Matched line shapes (after trimming leading `- ` / whitespace):
///   "3000:8080"           "<old>:<container>"
///   3000:8080             "<old>:<container>"
///   "127.0.0.1:3000:8080" "<host>:<old>:<container>"
///   3000-3001:8080-8081   range — host-low replaced if equal to `old`
fn rewrite_compose_host_port(content: &str, old: u16, new: u16) -> (String, usize) {
    let old_s = old.to_string();
    let new_s = new.to_string();
    let mut out = String::with_capacity(content.len() + 8);
    let mut changes = 0;
    for line in content.split_inclusive('\n') {
        if let Some(replaced) = try_rewrite_port_line(line, &old_s, &new_s) {
            out.push_str(&replaced);
            changes += 1;
        } else {
            out.push_str(line);
        }
    }
    (out, changes)
}

/// Returns `Some(replaced_line)` when the line is a compose port-mapping
/// entry whose host side equals `old`. Returns `None` otherwise (caller
/// keeps the line untouched).
fn try_rewrite_port_line(line: &str, old: &str, new: &str) -> Option<String> {
    // Split off trailing newline so we can re-attach after replacement.
    let (body, eol) = match line.rfind('\n') {
        Some(idx) => (&line[..idx], &line[idx..]),
        None => (line, ""),
    };
    let trimmed = body.trim_start();
    let leading_ws = &body[..body.len() - trimmed.len()];

    // Must be a list entry inside `ports:`. We don't have YAML context here,
    // but `- ` prefix + `<digits>:<digits>` shape is a strong-enough signal.
    let after_dash = trimmed.strip_prefix("- ")?;
    let dash_prefix = &trimmed[..trimmed.len() - after_dash.len()];

    // Peel off (in order): trailing comment → trailing whitespace before
    // comment → surrounding quotes around the mapping itself. This ordering
    // matters: `"3000:80"  # comment` would otherwise leave a stray `"` in
    // the "value" segment if we tried to strip quotes first.
    let (value_with_ws, trailing_comment) = match after_dash.find('#') {
        Some(idx) => (&after_dash[..idx], &after_dash[idx..]),
        None => (after_dash, ""),
    };
    let value = value_with_ws.trim_end();
    let trailing_ws = &value_with_ws[value.len()..];

    let (open_q, mapping, close_q) = strip_quotes(value);
    let new_mapping = rewrite_mapping_host(mapping, old, new)?;

    let mut rebuilt = String::new();
    rebuilt.push_str(leading_ws);
    rebuilt.push_str(dash_prefix);
    if let Some(q) = open_q {
        rebuilt.push(q);
    }
    rebuilt.push_str(&new_mapping);
    if let Some(q) = close_q {
        rebuilt.push(q);
    }
    rebuilt.push_str(trailing_ws);
    rebuilt.push_str(trailing_comment);
    rebuilt.push_str(eol);
    Some(rebuilt)
}

fn strip_quotes(s: &str) -> (Option<char>, &str, Option<char>) {
    if let Some(stripped) = s.strip_prefix('"').and_then(|r| r.strip_suffix('"')) {
        return (Some('"'), stripped, Some('"'));
    }
    if let Some(stripped) = s.strip_prefix('\'').and_then(|r| r.strip_suffix('\'')) {
        return (Some('\''), stripped, Some('\''));
    }
    (None, s, None)
}

/// Rewrite the host portion of a "host:container" or "ip:host:container"
/// mapping. Returns None when no match.
fn rewrite_mapping_host(mapping: &str, old: &str, new: &str) -> Option<String> {
    let parts: Vec<&str> = mapping.split(':').collect();
    match parts.len() {
        2 => {
            // host:container   — match host (parts[0]) only
            let host = parts[0];
            let host_replaced = replace_port_token(host, old, new)?;
            Some(format!("{}:{}", host_replaced, parts[1]))
        }
        3 => {
            // ip:host:container — match middle
            let host = parts[1];
            let host_replaced = replace_port_token(host, old, new)?;
            Some(format!("{}:{}:{}", parts[0], host_replaced, parts[2]))
        }
        _ => None,
    }
}

/// Replace a host-port token — accepts either an exact match (`3000`) or a
/// range with `old` as the low end (`3000-3001`). Returns None when no match
/// so the caller can leave the line alone.
fn replace_port_token(token: &str, old: &str, new: &str) -> Option<String> {
    if token == old {
        return Some(new.to_string());
    }
    if let Some((lo, hi)) = token.split_once('-') {
        if lo == old {
            return Some(format!("{}-{}", new, hi));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrite_quoted_simple_mapping() {
        let yaml = "services:\n  web:\n    ports:\n      - \"3000:8080\"\n";
        let (out, n) = rewrite_compose_host_port(yaml, 3000, 3001);
        assert_eq!(n, 1);
        assert!(out.contains("\"3001:8080\""), "got: {}", out);
    }

    #[test]
    fn rewrite_bare_mapping() {
        let yaml = "    ports:\n      - 3000:8080\n";
        let (out, n) = rewrite_compose_host_port(yaml, 3000, 4000);
        assert_eq!(n, 1);
        assert!(out.contains("- 4000:8080"), "got: {}", out);
    }

    #[test]
    fn rewrite_with_bind_ip() {
        let yaml = "      - \"127.0.0.1:3000:80\"\n";
        let (out, n) = rewrite_compose_host_port(yaml, 3000, 3001);
        assert_eq!(n, 1);
        assert!(out.contains("\"127.0.0.1:3001:80\""), "got: {}", out);
    }

    #[test]
    fn preserves_trailing_comment() {
        let yaml = "      - \"3000:80\"  # ui port\n";
        let (out, n) = rewrite_compose_host_port(yaml, 3000, 3001);
        assert_eq!(n, 1);
        assert!(out.contains("\"3001:80\""), "got: {}", out);
        assert!(out.contains("# ui port"), "got: {}", out);
    }

    #[test]
    fn skips_non_matching_lines() {
        let yaml = "services:\n  web:\n    image: nginx\n    ports:\n      - \"8080:80\"\n";
        let (out, n) = rewrite_compose_host_port(yaml, 3000, 3001);
        assert_eq!(n, 0);
        assert_eq!(out, yaml);
    }

    #[test]
    fn does_not_rewrite_container_side() {
        // `old` matches container port (right side) — must NOT replace.
        let yaml = "      - \"8080:3000\"\n";
        let (out, n) = rewrite_compose_host_port(yaml, 3000, 9999);
        assert_eq!(n, 0);
        assert_eq!(out, yaml);
    }

    #[test]
    fn rewrite_range_low_end() {
        let yaml = "      - \"3000-3001:80-81\"\n";
        let (out, n) = rewrite_compose_host_port(yaml, 3000, 4000);
        assert_eq!(n, 1);
        assert!(out.contains("\"4000-3001:80-81\""), "got: {}", out);
    }
}
