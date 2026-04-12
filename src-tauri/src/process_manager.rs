use anyhow::{anyhow, Result};
use nix::sys::signal::{kill, Signal};
use nix::unistd::Pid;
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
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
    pub fn start(
        &self,
        app_id: &str,
        command: &str,
        root_dir: &Path,
        port: u16,
        env_file: Option<&str>,
        extra_env: &HashMap<String, String>,
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

        let on_log = Arc::new(on_log);
        let pids = Arc::clone(&self.pids);
        let stopping = Arc::clone(&self.stopping);
        let app_id_str = app_id.to_string();

        // stdout reader
        let on_log_out = Arc::clone(&on_log);
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().flatten() {
                on_log_out(line);
            }
        });

        // stderr reader
        let on_log_err = Arc::clone(&on_log);
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().flatten() {
                on_log_err(line);
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
