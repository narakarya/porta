//! `ProcessManager::adopt_tmux` against a session it never started.
//!
//! This is the whole feature: it turns "the app survived the update" into
//! "Porta knows the app survived the update". The session here is built exactly
//! the way `start_tmux_session` builds one, standing in for what a previous
//! Porta run left behind.
//!
//! Its own test binary, deliberately. Run in the same process as the start
//! test, the monitor threads and tmux server that test leaves mid-teardown
//! race this one's fresh session — which is a property of cargo's threaded
//! runner, not of the code under test.
//!
//! `ProcessManager` takes plain closures rather than an `AppHandle`, so all of
//! this runs without a window — which matters, because a Tauri window cannot be
//! created from a background launchd session at all.

use porta_lib::process_manager::ProcessManager;
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
fn adopt_picks_up_a_survivor_and_manages_it_again() {
    if !porta_lib::tmux::available() {
        eprintln!("skipping: tmux not installed");
        return;
    }
    let binary = porta_binary();
    if !binary.exists() {
        eprintln!("skipping: porta binary not built");
        return;
    }
    let sandbox = std::env::temp_dir().join(format!("porta-adopt-{}", std::process::id()));
    std::fs::create_dir_all(&sandbox).unwrap();
    std::env::set_var("HOME", &sandbox);
    std::env::set_var("TMUX_TMPDIR", &sandbox);
    std::env::set_var("PORTA_LOG_FILTER_BIN", &binary);
    let _guard = Sandbox(sandbox.clone());

    // Built exactly the way `start_tmux_session` builds one, which is what a
    // previous Porta run would have left behind.
    let app_id = "survivor-app";
    let survivor = porta_lib::tmux::app_session(app_id);
    let log_path = porta_lib::process_manager::log_file_path(app_id);
    std::fs::create_dir_all(log_path.parent().unwrap()).unwrap();
    std::fs::write(&log_path, "").unwrap();
    let pane = porta_lib::tmux::start_detached(
        &survivor,
        Path::new("/tmp"),
        "/bin/sh",
        "sleep 1; echo after-adoption; sleep 20",
        &[],
        Some(&porta_lib::tmux::filter_target(&binary, app_id)),
    )
    .expect("survivor session should start");

    let mgr2 = ProcessManager::new();
    let logs2 = sink();
    let exit2: Arc<Mutex<Option<(i32, bool)>>> = Arc::new(Mutex::new(None));
    let adopted = {
        let logs2 = Arc::clone(&logs2);
        let exit_slot = Arc::clone(&exit2);
        mgr2.adopt_tmux(
            app_id,
            move |line| logs2.lock().unwrap().push(line),
            move |code, intentional| *exit_slot.lock().unwrap() = Some((code, intentional)),
        )
    };
    assert_eq!(
        adopted,
        Some(pane.pid),
        "adoption should report the PID the surviving session is actually running"
    );
    assert!(mgr2.is_tmux_hosted(app_id));

    // Output produced *after* adoption must reach the new manager, or a
    // re-adopted app would show as running with a log frozen at the restart.
    assert!(
        wait_until(15, || joined(&logs2).contains("after-adoption")),
        "adopted app's later output never streamed; got {:?}",
        joined(&logs2)
    );

    // And the adopted app is fully managed again — stopping it works and is
    // reported as intentional, so no crash notification or auto-restart fires.
    mgr2.stop_and_wait(app_id, 5000).expect("stop should succeed");
    assert!(
        wait_until(20, || exit2.lock().unwrap().is_some()),
        "adopted app's exit was never reported"
    );
    assert!(
        exit2.lock().unwrap().unwrap().1,
        "a stop the user asked for must be reported as intentional"
    );

    // Nothing left behind for the next launch to adopt by mistake.
    assert!(!porta_lib::tmux::has_session(&survivor));
}
