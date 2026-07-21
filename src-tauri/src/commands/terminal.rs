use std::collections::{HashMap, VecDeque};
use std::os::unix::io::RawFd;
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use tauri::Emitter;

/// Most recent output retained per session, replayed when a UI reattaches.
/// Roughly a full screen of dense scrollback; bounds memory across sessions.
pub const BACKLOG_CAP: usize = 256 * 1024;

/// One session's state, behind two *independent* locks rather than one:
///
/// - `fd` guards the PTY master descriptor and every syscall that touches
///   it — `write`, the resize `ioctl`, `tcgetpgrp`, and taking+closing it.
/// - `backlog` guards the retained output and makes one reader-thread
///   chunk's append-then-emit atomic with respect to a `terminal_open`
///   reattach's snapshot (see the reader thread below).
///
/// No code path ever holds both at once, and neither is ever held across a
/// syscall while the *global* session map's lock is also held (see
/// `terminals()`). That combination is what breaks a deadlock this session
/// design used to be able to reach: `terminal_write` blocked inside a
/// blocking `write()` while holding a lock the reader thread also needed
/// (in the old single-mutex design, that was the map lock the reader thread
/// took to append output) could stall that reader thread — which stalls the
/// shell, which is what was blocking `write()` in the first place. Splitting
/// the fd's lock from the backlog's lock, and never holding either across
/// the *other* concern's work, means a write in flight for a session can
/// never be waited on by that same session's own reader thread, let alone
/// any other session's.
pub(super) struct TerminalHandle {
    pub fd: Mutex<RawFd>,
    pub child_pid: u32,
    /// Rolling tail of everything the shell has written.
    pub backlog: Mutex<VecDeque<u8>>,
    /// `Some(code)` once the shell exits. The handle is deliberately kept so a
    /// later reattach can still replay the final screen; only `terminal_close`
    /// removes it.
    pub exit_code: Mutex<Option<i32>>,
}

/// What a UI gets when it opens a session id: either a freshly spawned shell
/// (empty backlog) or the retained output of one that was already running.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAttach {
    pub spawned: bool,
    pub backlog: Vec<u8>,
}

/// The session map's own lock protects only the map's shape (insert/remove/
/// lookup) — never a syscall. Every command below holds it just long enough
/// to clone an `Arc<TerminalHandle>` out (or insert/remove one), then drops
/// it before doing anything that can block, so one session's slow syscall
/// never makes another session's `terminal_open`/`terminal_write`/
/// `terminal_close` wait on this lock.
pub(super) fn terminals() -> &'static Mutex<HashMap<String, Arc<TerminalHandle>>> {
    static T: OnceLock<Mutex<HashMap<String, Arc<TerminalHandle>>>> = OnceLock::new();
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

/// Map a raw `waitpid` status to the code a shell would report: the exit
/// status for a normal exit, `128 + signal` for a signalled death.
fn exit_code_from_status(status: libc::c_int) -> i32 {
    if status & 0x7f == 0 {
        (status >> 8) & 0xff
    } else {
        128 + (status & 0x7f)
    }
}

/// A session whose reader thread has closed the PTY has no usable
/// descriptor; write/resize must not touch the recycled number.
fn is_writable(fd: RawFd) -> bool {
    fd >= 0
}

/// Take the descriptor out of its slot, replacing it with the closed
/// sentinel (`-1`). The caller now owns the returned fd and is responsible
/// for closing it — after releasing the fd lock, so a blocking close can't
/// hold up another operation on this same session (or, since this is a
/// per-handle lock, any other session at all). Idempotent: calling this on
/// an already-retired slot just returns `-1` again.
fn take_fd(fd_slot: &mut RawFd) -> RawFd {
    std::mem::replace(fd_slot, -1)
}

/// Record the shell's exit code. Callers must retire the descriptor first
/// (via `take_fd`) — this never touches the fd.
fn record_exit(exit_code_slot: &mut Option<i32>, code: i32) {
    *exit_code_slot = Some(code);
}

/// Snapshot a session's retained output for a view that is (re)attaching.
///
/// The `backlog` lock this takes (see the reader thread below) guarantees
/// this snapshot can't observe a *torn* chunk — one whose append and emit are
/// still mid-flight — but it does **not** guarantee a chunk appears in only
/// one of {this snapshot, a live `terminal:data` event}. The frontend
/// registers its listener before calling `terminal_open`, so a chunk whose
/// append+emit critical section completes in the window between that
/// registration and this snapshot is both delivered live (and queued in JS,
/// since the backlog hasn't been consumed yet) *and* included here. Known
/// limitation: a reattach can replay a few of the shell's most recent bytes
/// twice. Nothing here corrupts state or drops output — the cost is purely
/// cosmetic duplicate lines — so it's left as is rather than adding a
/// sequence-number scheme to close it.
fn attach_existing(h: &TerminalHandle) -> TerminalAttach {
    TerminalAttach {
        spawned: false,
        backlog: h.backlog.lock().unwrap().iter().copied().collect(),
    }
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
    // Clone the Arc out and drop the map lock immediately — everything below
    // (the resize ioctl, the backlog snapshot) touches only this session's
    // own locks, never the map's, so another session's `terminal_open` never
    // waits on this one.
    let existing = {
        let map = terminals().lock().unwrap();
        map.get(&app_id).cloned()
    };
    if let Some(h) = existing {
        // The reattaching view usually has different dimensions than the one
        // that left; push the new size to the still-live PTY. A no-op for an
        // exited session, whose fd is invalidated. Held under `fd`'s own
        // lock — not the map's — for the duration of the ioctl.
        let fd = h.fd.lock().unwrap();
        if is_writable(*fd) {
            let ws = libc::winsize { ws_row: rows, ws_col: cols, ws_xpixel: 0, ws_ypixel: 0 };
            unsafe { libc::ioctl(*fd, libc::TIOCSWINSZ, &ws); }
        }
        drop(fd);
        return Ok(attach_existing(&h));
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

    let handle = Arc::new(TerminalHandle {
        fd: Mutex::new(master_fd),
        child_pid,
        backlog: Mutex::new(VecDeque::new()),
        exit_code: Mutex::new(None),
    });
    terminals().lock().unwrap().insert(app_id.clone(), Arc::clone(&handle));

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

    // Stream PTY output to frontend as raw bytes (UTF-8 best-effort). Holds
    // its own Arc clone rather than looking the session up in the map each
    // chunk: it never needs the map at all (a session removed mid-stream by
    // `terminal_close` is still safe to keep appending/emitting into — the
    // handle stays alive via this Arc until the thread drops it below), and
    // — more importantly — never touches the map's lock, so this thread can
    // never be made to wait on another session's `terminal_open`/
    // `terminal_write`/`terminal_close`, or vice versa.
    let app_clone = app.clone();
    let id_clone  = app_id.clone();
    let handle_for_reader = Arc::clone(&handle);
    thread::spawn(move || {
        let mut buf = vec![0u8; 4096];
        loop {
            let n = unsafe {
                libc::read(master_fd, buf.as_mut_ptr() as *mut libc::c_void, buf.len())
            };
            if n <= 0 { break; }
            let chunk = &buf[..n as usize];
            // Hold the backlog lock across append + emit so a `terminal_open`
            // reattach's snapshot (also taken under this same lock, see
            // `attach_existing`) can't land *in the middle* of this chunk's
            // append+emit and see a torn/inconsistent version of it — the
            // snapshot either fully includes this chunk or fully doesn't.
            // That is weaker than "never both": it does not prevent this
            // chunk from landing in *both* the snapshot and a live event a
            // frontend listener already registered before `terminal_open` was
            // called receives — see the comment on `attach_existing` for that
            // known (cosmetic, duplicate-replay-only) limitation. Deliberately
            // *not* the map lock — this is a
            // per-session lock, so one session's `emit` (a JSON
            // serialization + IPC hop) never serializes against another
            // session's reader thread, and never against `terminal_write`'s
            // blocking write on *any* session (that uses `fd`, a completely
            // separate lock — see the comment on `TerminalHandle`).
            let mut backlog = handle_for_reader.backlog.lock().unwrap();
            push_backlog(&mut backlog, chunk);
            app_clone.emit(&format!("terminal:data:{}", id_clone), chunk.to_vec()).ok();
            drop(backlog);
        }

        // Single owner of the fd: whoever takes it out is the one that
        // closes it. Publish the `-1` sentinel *before* the descriptor
        // number is freed, so `is_writable` can never advertise a number the
        // kernel has already reused — closing it first and marking `-1`
        // after (a previous approach) left exactly that gap open for the
        // whole duration of the blocking `waitpid` below. `take_fd` is
        // idempotent, so it doesn't matter whether this thread or
        // `terminal_close` gets here first — whichever does takes the real
        // fd, the other gets `-1` and has nothing left to close.
        let taken_fd = take_fd(&mut handle_for_reader.fd.lock().unwrap());
        if taken_fd >= 0 {
            unsafe { libc::close(taken_fd); }
        }

        let mut status: libc::c_int = 0;
        let code = unsafe {
            if libc::waitpid(child_pid as i32, &mut status, 0) > 0 {
                exit_code_from_status(status)
            } else {
                // ECHILD (already reaped elsewhere) or EINTR (not retried
                // here) both fall through to 0 — indistinguishable from a
                // genuinely clean exit. Known limitation: the frontend
                // contract expects *a* code either way, so this can't
                // surface as an error, only as a possibly-wrong 0.
                0
            }
        };

        // Keep the handle: its backlog is the shell's final screen, and the
        // UI shows an `exited` tab until the user closes or restarts it.
        // Recording this even if `terminal_close` already removed the
        // session from the map is harmless — this Arc keeps the handle
        // alive regardless, and nothing reads it once it's unreachable from
        // the map.
        record_exit(&mut handle_for_reader.exit_code.lock().unwrap(), code);
        app_clone
            .emit(&format!("terminal:exit:{}", id_clone), serde_json::json!({ "code": code }))
            .ok();
    });

    Ok(TerminalAttach { spawned: true, backlog: Vec::new() })
}

/// Write bytes from the frontend keyboard input into the PTY master.
///
/// Clones the session's `Arc` out and drops the map lock *before* the
/// (potentially blocking — the slave's input queue can fill up while the
/// shell is busy producing output) `write` syscall. Holding the map lock
/// across that write is what used to let this deadlock with the reader
/// thread: this call blocked in `write()` while holding a lock the reader
/// thread needed to append output, the reader thread's stall then blocked
/// the shell from ever draining its input queue, and nothing moved again.
/// `fd`'s lock is per-session and is never taken by the reader thread at
/// all, so a write in flight here can now only ever block *this session's*
/// own resize/close, never its own (or any other session's) output stream.
#[tauri::command]
pub fn terminal_write(app_id: String, data: Vec<u8>) -> Result<(), String> {
    let handle = {
        let map = terminals().lock().unwrap();
        map.get(&app_id).cloned()
    };
    let Some(h) = handle else { return Ok(()) };
    let fd = h.fd.lock().unwrap();
    if is_writable(*fd) {
        unsafe {
            libc::write(*fd, data.as_ptr() as *const libc::c_void, data.len());
        }
    }
    Ok(())
}

/// Resize the terminal PTY (called when the xterm.js viewport changes).
#[tauri::command]
pub fn terminal_resize(app_id: String, rows: u16, cols: u16) -> Result<(), String> {
    let handle = {
        let map = terminals().lock().unwrap();
        map.get(&app_id).cloned()
    };
    let Some(h) = handle else { return Ok(()) };
    let fd = h.fd.lock().unwrap();
    if is_writable(*fd) {
        let ws = libc::winsize { ws_row: rows, ws_col: cols, ws_xpixel: 0, ws_ypixel: 0 };
        unsafe { libc::ioctl(*fd, libc::TIOCSWINSZ, &ws); }
    }
    Ok(())
}

/// Live state of one session, as the status bar renders it.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalState {
    pub alive: bool,
    pub running: bool,
    pub pid: u32,
    pub exit_code: Option<i32>,
}

/// A foreground pgid that isn't the shell's own means a command is running in
/// front of the prompt. `-1` means the fd is unreadable — treat as idle rather
/// than inventing activity.
fn session_state(h: &TerminalHandle, fg_pgid: i32) -> TerminalState {
    let exit_code = *h.exit_code.lock().unwrap();
    let alive = exit_code.is_none();
    TerminalState {
        alive,
        running: alive && fg_pgid > 0 && fg_pgid != h.child_pid as i32,
        pid: h.child_pid,
        exit_code,
    }
}

/// Poll one session's liveness. Drives the status bar and the
/// "something is still running" confirmation before a tab closes.
#[tauri::command]
pub fn terminal_state(app_id: String) -> Result<TerminalState, String> {
    let handle = {
        let map = terminals().lock().unwrap();
        map.get(&app_id).cloned()
    };
    let h = handle.ok_or("no such terminal session")?;
    // Guard on the descriptor, not `exit_code`, so this stays consistent with
    // `terminal_write`/`terminal_resize`: an exited session has its fd
    // retired to -1, and tcgetpgrp on a recycled number would be meaningless.
    let fd = h.fd.lock().unwrap();
    let fg_pgid = if is_writable(*fd) {
        unsafe { libc::tcgetpgrp(*fd) }
    } else {
        -1
    };
    drop(fd);
    Ok(session_state(&h, fg_pgid))
}

/// Close (and kill) a terminal session. The only path that removes a session —
/// called from closing a tab, closing a pane, or deleting the app.
///
/// `remove` drops this session out of the map immediately (a fast,
/// non-blocking op), so it never makes another session's `terminal_open`/
/// `terminal_write`/`terminal_close` wait on this one. Everything after
/// that — the signals, the `take_fd`+close — runs against the removed Arc
/// directly, racing only the reader thread's own EOF-triggered `take_fd`
/// (see the comment there for why that race is safe: `take_fd` is
/// idempotent and whichever of the two gets here first owns the real fd).
#[tauri::command]
pub fn terminal_close(app_id: String) -> Result<(), String> {
    let handle = terminals().lock().unwrap().remove(&app_id);
    if let Some(h) = handle {
        let alive = h.exit_code.lock().unwrap().is_none();
        if alive {
            unsafe {
                libc::kill(h.child_pid as i32, libc::SIGHUP);
                libc::kill(h.child_pid as i32, libc::SIGTERM);
            }
        }
        // An exited session's fd was already taken (and closed) by its
        // reader thread, leaving -1 here; only close a fd we actually own.
        let fd = take_fd(&mut h.fd.lock().unwrap());
        if fd >= 0 {
            unsafe { libc::close(fd); }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        attach_existing, exit_code_from_status, is_writable, push_backlog, record_exit,
        session_state, take_fd, utf8_locale_overrides, TerminalHandle, BACKLOG_CAP,
    };
    use std::collections::{HashMap, VecDeque};
    use std::sync::Mutex;

    fn handle(backlog: &[u8], exit_code: Option<i32>) -> TerminalHandle {
        TerminalHandle {
            fd: Mutex::new(-1),
            child_pid: 0,
            backlog: Mutex::new(backlog.iter().copied().collect()),
            exit_code: Mutex::new(exit_code),
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
        let h = handle(b"prompt$ ", None);

        let attach = attach_existing(&h);
        assert!(!attach.spawned);
        assert_eq!(attach.backlog, b"prompt$ ");
    }

    #[test]
    fn attaching_to_an_exited_session_still_replays_its_last_screen() {
        let h = handle(b"boom\n", Some(1));

        let attach = attach_existing(&h);
        assert!(!attach.spawned);
        assert_eq!(attach.backlog, b"boom\n");
    }

    // No test for "unknown session id" against `attach_existing`: that case
    // never reaches the helper. `terminal_open` handles it via
    // `map.get(&app_id)` returning `None`, which is `HashMap::get`'s own
    // documented behavior, not logic this file owns. A test here would only
    // restate the standard library's contract.

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

    #[test]
    fn normal_exit_reports_its_status_code() {
        // WIFEXITED with WEXITSTATUS == 0 → clean exit.
        assert_eq!(exit_code_from_status(0x0000), 0);
        // WEXITSTATUS == 1 lives in the high byte.
        assert_eq!(exit_code_from_status(0x0100), 1);
        assert_eq!(exit_code_from_status(0x7f00), 127);
    }

    #[test]
    fn a_signalled_shell_reports_the_shell_convention_code() {
        // Low 7 bits carry the signal; SIGKILL (9) → 128 + 9.
        assert_eq!(exit_code_from_status(9), 137);
        // SIGHUP (1) — what terminal_close sends.
        assert_eq!(exit_code_from_status(1), 129);
    }

    #[test]
    fn take_fd_retires_the_descriptor_but_keeps_the_rest() {
        // Simulates a still-live handle at the moment the reader thread's
        // read loop exits: real fd, no exit code yet.
        let h = handle(b"final output", None);
        *h.fd.lock().unwrap() = 42;

        let taken = take_fd(&mut h.fd.lock().unwrap());

        // The old fd comes back so a caller that still owns it can close it
        // — leaving the number in the slot would let a later write land
        // in whatever the kernel reused it for.
        assert_eq!(taken, 42);
        assert!(*h.fd.lock().unwrap() < 0);
        // Untouched: `take_fd` only ever mutates the fd slot it's handed.
        assert_eq!(*h.exit_code.lock().unwrap(), None);
        assert_eq!(
            *h.backlog.lock().unwrap(),
            b"final output".iter().copied().collect::<VecDeque<u8>>()
        );
    }

    #[test]
    fn take_fd_is_idempotent_when_the_fd_is_already_gone() {
        // The production reader thread and `terminal_close` can both reach
        // `take_fd` for the same session (that race is exactly what the
        // per-handle `fd` lock exists to serialize) — whichever gets there
        // first owns the real fd, and this pins that the loser's repeat call
        // is still safe.
        let mut fd = -1;
        assert_eq!(take_fd(&mut fd), -1);
        assert_eq!(fd, -1);
    }

    #[test]
    fn record_exit_sets_the_code_without_touching_the_descriptor() {
        // Production always calls this after `take_fd` has already retired
        // the descriptor; the fd should be left untouched here.
        let h = handle(b"final output", None);
        *h.fd.lock().unwrap() = -1;

        record_exit(&mut h.exit_code.lock().unwrap(), 1);

        assert_eq!(*h.exit_code.lock().unwrap(), Some(1));
        assert_eq!(*h.fd.lock().unwrap(), -1);
        assert_eq!(
            *h.backlog.lock().unwrap(),
            b"final output".iter().copied().collect::<VecDeque<u8>>()
        );
    }

    #[test]
    fn a_live_session_is_writable_and_a_closed_one_is_not() {
        assert!(is_writable(7));
        assert!(!is_writable(-1));
    }

    #[test]
    fn a_foreground_process_other_than_the_shell_reads_as_running() {
        let h = handle(b"", None);
        // child_pid is 0 in the fixture; a different foreground pgid means
        // something is running in front of the prompt.
        let state = session_state(&h, 4242);
        assert!(state.alive);
        assert!(state.running);
        assert_eq!(state.exit_code, None);
    }

    #[test]
    fn a_shell_at_its_own_prompt_reads_as_idle() {
        // PIDs must be nonzero to exercise the comparison fg_pgid != h.child_pid,
        // which is the production case: a shell sitting at its prompt has the
        // same foreground process group as its own pid.
        let mut h = handle(b"", None);
        h.child_pid = 4242;

        let state = session_state(&h, 4242);

        assert!(state.alive);
        assert!(!state.running);
        assert_eq!(state.pid, 4242);
    }

    #[test]
    fn an_exited_session_is_neither_alive_nor_running() {
        let h = handle(b"", Some(1));
        let state = session_state(&h, 4242);
        assert!(!state.alive);
        assert!(!state.running);
        assert_eq!(state.exit_code, Some(1));
    }

    #[test]
    fn an_unreadable_foreground_pgid_reads_as_idle() {
        // tcgetpgrp returns -1 when the fd is gone; don't report phantom work.
        let h = handle(b"", None);
        assert!(!session_state(&h, -1).running);
    }

    // Finding 2 (CRITICAL): the reader thread's append and the fd-using
    // commands (`terminal_write`/`terminal_resize`/close) used to share one
    // global map mutex. `terminal_write` could genuinely block inside its
    // `write` syscall while holding that mutex — the PTY's input queue fills
    // up when the shell is busy producing output — which starved the reader
    // thread of the very lock it needed to drain that output, which is
    // exactly what was keeping the shell too busy to read its input. Nobody
    // moves again: the whole session (and, since it was one global lock,
    // every other session's `terminal_open`/`terminal_write`/`terminal_state`
    // too) hangs. `fd` and `backlog` are separate per-handle locks
    // specifically so that cycle can no longer form: this test pins that a
    // thread blocked holding `fd` never makes a concurrent `backlog` access
    // wait on it.
    #[test]
    fn fd_operations_never_wait_on_the_backlog_lock() {
        use std::sync::{Arc, Barrier};
        use std::thread;
        use std::time::{Duration, Instant};

        let h = Arc::new(TerminalHandle {
            fd: Mutex::new(-1),
            child_pid: 0,
            backlog: Mutex::new(VecDeque::new()),
            exit_code: Mutex::new(None),
        });

        // Simulate `terminal_write` parked deep inside a slow `write` by
        // holding the fd lock for a while.
        let barrier = Arc::new(Barrier::new(2));
        let h_writer = Arc::clone(&h);
        let barrier_writer = Arc::clone(&barrier);
        let writer = thread::spawn(move || {
            let _fd_guard = h_writer.fd.lock().unwrap();
            barrier_writer.wait();
            thread::sleep(Duration::from_millis(250));
        });
        barrier.wait();

        // A reader-thread-style append (which only ever touches `backlog`)
        // must complete promptly regardless of the fd being held elsewhere.
        let started = Instant::now();
        {
            let mut backlog = h.backlog.lock().unwrap();
            push_backlog(&mut backlog, b"chunk");
        }
        let elapsed = started.elapsed();

        writer.join().unwrap();

        assert!(
            elapsed < Duration::from_millis(100),
            "backlog append waited {elapsed:?} on a lock a blocked fd write was \
             holding — the two must be independent, or this reproduces the deadlock",
        );
    }

    // Companion to the test above: the two locks being independent must not
    // come at the cost of the *torn-read* guarantee `terminal_open`'s
    // reattach snapshot depends on. `attach_existing` takes the *same*
    // `backlog` lock the reader thread's append-then-emit critical section
    // holds, so a snapshot running concurrently with an append must still
    // serialize against it rather than interleave — it sees either all of a
    // given chunk or none of it, never a half-appended one.
    //
    // This is *not* a claim that a chunk never appears in both the snapshot
    // and a live event — it can, since the frontend registers its listener
    // before calling `terminal_open`: a chunk whose critical section
    // completes between that registration and this snapshot is delivered
    // live *and* included here. See the comment on `attach_existing` for
    // that known, cosmetic (duplicate-replay-only) limitation, which this
    // lock does not and was never meant to close.
    #[test]
    fn a_backlog_snapshot_serializes_against_a_concurrent_append() {
        use std::sync::{Arc, Barrier};
        use std::thread;
        use std::time::{Duration, Instant};

        let h = Arc::new(TerminalHandle {
            fd: Mutex::new(-1),
            child_pid: 0,
            backlog: Mutex::new(VecDeque::new()),
            exit_code: Mutex::new(None),
        });

        let barrier = Arc::new(Barrier::new(2));
        let h_appender = Arc::clone(&h);
        let barrier_appender = Arc::clone(&barrier);
        let appender = thread::spawn(move || {
            let mut backlog = h_appender.backlog.lock().unwrap();
            barrier_appender.wait();
            thread::sleep(Duration::from_millis(200));
            push_backlog(&mut backlog, b"chunk");
        });
        barrier.wait();

        let started = Instant::now();
        let snapshot = attach_existing(&h);
        let elapsed = started.elapsed();

        appender.join().unwrap();

        // The snapshot had to wait out the append's critical section, so it
        // deterministically sees either all of "chunk" or none of it — never
        // a torn read, and never a version some *other* concurrent reader
        // wouldn't also have seen.
        assert!(elapsed >= Duration::from_millis(150));
        assert!(snapshot.backlog.is_empty() || snapshot.backlog == b"chunk");
    }
}
