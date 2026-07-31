//! Regression tests for the tmux monitor's failure semantics.
//!
//! Two behaviours here bit in production. `panes()` used to report a failed
//! query as an empty listing, and one transient failure made the monitor
//! declare every hosted app dead and kill their live sessions. And replacing a
//! session (`start` over an existing run) fired `kill-session` — which only
//! *delivers* SIGHUP — and immediately booted the successor, racing the dying
//! process for its own port.

use porta_lib::process_manager::{LogStart, ProcessManager};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

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

fn porta_binary() -> PathBuf {
    let mut p = std::env::current_exe().expect("test exe");
    p.pop();
    if p.ends_with("deps") {
        p.pop();
    }
    p.join("porta")
}

fn alive(pid: u32) -> bool {
    nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid as i32), None).is_ok()
}

#[test]
fn no_server_is_empty_a_fresh_start_survives_ticks_and_replace_waits_for_death() {
    if !porta_lib::tmux::available() {
        eprintln!("skipping: tmux not installed");
        return;
    }
    let binary = porta_binary();
    if !binary.exists() {
        eprintln!("skipping: porta binary not built");
        return;
    }

    let sandbox = std::env::temp_dir().join(format!("porta-monitor-{}", std::process::id()));
    std::fs::create_dir_all(&sandbox).unwrap();
    std::env::set_var("HOME", &sandbox);
    std::env::set_var("TMUX_TMPDIR", &sandbox);
    std::env::set_var("PORTA_LOG_FILTER_BIN", &binary);
    let _guard = Sandbox(sandbox.clone());

    // ── 1. A dead server is genuinely "no panes", not an error ──────────────
    assert!(
        porta_lib::tmux::panes().expect("no server must be Ok, not Err").is_empty(),
        "no server means no panes"
    );

    // ── 2. A freshly started app must survive several monitor ticks ─────────
    let mgr = ProcessManager::new();
    let exit: Arc<Mutex<Option<(i32, bool)>>> = Arc::new(Mutex::new(None));
    let old_pid = {
        let exit_slot = Arc::clone(&exit);
        mgr.start(
            "replace-me",
            "sleep 30",
            Path::new("/tmp"),
            4321,
            None,
            &HashMap::new(),
            LogStart::Fresh,
            |_| {},
            move |code, intentional| *exit_slot.lock().unwrap() = Some((code, intentional)),
        )
        .expect("first start should succeed")
    };
    let session = porta_lib::tmux::app_session("replace-me");
    // Several 400 ms ticks worth of run-time: the monitor must not reap a live
    // session, and on_exit must stay silent.
    std::thread::sleep(Duration::from_millis(1600));
    assert!(porta_lib::tmux::has_session(&session), "live session was reaped by the monitor");
    assert_eq!(*exit.lock().unwrap(), None, "monitor reported an exit for a live app");

    // ── 3. Replacing the run must not leave the old process alive ───────────
    mgr.start(
        "replace-me",
        "sleep 30",
        Path::new("/tmp"),
        4321,
        None,
        &HashMap::new(),
        LogStart::Fresh,
        |_| {},
        |_, _| {},
    )
    .expect("replacement start should succeed");
    assert!(
        !alive(old_pid),
        "old run (pid {old_pid}) still alive after its replacement started — the port race is back"
    );
    assert!(porta_lib::tmux::has_session(&session), "replacement session should exist");

    // Cleanup: tear the replacement down so the sandbox drop has less to do.
    mgr.stop("replace-me").ok();
    assert!(
        wait_until(10, || !porta_lib::tmux::has_session(&session)),
        "session should be gone after stop"
    );
}
