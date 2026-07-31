use anyhow::{anyhow, Result};
use nix::sys::signal::{kill, killpg, Signal};
use nix::unistd::Pid;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufReader, LineWriter};
use std::os::unix::process::CommandExt as _;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

pub(crate) type SharedLogWriter = Arc<Mutex<LineWriter<File>>>;

/// Exit code [`ProcessManager::run_build`] reports when the user stopped the
/// app mid-build. Distinct from any real shell status so the caller can tell
/// "user cancelled" from "build failed".
pub const BUILD_CANCELLED: i32 = -2;

/// Collect `root` plus every descendant PID by walking the system PPID table.
///
/// We spawn into a fresh process group (`process_group(0)`), so `killpg` reaches
/// the shell + node + any child that stays in the group. But puppeteer/Electron
/// spawn Chromium via `setsid()`, which escapes into its own session and process
/// group — `killpg` on the spawn pgid never touches it, leaving the browser
/// orphaned ("nangkut") after node dies. Walking PPID links catches it *while the
/// parent is still alive*; once node exits, Chromium reparents to launchd and the
/// link is gone — so callers must snapshot BEFORE sending the kill signal.
pub fn descendant_pids(root: u32) -> Vec<u32> {
    let output = match Command::new("ps").args(["-axo", "pid=,ppid="]).output() {
        Ok(o) => o,
        Err(_) => return vec![root],
    };
    let text = String::from_utf8_lossy(&output.stdout);
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for line in text.lines() {
        let mut it = line.split_whitespace();
        if let (Some(pid), Some(ppid)) = (it.next(), it.next()) {
            if let (Ok(pid), Ok(ppid)) = (pid.parse::<u32>(), ppid.parse::<u32>()) {
                children.entry(ppid).or_default().push(pid);
            }
        }
    }
    let mut result = vec![root];
    let mut stack = vec![root];
    while let Some(p) = stack.pop() {
        if let Some(kids) = children.get(&p) {
            for &k in kids {
                if !result.contains(&k) {
                    result.push(k);
                    stack.push(k);
                }
            }
        }
    }
    result
}

/// Signal `pid`, its whole process group, and every descendant (each plus its own
/// group, to catch Chromium's detached helper subtree). Snapshots the tree first
/// so a dying parent doesn't sever the links before we read them.
pub fn signal_tree(pid: u32, sig: Signal) {
    let tree = descendant_pids(pid);
    // Group first — fastest path for well-behaved children that stayed in-group.
    let _ = killpg(Pid::from_raw(pid as i32), sig);
    // Then each descendant individually + its own group (setsid'd Chromium).
    for &p in &tree {
        let ip = Pid::from_raw(p as i32);
        let _ = killpg(ip, sig);
        let _ = kill(ip, sig);
    }
}

/// How a run should treat the app's existing log file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogStart {
    /// Manual start/restart — wipe the log so this run starts clean.
    Fresh,
    /// Porta boot auto-start — append, marking the boundary with a separator.
    Resume,
    /// A build step already opened this log for the same run — append silently
    /// so the build output and the server output read as one continuous run.
    Continue,
}

/// Build the login-shell `Command` used for both builds and long-running app
/// processes, with identical cwd/PORT/env-file/env-var semantics so a prod build
/// sees exactly the environment its server will run under.
///
/// When launched as a macOS .app bundle the process inherits a minimal
/// environment without Homebrew, asdf, nvm, etc. Sourcing ~/.zprofile and
/// ~/.zshrc through a login shell gives children the same PATH the user has in
/// their terminal.
fn shell_command(
    command: &str,
    root_dir: &Path,
    port: u16,
    env_file: Option<&str>,
    extra_env: &HashMap<String, String>,
) -> Command {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let wrapped = format!("source ~/.zprofile 2>/dev/null; source ~/.zshrc 2>/dev/null; {command}");
    let mut cmd = Command::new(&shell);
    cmd.args(["-l", "-c", &wrapped])
        .current_dir(root_dir)
        .env("PORT", port.to_string())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Create a new process group so we can kill the shell AND all its
        // children (e.g. node, next dev) with a single signal to -pgid.
        .process_group(0);

    // Inject .env file variables (PORT always wins over .env).
    if let Some(path) = env_file {
        let resolved = if std::path::Path::new(path).is_absolute() {
            path.to_string()
        } else {
            root_dir.join(path).to_string_lossy().to_string()
        };
        for (key, val) in parse_env_file(&resolved) {
            if key != "PORT" {
                cmd.env(key, val);
            }
        }
    }

    // Inject inline env vars (PORT still wins — set after file vars so they take precedence,
    // but PORT is excluded since it's already set by the env("PORT", ...) call above).
    for (key, val) in extra_env {
        if key != "PORT" {
            cmd.env(key, val);
        }
    }

    cmd
}

/// Open (and, per `log_start`, prepare) the per-app log file.
fn open_log_writer(app_id: &str, log_start: LogStart) -> Option<SharedLogWriter> {
    let log_path = log_file_path(app_id);
    if let Some(parent) = log_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if log_start == LogStart::Fresh {
        let _ = std::fs::write(&log_path, "");
    }

    // One persistent append-mode file handle is shared across both reader threads.
    // LineWriter auto-flushes on each '\n' so the log viewer can still tail in real time,
    // but we skip the per-line open() syscall that dominated the old hot path.
    let writer: Option<SharedLogWriter> = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .ok()
        .map(|f| Arc::new(Mutex::new(LineWriter::new(f))));

    if log_start == LogStart::Resume {
        if let Some(w) = &writer {
            use std::io::Write as _;
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            if let Ok(mut g) = w.lock() {
                let _ = writeln!(g, "\n── Porta restarted (t={ts}) ──");
            }
        }
    }

    writer
}

pub struct ProcessManager {
    pids: Arc<Mutex<HashMap<String, u32>>>,
    /// Tracks app IDs that are being intentionally stopped (SIGTERM/SIGKILL by user).
    /// The on_exit closure checks this to avoid triggering auto-restart on manual stops.
    pub stopping: Arc<Mutex<HashSet<String>>>,
    /// Tracks retry counts per app for auto-restart logic.
    pub retry_counts: Arc<Mutex<HashMap<String, u32>>>,
    /// Apps hosted in a tmux session rather than on a pipe, keyed by app id.
    /// Holds what the piped path gets from owning the child: where to stream
    /// output from, and who to tell when it exits.
    tmux_apps: Arc<Mutex<HashMap<String, TmuxApp>>>,
    /// Set once the shared tmux monitor thread is running.
    tmux_monitor: Arc<std::sync::atomic::AtomicBool>,
}

impl Default for ProcessManager {
    fn default() -> Self {
        Self::new()
    }
}

impl ProcessManager {
    pub fn new() -> Self {
        ProcessManager {
            pids: Arc::new(Mutex::new(HashMap::new())),
            stopping: Arc::new(Mutex::new(HashSet::new())),
            retry_counts: Arc::new(Mutex::new(HashMap::new())),
            tmux_apps: Arc::new(Mutex::new(HashMap::new())),
            tmux_monitor: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }

    /// Start an app process, streaming its stdout+stderr via `on_log` and
    /// notifying when it exits via `on_exit(exit_code, intentional_stop)`.
    /// `extra_env` vars are injected before the process spawns (PORT still wins over everything).
    /// `log_start` decides whether this run wipes, separates from, or silently
    /// continues the app's existing log (see [`LogStart`]).
    #[allow(clippy::too_many_arguments)]
    pub fn start(
        &self,
        app_id: &str,
        command: &str,
        root_dir: &Path,
        port: u16,
        env_file: Option<&str>,
        extra_env: &HashMap<String, String>,
        log_start: LogStart,
        on_log: impl Fn(String) + Send + Sync + 'static,
        on_exit: impl Fn(i32, bool) + Send + 'static,
    ) -> Result<u32> {
        if command.trim().is_empty() {
            return Err(anyhow!("empty command"));
        }

        // Prefer a tmux session — it outlives Porta, which the piped path below
        // cannot. Failing over to a pipe rather than propagating the error
        // keeps a broken tmux from making apps unstartable, and the closures
        // are only consumed once the session is known to exist.
        if tmux_hosting_enabled() {
            match self.start_tmux_session(
                app_id, command, root_dir, port, env_file, extra_env, log_start,
            ) {
                Ok((pane, log_offset)) => {
                    let pid = pane.pid;
                    self.pids.lock().unwrap().insert(app_id.to_string(), pid);
                    self.register_tmux(app_id, pane.session, log_offset, on_log, on_exit);
                    return Ok(pid);
                }
                Err(e) => {
                    eprintln!("[tmux] hosting {app_id} failed, falling back to a pipe: {e}")
                }
            }
        }

        let mut cmd = shell_command(command, root_dir, port, env_file, extra_env);
        let mut child = cmd.spawn()?;

        let pid = child.id();
        self.pids.lock().unwrap().insert(app_id.to_string(), pid);

        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();

        let log_writer = open_log_writer(app_id, log_start);

        let on_log = Arc::new(on_log);
        let pids = Arc::clone(&self.pids);
        let stopping = Arc::clone(&self.stopping);
        let app_id_str = app_id.to_string();

        // stdout reader
        let on_log_out = Arc::clone(&on_log);
        let writer_out = log_writer.clone();
        thread::spawn(move || {
            stream_child_output(stdout, writer_out, on_log_out);
        });

        // stderr reader
        let on_log_err = Arc::clone(&on_log);
        let writer_err = log_writer.clone();
        thread::spawn(move || {
            stream_child_output(stderr, writer_err, on_log_err);
        });

        // exit watcher — waits for process and fires on_exit(code, intentional)
        thread::spawn(move || {
            let code = child.wait()
                .map(|s| s.code().unwrap_or(-1))
                .unwrap_or(-1);
            pids.lock().unwrap().remove(&app_id_str);
            // Remove from stopping set and report whether this was intentional
            let intentional = stopping.lock().unwrap().remove(&app_id_str);
            on_exit(code, intentional);
        });

        Ok(pid)
    }

    /// Run a run-profile's build step to completion, streaming its output into
    /// the same log the server will use. **Blocks** — callers must invoke this
    /// from a background thread, since a prod build can take minutes.
    ///
    /// The build PID is registered under `app_id` exactly like a server process,
    /// so Stop / Force Kill during a build reach it (a `mix release` or
    /// `next build` that can't be cancelled would strand the card in "starting"
    /// with no way out but quitting Porta).
    ///
    /// Returns the exit code; a non-zero code means the caller must NOT start
    /// the server — a prod server launched over a failed build either won't boot
    /// or, worse, silently serves the previous build's artifacts.
    #[allow(clippy::too_many_arguments)]
    pub fn run_build(
        &self,
        app_id: &str,
        command: &str,
        root_dir: &Path,
        port: u16,
        env_file: Option<&str>,
        extra_env: &HashMap<String, String>,
        log_start: LogStart,
        on_log: impl Fn(String) + Send + Sync + 'static,
    ) -> Result<i32> {
        if command.trim().is_empty() {
            return Err(anyhow!("empty build command"));
        }

        let mut cmd = shell_command(command, root_dir, port, env_file, extra_env);
        let mut child = cmd.spawn()?;
        let pid = child.id();
        self.pids.lock().unwrap().insert(app_id.to_string(), pid);

        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let log_writer = open_log_writer(app_id, log_start);

        let on_log = Arc::new(on_log);
        on_log(format!("── build: {} ──", command.trim()));
        if let Some(w) = &log_writer {
            use std::io::Write as _;
            if let Ok(mut g) = w.lock() {
                let _ = writeln!(g, "── build: {} ──", command.trim());
            }
        }

        let out_log = Arc::clone(&on_log);
        let out_writer = log_writer.clone();
        let out_thread = thread::spawn(move || stream_child_output(stdout, out_writer, out_log));
        let err_log = Arc::clone(&on_log);
        let err_writer = log_writer.clone();
        let err_thread = thread::spawn(move || stream_child_output(stderr, err_writer, err_log));

        let code = child.wait().map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);
        // Join the readers so every build line has landed before the caller
        // starts the server and its own output begins interleaving.
        let _ = out_thread.join();
        let _ = err_thread.join();

        // The build is done — drop its PID so the server's start() owns the slot.
        // A Stop during the build already removed it, which `remove` tolerates.
        self.pids.lock().unwrap().remove(app_id);

        // Stop pressed mid-build: report it as a distinct code so the caller can
        // skip the server start without treating it as a build failure.
        if self.stopping.lock().unwrap().contains(app_id) {
            return Ok(BUILD_CANCELLED);
        }

        Ok(code)
    }

    pub fn stop(&self, app_id: &str) -> Result<()> {
        // Mark as intentionally stopping before sending signal
        self.stopping.lock().unwrap().insert(app_id.to_string());
        // Reset retry count on manual stop
        self.retry_counts.lock().unwrap().remove(app_id);

        let pid_opt = {
            let pids = self.pids.lock().unwrap();
            pids.get(app_id).copied()
        };
        if let Some(pid) = pid_opt {
            // SIGTERM the whole tree (group + setsid'd children like Chromium)
            signal_tree(pid, Signal::SIGTERM);
            let pids = Arc::clone(&self.pids);
            let app_id = app_id.to_string();
            thread::spawn(move || {
                for _ in 0..50 {
                    thread::sleep(Duration::from_millis(100));
                    if kill(Pid::from_raw(pid as i32), None).is_err() {
                        pids.lock().unwrap().remove(&app_id);
                        return;
                    }
                }
                // Escalate: SIGKILL the entire tree
                signal_tree(pid, Signal::SIGKILL);
                pids.lock().unwrap().remove(&app_id);
            });
        }
        Ok(())
    }

    /// Stop the process and **block** until it is confirmed dead or the timeout
    /// expires (falls back to SIGKILL). Used by restart_app so the port is
    /// guaranteed free before the new process starts.
    pub fn stop_and_wait(&self, app_id: &str, timeout_ms: u64) -> Result<()> {
        self.stopping.lock().unwrap().insert(app_id.to_string());

        let pid_opt = {
            let pids = self.pids.lock().unwrap();
            pids.get(app_id).copied()
        };

        let Some(pid) = pid_opt else { return Ok(()) };

        // Graceful SIGTERM to the entire tree (group + setsid'd children) first
        signal_tree(pid, Signal::SIGTERM);

        // Poll until dead, falling back to SIGKILL after timeout
        let steps = (timeout_ms / 50).max(1);
        for i in 0..steps {
            thread::sleep(Duration::from_millis(50));
            if kill(Pid::from_raw(pid as i32), None).is_err() {
                // Confirmed dead — give the OS time to reclaim the socket/port
                thread::sleep(Duration::from_millis(300));
                self.pids.lock().unwrap().remove(app_id);
                return Ok(());
            }
            // Halfway through timeout — escalate to SIGKILL on the whole tree
            if i == steps / 2 {
                signal_tree(pid, Signal::SIGKILL);
            }
        }

        // Final SIGKILL to the whole tree and grace period for the OS to reclaim the port
        signal_tree(pid, Signal::SIGKILL);
        thread::sleep(Duration::from_millis(500));
        self.pids.lock().unwrap().remove(app_id);
        Ok(())
    }

    /// Force-kill a process with SIGKILL (no cleanup, immediate termination).
    pub fn kill(&self, app_id: &str) -> Result<()> {
        self.stopping.lock().unwrap().insert(app_id.to_string());
        let mut pids = self.pids.lock().unwrap();
        if let Some(pid) = pids.remove(app_id) {
            // Kill the entire tree (group + setsid'd children like Chromium)
            signal_tree(pid, Signal::SIGKILL);
        }
        Ok(())
    }

    pub fn stop_all(&self) {
        let mut pids = self.pids.lock().unwrap();
        // Mark all as intentionally stopping so on_exit doesn't trigger auto-restart
        let mut stopping = self.stopping.lock().unwrap();
        for app_id in pids.keys() {
            stopping.insert(app_id.clone());
        }
        drop(stopping);
        for pid in pids.values() {
            // Kill the entire tree for each app (group + setsid'd children)
            signal_tree(*pid, Signal::SIGTERM);
        }
        pids.clear();
    }

    pub fn is_running(&self, app_id: &str) -> bool {
        self.pids.lock().unwrap().contains_key(app_id)
    }

    /// Returns a snapshot of current app_id → pid mappings (for metrics polling).
    /// Returns `Vec` rather than `HashMap` so the lock is held only for a cheap
    /// iter+clone; callers that need map semantics can `.into_iter().collect()`.
    pub fn pids(&self) -> Vec<(String, u32)> {
        self.pids.lock().unwrap()
            .iter()
            .map(|(k, v)| (k.clone(), *v))
            .collect()
    }
}

/// Does this line already open with a clock the log viewer can peel into its
/// timestamp column? Two shapes count:
///
///   `10:23:45.123 [info] GET /`   — Phoenix, Rails, most loggers
///   `2026-07-27T04:10:02.9Z INF`  — RFC3339, `docker logs --timestamps`, Go
///
/// Cheap byte checks rather than a regex: this runs once per log line on the
/// process hot path, and an app under load emits thousands a second.
fn starts_with_timestamp(line: &str) -> bool {
    let b = line.as_bytes();
    // HH:MM:SS — allow a single-digit hour ("9:05:01").
    let hhmmss = |o: usize| {
        b.len() >= o + 8
            && b[o].is_ascii_digit()
            && b[o + 1].is_ascii_digit()
            && b[o + 2] == b':'
            && b[o + 3].is_ascii_digit()
            && b[o + 4].is_ascii_digit()
            && b[o + 5] == b':'
    };
    if hhmmss(0) {
        return true;
    }
    // YYYY-MM-DDT… / YYYY-MM-DD …
    b.len() >= 11
        && b[0..4].iter().all(|c| c.is_ascii_digit())
        && b[4] == b'-'
        && b[7] == b'-'
        && (b[10] == b'T' || b[10] == b' ')
}

/// Drain a child's stdout/stderr pipe line-by-line, persisting to the shared
/// log writer (if any) and forwarding each line to `on_log` for the frontend.
///
/// Lines that carry no clock of their own get one prepended, in the
/// `HH:MM:SS.mmm` shape the viewer already knows how to split into its own
/// column. Plenty of programs just `println!` — without this the viewer's
/// timestamp toggle had nothing to show for them and looked broken, and a log
/// read back from disk hours later had no way to say when anything happened.
/// Lines that already start with a timestamp are left exactly as they are, so
/// a Phoenix log doesn't end up wearing two clocks.
pub(crate) fn stream_child_output(
    pipe: impl std::io::Read,
    writer: Option<SharedLogWriter>,
    on_log: Arc<impl Fn(String) + Send + Sync + 'static>,
) {
    use std::io::{BufRead as _, Write as _};
    let mut reader = BufReader::new(pipe);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) => break,
            Ok(_) => {
                if buf.ends_with(b"\n") { buf.pop(); }
                if buf.ends_with(b"\r") { buf.pop(); }
                let raw = String::from_utf8_lossy(&buf).into_owned();
                // Blank lines stay blank — they're paragraph breaks in the
                // output, and stamping them would turn every one into content.
                let line = if raw.trim().is_empty() || starts_with_timestamp(&raw) {
                    raw
                } else {
                    format!("{} {}", chrono::Local::now().format("%H:%M:%S%.3f"), raw)
                };
                if let Some(w) = &writer {
                    if let Ok(mut g) = w.lock() {
                        let _ = writeln!(g, "{}", line);
                    }
                }
                on_log(line);
            }
            Err(_) => break,
        }
    }
}

/// Returns the path to the per-app log file: <porta_dir>/logs/{app_id}.log
pub fn log_file_path(app_id: &str) -> std::path::PathBuf {
    crate::porta_dir()
        .join("logs")
        .join(format!("{}.log", app_id))
}

/// Parse a .env file into key=value pairs.
fn parse_env_file(path: &str) -> Vec<(String, String)> {
    let Ok(content) = std::fs::read_to_string(path) else { return vec![] };
    content
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                return None;
            }
            let (key, val) = line.split_once('=')?;
            let key = key.trim().to_string();
            let val = val.trim();
            let val = if (val.starts_with('"') && val.ends_with('"'))
                || (val.starts_with('\'') && val.ends_with('\''))
            {
                val[1..val.len() - 1].to_string()
            } else {
                val.to_string()
            };
            Some((key, val))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::starts_with_timestamp;

    #[test]
    fn recognises_lines_that_already_carry_a_clock() {
        // Phoenix / Rails / most loggers.
        assert!(starts_with_timestamp("10:23:45.123 [info] GET /"));
        assert!(starts_with_timestamp("09:05:01 starting"));
        // RFC3339 — `docker logs --timestamps`, Go's slog, cloudflared.
        assert!(starts_with_timestamp("2026-07-27T04:10:02.938Z INF ready"));
        assert!(starts_with_timestamp("2026-07-27 04:10:02 ready"));
    }

    #[test]
    fn plain_output_gets_stamped() {
        assert!(!starts_with_timestamp("Listening on http://localhost:4000"));
        assert!(!starts_with_timestamp("web-1  | compiled successfully"));
        assert!(!starts_with_timestamp("[info] this one leads with a level"));
        // Guard the byte indexing against short lines.
        assert!(!starts_with_timestamp(""));
        assert!(!starts_with_timestamp("12:3"));
        assert!(!starts_with_timestamp("2026-07-2"));
    }
}

// ── tmux-hosted app processes ───────────────────────────────────────────────
//
// The piped path above ties an app's lifetime to Porta's: its stdout is a pipe
// whose read end lives in this process, so the app dies when Porta does — an
// auto-update restart takes every dev server with it. Hosting the same command
// in a tmux session breaks that link (see `crate::tmux`), at the cost of losing
// the two things the pipe gave us for free: line-by-line output, and a
// `child.wait()` to learn the exit code. Both are rebuilt here.

/// argv flag that turns a Porta launch into a log-filter process rather than
/// the GUI. Handled in `main.rs` before any Tauri setup.
pub const LOG_FILTER_FLAG: &str = "--log-filter";

/// Append pane output arriving on stdin to `app_id`'s log file, timestamped.
///
/// This runs as a *separate* Porta process, spawned by tmux's `pipe-pane` and
/// therefore a child of the tmux server rather than of the app. That is the
/// whole point: it keeps writing the log across a Porta quit, crash, or update,
/// so the window in which an app is running unsupervised is not also a window
/// in which its output is lost.
///
/// Reusing `stream_child_output` is deliberate — it is the single definition of
/// how a log line is timestamped, so a tmux-hosted app's log file is
/// byte-for-byte the same shape as a piped one's, and `get_app_logs` needs no
/// idea which backend produced it. `LogStart::Continue` because the caller
/// already wiped or marked the file before starting the session; a filter that
/// wiped on its own would erase the run it is about to record.
pub fn run_log_filter(app_id: &str) {
    let writer = open_log_writer(app_id, LogStart::Continue);
    stream_child_output(std::io::stdin(), writer, Arc::new(|_line: String| {}));
}

/// The binary tmux re-invokes as a log filter — normally Porta itself.
///
/// Overridable through `PORTA_LOG_FILTER_BIN` so integration tests can point at
/// the real Porta binary: inside a test harness `current_exe()` is the test
/// runner, which knows nothing about `--log-filter`, and every hosted app would
/// silently capture nothing. Nothing sets this in production.
fn log_filter_exe() -> Result<std::path::PathBuf> {
    if let Ok(path) = std::env::var("PORTA_LOG_FILTER_BIN") {
        return Ok(std::path::PathBuf::from(path));
    }
    Ok(std::env::current_exe()?)
}

/// Should app processes be hosted in tmux?
///
/// Both halves matter: tmux has to be installed *and* the user must not have
/// turned session hosting off. Defaults to on, so installing tmux is all it
/// takes to stop losing dev servers to an update.
pub fn tmux_hosting_enabled() -> bool {
    crate::tmux::available()
        && crate::commands::settings::read_porta_config()["tmux_sessions_enabled"]
            .as_bool()
            .unwrap_or(true)
}

/// Should apps keep running after Porta exits?
///
/// Read at quit time rather than cached, so toggling it takes effect without a
/// restart. Only meaningful for tmux-hosted apps — a piped app dies with its
/// pipe no matter what this says.
pub fn keep_apps_running_on_quit() -> bool {
    crate::commands::settings::read_porta_config()["keep_apps_running_on_quit"]
        .as_bool()
        .unwrap_or(true)
}

/// The environment a tmux-hosted process is started with, mirroring
/// `shell_command`'s precedence exactly: `.env` file first, inline vars on top,
/// and `PORT` winning over both (which is why it is excluded from both loops
/// rather than merely written first).
fn tmux_env(
    root_dir: &Path,
    port: u16,
    env_file: Option<&str>,
    extra_env: &HashMap<String, String>,
) -> Vec<(String, String)> {
    let mut env = vec![("PORT".to_string(), port.to_string())];
    if let Some(path) = env_file {
        let resolved = if Path::new(path).is_absolute() {
            path.to_string()
        } else {
            root_dir.join(path).to_string_lossy().to_string()
        };
        for (key, val) in parse_env_file(&resolved) {
            if key != "PORT" {
                env.push((key, val));
            }
        }
    }
    for (key, val) in extra_env {
        if key != "PORT" {
            env.push((key.clone(), val.clone()));
        }
    }
    env
}

/// One tmux-hosted app, as the monitor thread sees it.
struct TmuxApp {
    session: String,
    /// Tells this app's log tailer to drain and stop.
    stop_tail: Arc<std::sync::atomic::AtomicBool>,
    /// Fired with `(exit_code, was_intentional)` once the pane dies, standing in
    /// for the piped path's `child.wait()`.
    on_exit: Box<dyn Fn(i32, bool) + Send>,
}

/// Read everything appended to `path` since `offset`, emitting whole lines.
///
/// Returns the new offset and keeps any trailing partial line in `pending` for
/// the next pass, so a line split across two writes is never delivered twice or
/// truncated. A file that *shrank* was truncated in place by
/// `log_rotation::rotate_log` or `clear_log_file` — the only correct response is
/// to start over from the top rather than seek past the new end.
fn drain_log(
    path: &Path,
    offset: &mut u64,
    pending: &mut Vec<u8>,
    on_log: &(impl Fn(String) + Send + Sync + 'static),
) {
    use std::io::{Read as _, Seek as _, SeekFrom};
    let Ok(mut file) = File::open(path) else { return };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    if len < *offset {
        *offset = 0;
        pending.clear();
    }
    if len == *offset {
        return;
    }
    if file.seek(SeekFrom::Start(*offset)).is_err() {
        return;
    }
    // Cap one pass so a log that grew by hundreds of MB while Porta was away
    // doesn't get slurped into memory in a single read; the next tick picks up
    // where this one stopped.
    let want = (len - *offset).min(1 << 20) as usize;
    let mut buf = vec![0u8; want];
    let Ok(n) = file.read(&mut buf) else { return };
    buf.truncate(n);
    *offset += n as u64;
    pending.extend_from_slice(&buf);

    while let Some(pos) = pending.iter().position(|&b| b == b'\n') {
        let line: Vec<u8> = pending.drain(..=pos).collect();
        let mut end = line.len() - 1;
        // Output came off a real tty, so lines arrive CRLF-terminated.
        if end > 0 && line[end - 1] == b'\r' {
            end -= 1;
        }
        on_log(String::from_utf8_lossy(&line[..end]).into_owned());
    }
}

/// Follow `path` and forward each appended line to `on_log`.
///
/// The piped backend pushes lines straight from the child's pipe; here the
/// log-filter process owns the file and Porta reads it back, which is what lets
/// a re-adopted app resume streaming without having been its parent. Polling
/// rather than watching: the file changes in bursts a few times a second at
/// most, and a 200 ms tick costs a `stat` while an fsevents watcher would need
/// its own lifecycle across rotation's in-place truncate.
fn spawn_log_tail(
    path: std::path::PathBuf,
    start_offset: u64,
    on_log: Arc<impl Fn(String) + Send + Sync + 'static>,
    stop: Arc<std::sync::atomic::AtomicBool>,
) {
    use std::sync::atomic::Ordering;
    thread::spawn(move || {
        let mut offset = start_offset;
        let mut pending = Vec::new();
        loop {
            drain_log(&path, &mut offset, &mut pending, on_log.as_ref());
            if stop.load(Ordering::Relaxed) {
                // One last pass: the lines an app printed as it died are the
                // interesting ones, and they land after the pane is already gone.
                thread::sleep(Duration::from_millis(120));
                drain_log(&path, &mut offset, &mut pending, on_log.as_ref());
                return;
            }
            thread::sleep(Duration::from_millis(200));
        }
    });
}

impl ProcessManager {
    /// Start the one thread that watches every tmux-hosted app.
    ///
    /// One thread for all of them, not one per app: `tmux::panes()` reports the
    /// whole socket in a single subprocess, so N apps cost the same as one. A
    /// watcher per app would spawn N `tmux` processes every tick.
    ///
    /// Idempotent via a compare-and-set, and free when nothing is hosted — the
    /// loop skips the subprocess entirely while the registry is empty, so it
    /// costs a timer wakeup rather than being torn down and rebuilt.
    fn ensure_tmux_monitor(&self) {
        use std::sync::atomic::Ordering;
        if self.tmux_monitor.swap(true, Ordering::SeqCst) {
            return;
        }
        let apps = Arc::clone(&self.tmux_apps);
        let pids = Arc::clone(&self.pids);
        let stopping = Arc::clone(&self.stopping);
        thread::spawn(move || loop {
            thread::sleep(Duration::from_millis(400));
            if apps.lock().unwrap().is_empty() {
                continue;
            }
            let panes = crate::tmux::panes();
            // Collect first, fire callbacks after: `on_exit` re-enters the
            // manager (auto-restart calls `start` again), so it must never run
            // while this map's lock is held.
            let finished: Vec<(String, i32)> = {
                let map = apps.lock().unwrap();
                map.iter()
                    .filter_map(|(id, w)| {
                        match panes.iter().find(|p| p.session == w.session) {
                            Some(p) if !p.dead => None,
                            Some(p) => Some((id.clone(), p.dead_status.unwrap_or(-1))),
                            // Session gone outright — killed from another
                            // terminal, or torn down by a stop. No status left
                            // to read, and `stopping` already knows whether the
                            // user asked for it.
                            None => Some((id.clone(), 0)),
                        }
                    })
                    .collect()
            };
            for (id, code) in finished {
                let Some(w) = apps.lock().unwrap().remove(&id) else { continue };
                w.stop_tail.store(true, Ordering::Relaxed);
                let _ = crate::tmux::kill_session(&w.session);
                pids.lock().unwrap().remove(&id);
                let intentional = stopping.lock().unwrap().remove(&id);
                (w.on_exit)(code, intentional);
            }
        });
    }

    /// Create the tmux session for `app_id` and point a log filter at it.
    ///
    /// Split out from the streaming setup so a failure here can fall back to
    /// the piped path without having consumed the caller's `on_log`/`on_exit`
    /// closures. Returns the pane plus the log offset the tailer must start at.
    fn start_tmux_session(
        &self,
        app_id: &str,
        command: &str,
        root_dir: &Path,
        port: u16,
        env_file: Option<&str>,
        extra_env: &HashMap<String, String>,
        log_start: LogStart,
    ) -> Result<(crate::tmux::Pane, u64)> {
        let session = crate::tmux::app_session(app_id);
        // A previous run usually leaves a husk: `remain-on-exit` holds the pane
        // open so its status can be read, and `new-session` refuses a duplicate
        // name. Starting an app is an explicit "replace whatever is there".
        if crate::tmux::has_session(&session) {
            let _ = crate::tmux::kill_session(&session);
        }

        // Wipe (or mark) the log before the session exists, and note where this
        // run begins. Taking the offset here rather than after `pipe-pane`
        // attaches is what stops the tailer from either replaying the previous
        // run or skipping the first lines of this one.
        drop(open_log_writer(app_id, log_start));
        let log_path = log_file_path(app_id);
        let offset = std::fs::metadata(&log_path).map(|m| m.len()).unwrap_or(0);

        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        // Identical wrapping to `shell_command`, so a tmux-hosted app resolves
        // binaries through the same profile as a piped one.
        let wrapped =
            format!("source ~/.zprofile 2>/dev/null; source ~/.zshrc 2>/dev/null; {command}");
        let env = tmux_env(root_dir, port, env_file, extra_env);
        // Capture is set up in the same tmux command list as the session, so an
        // app that prints the moment it starts still has those lines recorded.
        let exe = log_filter_exe()?;
        let pipe = crate::tmux::filter_target(&exe, app_id);
        let pane = crate::tmux::start_detached(
            &session,
            root_dir,
            &shell,
            &wrapped,
            &env,
            Some(&pipe),
        )?;
        Ok((pane, offset))
    }

    /// Attach output streaming and exit watching to an already-running session.
    fn register_tmux(
        &self,
        app_id: &str,
        session: String,
        log_offset: u64,
        on_log: impl Fn(String) + Send + Sync + 'static,
        on_exit: impl Fn(i32, bool) + Send + 'static,
    ) {
        let stop_tail = Arc::new(std::sync::atomic::AtomicBool::new(false));
        spawn_log_tail(
            log_file_path(app_id),
            log_offset,
            Arc::new(on_log),
            Arc::clone(&stop_tail),
        );
        self.tmux_apps.lock().unwrap().insert(
            app_id.to_string(),
            TmuxApp { session, stop_tail, on_exit: Box::new(on_exit) },
        );
        self.ensure_tmux_monitor();
    }

    /// Re-attach to `app_id`'s session if it outlived a previous Porta run.
    ///
    /// This is the payoff for hosting in tmux: after an update restart the app
    /// is still serving, and Porta picks it back up — status, PID, live log —
    /// instead of showing it stopped and making the user start it again.
    /// Returns the running PID, or `None` when there is nothing to adopt.
    pub fn adopt_tmux(
        &self,
        app_id: &str,
        on_log: impl Fn(String) + Send + Sync + 'static,
        on_exit: impl Fn(i32, bool) + Send + 'static,
    ) -> Option<u32> {
        let session = crate::tmux::app_session(app_id);
        let pane = crate::tmux::pane(&session)?;
        if pane.dead {
            // It exited while Porta was away. Nothing to adopt, and the husk
            // would block the next start on a duplicate session name.
            let _ = crate::tmux::kill_session(&session);
            return None;
        }

        // Only attach a pipe if the pane has none. The filter started before
        // the restart is a child of the tmux server, so it is normally still
        // writing — and `pipe-pane -o` *toggles*, so re-piping here would turn
        // that surviving capture off and leave the adopted app running with a
        // log frozen at the moment Porta restarted.
        if !pane.piped {
            if let Ok(exe) = log_filter_exe() {
                let _ = crate::tmux::pipe_to_filter(&session, &exe, app_id);
            }
        }

        self.pids.lock().unwrap().insert(app_id.to_string(), pane.pid);
        // Resume at the current end of the log. Everything written while Porta
        // was away is already on disk, and the viewer loads it via
        // `get_app_logs`; replaying it as live events would show it twice.
        let offset = std::fs::metadata(log_file_path(app_id))
            .map(|m| m.len())
            .unwrap_or(0);
        self.register_tmux(app_id, session, offset, on_log, on_exit);
        Some(pane.pid)
    }

    /// Is this app hosted in a tmux session (rather than piped)?
    pub fn is_tmux_hosted(&self, app_id: &str) -> bool {
        self.tmux_apps.lock().unwrap().contains_key(app_id)
    }

    /// The command a user can run to attach to `app_id`'s session themselves.
    pub fn tmux_attach_command(&self, app_id: &str) -> Option<String> {
        let map = self.tmux_apps.lock().unwrap();
        map.get(app_id).map(|w| crate::tmux::attach_command(&w.session))
    }

    /// Destroy every hosted session.
    ///
    /// Only correct when the user actually wants apps stopped — quitting Porta
    /// does *not* imply that (see `keep_apps_running_on_quit`), which is the
    /// distinction this whole backend exists to make.
    pub fn kill_tmux_sessions(&self) {
        let sessions: Vec<String> = self
            .tmux_apps
            .lock()
            .unwrap()
            .values()
            .map(|w| w.session.clone())
            .collect();
        for s in sessions {
            let _ = crate::tmux::kill_session(&s);
        }
    }
}
