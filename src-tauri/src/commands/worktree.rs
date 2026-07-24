//! Discover git worktrees of an app's repo and run the app from them as
//! isolated instances. Porta reads `git worktree list`, can create a worktree
//! for a branch (`git_worktree_add`) so an instance can be launched by branch,
//! and runs the app from a worktree path.

use crate::app_state::AppState;
use crate::commands::git::git_bin;
use crate::commands::setup::sync_caddy;
use crate::db::models::AppInstance;
use crate::db::Database;
use crate::port_scanner::find_available_port;
use std::path::Path;
use std::process::Command;
use std::sync::Mutex;
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

/// Longest branch part kept in a host label. Past this a name stops being
/// readable at a glance and starts being a thing you scroll past.
const MAX_BRANCH_LABEL: usize = 20;

/// The short, typeable part of a branch name. Branches are namespaced
/// (`codex/…`, `feature/…`, `users/me/…`) and the namespace carries no
/// information once the label is already scoped by the app — so keep the last
/// segment and cap its length. Collisions between two branches that shorten to
/// the same thing are handled by `pick_instance_subdomain`'s `-2` suffix.
fn short_branch_label(branch: &str) -> String {
    let tail = branch.rsplit('/').find(|s| !s.trim().is_empty()).unwrap_or(branch);
    let mut label = sanitize_label(tail);
    if label.is_empty() {
        label = sanitize_label(branch);
    }
    if label.len() > MAX_BRANCH_LABEL {
        // Prefer cutting on a word boundary, but not if that leaves a stub.
        let cut = label[..MAX_BRANCH_LABEL].rfind('-').filter(|i| *i >= 6).unwrap_or(MAX_BRANCH_LABEL);
        label.truncate(cut);
        label = label.trim_matches('-').to_string();
    }
    label
}

/// `<app-subdomain>-<short-branch>` — the instance's DNS label. Deliberately
/// not the full branch: the row and the workbench header both show that in
/// full, while this ends up in a URL the user types.
fn instance_subdomain(app_sub: &str, branch: &str) -> String {
    sanitize_label(&format!("{app_sub}-{}", short_branch_label(branch)))
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

/// Does `ref_name` (a full ref path like `refs/heads/main`) exist in the repo?
fn ref_exists(bin: &str, root_dir: &str, ref_name: &str) -> bool {
    Command::new(bin)
        .current_dir(root_dir)
        .env("LC_ALL", "C")
        .args(["show-ref", "--verify", "--quiet", ref_name])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Argv for `git worktree add`, split out so the three shapes are testable
/// without a repo:
///
/// * new branch off HEAD — `-b <local> <path>`
/// * new local branch off a remote-tracking ref — `-b <local> <path> origin/x`
///   (git sets up tracking, so the instance is push/pull-ready)
/// * existing local branch — `<path> <local>`
fn worktree_add_args<'a>(
    wt_path: &'a str,
    local: &'a str,
    start_point: Option<&'a str>,
    create_new: bool,
) -> Vec<&'a str> {
    let mut args = vec!["worktree", "add"];
    if create_new || start_point.is_some() {
        args.extend_from_slice(&["-b", local, wt_path]);
        if let Some(sp) = start_point {
            args.push(sp);
        }
    } else {
        args.extend_from_slice(&[wt_path, local]);
    }
    args
}

/// Create a git worktree for `branch` (checking out an existing branch, or with
/// `create_new` making a new branch off HEAD), placed in a sibling
/// `<repo>-worktrees/<sanitized-branch>` directory. Returns the freshly-created
/// worktree entry so the caller can immediately run an instance from it.
///
/// `branch` may also be a remote-tracking name (`origin/feature`) — the picker
/// offers those directly after a fetch, since a teammate's branch has no local
/// ref yet. We then create the local branch off it rather than failing, which is
/// what `git worktree add <path> origin/feature` would otherwise do (detached).
#[tauri::command]
pub async fn git_worktree_add(
    root_dir: String,
    branch: String,
    create_new: bool,
) -> Result<WorktreeEntry, String> {
    tokio::task::spawn_blocking(move || worktree_add_for(&root_dir, &branch, create_new))
        .await
        .map_err(|e| e.to_string())?
}

fn worktree_add_for(root_dir: &str, branch: &str, create_new: bool) -> Result<WorktreeEntry, String> {
    let bin = git_bin().ok_or_else(|| "git not found".to_string())?;
    let root = Path::new(root_dir);
    if !root.is_dir() {
        return Err("app root directory not found".to_string());
    }
    if branch.trim().is_empty() {
        return Err("branch name is required".to_string());
    }

    // Resolve what was asked for. A name with no local ref but a matching
    // remote-tracking ref is a branch we've only ever fetched: check it out as a
    // local branch of the same short name, off the remote ref.
    let mut local = branch.to_string();
    let mut start_point: Option<String> = None;
    if !create_new
        && !ref_exists(bin, root_dir, &format!("refs/heads/{branch}"))
        && ref_exists(bin, root_dir, &format!("refs/remotes/{branch}"))
    {
        let short = branch.split_once('/').map(|(_, rest)| rest).unwrap_or(branch);
        // `origin/main` when `main` already exists locally is just that branch.
        if ref_exists(bin, root_dir, &format!("refs/heads/{short}")) {
            local = short.to_string();
        } else {
            local = short.to_string();
            start_point = Some(branch.to_string());
        }
    }
    let branch = local.as_str();

    let repo_name = root
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("repo");
    let parent = root
        .parent()
        .ok_or_else(|| "cannot resolve the repo's parent directory".to_string())?;
    let wt_root = parent.join(format!("{repo_name}-worktrees"));
    let wt_path = wt_root.join(sanitize_label(branch));
    std::fs::create_dir_all(&wt_root).map_err(|e| e.to_string())?;
    let wt_path_str = wt_path
        .to_str()
        .ok_or_else(|| "worktree path is not valid UTF-8".to_string())?
        .to_string();

    let args = worktree_add_args(&wt_path_str, branch, start_point.as_deref(), create_new);

    let out = Command::new(bin)
        .current_dir(root_dir)
        .env("LC_ALL", "C")
        .args(&args)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }

    worktree_list_for(root_dir)?
        .into_iter()
        .find(|w| w.path == wt_path_str)
        .ok_or_else(|| "worktree was created but did not appear in the list".to_string())
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

/// Stop an instance's process but KEEP its row (marked "stopped"), so the card
/// stays put and the user can re-run, kill a stuck port, or remove it
/// deliberately. Mirrors how a stopped primary app behaves — the process dies,
/// the row and its port reservation remain. Removal is a separate, explicit
/// action (`remove_instance`).
#[tauri::command]
pub async fn stop_instance(app: AppHandle, instance_id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
        // Tear down its tunnel first (drops it from a shared named connector or
        // kills its quick child) — the worktree port is about to go away.
        crate::commands::tunnel::stop_instance_tunnel(instance_id.clone(), app.clone()).ok();
        // Kill the process under the instance key (no-op if already exited).
        state.processes.stop(&instance_id).map_err(|e| e.to_string())?;
        // Keep the row; just flip it to "stopped". (The process's on_exit hook
        // also does this, but setting it here makes Stop deterministic instead
        // of racing the async exit callback.)
        {
            let db = state.db.lock().unwrap();
            db.update_instance_status_only(&instance_id, "stopped")
                .map_err(|e| e.to_string())?;
        }
        sync_caddy(&state)?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Force-kill an instance's process (SIGKILL, no graceful shutdown), then flip
/// its row to "stopped" — the SIGKILL counterpart to `stop_instance`. Keeps the
/// row + port reservation, same as Stop; removal is still a separate action.
#[tauri::command]
pub async fn kill_instance(app: AppHandle, instance_id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
        // Tear down its tunnel first — the worktree port is about to go away.
        crate::commands::tunnel::stop_instance_tunnel(instance_id.clone(), app.clone()).ok();
        // SIGKILL the process tree under the instance key (no-op if already dead).
        state.processes.kill(&instance_id).map_err(|e| e.to_string())?;
        {
            let db = state.db.lock().unwrap();
            db.update_instance_status_only(&instance_id, "stopped")
                .map_err(|e| e.to_string())?;
        }
        sync_caddy(&state)?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Remove an instance for good: stop its process (no-op if already dead), drop
/// the row + free the port, then rebuild Caddy so the route vanishes. This is
/// the destructive counterpart to `stop_instance`.
#[tauri::command]
pub async fn remove_instance(app: AppHandle, instance_id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
        // Drop it from any shared named tunnel (or kill its quick child) while
        // the row still exists so we can resolve its parent + channel.
        crate::commands::tunnel::stop_instance_tunnel(instance_id.clone(), app.clone()).ok();
        state.processes.stop(&instance_id).map_err(|e| e.to_string())?;
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

    // 5. Compute subdomain. An instance's Caddy host is
    //    `<label>.<parent app's effective domain>`, and a primary app owns
    //    `<its label>.<its domain>` — so the instance label must dodge not just
    //    other instance labels but every primary app label sharing this domain,
    //    or Caddy would emit two routes for one host.
    let app_sub = app_row.subdomain.as_deref().unwrap_or(&app_row.name);
    let subdomain = {
        let db = state.db.lock().unwrap();
        let workspaces = db.list_workspaces().map_err(|e| e.to_string())?;
        let domain = app_row.effective_domain(&workspaces);
        let instance_labels: Vec<String> = db.list_instances().map_err(|e| e.to_string())?
            .into_iter().map(|i| i.subdomain).collect();
        let app_hosts: Vec<(String, String)> = db.list_apps().map_err(|e| e.to_string())?
            .into_iter()
            .map(|a| {
                let label = a.subdomain.clone().unwrap_or_else(|| a.name.clone());
                let d = a.effective_domain(&workspaces);
                (label, d)
            })
            .collect();
        pick_instance_subdomain(
            instance_subdomain(app_sub, &branch),
            &domain,
            &instance_labels,
            &app_hosts,
        )
    };

    // 6. Allocate a free port and insert the "starting" row as ONE atomic step,
    //    guarded by `instance_alloc_lock`. Doing the port read and the insert
    //    under one guard closes the TOCTOU window where two concurrent starts
    //    (even for different apps) both read the same free port before either
    //    reserves it in `port_registry`, leaving one process unable to bind.
    let instance = allocate_and_insert_instance(
        &state.db,
        &state.instance_alloc_lock,
        AppInstance {
            id: iid.clone(),
            app_id: app_id.clone(),
            worktree_path: worktree_path.clone(),
            branch: branch.clone(),
            subdomain,
            port: 0, // replaced with a free port chosen under the lock
            pid: None,
            status: "starting".into(),
        },
    )?;
    let port = instance.port;

    // 7. Spawn: reuse the app's start_command, cwd = worktree, PORT = new port.
    let log_handle = app.clone();
    let log_id = iid.clone();
    let on_log = move |line: String| { log_handle.emit(&format!("instance:log:{}", log_id), line).ok(); };

    let exit_handle = app.clone();
    let exit_id = iid.clone();
    // No auto-restart for instances in v1: mark stopped, drop the Caddy route.
    // Report exit 0 for an intentional Stop so the row (which now persists)
    // doesn't render a spurious crash banner; a real crash keeps its code.
    // Mirrors the primary app's on_exit `is_stop` handling.
    let on_exit = move |code: i32, intentional: bool| {
        let reported = if intentional { 0 } else { code };
        let st = exit_handle.state::<AppState>();
        st.db.lock().unwrap().update_instance_status_only(&exit_id, "stopped").ok();
        sync_caddy(&st).ok();
        exit_handle.emit(&format!("instance:exit:{}", exit_id), reported).ok();
    };

    // Instances run with cwd = the worktree, but `.env` is gitignored so a fresh
    // worktree checkout doesn't have one. A `source .env` in the start command
    // (or any relative file read) then fails with "no such file". Symlink the
    // parent app's env file(s) into the worktree so the shell command AND
    // Porta's env injection resolve against the parent's copy — "refer
    // everything from the parent". Best-effort: a missing parent file or an
    // already-present worktree file is left untouched.
    #[cfg(unix)]
    {
        let mut names: Vec<&str> = vec![".env"];
        if let Some(ef) = app_row.env_file.as_deref() {
            if std::path::Path::new(ef).is_relative() && !names.contains(&ef) {
                names.push(ef);
            }
        }
        for name in names {
            let parent_env = std::path::Path::new(&app_row.root_dir).join(name);
            let wt_env = std::path::Path::new(&worktree_path).join(name);
            // symlink_metadata (unlike exists) doesn't follow links, so an
            // existing symlink — even a broken one — counts as "already there".
            if parent_env.exists() && wt_env.symlink_metadata().is_err() {
                let _ = std::os::unix::fs::symlink(&parent_env, &wt_env);
            }
        }
    }

    // Same "refer everything from the parent" rule, applied to mise's trust
    // store — see `inherit_mise_trust`.
    inherit_mise_trust(&app_row.root_dir, &worktree_path);

    // Also hand Porta's own env injection an absolute path resolved against the
    // parent, so it works regardless of the symlink above.
    let env_file_abs = app_row.env_file.as_deref().map(|ef| {
        let p = std::path::Path::new(ef);
        if p.is_absolute() {
            ef.to_string()
        } else {
            std::path::Path::new(&app_row.root_dir)
                .join(ef)
                .to_string_lossy()
                .into_owned()
        }
    });

    // Deliberately the app's own command, not the active run profile's override:
    // a fresh worktree has no build artifacts, so a "prod" profile's
    // `bin/app start` would launch against nothing. Instances are dev previews.
    let pid = match state.processes.start(
        &iid,
        &app_row.start_command,
        std::path::Path::new(&worktree_path),
        port,
        env_file_abs.as_deref(),
        &app_row.env_vars,
        crate::process_manager::LogStart::Fresh,
        on_log,
        on_exit,
    ) {
        Ok(pid) => pid,
        Err(e) => {
            // Spawn failed — roll back the row we inserted so we don't leak a
            // ghost "starting" instance and a permanently-reserved port
            // (delete_instance removes both the row and its port_registry entry).
            let mut db = state.db.lock().unwrap();
            let _ = db.delete_instance(&iid);
            return Err(e.to_string());
        }
    };

    {
        let db = state.db.lock().unwrap();
        db.update_instance_status(&iid, "starting", Some(pid)).map_err(|e| e.to_string())?;
    }

    // 8. Add the Caddy route now that the row exists, then watch the port.
    sync_caddy(&state)?;
    spawn_instance_port_watcher(
        app.clone(),
        iid.clone(),
        port,
        app_row.health_check_path.clone(),
    );

    // Return the freshly-inserted instance (with pid).
    let db = state.db.lock().unwrap();
    let out = db.list_instances_for(&app_id).map_err(|e| e.to_string())?
        .into_iter().find(|i| i.id == iid)
        .ok_or_else(|| "instance vanished".to_string())?;
    Ok(out)
}

/// Pick a free port for `instance` and insert its row atomically.
///
/// `alloc_lock` is held across the whole read → insert so two concurrent
/// `start_instance` calls can't both read the same free port from
/// `used_ports()` before either reserves it via `insert_instance` (which writes
/// `port_registry`). Primary apps get this serialization for free from their
/// per-id `lifecycle_lock`; instances need a lock too, but a *shared* one — the
/// racing callers are different apps/instances with different ids, so a per-id
/// lock wouldn't make them contend. `find_available_port` also binds a probe
/// socket per candidate, so the `db` lock is released across it — the alloc
/// lock alone provides the mutual exclusion, without blocking unrelated DB work.
fn allocate_and_insert_instance(
    db: &Mutex<Database>,
    alloc_lock: &Mutex<()>,
    mut instance: AppInstance,
) -> Result<AppInstance, String> {
    let _alloc = alloc_lock.lock().unwrap_or_else(|e| e.into_inner());
    let used = {
        let db = db.lock().unwrap();
        db.used_ports().map_err(|e| e.to_string())?
    };
    instance.port =
        find_available_port(&used, 3000, 9999).ok_or_else(|| "no free port".to_string())?;
    db.lock().unwrap().insert_instance(&instance).map_err(|e| e.to_string())?;
    Ok(instance)
}

// ── mise trust inheritance ─────────────────────────────────────────────────

/// Project config files mise checks trust for. `.tool-versions` is included:
/// asdf-style files go through the same gate.
const MISE_CONFIG_FILES: [&str; 7] = [
    "mise.toml",
    ".mise.toml",
    "mise.local.toml",
    ".mise.local.toml",
    ".config/mise.toml",
    ".mise/config.toml",
    ".tool-versions",
];

fn has_mise_config(dir: &str) -> bool {
    MISE_CONFIG_FILES
        .iter()
        .any(|f| Path::new(dir).join(f).exists())
}

/// mise's own binary. `~/.local/bin` first — that's where mise's installer puts
/// it, and it's the one location a GUI app's PATH is guaranteed to miss.
fn find_mise() -> Option<String> {
    if let Some(home) = std::env::var_os("HOME") {
        let p = Path::new(&home).join(".local/bin/mise");
        if p.exists() {
            return Some(p.to_string_lossy().into_owned());
        }
    }
    for p in ["/opt/homebrew/bin/mise", "/usr/local/bin/mise"] {
        if Path::new(p).exists() {
            return Some(p.to_string());
        }
    }
    let out = Command::new("/usr/bin/which").arg("mise").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!path.is_empty()).then_some(path)
}

/// Is every config `mise trust --show` listed for a directory trusted?
///
/// Output is one `<path>: trusted` / `<path>: untrusted` per line, covering the
/// directory *and its parents*. Note "untrusted" ends in "trusted", so the test
/// has to be on the whole suffix — matching `contains("trusted")` would call an
/// untrusted config trusted. An empty listing is not "all trusted": there is
/// simply nothing to go on, so it reports false.
fn mise_all_trusted(show_output: &str) -> bool {
    let mut saw_any = false;
    for line in show_output.lines() {
        let line = line.trim();
        if line.ends_with(": untrusted") {
            return false;
        }
        if line.ends_with(": trusted") {
            saw_any = true;
        }
    }
    saw_any
}

/// Mirror the primary checkout's mise trust onto a worktree.
///
/// mise trusts a config *by path*, and a worktree is a new path — so the first
/// run of every fresh branch instance of a mise-managed repo died with "Config
/// files … are not trusted", then `command not found: mix` once mise refused to
/// load the toolchain. The user had to go trust it by hand, per branch, forever.
///
/// The worktree is a checkout of the repo whose start command Porta is about to
/// run in it regardless, so trusting its config grants nothing that starting the
/// instance doesn't already grant.
///
/// What this deliberately will not do is widen trust the user never gave: if the
/// primary checkout is itself untrusted, the worktree is left alone and the
/// crash banner's `mise trust` action handles it as a visible choice. Entirely
/// best-effort — no mise, no config, or any command failing just means the
/// instance starts exactly as it did before.
fn inherit_mise_trust(parent_root: &str, worktree: &str) {
    if !has_mise_config(worktree) {
        return;
    }
    let Some(mise) = find_mise() else { return };

    let show = |dir: &str| -> Option<String> {
        let out = Command::new(&mise)
            .args(["trust", "--show", "-C", dir])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        // mise writes the listing to stdout and its warnings to stderr; read
        // both so a version that moves the listing doesn't silently no-op.
        Some(format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        ))
    };

    // Re-running an instance we already trusted: nothing to do.
    match show(worktree) {
        Some(out) if mise_all_trusted(&out) => return,
        None => return,
        _ => {}
    }
    // Only mirror what the primary checkout already has.
    match show(parent_root) {
        Some(out) if mise_all_trusted(&out) => {}
        _ => return,
    }
    let _ = Command::new(&mise).args(["trust", "-C", worktree]).output();
}

/// Pick a unique instance subdomain label. An instance's Caddy host is
/// `<label>.<domain>`, so the label must avoid every existing instance label
/// *and* every primary app label that resolves to the same `domain` — otherwise
/// Caddy would front two routes on one host. `app_hosts` is `(label, domain)`
/// per primary app; only those in `domain` are collision candidates.
fn pick_instance_subdomain(
    base: String,
    domain: &str,
    instance_labels: &[String],
    app_hosts: &[(String, String)],
) -> String {
    let mut taken: Vec<String> = instance_labels.to_vec();
    taken.extend(
        app_hosts
            .iter()
            .filter(|(_, d)| d == domain)
            .map(|(label, _)| label.clone()),
    );
    disambiguate(base, &taken)
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

/// Poll the instance until it is actually serving, then flip
/// "starting" → "running" and emit ready. This mirrors the primary app
/// watcher: a TCP bind alone is too early for frameworks that open their
/// listener before routes/build output are ready.
fn spawn_instance_port_watcher(
    app: AppHandle,
    iid: String,
    port: u16,
    health_check_path: Option<String>,
) {
    std::thread::spawn(move || {
        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));

        let still_starting = |app: &AppHandle| -> bool {
            let state = app.state::<AppState>();
            state.db.lock().ok()
                .and_then(|db| db.list_instances().ok())
                .and_then(|is| is.into_iter().find(|i| i.id == iid).map(|i| i.status))
                .map(|s| s == "starting").unwrap_or(false)
        };

        let resolve = |app: &AppHandle| {
            let state = app.state::<AppState>();
            state.db.lock().unwrap().update_instance_status_only(&iid, "running").ok();
            app.emit(&format!("instance:ready:{}", iid), ()).ok();
        };

        loop {
            std::thread::sleep(std::time::Duration::from_millis(500));
            if !still_starting(&app) { return; }
            if std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(300)).is_err() {
                continue;
            }
            let ready = match health_check_path.as_deref() {
                Some(path) => {
                    crate::health::check_health(port, Some(path))
                        == crate::health::HealthStatus::Healthy
                }
                None => {
                    crate::health::probe_http_root(port) == crate::health::HttpProbe::Responded
                }
            };
            if ready {
                resolve(&app);
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
    fn worktree_add_args_cover_the_three_shapes() {
        assert_eq!(
            worktree_add_args("/wt/feat", "feat", None, true),
            vec!["worktree", "add", "-b", "feat", "/wt/feat"],
        );
        assert_eq!(
            worktree_add_args("/wt/feat", "feat", None, false),
            vec!["worktree", "add", "/wt/feat", "feat"],
        );
        // Remote-only branch: create the local one off the tracking ref, or the
        // worktree would land on a detached HEAD with no upstream.
        assert_eq!(
            worktree_add_args("/wt/feat", "feat", Some("origin/feat"), false),
            vec!["worktree", "add", "-b", "feat", "/wt/feat", "origin/feat"],
        );
    }

    #[test]
    fn builds_subdomain_and_id() {
        // Label drops the branch namespace; the id keeps the full branch so two
        // branches that shorten alike still get distinct process keys.
        assert_eq!(instance_subdomain("eventorg", "codex/migration"),
                   "eventorg-migration");
        assert_eq!(instance_id("app123", "feature/x"), "app123:feature-x");
    }

    #[test]
    fn mise_trust_listing_distinguishes_untrusted_from_trusted() {
        // "untrusted" ends in "trusted" — a substring check here would trust a
        // worktree mise explicitly refused, which is the one outcome this
        // function exists to prevent.
        assert!(mise_all_trusted("~/projects/app: trusted\n~/projects: trusted\n"));
        assert!(!mise_all_trusted("~/projects/app: untrusted\n"));
        assert!(!mise_all_trusted(
            "~/projects: trusted\n~/projects/app-worktrees/feat-x: untrusted\n"
        ));
        // Nothing listed is not a yes.
        assert!(!mise_all_trusted(""));
        assert!(!mise_all_trusted("mise WARN  a newer version is available\n"));
    }

    #[test]
    fn mise_config_detection_covers_the_nested_layouts() {
        let dir = std::env::temp_dir().join(format!("porta-mise-{}", std::process::id()));
        std::fs::create_dir_all(dir.join(".config")).unwrap();
        let path = dir.to_string_lossy().into_owned();
        assert!(!has_mise_config(&path));
        std::fs::write(dir.join(".config/mise.toml"), "[tools]\n").unwrap();
        assert!(has_mise_config(&path));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn short_branch_label_trims_namespace_and_length() {
        assert_eq!(short_branch_label("main"), "main");
        assert_eq!(short_branch_label("feature/checkout"), "checkout");
        assert_eq!(short_branch_label("users/nasrul/fix-login"), "fix-login");
        // Over the cap: cut on the last dash that still leaves something useful.
        assert_eq!(
            short_branch_label("codex/rework-the-entire-billing-pipeline"),
            "rework-the-entire",
        );
        // No dash to cut on — a hard truncate beats an unreadable label.
        assert_eq!(short_branch_label(&"a".repeat(30)), "a".repeat(20));
        // Trailing slash: don't end up with an empty label.
        assert_eq!(short_branch_label("feature/"), "feature");
    }

    #[test]
    fn instance_subdomain_dodges_a_primary_app_host_in_the_same_domain() {
        // A primary app already owns `eventorg-codex-migration.narakarya.test`.
        // An instance whose label lands there must be bumped, or Caddy would
        // front two routes on one host.
        let app_hosts = vec![
            ("eventorg".into(), "narakarya.test".into()),
            ("eventorg-codex-migration".into(), "narakarya.test".into()),
        ];
        let got = pick_instance_subdomain(
            "eventorg-codex-migration".into(),
            "narakarya.test",
            &[],
            &app_hosts,
        );
        assert_eq!(got, "eventorg-codex-migration-2");
    }

    #[test]
    fn instance_subdomain_ignores_same_label_in_a_different_domain() {
        // Same label but another domain is a different host — no collision, so
        // no needless `-2` suffix.
        let app_hosts = vec![("eventorg-codex-migration".into(), "other.test".into())];
        let got = pick_instance_subdomain(
            "eventorg-codex-migration".into(),
            "narakarya.test",
            &[],
            &app_hosts,
        );
        assert_eq!(got, "eventorg-codex-migration");
    }

    #[test]
    fn instance_subdomain_still_dodges_other_instance_labels() {
        let got = pick_instance_subdomain(
            "eventorg-codex-migration".into(),
            "narakarya.test",
            &["eventorg-codex-migration".to_string()],
            &[],
        );
        assert_eq!(got, "eventorg-codex-migration-2");
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
        pm.start(&k1, "sleep 30", Path::new("/tmp"), 6101, None, &env, crate::process_manager::LogStart::Fresh, noop_log, |_c, _i| {}).unwrap();
        pm.start(&k2, "sleep 30", Path::new("/tmp"), 6102, None, &env, crate::process_manager::LogStart::Fresh, |_l| {}, |_c, _i| {}).unwrap();

        // Both keys are tracked simultaneously — the multi-instance guarantee.
        assert!(pm.is_running(&k1));
        assert!(pm.is_running(&k2));
        assert_ne!(k1, k2);

        pm.stop(&k1).ok();
        pm.stop(&k2).ok();
    }

    #[test]
    fn concurrent_allocations_never_share_a_port() {
        use std::sync::{Arc, Barrier};
        use std::thread;

        // Shared registry + the shared allocation lock, exactly as AppState holds
        // them. Without the lock, the read-used-ports → insert window lets two
        // starts pick the same free port; the lock must make every start distinct.
        const N: usize = 16;

        let db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        // Seed the parent app rows — `insert_instance` has an FK to `apps`.
        for i in 0..N {
            db.conn
                .execute(
                    "INSERT INTO apps (id, name, root_dir, port) VALUES (?1, 'a', '/tmp', ?2)",
                    rusqlite::params![format!("app{i}"), 4000 + i as i64],
                )
                .unwrap();
        }
        let db = Arc::new(Mutex::new(db));
        let alloc = Arc::new(Mutex::new(()));

        // A barrier lines every thread up on the allocate→insert window at once,
        // maximizing contention so a missing lock would collide, not pass by luck.
        let barrier = Arc::new(Barrier::new(N));

        let handles: Vec<_> = (0..N)
            .map(|i| {
                let db = db.clone();
                let alloc = alloc.clone();
                let barrier = barrier.clone();
                thread::spawn(move || {
                    // Each thread is a start for a *different* app — the exact
                    // cross-app case a per-id lock wouldn't serialize.
                    let inst = AppInstance {
                        id: format!("app{i}:main"),
                        app_id: format!("app{i}"),
                        worktree_path: "/wt".into(),
                        branch: "main".into(),
                        subdomain: format!("app{i}"),
                        port: 0,
                        pid: None,
                        status: "starting".into(),
                    };
                    barrier.wait();
                    allocate_and_insert_instance(&db, &alloc, inst).unwrap().port
                })
            })
            .collect();

        let ports: Vec<u16> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        let unique: std::collections::BTreeSet<u16> = ports.iter().copied().collect();
        assert_eq!(
            unique.len(),
            N,
            "every concurrent start must get a distinct port, got {ports:?}"
        );
    }
}
