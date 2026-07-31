//! Runtime check that a tmux-hosted pane reports *its own* foreground state.
//!
//! This is the one behaviour putting tmux under the terminal could silently
//! break: with a tmux client in the PTY, `tcgetpgrp` on the master reports the
//! client, which is never the shell's group. Read that way every pane looks
//! permanently busy, and — far worse — `terminal_signal` aims ^C at the client
//! instead of the command the user wants to interrupt. Only a real tmux server
//! can show whether reading the pane's own tty fixes it.
//!
//! Its own test file, not a second `#[test]` in the hosting suite: both set
//! `HOME`/`TMUX_TMPDIR` process-wide, and cargo would otherwise run them
//! concurrently in one process.

use std::path::Path;
use std::time::{Duration, Instant};

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

#[test]
fn a_pane_tells_an_idle_prompt_from_a_running_command() {
    if !porta_lib::tmux::available() {
        eprintln!("skipping: tmux not installed");
        return;
    }
    let sandbox = std::env::temp_dir().join(format!("porta-tmux-term-{}", std::process::id()));
    std::fs::create_dir_all(&sandbox).unwrap();
    std::env::set_var("HOME", &sandbox);
    std::env::set_var("TMUX_TMPDIR", &sandbox);
    let _guard = Sandbox(sandbox.clone());

    let session = porta_lib::tmux::term_session("probe");
    // `exec` so the pane's pid stays the interactive shell's pid, exactly as it
    // is for a real terminal pane.
    let pane = porta_lib::tmux::start_detached(
        &session,
        Path::new("/tmp"),
        "/bin/sh",
        "exec /bin/sh -i",
        &[],
        None,
    )
    .expect("session should start");

    // A shell sitting at its prompt owns the foreground group itself.
    let idle = wait_until(10, || {
        porta_lib::tmux::pane_foreground_pgid(&pane.tty) == pane.pid as i32
    });
    assert!(
        idle,
        "an idle prompt should report the shell's own pgid; got {} for shell {}",
        porta_lib::tmux::pane_foreground_pgid(&pane.tty),
        pane.pid
    );

    // Run something in front of the prompt: the foreground group must move, or
    // ^C would be delivered to the shell instead of the job.
    porta_lib::tmux::send_line(&session, "sleep 30").expect("send-keys");
    let busy = wait_until(10, || {
        let fg = porta_lib::tmux::pane_foreground_pgid(&pane.tty);
        fg > 0 && fg != pane.pid as i32
    });
    let fg = porta_lib::tmux::pane_foreground_pgid(&pane.tty);
    assert!(
        busy,
        "a running command should own the foreground group; got {fg} for shell {}",
        pane.pid
    );

    // And the PTY-master reading this replaces would have been wrong here: the
    // pane pid is the shell, never the process actually in front of it.
    assert_ne!(fg, pane.pid as i32);
}
