use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use tauri::Emitter;
use tauri::State;

use crate::app_state::AppState;

/// Check if the `kamal` binary is in PATH. Returns { installed, version }.
#[tauri::command]
pub fn check_kamal() -> serde_json::Value {
    // Try direct binary first (gem-installed kamal)
    if let Ok(out) = std::process::Command::new("kamal").arg("version").output() {
        if out.status.success() {
            let raw = String::from_utf8_lossy(&out.stdout);
            return serde_json::json!({ "installed": true, "version": raw.trim() });
        }
    }

    // Fall back to shell check — handles zsh aliases (e.g. Docker-based kamal),
    // rbenv/asdf shims, or any other shell-level kamal wrapper.
    if let Ok(out) = std::process::Command::new("zsh")
        .args(["-i", "-c", "type kamal 2>/dev/null"])
        .output()
    {
        if out.status.success() {
            let stdout = String::from_utf8_lossy(&out.stdout);
            if !stdout.is_empty() && !stdout.contains("not found") {
                return serde_json::json!({ "installed": true, "version": null });
            }
        }
    }

    serde_json::json!({ "installed": false, "version": null })
}

/// Determine the working directory for a kamal config path.
fn kamal_work_dir(config_path: &str) -> PathBuf {
    let p = std::path::Path::new(config_path);
    if config_path.ends_with("/config/deploy.yml") {
        p.parent()
            .and_then(|p| p.parent())
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."))
    } else {
        p.parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."))
    }
}

// ── PTY helper ───────────────────────────────────────────────────────────────

pub(super) fn spawn_pty_command<F>(cmd_str: &str, cwd: &Path, on_line: F) -> Result<i32, String>
where
    F: Fn(String) + Send + Sync + 'static,
{
    use std::os::unix::io::FromRawFd;
    use std::os::unix::process::CommandExt;
    use std::sync::atomic::{AtomicI32, Ordering};

    let (master_fd, slave_fd) = unsafe {
        let mut m: libc::c_int = -1;
        let mut s: libc::c_int = -1;
        if libc::openpty(&mut m, &mut s, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut()) != 0 {
            return Err(format!("openpty: {}", std::io::Error::last_os_error()));
        }
        (m, s)
    };

    let (stdin_fd, stdout_fd, stderr_fd) = unsafe {(
        libc::dup(slave_fd), libc::dup(slave_fd), libc::dup(slave_fd),
    )};
    if stdin_fd < 0 || stdout_fd < 0 || stderr_fd < 0 {
        unsafe { libc::close(slave_fd); libc::close(master_fd); }
        return Err("dup() failed when setting up PTY".into());
    }

    let reader_fd = unsafe { libc::dup(master_fd) };
    if reader_fd < 0 {
        unsafe { libc::close(slave_fd); libc::close(master_fd); }
        return Err("dup() for reader failed".into());
    }
    let shared_rfd = Arc::new(AtomicI32::new(reader_fd));
    let shared_rfd2 = Arc::clone(&shared_rfd);

    let mut cmd = std::process::Command::new("zsh");
    cmd.args(["-i", "-c", cmd_str])
       .current_dir(cwd)
       .stdin(unsafe  { std::process::Stdio::from_raw_fd(stdin_fd)  })
       .stdout(unsafe { std::process::Stdio::from_raw_fd(stdout_fd) })
       .stderr(unsafe { std::process::Stdio::from_raw_fd(stderr_fd) });

    unsafe {
        cmd.pre_exec(move || {
            libc::close(slave_fd);
            libc::close(master_fd);
            libc::close(reader_fd);
            Ok(())
        });
    }

    let mut child = cmd.spawn().map_err(|e| {
        unsafe { libc::close(slave_fd); libc::close(master_fd); libc::close(reader_fd); }
        format!("spawn: {e}")
    })?;

    unsafe { libc::close(slave_fd); }

    let on_line = Arc::new(on_line);
    let on_line_r = Arc::clone(&on_line);
    thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut leftover: Vec<u8> = Vec::new();
        loop {
            let fd = shared_rfd2.load(Ordering::Acquire);
            if fd < 0 { break; }
            let n = unsafe { libc::read(fd, buf.as_mut_ptr() as *mut libc::c_void, buf.len()) };
            if n <= 0 { break; }
            leftover.extend_from_slice(&buf[..n as usize]);
            while let Some(pos) = leftover.iter().position(|&b| b == b'\n') {
                let end = if pos > 0 && leftover[pos - 1] == b'\r' { pos - 1 } else { pos };
                if let Ok(line) = std::str::from_utf8(&leftover[..end]) {
                    if !line.is_empty() { on_line_r(line.to_string()); }
                }
                leftover = leftover[pos + 1..].to_vec();
            }
        }
        if !leftover.is_empty() {
            let end = if leftover.last() == Some(&b'\r') { leftover.len() - 1 } else { leftover.len() };
            if let Ok(line) = std::str::from_utf8(&leftover[..end]) {
                if !line.is_empty() { on_line_r(line.to_string()); }
            }
        }
    });

    let code = child.wait().map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);

    thread::sleep(Duration::from_millis(250));

    unsafe { libc::close(master_fd); }
    let rfd = shared_rfd.swap(-1, Ordering::SeqCst);
    if rfd >= 0 { unsafe { libc::close(rfd); } }

    Ok(code)
}

// ── Kamal commands ────────────────────────────────────────────────────────────

#[tauri::command]
pub fn kamal_run(
    app: tauri::AppHandle,
    app_id: String,
    config_path: String,
    args: Vec<String>,
    run_id: String,
) -> Result<(), String> {
    let _ = app_id;
    let work_dir = kamal_work_dir(&config_path);
    thread::spawn(move || {
        let kamal_cmd = format!("kamal {}", args.join(" "));
        let log_app = app.clone();
        let log_id  = run_id.clone();
        match spawn_pty_command(&kamal_cmd, &work_dir, move |line| {
            log_app.emit(&format!("kamal:log:{}", log_id), line).ok();
        }) {
            Ok(code) => { app.emit(&format!("kamal:exit:{}", run_id), code).ok(); }
            Err(e)   => {
                app.emit(&format!("kamal:log:{}", run_id), format!("[err] {e}")).ok();
                app.emit(&format!("kamal:exit:{}", run_id), -1i32).ok();
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub fn install_kamal(app: tauri::AppHandle, app_id: String, run_id: String) -> Result<(), String> {
    let _ = app_id;
    thread::spawn(move || {
        let log_app = app.clone();
        let log_id  = run_id.clone();
        match spawn_pty_command("gem install kamal", std::path::Path::new("/tmp"), move |line| {
            log_app.emit(&format!("kamal:log:{}", log_id), line).ok();
        }) {
            Ok(code) => { app.emit(&format!("kamal:exit:{}", run_id), code).ok(); }
            Err(e)   => {
                app.emit(&format!("kamal:log:{}", run_id), format!("[err] {e}")).ok();
                app.emit(&format!("kamal:exit:{}", run_id), -1i32).ok();
            }
        }
    });
    Ok(())
}

// ── Kamal accessories + custom commands ──────────────────────────────────────

#[tauri::command]
pub fn parse_kamal_accessories(config_path: String) -> Vec<String> {
    let Ok(content) = std::fs::read_to_string(&config_path) else {
        return vec![];
    };
    let Ok(value) = serde_yaml::from_str::<serde_yaml::Value>(&content) else {
        return vec![];
    };
    value
        .get("accessories")
        .and_then(|v| v.as_mapping())
        .map(|m| {
            m.keys()
                .filter_map(|k| k.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

#[tauri::command]
pub fn add_deploy_custom_cmd(
    state: State<AppState>,
    app_id: String,
    cmd: serde_json::Value,
) -> Result<(), String> {
    let new_cmd: crate::db::models::CustomDeployCmd =
        serde_json::from_value(cmd).map_err(|e| e.to_string())?;
    let db = state.db.lock().unwrap();
    let mut cmds = db.get_deploy_custom_cmds(&app_id).map_err(|e| e.to_string())?;
    if cmds.iter().any(|c| c.id == new_cmd.id) {
        return Err("Command with this id already exists".into());
    }
    cmds.push(new_cmd);
    db.set_deploy_custom_cmds(&app_id, &cmds).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_deploy_custom_cmd(
    state: State<AppState>,
    app_id: String,
    cmd: serde_json::Value,
) -> Result<(), String> {
    let updated: crate::db::models::CustomDeployCmd =
        serde_json::from_value(cmd).map_err(|e| e.to_string())?;
    let db = state.db.lock().unwrap();
    let mut cmds = db.get_deploy_custom_cmds(&app_id).map_err(|e| e.to_string())?;
    let pos = cmds.iter().position(|c| c.id == updated.id)
        .ok_or_else(|| "Command not found".to_string())?;
    cmds[pos] = updated;
    db.set_deploy_custom_cmds(&app_id, &cmds).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_deploy_custom_cmd(
    state: State<AppState>,
    app_id: String,
    cmd_id: String,
) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    let mut cmds = db.get_deploy_custom_cmds(&app_id).map_err(|e| e.to_string())?;
    cmds.retain(|c| c.id != cmd_id);
    db.set_deploy_custom_cmds(&app_id, &cmds).map_err(|e| e.to_string())
}
