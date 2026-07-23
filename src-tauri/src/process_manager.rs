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

/// Drain a child's stdout/stderr pipe line-by-line, persisting to the shared
/// log writer (if any) and forwarding each line to `on_log` for the frontend.
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
                let line = String::from_utf8_lossy(&buf).into_owned();
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
