//! Install + first-run setup for the CLIs Porta drives (cloudflared,
//! tailscale), run from inside the app.
//!
//! Until this existed, "expose an app publicly" started with a card telling the
//! user to copy `brew install …` into a terminal, come back, and click "I've
//! installed it" — three context switches before the feature could be tried at
//! all. Every step here is one the setup cards already spelled out; the only
//! change is that Porta runs it and streams the output back.
//!
//! Two rules this module does not bend:
//!   * The frontend never passes a command line. It names a step from the
//!     whitelist below and the argv is built here — an IPC surface that took a
//!     shell string would be a remote-exec hole in a WebView.
//!   * Nothing is installed outside Homebrew. The alternatives (a curl|sh
//!     bootstrap, a .pkg needing sudo) all need an interactive privilege prompt
//!     Porta can't host honestly, so a machine without brew gets pointed at
//!     brew.sh instead.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// One streamed output line from a running step.
#[derive(Clone, Serialize)]
struct ProvisionLine {
    step: String,
    line: String,
}

/// PIDs of the steps currently running, keyed by step id. `cloudflared tunnel
/// login` and `tailscale up` both block until the user finishes a browser flow
/// — without a handle on them, closing the panel would leave a child waiting
/// forever with nothing able to reach it.
fn running_jobs() -> &'static Mutex<HashMap<String, u32>> {
    static JOBS: OnceLock<Mutex<HashMap<String, u32>>> = OnceLock::new();
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Homebrew's binary, at either of the two prefixes its installer uses (Apple
/// silicon, then Intel), falling back to whatever is on PATH.
fn find_brew() -> Option<String> {
    for p in ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"] {
        if std::path::Path::new(p).exists() {
            return Some(p.to_string());
        }
    }
    which("brew")
}

/// `which <bin>`, as a plain lookup that doesn't care about the caller's shell.
fn which(bin: &str) -> Option<String> {
    let out = Command::new("/usr/bin/which").arg(bin).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!path.is_empty()).then_some(path)
}

/// Is Homebrew installed? Drives whether the setup cards offer a Run button or
/// the "install Homebrew first" fallback.
#[tauri::command]
pub fn brew_available() -> bool {
    find_brew().is_some()
}

/// A step's program + arguments. Resolved here, never taken from the frontend.
fn resolve_step(step: &str) -> Result<(String, Vec<String>), String> {
    let args = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    match step {
        "install-cloudflared" => {
            let brew = find_brew().ok_or_else(missing_brew)?;
            Ok((brew, args(&["install", "cloudflared"])))
        }
        "install-tailscale" => {
            let brew = find_brew().ok_or_else(missing_brew)?;
            Ok((brew, args(&["install", "tailscale"])))
        }
        // Opens the browser and blocks until the cert is downloaded.
        "cloudflared-login" => {
            let cf = which("cloudflared")
                .or_else(|| existing(&["/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared"]))
                .ok_or_else(|| "cloudflared isn't installed yet.".to_string())?;
            Ok((cf, args(&["tunnel", "login"])))
        }
        // Prints an auth URL on stderr, then blocks until the machine is added.
        "tailscale-up" => {
            let ts = which("tailscale")
                .or_else(|| {
                    existing(&[
                        "/opt/homebrew/bin/tailscale",
                        "/usr/local/bin/tailscale",
                        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
                    ])
                })
                .ok_or_else(|| "tailscale isn't installed yet.".to_string())?;
            Ok((ts, args(&["up"])))
        }
        // The CLI talks to the daemon the GUI app hosts; if the app has never
        // been opened there is no daemon and every tailscale call fails with a
        // connect error that reads like a bug.
        "start-tailscale-app" => Ok(("/usr/bin/open".to_string(), args(&["-a", "Tailscale"]))),
        other => Err(format!("unknown provisioning step: {other}")),
    }
}

fn missing_brew() -> String {
    "Homebrew isn't installed. Install it from https://brew.sh, then try again.".to_string()
}

fn existing(paths: &[&str]) -> Option<String> {
    paths
        .iter()
        .find(|p| std::path::Path::new(p).exists())
        .map(|p| p.to_string())
}

/// Run one whitelisted step, streaming stdout+stderr to `provision:log` as it
/// arrives and resolving when the process exits. A non-zero exit returns the
/// last error-looking line so the caller has something to show without asking
/// the user to read the whole transcript.
#[tauri::command]
pub async fn run_provision_step(app: AppHandle, step: String) -> Result<(), String> {
    if running_jobs().lock().unwrap().contains_key(&step) {
        return Err("That step is already running.".into());
    }
    let (program, argv) = resolve_step(&step)?;

    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut child = Command::new(&program)
            .args(&argv)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // Homebrew shells out to git/curl and reads its own prefix from
            // PATH; a GUI app's inherited PATH is too bare for that.
            .env(
                "PATH",
                "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
            )
            // brew's progress spinners and cloudflared's prompts are noise (or
            // worse, control-character soup) in a log pane.
            .env("HOMEBREW_NO_AUTO_UPDATE", "1")
            .env("HOMEBREW_NO_ENV_HINTS", "1")
            .env("NO_COLOR", "1")
            .env("CI", "1")
            .spawn()
            .map_err(|e| format!("Could not start {program}: {e}"))?;

        running_jobs()
            .lock()
            .unwrap()
            .insert(step.clone(), child.id());

        let mut handles = Vec::new();
        for pipe in [
            child.stdout.take().map(PipeKind::Out),
            child.stderr.take().map(PipeKind::Err),
        ]
        .into_iter()
        .flatten()
        {
            let app = app.clone();
            let step = step.clone();
            handles.push(std::thread::spawn(move || {
                let mut last = String::new();
                let reader: Box<dyn BufRead + Send> = match pipe {
                    PipeKind::Out(p) => Box::new(BufReader::new(p)),
                    PipeKind::Err(p) => Box::new(BufReader::new(p)),
                };
                for line in reader.lines().map_while(Result::ok) {
                    if line.trim().is_empty() {
                        continue;
                    }
                    last = line.clone();
                    app.emit(
                        "provision:log",
                        ProvisionLine {
                            step: step.clone(),
                            line,
                        },
                    )
                    .ok();
                }
                last
            }));
        }

        let status = child.wait().map_err(|e| e.to_string())?;
        let tail: Vec<String> = handles
            .into_iter()
            .filter_map(|h| h.join().ok())
            .filter(|s| !s.trim().is_empty())
            .collect();
        running_jobs().lock().unwrap().remove(&step);

        if status.success() {
            Ok(())
        } else {
            let code = status.code().unwrap_or(-1);
            // -1 is what a signal exit reports, which here means the user hit
            // Cancel — not a failure worth a red banner.
            if code == -1 {
                return Err("Cancelled.".into());
            }
            Err(tail
                .last()
                .cloned()
                .unwrap_or_else(|| format!("{step} exited with code {code}")))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

enum PipeKind {
    Out(std::process::ChildStdout),
    Err(std::process::ChildStderr),
}

/// Stop a step that's waiting on a browser flow the user abandoned. Signals the
/// whole tree — `brew install` spawns curl/git children that outlive a bare
/// SIGTERM to the parent.
#[tauri::command]
pub fn cancel_provision_step(step: String) -> Result<(), String> {
    let pid = running_jobs().lock().unwrap().remove(&step);
    match pid {
        Some(pid) => {
            crate::process_manager::signal_tree(pid, nix::sys::signal::Signal::SIGTERM);
            Ok(())
        }
        None => Err("That step isn't running.".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_steps_are_rejected() {
        assert!(resolve_step("rm -rf /").is_err());
        assert!(resolve_step("install-postgres").is_err());
    }

    #[test]
    fn open_step_needs_no_toolchain() {
        // The only step that must resolve on any Mac, installed or not — it's
        // how the user gets the Tailscale daemon running in the first place.
        let (program, argv) = resolve_step("start-tailscale-app").expect("resolves");
        assert_eq!(program, "/usr/bin/open");
        assert_eq!(argv, vec!["-a", "Tailscale"]);
    }
}
