//! Discover existing git worktrees of an app's repo and run the app from them
//! as isolated instances. Porta never creates or removes worktrees — it only
//! reads `git worktree list` and runs from what already exists.

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

/// Stop an instance's process but KEEP its row (marked "stopped"), so the card
/// stays put and the user can re-run, kill a stuck port, or remove it
/// deliberately. Mirrors how a stopped primary app behaves — the process dies,
/// the row and its port reservation remain. Removal is a separate, explicit
/// action (`remove_instance`).
#[tauri::command]
pub async fn stop_instance(app: AppHandle, instance_id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
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

/// Remove an instance for good: stop its process (no-op if already dead), drop
/// the row + free the port, then rebuild Caddy so the route vanishes. This is
/// the destructive counterpart to `stop_instance`.
#[tauri::command]
pub async fn remove_instance(app: AppHandle, instance_id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
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

    let pid = match state.processes.start(
        &iid,
        &app_row.start_command,
        std::path::Path::new(&worktree_path),
        port,
        env_file_abs.as_deref(),
        &app_row.env_vars,
        true,
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
    spawn_instance_port_watcher(app.clone(), iid.clone(), port);

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

/// Poll the instance's port; flip "starting" → "running" and emit ready.
fn spawn_instance_port_watcher(app: AppHandle, iid: String, port: u16) {
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

        for _ in 0..120 {
            std::thread::sleep(std::time::Duration::from_millis(500));
            if !still_starting(&app) { return; }
            if std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(300)).is_ok() {
                resolve(&app);
                return;
            }
        }
        // Timeout fallback — the port never opened. Only resolve if the user is
        // still expecting a startup; otherwise a stop already happened and we'd
        // flip the dot back to running. Mirrors `spawn_port_watcher` in
        // app_lifecycle.rs so the UI never stays stuck on "starting".
        if still_starting(&app) {
            resolve(&app);
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
        pm.start(&k1, "sleep 30", Path::new("/tmp"), 6101, None, &env, true, noop_log, |_c, _i| {}).unwrap();
        pm.start(&k2, "sleep 30", Path::new("/tmp"), 6102, None, &env, true, |_l| {}, |_c, _i| {}).unwrap();

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
