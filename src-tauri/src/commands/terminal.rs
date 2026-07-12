use std::collections::HashMap;
use std::os::unix::io::RawFd;
use std::sync::{Mutex, OnceLock};
use std::thread;
use tauri::Emitter;

pub(super) struct TerminalHandle {
    pub master_fd: RawFd,
    pub child_pid: u32,
}

pub(super) fn terminals() -> &'static Mutex<HashMap<String, TerminalHandle>> {
    static T: OnceLock<Mutex<HashMap<String, TerminalHandle>>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Ensure the spawned shell sees a UTF-8 locale.
///
/// macOS GUI apps are launched (Finder/Dock) without the terminal's locale
/// environment, so `LANG` / `LC_*` are typically unset. Programs that gate
/// Unicode output on the locale then fall back to latin1 — e.g. the Erlang
/// compiler escapes box-drawing characters as `\x{250C}` instead of drawing
/// them. If the environment already declares a UTF-8 locale we leave it
/// untouched; otherwise we inject a sane default.
fn utf8_locale_overrides(
    lookup: impl Fn(&str) -> Option<String>,
) -> Vec<(&'static str, String)> {
    let already_utf8 = ["LC_ALL", "LC_CTYPE", "LANG"]
        .iter()
        .filter_map(|k| lookup(k))
        .any(|v| {
            let v = v.to_ascii_uppercase();
            v.contains("UTF-8") || v.contains("UTF8")
        });
    if already_utf8 {
        vec![]
    } else {
        vec![
            ("LANG", "en_US.UTF-8".to_string()),
            ("LC_CTYPE", "en_US.UTF-8".to_string()),
        ]
    }
}

/// Spawn an interactive `zsh` shell in `root_dir` inside a PTY.
/// Output is streamed to `terminal:data:{app_id}` events as raw bytes (base64).
/// Emits `terminal:exit:{app_id}` when the shell exits.
///
/// If `startup_cmd` is provided, it is written to the PTY after the shell
/// prompt appears — this keeps the shell fully interactive (history, aliases,
/// Ctrl-C) while auto-running a command like `claude`. Using the PTY write
/// path (rather than `zsh -c`) is what lets the user see the command typed in
/// and interact with its TUI afterwards.
#[tauri::command]
pub fn terminal_open(
    app: tauri::AppHandle,
    app_id: String,
    root_dir: String,
    rows: u16,
    cols: u16,
    startup_cmd: Option<String>,
) -> Result<(), String> {
    use std::os::unix::io::FromRawFd;
    use std::os::unix::process::CommandExt;

    // Close any existing terminal for this app first.
    terminal_close(app_id.clone())?;

    let (master_fd, slave_fd) = unsafe {
        let mut m: libc::c_int = -1;
        let mut s: libc::c_int = -1;
        let mut ws = libc::winsize {
            ws_row: rows, ws_col: cols, ws_xpixel: 0, ws_ypixel: 0,
        };
        let ret = libc::openpty(
            &mut m, &mut s, std::ptr::null_mut(), std::ptr::null_mut(), &mut ws,
        );
        if ret != 0 {
            return Err(format!("openpty: {}", std::io::Error::last_os_error()));
        }
        (m, s)
    };

    let (stdin_fd, stdout_fd, stderr_fd) = unsafe {(
        libc::dup(slave_fd),
        libc::dup(slave_fd),
        libc::dup(slave_fd),
    )};

    let cwd = std::path::PathBuf::from(&root_dir);
    let mut cmd = std::process::Command::new("zsh");
    // Login + interactive: `-l` sources ~/.zprofile/~/.zlogin (where Homebrew's
    // `brew shellenv` typically puts /opt/homebrew/bin on PATH), `-i` sources
    // ~/.zshrc (aliases, `eval "$(starship init zsh)"`). Without `-l`, a .app
    // bundle's minimal PATH means `starship` isn't found and the prompt silently
    // falls back to the bare zsh prompt — matches the process launcher, which
    // also runs a login shell.
    cmd.arg("-i").arg("-l")
       .env("TERM", "xterm-256color")
       .current_dir(&cwd);

    for (key, val) in utf8_locale_overrides(|k| std::env::var(k).ok()) {
        cmd.env(key, val);
    }

    cmd
       .stdin(unsafe  { std::process::Stdio::from_raw_fd(stdin_fd)  })
       .stdout(unsafe { std::process::Stdio::from_raw_fd(stdout_fd) })
       .stderr(unsafe { std::process::Stdio::from_raw_fd(stderr_fd) });

    unsafe {
        cmd.pre_exec(move || {
            libc::close(slave_fd);
            libc::close(master_fd);
            libc::setsid();
            libc::ioctl(0, libc::TIOCSCTTY.into(), 0i32);
            Ok(())
        });
    }

    let child = cmd.spawn().map_err(|e| format!("spawn shell: {e}"))?;
    let child_pid = child.id();

    unsafe { libc::close(slave_fd); }

    // Detach child so we don't leave a zombie — we wait in a background thread.
    let wait_pid = child_pid;
    thread::spawn(move || unsafe { libc::waitpid(wait_pid as i32, std::ptr::null_mut(), 0); });

    terminals().lock().unwrap().insert(app_id.clone(), TerminalHandle { master_fd, child_pid });

    // If a startup command was requested, write it to the PTY after a short
    // delay so the interactive shell has a chance to print its prompt first.
    if let Some(cmd_text) = startup_cmd {
        let cmd_trimmed = cmd_text.trim().to_string();
        if !cmd_trimmed.is_empty() {
            thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(120));
                let payload = format!("{}\n", cmd_trimmed);
                unsafe {
                    libc::write(
                        master_fd,
                        payload.as_ptr() as *const libc::c_void,
                        payload.len(),
                    );
                }
            });
        }
    }

    // Stream PTY output to frontend as raw bytes (UTF-8 best-effort).
    let app_clone = app.clone();
    let id_clone  = app_id.clone();
    thread::spawn(move || {
        let mut buf = vec![0u8; 4096];
        loop {
            let n = unsafe {
                libc::read(master_fd, buf.as_mut_ptr() as *mut libc::c_void, buf.len())
            };
            if n <= 0 { break; }
            // Send raw bytes as a Vec<u8> — Tauri serialises to JSON array.
            let chunk: Vec<u8> = buf[..n as usize].to_vec();
            app_clone.emit(&format!("terminal:data:{}", id_clone), chunk).ok();
        }
        // Shell exited or fd closed — clean up.
        terminals().lock().unwrap().remove(&id_clone);
        unsafe { libc::close(master_fd); }
        app_clone.emit(&format!("terminal:exit:{}", id_clone), ()).ok();
    });

    Ok(())
}

/// Write bytes from the frontend keyboard input into the PTY master.
#[tauri::command]
pub fn terminal_write(app_id: String, data: Vec<u8>) -> Result<(), String> {
    let map = terminals().lock().unwrap();
    if let Some(h) = map.get(&app_id) {
        unsafe {
            libc::write(h.master_fd, data.as_ptr() as *const libc::c_void, data.len());
        }
    }
    Ok(())
}

/// Resize the terminal PTY (called when the xterm.js viewport changes).
#[tauri::command]
pub fn terminal_resize(app_id: String, rows: u16, cols: u16) -> Result<(), String> {
    let map = terminals().lock().unwrap();
    if let Some(h) = map.get(&app_id) {
        let ws = libc::winsize { ws_row: rows, ws_col: cols, ws_xpixel: 0, ws_ypixel: 0 };
        unsafe { libc::ioctl(h.master_fd, libc::TIOCSWINSZ, &ws); }
    }
    Ok(())
}

/// Close (and kill) a terminal session.
#[tauri::command]
pub fn terminal_close(app_id: String) -> Result<(), String> {
    if let Some(h) = terminals().lock().unwrap().remove(&app_id) {
        unsafe {
            libc::kill(h.child_pid as i32, libc::SIGHUP);
            libc::kill(h.child_pid as i32, libc::SIGTERM);
            // Close master fd — causes the read thread to get EIO and stop.
            libc::close(h.master_fd);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::utf8_locale_overrides;
    use std::collections::HashMap;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> =
            pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        move |k: &str| map.get(k).cloned()
    }

    #[test]
    fn injects_utf8_when_locale_env_is_empty() {
        let overrides = utf8_locale_overrides(env(&[]));
        assert_eq!(
            overrides,
            vec![
                ("LANG", "en_US.UTF-8".to_string()),
                ("LC_CTYPE", "en_US.UTF-8".to_string()),
            ]
        );
    }

    #[test]
    fn leaves_existing_utf8_locale_untouched() {
        assert!(utf8_locale_overrides(env(&[("LANG", "en_US.UTF-8")])).is_empty());
        assert!(utf8_locale_overrides(env(&[("LC_ALL", "C.UTF-8")])).is_empty());
        assert!(utf8_locale_overrides(env(&[("LC_CTYPE", "de_DE.utf8")])).is_empty());
    }

    #[test]
    fn injects_utf8_when_locale_is_non_utf8() {
        assert!(!utf8_locale_overrides(env(&[("LANG", "C")])).is_empty());
        assert!(!utf8_locale_overrides(env(&[("LC_ALL", "POSIX")])).is_empty());
    }
}
