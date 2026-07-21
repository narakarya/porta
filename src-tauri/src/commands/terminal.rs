use std::collections::{HashMap, VecDeque};
use std::os::unix::io::RawFd;
use std::sync::{Mutex, OnceLock};
use std::thread;
use tauri::Emitter;

/// Most recent output retained per session, replayed when a UI reattaches.
/// Roughly a full screen of dense scrollback; bounds memory across sessions.
pub const BACKLOG_CAP: usize = 256 * 1024;

pub(super) struct TerminalHandle {
    pub master_fd: RawFd,
    pub child_pid: u32,
    /// Rolling tail of everything the shell has written.
    pub backlog: VecDeque<u8>,
    /// `Some(code)` once the shell exits. The handle is deliberately kept so a
    /// later reattach can still replay the final screen; only `terminal_close`
    /// removes it.
    pub exit_code: Option<i32>,
}

/// What a UI gets when it opens a session id: either a freshly spawned shell
/// (empty backlog) or the retained output of one that was already running.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAttach {
    pub spawned: bool,
    pub backlog: Vec<u8>,
}

pub(super) fn terminals() -> &'static Mutex<HashMap<String, TerminalHandle>> {
    static T: OnceLock<Mutex<HashMap<String, TerminalHandle>>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Append `chunk`, dropping from the front so the buffer never exceeds
/// `BACKLOG_CAP`.
fn push_backlog(buf: &mut VecDeque<u8>, chunk: &[u8]) {
    if chunk.len() >= BACKLOG_CAP {
        buf.clear();
        buf.extend(&chunk[chunk.len() - BACKLOG_CAP..]);
        return;
    }
    let overflow = (buf.len() + chunk.len()).saturating_sub(BACKLOG_CAP);
    buf.drain(..overflow);
    buf.extend(chunk);
}

/// Snapshot an existing session's backlog, or `None` if the id is unknown.
fn attach_existing(map: &HashMap<String, TerminalHandle>, id: &str) -> Option<TerminalAttach> {
    map.get(id).map(|h| TerminalAttach {
        spawned: false,
        backlog: h.backlog.iter().copied().collect(),
    })
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
) -> Result<TerminalAttach, String> {
    use std::os::unix::io::FromRawFd;
    use std::os::unix::process::CommandExt;

    // Reattach rather than respawn. This is what lets the UI unmount freely:
    // navigating away disposes the xterm, coming back replays the buffer.
    // Bound the guard to a local so the lock is released before we spawn.
    let existing = {
        let map = terminals().lock().unwrap();
        attach_existing(&map, &app_id)
    };
    if let Some(attach) = existing {
        return Ok(attach);
    }

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

    terminals().lock().unwrap().insert(
        app_id.clone(),
        TerminalHandle {
            master_fd,
            child_pid,
            backlog: VecDeque::new(),
            exit_code: None,
        },
    );

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
            let chunk = &buf[..n as usize];
            // Hold the map lock across append + emit so `terminal_open`'s
            // snapshot can't interleave and duplicate (or drop) a chunk.
            let mut map = terminals().lock().unwrap();
            if let Some(h) = map.get_mut(&id_clone) {
                push_backlog(&mut h.backlog, chunk);
            }
            app_clone.emit(&format!("terminal:data:{}", id_clone), chunk.to_vec()).ok();
            drop(map);
        }
        unsafe { libc::close(master_fd); }
        app_clone.emit(&format!("terminal:exit:{}", id_clone), ()).ok();
    });

    Ok(TerminalAttach { spawned: true, backlog: Vec::new() })
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
    use super::{attach_existing, push_backlog, utf8_locale_overrides, TerminalHandle, BACKLOG_CAP};
    use std::collections::{HashMap, VecDeque};

    fn handle(backlog: &[u8], exit_code: Option<i32>) -> TerminalHandle {
        TerminalHandle {
            master_fd: -1,
            child_pid: 0,
            backlog: backlog.iter().copied().collect(),
            exit_code,
        }
    }

    #[test]
    fn backlog_keeps_recent_bytes_under_the_cap() {
        let mut buf = VecDeque::new();
        push_backlog(&mut buf, b"hello ");
        push_backlog(&mut buf, b"world");
        assert_eq!(buf.iter().copied().collect::<Vec<u8>>(), b"hello world");
    }

    #[test]
    fn backlog_drops_from_the_front_once_full() {
        let mut buf = VecDeque::new();
        push_backlog(&mut buf, &vec![b'a'; BACKLOG_CAP]);
        push_backlog(&mut buf, b"tail");
        assert_eq!(buf.len(), BACKLOG_CAP);
        let tail: Vec<u8> = buf.iter().rev().take(4).rev().copied().collect();
        assert_eq!(tail, b"tail");
    }

    #[test]
    fn backlog_handles_a_chunk_larger_than_the_cap() {
        let mut buf = VecDeque::new();
        let huge = vec![b'x'; BACKLOG_CAP + 512];
        push_backlog(&mut buf, &huge);
        assert_eq!(buf.len(), BACKLOG_CAP);
    }

    #[test]
    fn attaching_to_a_live_session_replays_without_spawning() {
        let mut map = HashMap::new();
        map.insert("pane-1".to_string(), handle(b"prompt$ ", None));

        let attach = attach_existing(&map, "pane-1").expect("live session attaches");
        assert!(!attach.spawned);
        assert_eq!(attach.backlog, b"prompt$ ");
    }

    #[test]
    fn attaching_to_an_exited_session_still_replays_its_last_screen() {
        let mut map = HashMap::new();
        map.insert("pane-1".to_string(), handle(b"boom\n", Some(1)));

        let attach = attach_existing(&map, "pane-1").expect("exited session attaches");
        assert!(!attach.spawned);
        assert_eq!(attach.backlog, b"boom\n");
    }

    #[test]
    fn attaching_to_an_unknown_session_asks_for_a_spawn() {
        let map = HashMap::new();
        assert!(attach_existing(&map, "pane-1").is_none());
    }

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
