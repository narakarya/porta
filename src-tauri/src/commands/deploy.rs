use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;
use tauri::Emitter;
use tauri::State;

use crate::app_state::AppState;

// Tracks live PTY runs by run_id so kamal_cancel can kill them. The child is
// made its own session/group leader via setsid() so we can signal the whole
// group with kill(-pid, …) without hitting porta itself.
fn kamal_run_pids() -> &'static Mutex<HashMap<String, i32>> {
    static R: OnceLock<Mutex<HashMap<String, i32>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashMap::new()))
}

// Returns a shim ZDOTDIR that redirects `.zshrc` loading through porta. The
// shim defines dummy functions for known-broken plugins (kiro-cli-autocomplete
// panics on `kiro init zsh` inside a non-TTY PTY) BEFORE sourcing the user's
// real startup files, so those plugin init calls become no-ops. The user's
// aliases / PATH / everything else in `.zshrc` still load normally.
fn zsh_shim_zdotdir() -> &'static Path {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    DIR.get_or_init(|| {
        let dir = std::env::temp_dir().join("porta-zsh-shim");
        let _ = std::fs::create_dir_all(&dir);

        // Helper block: stub every known-broken CLI that panics when invoked
        // from a PTY (kiro-cli-autocomplete + its aliases). Functions shadow
        // binaries in zsh's lookup order, so any `kiro init zsh` or similar
        // invocation becomes a no-op. Applied BOTH in .zshenv and .zshrc so
        // it's active no matter which user file tries to init the plugin.
        let stub = r#"# porta shim — silence broken CLI autocomplete plugins
kiro() { return 0 }
kiro-cli-autocomplete() { return 0 }
# Env-var belt-and-suspenders — some versions respect these.
export KIRO_DISABLE=1
export KIRO_CLI_AUTOCOMPLETE_DISABLE=1
export KIRO_NO_AUTOCOMPLETE=1
"#;

        // shim/.zshenv — runs first, before user's env. Stub kiro here so
        // user's .zshenv can't accidentally invoke the real binary.
        let shim_zshenv = format!(
            "{stub}\n[[ -r \"$HOME/.zshenv\" ]] && source \"$HOME/.zshenv\"\n"
        );
        let _ = std::fs::write(dir.join(".zshenv"), shim_zshenv);

        // shim/.zshrc — re-apply stub (idempotent) then source user's rc files
        // in zsh's normal order. The trailing unset lets the user's *command*
        // still resolve the real kiro binary via PATH (plugin init is done by
        // this point, so the panic-y code paths are behind us).
        let shim_zshrc = format!(
            r#"{stub}
# ZDOTDIR redirects zsh away from $HOME for startup files, so source
# the user's files manually in zsh's normal order.
[[ -r "$HOME/.zprofile" ]] && source "$HOME/.zprofile"
[[ -r "$HOME/.zshrc"    ]] && source "$HOME/.zshrc"

unset -f kiro kiro-cli-autocomplete 2>/dev/null
"#
        );
        let _ = std::fs::write(dir.join(".zshrc"), shim_zshrc);

        dir
    }).as_path()
}

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

pub(super) fn spawn_pty_command<F, S>(
    cmd_str: &str,
    cwd: &Path,
    on_line: F,
    on_spawn: S,
) -> Result<i32, String>
where
    F: Fn(String) + Send + Sync + 'static,
    S: FnOnce(u32),
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

    // Keep `-i` so aliases/functions from the user's `.zshrc` (e.g. a
    // Docker-based `kamal` alias) are available, but override ZDOTDIR to a
    // porta-managed shim that stubs known-broken plugins before sourcing
    // the user's real startup files — see `zsh_shim_zdotdir()`.
    let mut cmd = std::process::Command::new("zsh");
    cmd.args(["-i", "-c", cmd_str])
       .env("ZDOTDIR", zsh_shim_zdotdir())
       .current_dir(cwd)
       .stdin(unsafe  { std::process::Stdio::from_raw_fd(stdin_fd)  })
       .stdout(unsafe { std::process::Stdio::from_raw_fd(stdout_fd) })
       .stderr(unsafe { std::process::Stdio::from_raw_fd(stderr_fd) });

    unsafe {
        cmd.pre_exec(move || {
            libc::close(slave_fd);
            libc::close(master_fd);
            libc::close(reader_fd);
            // Become our own session/process-group leader so cancel can kill the
            // whole group (via kill(-pid, …)) without hitting porta itself.
            if libc::setsid() < 0 {
                return Err(std::io::Error::last_os_error());
            }
            // Attach our PTY slave (now on fd 0 via dup2 in spawn) as the
            // controlling terminal. Without this, `zsh -i` job-control calls
            // (tcsetpgrp, tcgetpgrp) have no ctty and can leave the shell in
            // a state where waitpid() on the parent side never reports exit.
            libc::ioctl(0, libc::TIOCSCTTY.into(), 0i32);
            Ok(())
        });
    }

    let mut child = cmd.spawn().map_err(|e| {
        unsafe { libc::close(slave_fd); libc::close(master_fd); libc::close(reader_fd); }
        format!("spawn: {e}")
    })?;

    unsafe { libc::close(slave_fd); }

    on_spawn(child.id());

    let on_line = Arc::new(on_line);
    let on_line_r = Arc::clone(&on_line);
    let on_line_m = Arc::clone(&on_line);
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

    // Poll for exit rather than blocking on `child.wait()`. A blocking wait
    // can hang indefinitely if another thread in the process (e.g. a Tauri
    // plugin) happens to reap our child via waitpid(-1, …) first. The
    // kill(pid, 0) probe is a safety net for the (unlikely) case where
    // try_wait keeps reporting None on a dead child — if the kernel no longer
    // knows the pid, bail out instead of spinning forever.
    let child_pid = child.id() as i32;
    let code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code().unwrap_or(-1),
            Err(e) => {
                on_line_m(format!("[porta] try_wait error: {} — bailing out", e));
                break -1;
            }
            Ok(None) => {}
        }
        if unsafe { libc::kill(child_pid, 0) } != 0 {
            let errno = std::io::Error::last_os_error();
            on_line_m(format!(
                "[porta] kill(pid {}, 0) failed ({}) — treating as exited",
                child_pid, errno
            ));
            break -1;
        }
        thread::sleep(Duration::from_millis(150));
    };

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
        let reg_id  = run_id.clone();
        let result = spawn_pty_command(
            &kamal_cmd,
            &work_dir,
            move |line| {
                log_app.emit(&format!("kamal:log:{}", log_id), line).ok();
            },
            move |pid| {
                kamal_run_pids().lock().unwrap().insert(reg_id, pid as i32);
            },
        );
        kamal_run_pids().lock().unwrap().remove(&run_id);
        match result {
            Ok(code) => {
                app.emit(&format!("kamal:log:{}", run_id), format!("[porta] process finished (exit {})", code)).ok();
                app.emit(&format!("kamal:exit:{}", run_id), code).ok();
            }
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
        let reg_id  = run_id.clone();

        // Detect if gem env requires --user-install (system Ruby without write perms)
        let install_cmd = match std::process::Command::new("zsh")
            .args(["-i", "-c", "gem env gemdir"])
            .output()
        {
            Ok(out) => {
                let gemdir = String::from_utf8_lossy(&out.stdout).trim().to_string();
                let writable = !gemdir.is_empty() && unsafe {
                    let c_path = std::ffi::CString::new(gemdir.as_str()).unwrap();
                    libc::access(c_path.as_ptr(), libc::W_OK) == 0
                };
                if writable { "gem install kamal" } else { "gem install kamal --user-install" }
            }
            _ => "gem install kamal --user-install",
        };

        let result = spawn_pty_command(
            install_cmd,
            std::path::Path::new("/tmp"),
            move |line| {
                log_app.emit(&format!("kamal:log:{}", log_id), line).ok();
            },
            move |pid| {
                kamal_run_pids().lock().unwrap().insert(reg_id, pid as i32);
            },
        );
        kamal_run_pids().lock().unwrap().remove(&run_id);
        match result {
            Ok(code) => { app.emit(&format!("kamal:exit:{}", run_id), code).ok(); }
            Err(e)   => {
                app.emit(&format!("kamal:log:{}", run_id), format!("[err] {e}")).ok();
                app.emit(&format!("kamal:exit:{}", run_id), -1i32).ok();
            }
        }
    });
    Ok(())
}

/// Interrupt a running kamal command. Sends SIGINT to the process group first
/// (so kamal can clean up SSH sessions), then escalates to SIGKILL after a short
/// grace period if it's still alive.
#[tauri::command]
pub fn kamal_cancel(app: tauri::AppHandle, run_id: String) -> Result<(), String> {
    let pid = match kamal_run_pids().lock().unwrap().get(&run_id).copied() {
        Some(p) => p,
        None => {
            app.emit(
                &format!("kamal:log:{}", run_id),
                "[porta] cancel requested — process already exited".to_string(),
            ).ok();
            return Ok(());
        }
    };

    app.emit(
        &format!("kamal:log:{}", run_id),
        format!("[porta] stopping (SIGINT → pgid {})", pid),
    ).ok();

    // Signal the entire process group so nested kamal children (ssh, docker, …) get hit.
    let int_rc = unsafe { libc::kill(-pid, libc::SIGINT) };
    if int_rc != 0 {
        app.emit(
            &format!("kamal:log:{}", run_id),
            format!("[porta] SIGINT failed: {}", std::io::Error::last_os_error()),
        ).ok();
    }

    let app_kill = app.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(2000));
        let still_alive = kamal_run_pids().lock().unwrap().contains_key(&run_id);
        if still_alive {
            app_kill.emit(
                &format!("kamal:log:{}", run_id),
                "[porta] grace period elapsed — sending SIGKILL".to_string(),
            ).ok();
            unsafe { libc::kill(-pid, libc::SIGKILL); }
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
