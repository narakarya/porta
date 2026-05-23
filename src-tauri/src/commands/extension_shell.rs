use serde::Serialize;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::State;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::time::timeout;

use crate::app_state::AppState;
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
        let apps = db.list_apps().map_err(|e| format!("DB error: {}", e))?;
        apps.into_iter()
            .find(|a| a.id == app_id)
            .ok_or_else(|| format!("App '{}' not found", app_id))?
            .root_dir
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

    // 5. Spawn via login shell so user PATH (mix, node, etc.) is available
    let mut child = shell_cmd(&cmd, &cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn command: {}", e))?;

    let stdout_handle = child.stdout.take();
    let stderr_handle = child.stderr.take();

    let result = timeout(Duration::from_millis(ms), async {
        let mut stdout_buf = String::new();
        let mut stderr_buf = String::new();

        if let Some(mut out) = stdout_handle {
            let _ = out.read_to_string(&mut stdout_buf).await;
        }
        if let Some(mut err) = stderr_handle {
            let _ = err.read_to_string(&mut stderr_buf).await;
        }

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
        let apps = db.list_apps().map_err(|e| format!("DB error: {}", e))?;
        apps.into_iter()
            .find(|a| a.id == app_id)
            .ok_or_else(|| format!("App '{}' not found", app_id))?
            .root_dir
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
