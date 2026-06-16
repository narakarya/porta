use anyhow::{anyhow, Result};
use std::collections::{HashMap, HashSet};
use std::io::LineWriter;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use crate::process_manager::{log_file_path, stream_child_output, SharedLogWriter};

/// Locate the `docker` CLI. GUI apps on macOS don't inherit the user's shell
/// PATH, so we fall back to known install locations for Docker Desktop and
/// OrbStack.
pub(crate) fn docker_bin() -> &'static str {
    static CACHED: OnceLock<String> = OnceLock::new();
    CACHED.get_or_init(find_docker_cli).as_str()
}

fn find_docker_cli() -> String {
    // Try PATH first — works when Porta is launched from a terminal.
    if Command::new("docker")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
    {
        return "docker".into();
    }
    let home = std::env::var("HOME").unwrap_or_default();
    let orbstack_home = format!("{}/.orbstack/bin/docker", home);
    let candidates = [
        "/usr/local/bin/docker",                                         // Homebrew (Intel) / Docker Desktop symlink
        "/opt/homebrew/bin/docker",                                      // Homebrew (Apple Silicon)
        orbstack_home.as_str(),                                          // OrbStack user install
        "/Applications/OrbStack.app/Contents/MacOS/bin/docker",          // OrbStack bundle
        "/Applications/Docker.app/Contents/Resources/bin/docker",        // Docker Desktop bundle
    ];
    for path in candidates {
        if std::path::Path::new(path).exists() {
            return path.to_string();
        }
    }
    // Last resort: return "docker" and let the spawn fail loudly later.
    "docker".into()
}

/// Manages lifecycle of Docker-backed apps. Containers are named deterministically
/// as `porta-<app_id>` so we can operate on them across Porta restarts.
pub struct DockerManager {
    /// app_ids of currently-active containers (managed by us).
    active: Arc<Mutex<HashSet<String>>>,
    /// App IDs being intentionally stopped — on_exit checks this to suppress auto-restart.
    pub stopping: Arc<Mutex<HashSet<String>>>,
    /// Retry counts per app for auto-restart logic.
    pub retry_counts: Arc<Mutex<HashMap<String, u32>>>,
}

impl Default for DockerManager {
    fn default() -> Self {
        Self::new()
    }
}

impl DockerManager {
    pub fn new() -> Self {
        DockerManager {
            active: Arc::new(Mutex::new(HashSet::new())),
            stopping: Arc::new(Mutex::new(HashSet::new())),
            retry_counts: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn container_name(app_id: &str) -> String {
        format!("porta-{}", app_id)
    }

    /// Ensure a user-defined bridge network with `name` exists. Idempotent —
    /// succeeds if the network already exists, creates it otherwise. Used for
    /// the shared workspace network so apps in the same workspace can reach
    /// each other by container name.
    pub fn ensure_network(name: &str) -> Result<()> {
        let exists = Command::new(docker_bin())
            .args(["network", "inspect", name])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if exists {
            return Ok(());
        }
        let out = Command::new(docker_bin())
            .args(["network", "create", "--driver", "bridge", name])
            .output()?;
        if !out.status.success() {
            return Err(anyhow!(
                "docker network create {} failed: {}",
                name,
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        Ok(())
    }

    /// Quick check — true if the `docker` CLI is present. Does not require the
    /// Docker-compatible daemon to be running.
    pub fn is_cli_available() -> bool {
        Command::new(docker_bin())
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    /// True when the Docker-compatible daemon is accepting requests. On macOS
    /// with OrbStack/Docker Desktop, the CLI can exist before the daemon is
    /// ready after login, so auto-start code should gate on this instead of
    /// only checking for the binary.
    pub fn is_engine_ready() -> bool {
        Command::new(docker_bin())
            .args(["info", "--format", "{{.ServerVersion}}"])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    /// Start a docker-backed app. Spawns `docker run -d`, then attaches a log
    /// streamer and a watcher that fires on_exit when the container stops.
    #[allow(clippy::too_many_arguments)]
    pub fn start(
        &self,
        app_id: &str,
        image: &str,
        host_port: u16,
        container_port: u16,
        extra_args: Option<&str>,
        volumes: &[String],
        root_dir: Option<&str>,
        shared_network: Option<&str>,
        env_vars: &HashMap<String, String>,
        truncate_log: bool,
        on_log: impl Fn(String) + Send + Sync + 'static,
        on_exit: impl Fn(i32, bool) + Send + 'static,
    ) -> Result<()> {
        if image.trim().is_empty() {
            return Err(anyhow!("docker image is empty"));
        }
        if !Self::is_cli_available() {
            return Err(anyhow!("Docker CLI not found — install Docker Desktop or OrbStack"));
        }
        if !Self::is_engine_ready() {
            return Err(anyhow!("Docker/OrbStack is not running yet"));
        }

        let name = Self::container_name(app_id);

        // Clean up any stale container with this name (ignore errors — it may not exist).
        let _ = Command::new(docker_bin())
            .args(["rm", "-f", &name])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .output();

        // Build docker run args.
        let mut args: Vec<String> = vec![
            "run".into(),
            "-d".into(),
            "--name".into(),
            name.clone(),
            "-p".into(),
            format!("127.0.0.1:{}:{}", host_port, container_port),
        ];
        if let Some(net) = shared_network.filter(|n| !n.is_empty()) {
            Self::ensure_network(net)?;
            // Set an alias equal to the Porta app name so other containers can
            // reach this one by its human-friendly name, not just `porta-<id>`.
            args.push("--network".into());
            args.push(net.to_string());
            args.push("--network-alias".into());
            args.push(format!("porta-{}", app_id));
        }
        for (k, v) in env_vars {
            args.push("-e".into());
            args.push(format!("{}={}", k, v));
        }
        for vol in volumes {
            let trimmed = vol.trim();
            if trimmed.is_empty() {
                continue;
            }
            let resolved = resolve_volume(trimmed, root_dir);
            ensure_volume_source_dir(&resolved);
            args.push("-v".into());
            args.push(resolved);
        }
        if let Some(xa) = extra_args {
            for tok in xa.split_whitespace() {
                args.push(tok.to_string());
            }
        }
        args.push(image.to_string());

        let out = Command::new(docker_bin()).args(&args).output()?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            return Err(anyhow!("docker run failed: {}", stderr.trim()));
        }

        self.active.lock().unwrap().insert(app_id.to_string());

        // Prepare the per-app log file (same path as process-backed apps).
        let log_path = log_file_path(app_id);
        if let Some(parent) = log_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if truncate_log {
            let _ = std::fs::write(&log_path, "");
        }
        let log_writer: Option<SharedLogWriter> = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .ok()
            .map(|f| Arc::new(Mutex::new(LineWriter::new(f))));

        if !truncate_log {
            if let Some(w) = &log_writer {
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

        // Log streamer — runs `docker logs -f --since=0s <name>` and pipes to on_log.
        let on_log = Arc::new(on_log);
        let name_for_logs = name.clone();
        let writer_logs = log_writer.clone();
        let on_log_logs = Arc::clone(&on_log);
        thread::spawn(move || {
            let child = Command::new(docker_bin())
                .args(["logs", "-f", "--since=0s", &name_for_logs])
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn();
            let Ok(mut child) = child else { return };
            let stdout = child.stdout.take();
            let stderr = child.stderr.take();
            let wa = writer_logs.clone();
            let wb = writer_logs.clone();
            let la = Arc::clone(&on_log_logs);
            let lb = Arc::clone(&on_log_logs);
            if let Some(s) = stdout {
                thread::spawn(move || stream_child_output(s, wa, la));
            }
            if let Some(s) = stderr {
                thread::spawn(move || stream_child_output(s, wb, lb));
            }
            let _ = child.wait();
        });

        // Exit watcher — polls `docker inspect` every 2s; fires on_exit when container no longer running.
        let active = Arc::clone(&self.active);
        let stopping = Arc::clone(&self.stopping);
        let name_for_watcher = name.clone();
        let app_id_str = app_id.to_string();
        thread::spawn(move || loop {
            thread::sleep(Duration::from_secs(2));
            let out = Command::new(docker_bin())
                .args([
                    "inspect",
                    "-f",
                    "{{.State.Running}} {{.State.ExitCode}}",
                    &name_for_watcher,
                ])
                .output();
            match out {
                Ok(o) if o.status.success() => {
                    let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
                    if s.starts_with("false") {
                        let exit_code: i32 = s
                            .split_whitespace()
                            .nth(1)
                            .and_then(|x| x.parse().ok())
                            .unwrap_or(-1);
                        active.lock().unwrap().remove(&app_id_str);
                        let intentional = stopping.lock().unwrap().remove(&app_id_str);
                        on_exit(exit_code, intentional);
                        return;
                    }
                }
                _ => {
                    // Container vanished (rm'd externally, docker stopped, etc.)
                    active.lock().unwrap().remove(&app_id_str);
                    let intentional = stopping.lock().unwrap().remove(&app_id_str);
                    on_exit(-1, intentional);
                    return;
                }
            }
        });

        Ok(())
    }

    /// Best-effort async stop — spawns a thread to call `docker stop` + `rm`.
    pub fn stop(&self, app_id: &str) -> Result<()> {
        self.stopping.lock().unwrap().insert(app_id.to_string());
        self.retry_counts.lock().unwrap().remove(app_id);
        let name = Self::container_name(app_id);
        let active = Arc::clone(&self.active);
        let app_id_str = app_id.to_string();
        thread::spawn(move || {
            let _ = Command::new(docker_bin())
                .args(["stop", "-t", "10", &name])
                .output();
            let _ = Command::new(docker_bin()).args(["rm", "-f", &name]).output();
            active.lock().unwrap().remove(&app_id_str);
        });
        Ok(())
    }

    /// Stop and block until the container is removed.
    pub fn stop_and_wait(&self, app_id: &str, timeout_ms: u64) -> Result<()> {
        self.stopping.lock().unwrap().insert(app_id.to_string());
        let name = Self::container_name(app_id);
        let grace = (timeout_ms / 1000).clamp(1, 30);
        let _ = Command::new(docker_bin())
            .args(["stop", "-t", &grace.to_string(), &name])
            .output();
        let _ = Command::new(docker_bin())
            .args(["rm", "-f", &name])
            .output();
        self.active.lock().unwrap().remove(app_id);
        // Port release grace
        thread::sleep(Duration::from_millis(300));
        Ok(())
    }

    /// Force-remove container (equivalent to SIGKILL for process-backed apps).
    pub fn kill(&self, app_id: &str) -> Result<()> {
        self.stopping.lock().unwrap().insert(app_id.to_string());
        let name = Self::container_name(app_id);
        let _ = Command::new(docker_bin())
            .args(["kill", &name])
            .output();
        let _ = Command::new(docker_bin())
            .args(["rm", "-f", &name])
            .output();
        self.active.lock().unwrap().remove(app_id);
        Ok(())
    }

    pub fn stop_all(&self) {
        let ids: Vec<String> = self.active.lock().unwrap().iter().cloned().collect();
        for id in &ids {
            self.stopping.lock().unwrap().insert(id.clone());
        }
        // Best-effort: an active id could be either a single container
        // (`porta-<id>`) or a compose project (`porta-<id>`). Try both — the one
        // that doesn't apply is a cheap no-op.
        for id in &ids {
            let name = Self::container_name(id);
            let project = Self::compose_project(id);
            let _ = Command::new(docker_bin())
                .args(["compose", "-p", &project, "down"])
                .output();
            let _ = Command::new(docker_bin())
                .args(["stop", "-t", "5", &name])
                .output();
            let _ = Command::new(docker_bin())
                .args(["rm", "-f", &name])
                .output();
        }
        self.active.lock().unwrap().clear();
    }

    pub fn is_running(&self, app_id: &str) -> bool {
        self.active.lock().unwrap().contains(app_id)
    }

    pub fn active_ids(&self) -> Vec<String> {
        self.active.lock().unwrap().iter().cloned().collect()
    }

    /// Register an app_id as active without starting a new container. Used at
    /// boot when we detect a container from a previous Porta session still running
    /// and want stop/metrics commands to operate on it. No log stream or exit
    /// watcher is attached — if the user wants full management they can restart.
    pub fn adopt(&self, app_id: &str) {
        self.active.lock().unwrap().insert(app_id.to_string());
    }

    // ── docker compose ─────────────────────────────────────────────────────────

    /// Project name Porta uses for compose stacks — scopes them so they don't
    /// collide with containers the user runs manually.
    pub fn compose_project(app_id: &str) -> String {
        format!("porta-{}", app_id)
    }

    /// Run `docker compose up -d` for the app's compose file and attach a log
    /// streamer. No exit watcher — compose stacks manage themselves; user stops
    /// them via the Stop button.
    #[allow(clippy::too_many_arguments)]
    pub fn compose_start(
        &self,
        app_id: &str,
        compose_file: &str,
        root_dir: Option<&str>,
        shared_network: Option<&str>,
        env_vars: &HashMap<String, String>,
        truncate_log: bool,
        on_log: impl Fn(String) + Send + Sync + 'static,
    ) -> Result<()> {
        if compose_file.trim().is_empty() {
            return Err(anyhow!("compose file path is empty"));
        }
        if !Self::is_cli_available() {
            return Err(anyhow!("Docker CLI not found — install Docker Desktop or OrbStack"));
        }
        if !Self::is_engine_ready() {
            return Err(anyhow!("Docker/OrbStack is not running yet"));
        }

        let file_path = resolve_compose_path(compose_file, root_dir);
        if !std::path::Path::new(&file_path).exists() {
            return Err(anyhow!("compose file not found: {}", file_path));
        }

        // The intentional-start clear happens in `start_app` (caller side) so
        // that a Stop click *between* the caller clearing and us reaching the
        // post-`up -d` check still wins the race.

        let project = Self::compose_project(app_id);
        let work_dir = std::path::Path::new(&file_path)
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| std::path::PathBuf::from("."));

        // Prepare per-app log file FIRST — pull progress and compose errors
        // stream here so the UI log pane shows what's happening.
        let log_path = log_file_path(app_id);
        if let Some(parent) = log_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if truncate_log {
            let _ = std::fs::write(&log_path, "");
        }
        let log_writer: Option<SharedLogWriter> = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .ok()
            .map(|f| Arc::new(Mutex::new(LineWriter::new(f))));

        let on_log = Arc::new(on_log);

        // Pre-create absolute bind-mount source dirs so docker doesn't auto-create
        // them as root in the wrong place. Resolve against the same project
        // directory `docker compose` will use (--project-directory or compose dir).
        let project_dir_for_resolve = root_dir
            .filter(|r| !r.is_empty())
            .map(|s| s.to_string())
            .unwrap_or_else(|| work_dir.to_string_lossy().into_owned());
        if let Ok(project) = crate::compose_parser::parse_compose(&file_path) {
            for svc in &project.services {
                for vol in &svc.volumes {
                    let resolved = resolve_volume(vol.trim(), Some(&project_dir_for_resolve));
                    ensure_volume_source_dir(&resolved);
                }
            }
        }

        // If the user set a root_dir, use it as --project-directory so relative
        // paths in the yml (volumes, build contexts) resolve there rather than
        // next to the managed compose file.
        let mut cmd = Command::new(docker_bin());
        let mut args: Vec<&str> = vec!["compose", "-f", &file_path, "-p", &project];
        let rd_owned;
        if let Some(rd) = root_dir.filter(|r| !r.is_empty()) {
            rd_owned = rd.to_string();
            args.push("--project-directory");
            args.push(&rd_owned);
        }
        args.extend(["up", "-d"]);
        cmd.args(&args)
            .current_dir(&work_dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (k, v) in env_vars {
            cmd.env(k, v);
        }

        // Spawn `up -d` and stream its output to the log pane so pull progress
        // and compose errors land in the log, not in a modal alert.
        let mut child = cmd.spawn()?;
        let up_stdout = child.stdout.take();
        let up_stderr = child.stderr.take();
        let w1 = log_writer.clone();
        let w2 = log_writer.clone();
        let l1 = Arc::clone(&on_log);
        let l2 = Arc::clone(&on_log);
        let t_out = up_stdout.map(|s| thread::spawn(move || stream_child_output(s, w1, l1)));
        let t_err = up_stderr.map(|s| thread::spawn(move || stream_child_output(s, w2, l2)));
        let status = child.wait()?;
        if let Some(t) = t_out { let _ = t.join(); }
        if let Some(t) = t_err { let _ = t.join(); }
        if !status.success() {
            return Err(anyhow!(
                "docker compose up exited with code {} — see logs for details",
                status.code().unwrap_or(-1)
            ));
        }

        // Did the user click Stop while we were starting? `up -d` is fast,
        // but if they did, undo it so the UI doesn't flip back to running
        // against their wishes. The error sentinel is recognised by
        // `start_single` so it doesn't pop a "Failed to start" alert.
        if self.stopping.lock().unwrap().contains(app_id) {
            let _ = Command::new(docker_bin())
                .args(["compose", "-f", &file_path, "-p", &project, "down"])
                .current_dir(&work_dir)
                .output();
            self.active.lock().unwrap().remove(app_id);
            return Err(anyhow!("aborted by user stop request"));
        }

        // Attach all containers in the compose project to the shared network.
        if let Some(net) = shared_network.filter(|n| !n.is_empty()) {
            Self::ensure_network(net)?;
            let ps = Command::new(docker_bin())
                .args(["compose", "-f", &file_path, "-p", &project, "ps", "-q"])
                .current_dir(&work_dir)
                .output();
            if let Ok(o) = ps {
                if o.status.success() {
                    for line in String::from_utf8_lossy(&o.stdout).lines() {
                        let cid = line.trim();
                        if cid.is_empty() {
                            continue;
                        }
                        // Alias allows other containers to reach this one by
                        // <app>-<service> — best-effort; ignore errors (e.g.
                        // already-connected).
                        let svc = Command::new(docker_bin())
                            .args(["inspect", "-f", "{{.Config.Labels \"com.docker.compose.service\"}}", cid])
                            .output()
                            .ok()
                            .and_then(|o| if o.status.success() { Some(String::from_utf8_lossy(&o.stdout).trim().to_string()) } else { None })
                            .unwrap_or_default();
                        let alias = if svc.is_empty() { format!("porta-{}", app_id) } else { format!("porta-{}-{}", app_id, svc) };
                        let _ = Command::new(docker_bin())
                            .args(["network", "connect", "--alias", &alias, net, cid])
                            .output();
                    }
                }
            }
        }

        self.active.lock().unwrap().insert(app_id.to_string());

        // Log streamer — `docker compose logs -f --tail 0`.
        let file_clone = file_path.clone();
        let project_clone = project.clone();
        let work_dir_clone = work_dir.clone();
        let writer_logs = log_writer.clone();
        let on_log_logs = Arc::clone(&on_log);
        thread::spawn(move || {
            let child = Command::new(docker_bin())
                .args([
                    "compose", "-f", &file_clone, "-p", &project_clone,
                    "logs", "-f", "--tail", "0",
                ])
                .current_dir(&work_dir_clone)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn();
            let Ok(mut child) = child else { return };
            let stdout = child.stdout.take();
            let stderr = child.stderr.take();
            let wa = writer_logs.clone();
            let wb = writer_logs.clone();
            let la = Arc::clone(&on_log_logs);
            let lb = Arc::clone(&on_log_logs);
            if let Some(s) = stdout {
                thread::spawn(move || stream_child_output(s, wa, la));
            }
            if let Some(s) = stderr {
                thread::spawn(move || stream_child_output(s, wb, lb));
            }
            let _ = child.wait();
        });

        Ok(())
    }

    /// Run `docker compose down` for the app's stack.
    pub fn compose_stop(&self, app_id: &str, compose_file: &str, root_dir: Option<&str>) -> Result<()> {
        self.stopping.lock().unwrap().insert(app_id.to_string());
        self.retry_counts.lock().unwrap().remove(app_id);
        let file_path = resolve_compose_path(compose_file, root_dir);
        let project = Self::compose_project(app_id);
        let active = Arc::clone(&self.active);
        let app_id_str = app_id.to_string();
        let work_dir = std::path::Path::new(&file_path)
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| std::path::PathBuf::from("."));
        thread::spawn(move || {
            let _ = Command::new(docker_bin())
                .args(["compose", "-f", &file_path, "-p", &project, "down"])
                .current_dir(&work_dir)
                .output();
            active.lock().unwrap().remove(&app_id_str);
        });
        Ok(())
    }

    /// Stop compose stack and block until it's down.
    pub fn compose_stop_and_wait(
        &self,
        app_id: &str,
        compose_file: &str,
        root_dir: Option<&str>,
    ) -> Result<()> {
        self.stopping.lock().unwrap().insert(app_id.to_string());
        let file_path = resolve_compose_path(compose_file, root_dir);
        let project = Self::compose_project(app_id);
        let work_dir = std::path::Path::new(&file_path)
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| std::path::PathBuf::from("."));
        let _ = Command::new(docker_bin())
            .args(["compose", "-f", &file_path, "-p", &project, "down"])
            .current_dir(&work_dir)
            .output();
        self.active.lock().unwrap().remove(app_id);
        thread::sleep(Duration::from_millis(300));
        Ok(())
    }

    /// Returns (cpu_percent, mem_bytes) from `docker stats --no-stream`.
    pub fn stats(app_id: &str) -> Option<(f32, u64)> {
        let name = Self::container_name(app_id);
        let out = Command::new(docker_bin())
            .args([
                "stats",
                "--no-stream",
                "--format",
                "{{.CPUPerc}} {{.MemUsage}}",
                &name,
            ])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let s = String::from_utf8_lossy(&out.stdout);
        let s = s.trim();
        // Format: "0.50% 12.5MiB / 1GiB"
        let mut parts = s.split_whitespace();
        let cpu_str = parts.next()?;
        let mem_str = parts.next()?;
        let cpu = cpu_str.trim_end_matches('%').parse::<f32>().ok()?;
        let mem = parse_docker_mem(mem_str)?;
        Some((cpu, mem))
    }
}

/// Resolve the source half of a "source:target[:opts]" volume spec.
///
/// Rules:
/// - If `source` starts with `/` → absolute path, use as-is.
/// - If `source` starts with `~` → expand to `$HOME`.
/// - If `source` contains no `/` (e.g. `mydata`) → named volume, use as-is.
/// - Otherwise (relative path like `./data` or `data/subdir`) → resolve against
///   `root_dir` if set; if no `root_dir`, leave as-is (docker CLI will resolve
///   against its own cwd, which may be Porta's binary dir).
pub(crate) fn resolve_volume(spec: &str, root_dir: Option<&str>) -> String {
    // Split "source:target[:opts]" into (source, rest).
    let Some((src, rest)) = spec.split_once(':') else {
        return spec.to_string();
    };
    let src = src.trim();
    let resolved = if src.starts_with('/') {
        src.to_string()
    } else if let Some(stripped) = src.strip_prefix("~/") {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
        format!("{}/{}", home.trim_end_matches('/'), stripped)
    } else if src == "~" {
        std::env::var("HOME").unwrap_or_else(|_| "/".into())
    } else if !src.contains('/') && !src.starts_with('.') {
        // Bare name — treat as named volume.
        return spec.to_string();
    } else if let Some(dir) = root_dir.filter(|d| !d.is_empty()) {
        let base = std::path::Path::new(dir);
        let candidate = if let Some(stripped) = src.strip_prefix("./") {
            base.join(stripped)
        } else {
            base.join(src)
        };
        candidate.to_string_lossy().into_owned()
    } else {
        src.to_string()
    };
    format!("{}:{}", resolved, rest)
}

/// Pre-create the host directory for an absolute bind-mount source so docker
/// doesn't silently materialize it as root in the wrong place. Idempotent —
/// returns early if the path already exists. Skips named volumes and
/// unresolved relative paths (no host dir we can safely create from those).
fn ensure_volume_source_dir(spec: &str) {
    let Some((src, _)) = spec.split_once(':') else { return };
    if !src.starts_with('/') {
        return;
    }
    let path = std::path::Path::new(src);
    if path.exists() {
        return;
    }
    let _ = std::fs::create_dir_all(path);
}

/// Resolve a compose file path. Absolute → as-is. `~/foo` → `$HOME/foo`.
/// Otherwise relative to `root_dir` if set; else as-is.
pub(crate) fn resolve_compose_path(path: &str, root_dir: Option<&str>) -> String {
    let path = path.trim();
    if path.starts_with('/') {
        return path.to_string();
    }
    if let Some(stripped) = path.strip_prefix("~/") {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
        return format!("{}/{}", home.trim_end_matches('/'), stripped);
    }
    if let Some(dir) = root_dir.filter(|d| !d.is_empty()) {
        let base = std::path::Path::new(dir);
        let rel = path.strip_prefix("./").unwrap_or(path);
        return base.join(rel).to_string_lossy().into_owned();
    }
    path.to_string()
}

fn parse_docker_mem(s: &str) -> Option<u64> {
    let s = s.trim();
    let idx = s.find(|c: char| c.is_alphabetic())?;
    let (num_str, unit) = (&s[..idx], &s[idx..]);
    let num: f64 = num_str.parse().ok()?;
    let mult: f64 = match unit {
        "B" => 1.0,
        "KiB" => 1024.0,
        "MiB" => 1024.0 * 1024.0,
        "GiB" => 1024.0 * 1024.0 * 1024.0,
        "TiB" => 1024.0_f64.powi(4),
        "KB" | "kB" => 1000.0,
        "MB" => 1_000_000.0,
        "GB" => 1_000_000_000.0,
        _ => return None,
    };
    Some((num * mult) as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_mem_units() {
        assert_eq!(parse_docker_mem("12.5MiB"), Some((12.5 * 1024.0 * 1024.0) as u64));
        assert_eq!(parse_docker_mem("1GiB"), Some(1024 * 1024 * 1024));
        assert_eq!(parse_docker_mem("500B"), Some(500));
        assert_eq!(parse_docker_mem("garbage"), None);
    }

    #[test]
    fn container_name_format() {
        assert_eq!(DockerManager::container_name("abc-123"), "porta-abc-123");
    }

    #[test]
    fn resolve_volume_absolute() {
        assert_eq!(resolve_volume("/data:/x", None), "/data:/x");
        assert_eq!(resolve_volume("/a/b:/c", Some("/root")), "/a/b:/c");
    }

    #[test]
    fn resolve_volume_relative_with_root() {
        assert_eq!(
            resolve_volume("./data:/data", Some("/home/me/proj")),
            "/home/me/proj/data:/data"
        );
        assert_eq!(
            resolve_volume("sub/dir:/x", Some("/home/me/proj")),
            "/home/me/proj/sub/dir:/x"
        );
    }

    #[test]
    fn resolve_volume_named_stays_named() {
        assert_eq!(resolve_volume("mydata:/data", Some("/root")), "mydata:/data");
    }

    #[test]
    fn resolve_volume_home_expansion() {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
        assert_eq!(
            resolve_volume("~/data:/x", None),
            format!("{}/data:/x", home.trim_end_matches('/'))
        );
    }
}
