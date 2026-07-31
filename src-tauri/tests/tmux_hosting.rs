//! End-to-end check of the tmux hosting path against a real tmux server and a
//! real Porta binary.
//!
//! The unit tests around this code only prove it is self-consistent. What
//! actually has to be true is that a session outlives the process that created
//! it, that its output keeps being captured by a filter Porta did not stay
//! alive to supervise, and that an exit status survives long enough to be read
//! back — none of which a mocked tmux can demonstrate. Everything here talks to
//! the installed `tmux`.
//!
//! Skipped, not failed, when tmux is absent: the feature degrades to the piped
//! path in that case, so its absence is not a broken build.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// Poll `f` until it returns true or `secs` elapse.
/// Tears the sandbox down even when an assertion panics.
///
/// Cleanup at the end of the test body is not enough: a failing run leaks its
/// tmux server, and because the socket lives under the `TMUX_TMPDIR` the
/// cleanup deletes, that server is then both unreachable and immortal — the
/// only way to reach it is by pid. Killing the server first, directory second,
/// keeps a failure from outliving the test.
struct Sandbox(std::path::PathBuf);

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
    // tests/../.. lands on target/debug next to the test executable.
    let mut p = std::env::current_exe().expect("test exe path");
    p.pop();
    if p.ends_with("deps") {
        p.pop();
    }
    p.join("porta")
}

#[test]
fn a_hosted_app_outlives_porta_and_keeps_its_log() {
    if !porta_lib::tmux::available() {
        eprintln!("skipping: tmux not installed");
        return;
    }
    let binary = porta_binary();
    if !binary.exists() {
        eprintln!("skipping: {} not built (run `cargo build --bin porta`)", binary.display());
        return;
    }

    // Isolate both halves of the world this touches: HOME decides `porta_dir()`
    // (and therefore where logs land), TMUX_TMPDIR decides where the socket
    // lives — without the latter this would share a server with a real Porta
    // dev instance running on the same machine.
    let sandbox = std::env::temp_dir().join(format!("porta-tmux-test-{}", std::process::id()));
    std::fs::create_dir_all(&sandbox).unwrap();
    std::env::set_var("HOME", &sandbox);
    std::env::set_var("TMUX_TMPDIR", &sandbox);
    let _guard = Sandbox(sandbox.clone());

    let app_id = "e2e-app";
    let session = porta_lib::tmux::app_session(app_id);
    let log = porta_lib::process_manager::log_file_path(app_id);
    std::fs::create_dir_all(log.parent().unwrap()).unwrap();
    std::fs::write(&log, "").unwrap();

    // A command that prints, then exits with a status we can assert on.
    let script = "echo hello-from-app; echo second-line; sleep 1; exit 7";
    let pane = porta_lib::tmux::start_detached(
        &session,
        Path::new("/tmp"),
        "/bin/sh",
        script,
        &[("PORTA_E2E".to_string(), "yes".to_string())],
        Some(&porta_lib::tmux::filter_target(&binary, app_id)),
    )
    .expect("session should start");
    assert!(pane.pid > 0, "pane should report a live pid");

    // The filter is a child of the tmux server, not of this test process —
    // which is exactly why it can keep writing after Porta goes away.
    let captured = wait_until(15, || {
        std::fs::read_to_string(&log).map(|s| s.contains("hello-from-app")).unwrap_or(false)
    });
    let body = std::fs::read_to_string(&log).unwrap_or_default();
    assert!(captured, "log never captured the app's output; got: {body:?}");
    assert!(body.contains("second-line"), "log missed later output: {body:?}");

    // Timestamped by the same code path the piped backend uses, so the viewer
    // cannot tell which backend produced a line.
    let first = body
        .lines()
        .find(|l| l.contains("hello-from-app"))
        .expect("captured line");
    let stamp: Vec<char> = first.chars().take(8).collect();
    assert!(
        stamp[2] == ':' && stamp[5] == ':' && stamp[0].is_ascii_digit(),
        "expected an HH:MM:SS prefix, got {first:?}"
    );

    // The exit status has to survive the process, or a crash is
    // indistinguishable from a clean stop and auto-restart never fires.
    let died = wait_until(15, || {
        porta_lib::tmux::pane(&session).map(|p| p.dead).unwrap_or(false)
    });
    assert!(died, "pane should be held open dead by remain-on-exit");
    assert_eq!(
        porta_lib::tmux::pane(&session).and_then(|p| p.dead_status),
        Some(7),
        "exit status should be readable after the command exited"
    );

    porta_lib::tmux::kill_session(&session).ok();
    assert!(
        !porta_lib::tmux::has_session(&session),
        "kill_session should remove the session"
    );
}
