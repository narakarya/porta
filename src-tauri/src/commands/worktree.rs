//! Discover existing git worktrees of an app's repo and run the app from them
//! as isolated instances. Porta never creates or removes worktrees — it only
//! reads `git worktree list` and runs from what already exists.

use crate::app_state::AppState;
use crate::commands::git::git_bin;
use crate::commands::setup::sync_caddy;
use crate::db::models::AppInstance;
use crate::port_scanner::find_available_port;
use std::path::Path;
use std::process::Command;
use tauri::{AppHandle, Emitter, Manager};

/// Reduce an arbitrary string to a safe DNS label: lowercase, every run of
/// characters outside `[a-z0-9]` becomes a single `-`, and leading/trailing
/// `-` are trimmed.
#[allow(dead_code)]
fn sanitize_label(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_dash = false;
    for ch in s.to_ascii_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

/// `<app-subdomain>-<sanitized-branch>` — the instance's DNS label.
fn instance_subdomain(app_sub: &str, branch: &str) -> String {
    sanitize_label(&format!("{app_sub}-{branch}"))
}

/// `<app_id>:<sanitized-branch>` — unique key used as the instance row id and
/// the ProcessManager key (can't collide with the primary app's key = app_id).
fn instance_id(app_id: &str, branch: &str) -> String {
    format!("{app_id}:{}", sanitize_label(branch))
}

/// One entry from `git worktree list --porcelain`. `branch` is the short branch
/// name (no `refs/heads/`); `None` for a detached or bare worktree.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct WorktreeEntry {
    pub path: String,
    pub branch: Option<String>,
    pub head: String,
    pub detached: bool,
}

/// Parse `git worktree list --porcelain`. Records are separated by a blank line;
/// each record starts with a `worktree <path>` line, then optional
/// `HEAD <sha>`, `branch refs/heads/<name>`, `detached`, `bare`, `locked` lines.
fn parse_worktree_porcelain(out: &str) -> Vec<WorktreeEntry> {
    let mut entries = Vec::new();
    let mut path: Option<String> = None;
    let mut head = String::new();
    let mut branch: Option<String> = None;
    let mut detached = false;

    let mut flush = |path: &mut Option<String>, head: &mut String, branch: &mut Option<String>, detached: &mut bool| {
        if let Some(p) = path.take() {
            entries.push(WorktreeEntry {
                path: p,
                branch: branch.take(),
                head: std::mem::take(head),
                detached: std::mem::replace(detached, false),
            });
        } else {
            *head = String::new();
            *branch = None;
            *detached = false;
        }
    };

    for line in out.lines() {
        if line.is_empty() {
            flush(&mut path, &mut head, &mut branch, &mut detached);
            continue;
        }
        if let Some(p) = line.strip_prefix("worktree ") {
            // A new record started without a blank separator (shouldn't happen,
            // but be defensive): flush the previous one first.
            if path.is_some() {
                flush(&mut path, &mut head, &mut branch, &mut detached);
            }
            path = Some(p.to_string());
        } else if let Some(h) = line.strip_prefix("HEAD ") {
            head = h.to_string();
        } else if let Some(b) = line.strip_prefix("branch ") {
            branch = Some(b.strip_prefix("refs/heads/").unwrap_or(b).to_string());
        } else if line == "detached" {
            detached = true;
        }
        // `bare`, `locked`, `prunable` lines are ignored.
    }
    // Final record if the output didn't end with a blank line.
    flush(&mut path, &mut head, &mut branch, &mut detached);
    entries
}

/// List existing git worktrees for the repo that owns `root_dir`. Returns an
/// empty vec when the dir isn't a repo (not an error) — the picker shows an
/// empty state. Runs on a blocking thread like the other git commands.
#[tauri::command]
pub async fn git_worktree_list(root_dir: String) -> Result<Vec<WorktreeEntry>, String> {
    tokio::task::spawn_blocking(move || worktree_list_for(&root_dir))
        .await
        .map_err(|e| e.to_string())?
}

/// Build the `git worktree list --porcelain` command. Pinning `LC_ALL=C` keeps
/// a Homebrew (NLS) git from translating "fatal:" messages, so our non-repo
/// detection matches on every locale — same reason `status_command` does it.
fn worktree_list_command(bin: &str, root_dir: &str) -> Command {
    let mut cmd = Command::new(bin);
    cmd.current_dir(root_dir)
        .env("LC_ALL", "C")
        .args(["worktree", "list", "--porcelain"]);
    cmd
}

pub(crate) fn worktree_list_for(root_dir: &str) -> Result<Vec<WorktreeEntry>, String> {
    if root_dir.is_empty() || !Path::new(root_dir).is_dir() {
        return Ok(Vec::new());
    }
    let Some(bin) = git_bin() else { return Ok(Vec::new()); };
    let out = worktree_list_command(bin, root_dir)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        // Not a repo → empty, consistent with git_status returning None.
        if stderr.contains("not a git repository") {
            return Ok(Vec::new());
        }
        return Err(stderr.trim().to_string());
    }
    Ok(parse_worktree_porcelain(&String::from_utf8_lossy(&out.stdout)))
}

#[tauri::command]
pub async fn list_instances(app: AppHandle, app_id: String) -> Result<Vec<AppInstance>, String> {
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let db = state.db.lock().unwrap();
        db.list_instances_for(&app_id).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn stop_instance(app: AppHandle, instance_id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
        // Kill the process under the instance key (no-op if already exited).
        state.processes.stop(&instance_id).map_err(|e| e.to_string())?;
        // Drop the row + free the port, then rebuild Caddy so the route vanishes.
        {
            let mut db = state.db.lock().unwrap();
            db.delete_instance(&instance_id).map_err(|e| e.to_string())?;
        }
        sync_caddy(&state)?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn start_instance(
    app: AppHandle,
    app_id: String,
    worktree_path: String,
) -> Result<AppInstance, String> {
    tokio::task::spawn_blocking(move || start_instance_inner(&app, app_id, worktree_path))
        .await
        .map_err(|e| e.to_string())?
}

fn start_instance_inner(
    app: &AppHandle,
    app_id: String,
    worktree_path: String,
) -> Result<AppInstance, String> {
    let state = app.state::<AppState>();

    // 1. Load the parent app (no get-by-id in the repo; filter list_apps).
    let app_row = {
        let db = state.db.lock().unwrap();
        db.list_apps().map_err(|e| e.to_string())?
            .into_iter().find(|a| a.id == app_id)
            .ok_or_else(|| "app not found".to_string())?
    };

    // 2. v1 scope: process apps only.
    if app_row.kind != "process" {
        return Err(format!("run-from-worktree supports process apps only (kind = {})", app_row.kind));
    }
    if app_row.start_command.trim().is_empty() {
        return Err("app has no start command".to_string());
    }

    // 3. Resolve the branch for this worktree from discovery.
    let branch = worktree_list_for(&app_row.root_dir)?
        .into_iter()
        .find(|w| w.path == worktree_path)
        .and_then(|w| w.branch)
        .ok_or_else(|| "worktree has no branch (detached or not found)".to_string())?;

    let iid = instance_id(&app_id, &branch);

    // Re-running an existing instance: if it's already tracked, reject; if it's
    // a stale stopped row, remove it first so we start clean.
    {
        let existing = {
            let db = state.db.lock().unwrap();
            db.list_instances_for(&app_id).map_err(|e| e.to_string())?
        };
        if let Some(prev) = existing.into_iter().find(|i| i.id == iid) {
            if state.processes.is_running(&iid) {
                return Err("instance already running".to_string());
            }
            let mut db = state.db.lock().unwrap();
            db.delete_instance(&prev.id).map_err(|e| e.to_string())?;
        }
    }

    // 4. Allocate a distinct port.
    let port = {
        let db = state.db.lock().unwrap();
        let used = db.used_ports().map_err(|e| e.to_string())?;
        find_available_port(&used, 3000, 9999).ok_or_else(|| "no free port".to_string())?
    };

    // 5. Compute subdomain (disambiguate against existing app/instance labels).
    let app_sub = app_row.subdomain.as_deref().unwrap_or(&app_row.name);
    let subdomain = {
        let db = state.db.lock().unwrap();
        let taken: Vec<String> = db.list_instances().map_err(|e| e.to_string())?
            .into_iter().map(|i| i.subdomain).collect();
        disambiguate(instance_subdomain(app_sub, &branch), &taken)
    };

    // 6. Insert the row (status "starting").
    let instance = AppInstance {
        id: iid.clone(), app_id: app_id.clone(), worktree_path: worktree_path.clone(),
        branch: branch.clone(), subdomain, port, pid: None, status: "starting".into(),
    };
    {
        let mut db = state.db.lock().unwrap();
        db.insert_instance(&instance).map_err(|e| e.to_string())?;
    }

    // 7. Spawn: reuse the app's start_command, cwd = worktree, PORT = new port.
    let log_handle = app.clone();
    let log_id = iid.clone();
    let on_log = move |line: String| { log_handle.emit(&format!("instance:log:{}", log_id), line).ok(); };

    let exit_handle = app.clone();
    let exit_id = iid.clone();
    // No auto-restart for instances in v1: mark stopped, drop the Caddy route.
    let on_exit = move |code: i32, _intentional: bool| {
        let st = exit_handle.state::<AppState>();
        st.db.lock().unwrap().update_instance_status_only(&exit_id, "stopped").ok();
        sync_caddy(&st).ok();
        exit_handle.emit(&format!("instance:exit:{}", exit_id), code).ok();
    };

    let pid = state.processes.start(
        &iid,
        &app_row.start_command,
        std::path::Path::new(&worktree_path),
        port,
        app_row.env_file.as_deref(),
        &app_row.env_vars,
        true,
        on_log,
        on_exit,
    ).map_err(|e| e.to_string())?;

    {
        let db = state.db.lock().unwrap();
        db.update_instance_status(&iid, "starting", Some(pid)).map_err(|e| e.to_string())?;
    }

    // 8. Add the Caddy route now that the row exists, then watch the port.
    sync_caddy(&state)?;
    spawn_instance_port_watcher(app.clone(), iid.clone(), port);

    // Return the freshly-inserted instance (with pid).
    let db = state.db.lock().unwrap();
    let out = db.list_instances_for(&app_id).map_err(|e| e.to_string())?
        .into_iter().find(|i| i.id == iid)
        .ok_or_else(|| "instance vanished".to_string())?;
    Ok(out)
}

/// Append `-2`, `-3`, … until the label is unique against `taken`.
fn disambiguate(base: String, taken: &[String]) -> String {
    if !taken.contains(&base) { return base; }
    for n in 2..1000 {
        let cand = format!("{base}-{n}");
        if !taken.contains(&cand) { return cand; }
    }
    base
}

/// Poll the instance's port; flip "starting" → "running" and emit ready.
fn spawn_instance_port_watcher(app: AppHandle, iid: String, port: u16) {
    std::thread::spawn(move || {
        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
        for _ in 0..120 {
            std::thread::sleep(std::time::Duration::from_millis(500));
            let state = app.state::<AppState>();
            let still_starting = state.db.lock().ok()
                .and_then(|db| db.list_instances().ok())
                .and_then(|is| is.into_iter().find(|i| i.id == iid).map(|i| i.status))
                .map(|s| s == "starting").unwrap_or(false);
            if !still_starting { return; }
            if std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(300)).is_ok() {
                state.db.lock().unwrap().update_instance_status_only(&iid, "running").ok();
                app.emit(&format!("instance:ready:{}", iid), ()).ok();
                return;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_branch_detached_and_bare() {
        let out = "\
worktree /repo
HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
branch refs/heads/main

worktree /repo/.wt/feature
HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
branch refs/heads/feature/x

worktree /repo/.wt/detached
HEAD cccccccccccccccccccccccccccccccccccccccc
detached
";
        let got = parse_worktree_porcelain(out);
        assert_eq!(got.len(), 3);
        assert_eq!(got[0].branch.as_deref(), Some("main"));
        assert!(!got[0].detached);
        assert_eq!(got[1].branch.as_deref(), Some("feature/x"));
        assert_eq!(got[1].path, "/repo/.wt/feature");
        assert_eq!(got[2].branch, None);
        assert!(got[2].detached);
    }

    #[test]
    fn empty_input_yields_no_entries() {
        assert!(parse_worktree_porcelain("").is_empty());
    }

    #[test]
    fn worktree_list_command_pins_the_locale() {
        // `stderr.contains("not a git repository")` matches English stderr. A git
        // built with NLS (Homebrew's is) would translate it, and every non-repo
        // folder would start returning an error. This machine's Apple Git may have
        // no NLS, so a behavioural test would pass for the wrong reason — assert
        // on the spawned command instead.
        let cmd = worktree_list_command("git", "/tmp");
        let has_lc_all = cmd
            .get_envs()
            .any(|(k, v)| k == std::ffi::OsStr::new("LC_ALL") && v == Some(std::ffi::OsStr::new("C")));
        assert!(has_lc_all, "worktree list command must pin LC_ALL=C");
    }

    #[test]
    fn sanitize_label_handles_slashes_and_case() {
        assert_eq!(sanitize_label("codex/Event-Organizer_Migration"),
                   "codex-event-organizer-migration");
        assert_eq!(sanitize_label("feat//x--y"), "feat-x-y");
        assert_eq!(sanitize_label("-trim-"), "trim");
    }

    #[test]
    fn builds_subdomain_and_id() {
        assert_eq!(instance_subdomain("eventorg", "codex/migration"),
                   "eventorg-codex-migration");
        assert_eq!(instance_id("app123", "feature/x"), "app123:feature-x");
    }

    #[test]
    fn process_manager_tracks_two_instances_of_one_app() {
        use crate::process_manager::ProcessManager;
        use std::collections::HashMap;
        use std::path::Path;

        let pm = ProcessManager::new();
        let env: HashMap<String, String> = HashMap::new();
        // Two long-lived shells under two distinct instance keys for one app.
        let k1 = instance_id("appX", "feature/a");
        let k2 = instance_id("appX", "feature/b");
        let noop_log = |_l: String| {};
        pm.start(&k1, "sleep 30", Path::new("/tmp"), 6101, None, &env, true, noop_log, |_c, _i| {}).unwrap();
        pm.start(&k2, "sleep 30", Path::new("/tmp"), 6102, None, &env, true, |_l| {}, |_c, _i| {}).unwrap();

        // Both keys are tracked simultaneously — the multi-instance guarantee.
        assert!(pm.is_running(&k1));
        assert!(pm.is_running(&k2));
        assert_ne!(k1, k2);

        pm.stop(&k1).ok();
        pm.stop(&k2).ok();
    }
}
