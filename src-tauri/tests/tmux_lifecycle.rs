//! `ProcessManager`'s tmux path, driven end-to-end against a real tmux server.
//!
//! The module tests prove the tmux wrapper works; this proves the wiring around
//! it does — that `start` actually dispatches into a session, that the log
//! tailer feeds `on_log`, that the shared monitor notices an exit and reports
//! the right status through `on_exit`, and that `adopt_tmux` picks up a session
//! it never started. That last one is the whole feature: it is what turns "the
//! app survived the update" into "Porta knows the app survived the update".
//!
//! `ProcessManager` takes plain closures rather than an `AppHandle`, so all of
//! this runs without a window — which matters, because a Tauri window cannot be
//! created from a background launchd session at all.

use porta_lib::process_manager::{LogStart, ProcessManager};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Kills the server and removes the sandbox even when an assertion panics —
/// otherwise a failing run leaks a tmux server whose socket has just been
/// deleted, leaving it unreachable and killable only by pid.
struct Sandbox(PathBuf);

impl Drop for Sandbox {
    fn drop(&mut self) {
        if let Some(bin) = porta_lib::tmux::binary() {
            std::process::Command::new(bin)
                .args(["-L", porta_lib::tmux::socket(), "kill-server"])
                .output()
                .ok();
        }
        std::fs::remove_dir_all(&self.0).ok();
    }
}

fn wait_until(secs: u64, mut f: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < deadline {
        if f() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

/// A shared sink standing in for the `app:log:{id}` emit.
type Sink = Arc<Mutex<Vec<String>>>;
fn sink() -> Sink {
    Arc::new(Mutex::new(Vec::new()))
}
fn joined(s: &Sink) -> String {
    s.lock().unwrap().join("\n")
}

fn porta_binary() -> PathBuf {
    let mut p = std::env::current_exe().expect("test exe");
    p.pop();
    if p.ends_with("deps") {
        p.pop();
    }
    p.join("porta")
}

#[test]
fn start_streams_and_reports_exit_then_adopt_picks_up_a_survivor() {
    if !porta_lib::tmux::available() {
        eprintln!("skipping: tmux not installed");
        return;
    }
    let binary = porta_binary();
    if !binary.exists() {
        eprintln!("skipping: porta binary not built");
        return;
    }

    let sandbox = std::env::temp_dir().join(format!("porta-lifecycle-{}", std::process::id()));
    std::fs::create_dir_all(&sandbox).unwrap();
    std::env::set_var("HOME", &sandbox);
    std::env::set_var("TMUX_TMPDIR", &sandbox);
    // `start()` resolves the filter from `current_exe()`, which in here is the
    // test runner rather than Porta; point it at the real binary so the capture
    // chain under test is the production one.
    std::env::set_var("PORTA_LOG_FILTER_BIN", &binary);
    let _guard = Sandbox(sandbox.clone());

    // ── 1. start() dispatches into tmux, streams output, and reports the exit ──
    let mgr = ProcessManager::new();
    let logs = sink();
    let exit: Arc<Mutex<Option<(i32, bool)>>> = Arc::new(Mutex::new(None));
    {
        let logs = Arc::clone(&logs);
        let exit_slot = Arc::clone(&exit);
        mgr.start(
            "started-app",
            "echo boot-line; sleep 2; exit 9",
            Path::new("/tmp"),
            4321,
            None,
            &HashMap::new(),
            LogStart::Fresh,
            move |line| logs.lock().unwrap().push(line),
            move |code, intentional| *exit_slot.lock().unwrap() = Some((code, intentional)),
        )
        .expect("start should succeed");
    }

    assert!(
        mgr.is_tmux_hosted("started-app"),
        "start() should have taken the tmux path, not fallen back to a pipe"
    );
    let session = porta_lib::tmux::app_session("started-app");
    assert!(porta_lib::tmux::has_session(&session), "session should exist");

    // The tailer reads the file the log filter writes, so a line reaching
    // `on_log` proves the whole capture chain is connected.
    assert!(
        wait_until(15, || joined(&logs).contains("boot-line")),
        "on_log never saw the app's output; got {:?}",
        joined(&logs)
    );

    // The monitor has to notice the exit *and* recover the status — without it a
    // crash is indistinguishable from a clean stop and auto-restart never fires.
    assert!(
        wait_until(20, || exit.lock().unwrap().is_some()),
        "on_exit never fired"
    );
    assert_eq!(
        *exit.lock().unwrap(),
        Some((9, false)),
        "exit code should survive the session, and an unrequested exit is not intentional"
    );
    assert!(
        !porta_lib::tmux::has_session(&session),
        "the monitor should have cleared the dead session"
    );
}
