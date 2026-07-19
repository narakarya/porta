use serde::Serialize;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::State;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::time::timeout;

use crate::app_state::AppState;
use crate::db::Database;
use crate::extensions::loader::extensions_dir;

/// Build an augmented PATH that includes shim directories from common version
/// managers (asdf, mise, homebrew) so tools like `mix`, `node`, `npm` are
/// reachable even when Porta is launched as a GUI app without a login shell.
fn augmented_path() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let current = std::env::var("PATH").unwrap_or_default();

    // Directories to prepend — order matters: user tools before system tools.
    let extra: &[&str] = &[
        // asdf shims
        "/.asdf/shims",
        "/.asdf/bin",
        // mise shims
        "/.local/share/mise/shims",
        "/.local/bin",
        // homebrew (Apple Silicon)
        // (Intel path /usr/local/bin is typically already in PATH)
    ];

    let mut parts: Vec<String> = extra
        .iter()
        .map(|s| format!("{home}{s}"))
        .collect();

    // homebrew static paths (not home-relative)
    parts.push("/opt/homebrew/bin".to_string());
    parts.push("/opt/homebrew/sbin".to_string());
    parts.push("/usr/local/bin".to_string());

    if !current.is_empty() {
        parts.push(current);
    }

    parts.join(":")
}

fn login_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
}

/// Spawn a shell command with an augmented PATH so version-manager tools
/// (mix, node, etc.) are available regardless of how Porta was launched.
fn shell_cmd(cmd: &str, cwd: &str) -> tokio::process::Command {
    let shell = login_shell();
    let mut c = tokio::process::Command::new(&shell);
    c.arg("-l")
        .arg("-c")
        .arg(cmd)
        .current_dir(cwd)
        .env("PATH", augmented_path());
    c
}

// ── Spawn event (used by streaming command) ───────────────────────────────────

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SpawnEvent {
    Stdout { line: String },
    Stderr { line: String },
    Done { code: i32, timed_out: bool },
}

/// Read an extension file by its absolute path.
/// Restricted to files within the extensions directory.
#[tauri::command]
pub fn read_extension_file(path: String) -> Result<String, String> {
    let p = std::path::Path::new(&path);
    let canonical = p.canonicalize().map_err(|e| format!("Cannot resolve path: {}", e))?;
    let ext_dir = extensions_dir()
        .canonicalize()
        .unwrap_or_else(|_| extensions_dir());
    if !canonical.starts_with(&ext_dir) {
        return Err("Access denied: path is outside extensions directory".to_string());
    }
    std::fs::read_to_string(&canonical).map_err(|e| format!("Failed to read file: {}", e))
}

const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const MAX_TIMEOUT_MS: u64 = 300_000;

#[derive(Debug, Serialize)]
pub struct ShellResult {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
    pub timed_out: bool,
}

/// Resolve an extension target to the checkout it is allowed to operate in.
/// The frontend uses a synthetic app id for worktree instances, so extension
/// commands must accept both primary app ids and instance ids. Returning the
/// instance worktree here also keeps cwd validation scoped to that checkout
/// instead of accidentally granting access to the parent's root.
fn extension_target_root(db: &Database, target_id: &str) -> Result<String, String> {
    let apps = db.list_apps().map_err(|e| format!("DB error: {}", e))?;
    if let Some(app) = apps.into_iter().find(|app| app.id == target_id) {
        return Ok(app.root_dir);
    }

    let instances = db
        .list_instances()
        .map_err(|e| format!("DB error: {}", e))?;
    instances
        .into_iter()
        .find(|instance| instance.id == target_id)
        .map(|instance| instance.worktree_path)
        .ok_or_else(|| format!("App or instance '{}' not found", target_id))
}

/// Run a shell command on behalf of an extension.
///
/// Security constraints:
/// - `cwd` defaults to `app.root_dir`; `cwd_override` must be a sub-path of `root_dir`
/// - Extension manifest must declare `"shell"` permission (checked at call time)
/// - Timeout capped at 300s
#[tauri::command]
pub async fn extension_shell_run(
    app_id: String,
    extension_id: String,
    cmd: String,
    cwd_override: Option<String>,
    timeout_ms: Option<u64>,
    state: State<'_, AppState>,
) -> Result<ShellResult, String> {
    // 1. Look up the app to get root_dir
    let root_dir: String = {
        let db = state.db.lock().unwrap();
        extension_target_root(&db, &app_id)?
    };

    // 2. Check extension permission
    {
        let exts = state.extensions.lock().unwrap();
        let ext = exts
            .iter()
            .find(|e| e.manifest.id == extension_id)
            .ok_or_else(|| format!("Extension '{}' not found", extension_id))?;
        if !ext.manifest.has_shell_permission() {
            return Err(format!(
                "Extension '{}' does not have 'shell' permission",
                extension_id
            ));
        }
        if !ext.enabled {
            return Err(format!("Extension '{}' is disabled", extension_id));
        }
    }

    // 3. Resolve and validate working directory
    let cwd = match cwd_override {
        Some(ref override_path) => {
            let candidate = Path::new(override_path).to_path_buf();
            let canonical_candidate = candidate
                .canonicalize()
                .unwrap_or(candidate.clone());
            let canonical_root = Path::new(&root_dir)
                .canonicalize()
                .unwrap_or_else(|_| Path::new(&root_dir).to_path_buf());
            // Must be root_dir itself or a subdirectory of it
            if !canonical_candidate.starts_with(&canonical_root) {
                return Err(format!(
                    "cwd '{}' is outside app root_dir '{}'",
                    override_path, root_dir
                ));
            }
            override_path.clone()
        }
        None => root_dir.clone(),
    };

    // 4. Cap timeout
    let ms = timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS).min(MAX_TIMEOUT_MS);

    // 5. Spawn via login shell so user PATH (mix, node, etc.) is available.
    //    Hardening mirrors git.rs `run_bin` so a network subprocess (git over
    //    HTTPS/ssh) can't hang or leak descendants past the timeout:
    //    - GIT_TERMINAL_PROMPT=0 + null stdin: Porta has no tty, so without
    //      this an HTTPS git op blocks forever asking for credentials. Nulling
    //      stdin makes the no-hang guarantee structural (covers ssh passphrase
    //      and host-key prompts too) instead of leaning on the timeout.
    //      NOTE: this means an extension command cannot read interactive stdin.
    //    - process_group(0): own group so a timeout can kill the command's
    //      descendants (git → ssh, credential helpers) too, not just the top
    //      pid — killing the top pid alone leaks them.
    let mut child = shell_cmd(&cmd, &cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .spawn()
        .map_err(|e| format!("Failed to spawn command: {}", e))?;

    let pid = child.id();
    let stdout_handle = child.stdout.take();
    let stderr_handle = child.stderr.take();

    let result = timeout(Duration::from_millis(ms), async {
        // Drain both pipes concurrently — reading them serially would deadlock
        // if the child fills one pipe buffer while we block on the other.
        let stdout_fut = async {
            let mut buf = String::new();
            if let Some(mut out) = stdout_handle {
                let _ = out.read_to_string(&mut buf).await;
            }
            buf
        };
        let stderr_fut = async {
            let mut buf = String::new();
            if let Some(mut err) = stderr_handle {
                let _ = err.read_to_string(&mut buf).await;
            }
            buf
        };
        let (stdout_buf, stderr_buf) = tokio::join!(stdout_fut, stderr_fut);

        let status = child.wait().await.map_err(|e| e.to_string())?;
        Ok::<(String, String, i32), String>((
            stdout_buf,
            stderr_buf,
            status.code().unwrap_or(-1),
        ))
    })
    .await;

    match result {
        Ok(Ok((stdout, stderr, code))) => Ok(ShellResult {
            stdout,
            stderr,
            code,
            timed_out: false,
        }),
        Ok(Err(e)) => Err(e),
        Err(_) => {
            // Kill the whole process group (negative pid) so leaked git/ssh
            // grandchildren are reaped, not just the direct child. `/bin/kill`
            // because tokio/std expose no group-kill and we take no libc dep —
            // mirrors git.rs `run_bin`.
            if let Some(pid) = pid {
                let _ = std::process::Command::new("/bin/kill")
                    .args(["-9", &format!("-{pid}")])
                    .output();
            }
            // Reap our direct child so we don't leave a zombie.
            let _ = child.kill().await;
            Ok(ShellResult {
                stdout: String::new(),
                stderr: format!("Command timed out after {}ms", ms),
                code: -1,
                timed_out: true,
            })
        }
    }
}

// ── Streaming spawn ───────────────────────────────────────────────────────────

/// Like extension_shell_run but streams stdout/stderr line-by-line via a Tauri Channel.
/// The channel receives SpawnEvent::Stdout/Stderr for each line, then SpawnEvent::Done.
/// Same security constraints as extension_shell_run.
#[tauri::command]
pub async fn extension_shell_spawn(
    app_id: String,
    extension_id: String,
    cmd: String,
    cwd_override: Option<String>,
    timeout_ms: Option<u64>,
    on_event: Channel<SpawnEvent>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root_dir: String = {
        let db = state.db.lock().unwrap();
        extension_target_root(&db, &app_id)?
    };

    {
        let exts = state.extensions.lock().unwrap();
        let ext = exts
            .iter()
            .find(|e| e.manifest.id == extension_id)
            .ok_or_else(|| format!("Extension '{}' not found", extension_id))?;
        if !ext.manifest.has_shell_permission() {
            return Err(format!("Extension '{}' does not have 'shell' permission", extension_id));
        }
        if !ext.enabled {
            return Err(format!("Extension '{}' is disabled", extension_id));
        }
    }

    let cwd = match cwd_override {
        Some(ref p) => {
            let candidate = Path::new(p).canonicalize().unwrap_or_else(|_| Path::new(p).to_path_buf());
            let root = Path::new(&root_dir).canonicalize().unwrap_or_else(|_| Path::new(&root_dir).to_path_buf());
            if !candidate.starts_with(&root) {
                return Err(format!("cwd '{}' is outside app root_dir '{}'", p, root_dir));
            }
            p.clone()
        }
        None => root_dir.clone(),
    };

    let ms = timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS).min(MAX_TIMEOUT_MS);

    let mut child = shell_cmd(&cmd, &cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn: {}", e))?;

    let mut stdout_lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let mut stderr_lines = BufReader::new(child.stderr.take().unwrap()).lines();
    let mut stdout_done = false;
    let mut stderr_done = false;

    let result = timeout(Duration::from_millis(ms), async {
        while !stdout_done || !stderr_done {
            tokio::select! {
                line = stdout_lines.next_line(), if !stdout_done => {
                    match line {
                        Ok(Some(l)) => { let _ = on_event.send(SpawnEvent::Stdout { line: l }); }
                        _ => { stdout_done = true; }
                    }
                }
                line = stderr_lines.next_line(), if !stderr_done => {
                    match line {
                        Ok(Some(l)) => { let _ = on_event.send(SpawnEvent::Stderr { line: l }); }
                        _ => { stderr_done = true; }
                    }
                }
            }
        }
        child.wait().await
    })
    .await;

    let (code, timed_out) = match result {
        Ok(Ok(status)) => (status.code().unwrap_or(-1), false),
        Ok(Err(_)) => (-1, false),
        Err(_) => {
            let _ = child.kill().await;
            (-1, true)
        }
    };

    let _ = on_event.send(SpawnEvent::Done { code, timed_out });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::models::AppInstance;
    use rusqlite::params;

    #[test]
    fn extension_target_root_resolves_primary_app_and_instance_worktree() {
        let mut db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        db.conn
            .execute(
                "INSERT INTO apps (id, name, root_dir, port) VALUES (?1, 'porta', ?2, 4001)",
                params!["app-1", "/repo/porta"],
            )
            .unwrap();
        db.insert_instance(&AppInstance {
            id: "app-1:feature-editor".into(),
            app_id: "app-1".into(),
            worktree_path: "/repo/porta-feature-editor".into(),
            branch: "feature/editor".into(),
            subdomain: "porta-feature-editor".into(),
            port: 5001,
            pid: None,
            status: "stopped".into(),
        })
        .unwrap();

        assert_eq!(extension_target_root(&db, "app-1").unwrap(), "/repo/porta");
        assert_eq!(
            extension_target_root(&db, "app-1:feature-editor").unwrap(),
            "/repo/porta-feature-editor"
        );
        assert!(extension_target_root(&db, "missing").is_err());
    }
}
