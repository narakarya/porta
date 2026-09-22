//! Subprocess helpers that cannot hang the caller.
//!
//! `std::process::Command::output()` waits forever. That was fine until a
//! helper CLI stopped exiting: the App Store `Tailscale` binary, invoked as
//! `Tailscale status --json`, has been observed running its AppKit event loop
//! instead of printing and quitting, and Porta's main thread sat in `poll()`
//! behind it for four days before the window was ever created.
//!
//! [`output_with_timeout`] is the drop-in replacement: same `Output` on
//! success, `ErrorKind::TimedOut` (with the child killed) when the deadline
//! passes.

use std::io::{self, Read};
use std::process::{Command, Output, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

/// Run `cmd` to completion, capturing stdout and stderr, or kill it once
/// `timeout` elapses.
///
/// stdin is closed (`/dev/null`) so a child that unexpectedly prompts fails
/// fast instead of waiting on a terminal it does not have. Output is drained
/// on helper threads so a chatty child cannot deadlock on a full pipe while
/// we wait on it.
///
/// The deadline bounds the whole call, not just the child's exit: if the
/// child exits but a grandchild it left behind still holds the pipes open,
/// the call returns at the deadline with the child's status and whatever
/// output had reached EOF by then (usually none). `Command::output()` would
/// block on that grandchild indefinitely.
pub fn output_with_timeout(cmd: &mut Command, timeout: Duration) -> io::Result<Output> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn()?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let (tx, rx) = mpsc::channel::<(Stream, Vec<u8>)>();
    spawn_reader(Stream::Out, stdout, tx.clone());
    spawn_reader(Stream::Err, stderr, tx);

    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() >= deadline {
            // SIGKILL, then reap so the child never lingers as a zombie. The
            // reader threads are left to finish on their own: the pipes close
            // when every holder exits, and we must not block on a grandchild
            // that inherited them.
            let _ = child.kill();
            let _ = child.wait();
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                format!("subprocess timed out after {}s", timeout.as_secs()),
            ));
        }
        thread::sleep(Duration::from_millis(25));
    };

    let mut out = Output {
        status,
        stdout: Vec::new(),
        stderr: Vec::new(),
    };
    for _ in 0..2 {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(remaining) {
            Ok((Stream::Out, buf)) => out.stdout = buf,
            Ok((Stream::Err, buf)) => out.stderr = buf,
            Err(_) => break,
        }
    }
    Ok(out)
}

#[derive(Clone, Copy)]
enum Stream {
    Out,
    Err,
}

fn spawn_reader<R: Read + Send + 'static>(
    which: Stream,
    pipe: Option<R>,
    tx: mpsc::Sender<(Stream, Vec<u8>)>,
) {
    thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut r) = pipe {
            let _ = r.read_to_end(&mut buf);
        }
        // The receiver is gone when the caller already returned (timeout);
        // nothing to do with the bytes then.
        let _ = tx.send((which, buf));
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_output_when_the_child_exits_in_time() {
        let out = output_with_timeout(
            Command::new("sh").args(["-c", "echo out; echo err >&2"]),
            Duration::from_secs(5),
        )
        .unwrap();
        assert!(out.status.success());
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "out");
        assert_eq!(String::from_utf8_lossy(&out.stderr).trim(), "err");
    }

    #[test]
    fn preserves_a_nonzero_exit_status() {
        let out =
            output_with_timeout(Command::new("sh").args(["-c", "exit 3"]), Duration::from_secs(5))
                .unwrap();
        assert_eq!(out.status.code(), Some(3));
    }

    #[test]
    fn captures_output_larger_than_the_pipe_buffer() {
        // 256 KiB is well past the 64 KiB pipe buffer: a naive wait-then-read
        // would deadlock here with the child blocked on write.
        let out = output_with_timeout(
            Command::new("sh").args(["-c", "head -c 262144 /dev/zero | tr '\\0' 'x'"]),
            Duration::from_secs(10),
        )
        .unwrap();
        assert_eq!(out.stdout.len(), 262_144);
    }

    #[test]
    fn kills_a_child_that_outlives_the_deadline() {
        let started = Instant::now();
        let err = output_with_timeout(Command::new("sleep").arg("30"), Duration::from_millis(300))
            .unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::TimedOut);
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "timeout should not wait for the child's natural exit"
        );
    }

    #[test]
    fn does_not_wait_on_a_grandchild_holding_the_pipes() {
        // The direct child exits immediately but leaves a background process
        // holding stdout open. `Command::output()` would block on that pipe
        // until the grandchild exits; we must return by the deadline.
        let started = Instant::now();
        let out = output_with_timeout(
            Command::new("sh").args(["-c", "sleep 30 & echo done"]),
            Duration::from_secs(1),
        )
        .unwrap();
        assert!(out.status.success());
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "must not block on the grandchild's copy of the pipe"
        );
    }

    #[test]
    fn spawn_failure_is_reported_not_swallowed() {
        let err = output_with_timeout(
            &mut Command::new("/nonexistent/porta-test-binary"),
            Duration::from_secs(1),
        )
        .unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::NotFound);
    }
}
