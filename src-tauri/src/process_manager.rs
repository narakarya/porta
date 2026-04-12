use anyhow::{anyhow, Result};
use nix::sys::signal::{kill, Signal};
use nix::unistd::Pid;
use std::collections::{HashMap, HashSet};
use std::io::BufReader;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

pub struct ProcessManager {
    pids: Arc<Mutex<HashMap<String, u32>>>,
    /// Tracks app IDs that are being intentionally stopped (SIGTERM/SIGKILL by user).
    /// The on_exit closure checks this to avoid triggering auto-restart on manual stops.
    pub stopping: Arc<Mutex<HashSet<String>>>,
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
        }
    }

    /// Start an app process, streaming its stdout+stderr via `on_log` and
    /// notifying when it exits via `on_exit(exit_code, intentional_stop)`.
    /// `extra_env` vars are injected before the process spawns (PORT still wins over everything).
    /// `truncate_log`: if true the log file is wiped clean before this run (manual start/restart);
    ///   if false, a separator is appended so history from the previous run is preserved
    ///   (used when Porta auto-starts apps on boot).
    #[allow(clippy::too_many_arguments)]
    pub fn start(
        &self,
        app_id: &str,
        command: &str,
        root_dir: &Path,
        port: u16,
        env_file: Option<&str>,
        extra_env: &HashMap<String, String>,
        truncate_log: bool,
        on_log: impl Fn(String) + Send + Sync + 'static,
        on_exit: impl Fn(i32, bool) + Send + 'static,
    ) -> Result<u32> {
        if command.trim().is_empty() {
            return Err(anyhow!("empty command"));
        }
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());

        let mut cmd = Command::new(&shell);
        cmd.args(["-l", "-c", command])
            .current_dir(root_dir)
            .env("PORT", port.to_string())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

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

        let mut child = cmd.spawn()?;

        let pid = child.id();
        self.pids.lock().unwrap().insert(app_id.to_string(), pid);

        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();

        // Prepare the per-app log file.
        let log_path = log_file_path(app_id);
        if let Some(parent) = log_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if truncate_log {
            // Manual start/restart — clear so this run starts fresh.
            let _ = std::fs::write(&log_path, "");
        } else {
            // Auto-start (Porta boot) — append separator so history is preserved.
            use std::io::Write as _;
            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&log_path) {
                let ts = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                let _ = writeln!(f, "\n── Porta restarted (t={ts}) ──");
            }
        }

        let on_log = Arc::new(on_log);
        let pids = Arc::clone(&self.pids);
        let stopping = Arc::clone(&self.stopping);
        let app_id_str = app_id.to_string();

        // stdout reader
        let on_log_out = Arc::clone(&on_log);
        let log_path_out = log_path.clone();
        thread::spawn(move || {
            use std::io::{BufRead as _, Write as _};
            let mut reader = BufReader::new(stdout);
            let mut buf = Vec::new();
            loop {
                buf.clear();
                match reader.read_until(b'\n', &mut buf) {
                    Ok(0) => break,
                    Ok(_) => {
                        if buf.ends_with(b"\n") { buf.pop(); }
                        if buf.ends_with(b"\r") { buf.pop(); }
                        let line = String::from_utf8_lossy(&buf).into_owned();
                        if let Ok(mut f) = std::fs::OpenOptions::new().append(true).open(&log_path_out) {
                            let _ = writeln!(f, "{}", line);
                        }
                        on_log_out(line);
                    }
                    Err(_) => break,
                }
            }
        });

        // stderr reader
        let on_log_err = Arc::clone(&on_log);
        let log_path_err = log_path.clone();
        thread::spawn(move || {
            use std::io::{BufRead as _, Write as _};
            let mut reader = BufReader::new(stderr);
            let mut buf = Vec::new();
            loop {
                buf.clear();
                match reader.read_until(b'\n', &mut buf) {
                    Ok(0) => break,
                    Ok(_) => {
                        if buf.ends_with(b"\n") { buf.pop(); }
                        if buf.ends_with(b"\r") { buf.pop(); }
                        let line = String::from_utf8_lossy(&buf).into_owned();
                        if let Ok(mut f) = std::fs::OpenOptions::new().append(true).open(&log_path_err) {
                            let _ = writeln!(f, "{}", line);
                        }
                        on_log_err(line);
                    }
                    Err(_) => break,
                }
            }
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

    pub fn stop(&self, app_id: &str) -> Result<()> {
        // Mark as intentionally stopping before sending signal
        self.stopping.lock().unwrap().insert(app_id.to_string());

        let pid_opt = {
            let pids = self.pids.lock().unwrap();
            pids.get(app_id).copied()
        };
        if let Some(pid) = pid_opt {
            let _ = kill(Pid::from_raw(pid as i32), Signal::SIGTERM);
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
                let _ = kill(Pid::from_raw(pid as i32), Signal::SIGKILL);
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

        // Graceful SIGTERM first
        let _ = kill(Pid::from_raw(pid as i32), Signal::SIGTERM);

        // Poll until dead, falling back to SIGKILL after timeout
        let steps = (timeout_ms / 50).max(1);
        for i in 0..steps {
            thread::sleep(Duration::from_millis(50));
            if kill(Pid::from_raw(pid as i32), None).is_err() {
                // Confirmed dead
                self.pids.lock().unwrap().remove(app_id);
                return Ok(());
            }
            // Halfway through timeout — escalate to SIGKILL
            if i == steps / 2 {
                let _ = kill(Pid::from_raw(pid as i32), Signal::SIGKILL);
            }
        }

        // Final SIGKILL and a short grace period for the OS to reclaim the port
        let _ = kill(Pid::from_raw(pid as i32), Signal::SIGKILL);
        thread::sleep(Duration::from_millis(150));
        self.pids.lock().unwrap().remove(app_id);
        Ok(())
    }

    /// Force-kill a process with SIGKILL (no cleanup, immediate termination).
    pub fn kill(&self, app_id: &str) -> Result<()> {
        self.stopping.lock().unwrap().insert(app_id.to_string());
        let mut pids = self.pids.lock().unwrap();
        if let Some(pid) = pids.remove(app_id) {
            let _ = kill(Pid::from_raw(pid as i32), Signal::SIGKILL);
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
            let _ = kill(Pid::from_raw(*pid as i32), Signal::SIGTERM);
        }
        pids.clear();
    }

    pub fn is_running(&self, app_id: &str) -> bool {
        self.pids.lock().unwrap().contains_key(app_id)
    }
}

/// Returns the path to the per-app log file: ~/.porta/logs/{app_id}.log
pub fn log_file_path(app_id: &str) -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    std::path::PathBuf::from(home)
        .join(".porta")
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
