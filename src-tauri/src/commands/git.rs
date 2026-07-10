//! Git status + ops for app cards.
//!
//! We shell out to the `git` binary rather than link libgit2. The hard part of
//! this feature is credentials, not parsing: libgit2 ignores `Include` in
//! `~/.ssh/config` and the `osxkeychain` credential helper unless we reimplement
//! them ourselves. The CLI already speaks the user's git config.

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct GitStatus {
    /// Branch name, or a short SHA when HEAD is detached.
    pub branch: String,
    pub detached: bool,
    /// e.g. `origin/main`. `None` when the branch has no upstream configured.
    pub upstream: Option<String>,
    /// Commits to push. Always 0 when `upstream` is `None`.
    pub ahead: u32,
    /// Commits to pull. Only meaningful after a fetch — the remote-tracking ref
    /// is a frozen snapshot until then.
    pub behind: u32,
    /// Count of changed, renamed, unmerged, and untracked files.
    pub dirty: u32,
}

/// Parse `git status --porcelain=v2 --branch` output.
///
/// The `--porcelain` formats are contractually stable across git versions —
/// that is the whole point of them — so parsing here is safe in a way that
/// parsing `git status` prose would not be.
fn parse_porcelain_v2(out: &str) -> GitStatus {
    let mut oid = String::new();
    let mut head = String::new();
    let mut upstream = None;
    let mut ahead = 0;
    let mut behind = 0;
    let mut dirty = 0;

    for line in out.lines() {
        if let Some(rest) = line.strip_prefix("# branch.oid ") {
            oid = rest.trim().to_string();
        } else if let Some(rest) = line.strip_prefix("# branch.head ") {
            head = rest.trim().to_string();
        } else if let Some(rest) = line.strip_prefix("# branch.upstream ") {
            upstream = Some(rest.trim().to_string());
        } else if let Some(rest) = line.strip_prefix("# branch.ab ") {
            // Format: "+2 -5". Both fields always present when this line exists.
            for tok in rest.split_whitespace() {
                match tok.split_at(1) {
                    ("+", n) => ahead = n.parse().unwrap_or(0),
                    ("-", n) => behind = n.parse().unwrap_or(0),
                    _ => {}
                }
            }
        } else if line.starts_with("1 ")
            || line.starts_with("2 ")
            || line.starts_with("u ")
            || line.starts_with("? ")
        {
            dirty += 1;
        }
    }

    let detached = head == "(detached)";
    // A fresh repo with no commits reports `# branch.oid (initial)`; there is no
    // SHA to show, so fall back to the branch name git already gave us.
    let branch = if detached && oid.len() >= 7 {
        oid[..7].to_string()
    } else {
        head
    };

    GitStatus { branch, detached, upstream, ahead, behind, dirty }
}

use std::io::Read;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::Command;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::OnceLock;
use std::thread;
use std::time::Duration;
use std::time::Instant;
use tauri::{Emitter, Manager};

use crate::app_state::AppState;

/// Locate the `git` CLI. GUI apps on macOS don't inherit the user's shell PATH,
/// so we fall back to known install locations — same shape as `docker_bin()`
/// in `docker_manager.rs`.
pub(crate) fn git_bin() -> Option<&'static str> {
    static CACHED: OnceLock<Option<String>> = OnceLock::new();
    CACHED.get_or_init(find_git_cli).as_deref()
}

fn find_git_cli() -> Option<String> {
    if Command::new("git")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
    {
        return Some("git".into());
    }
    for path in [
        "/usr/bin/git",            // Xcode Command Line Tools
        "/opt/homebrew/bin/git",   // Homebrew (Apple Silicon)
        "/usr/local/bin/git",      // Homebrew (Intel)
    ] {
        if Path::new(path).exists() {
            return Some(path.to_string());
        }
    }
    None
}

/// Does git's stderr mean "this directory simply isn't a repo"?
///
/// git exits 128 for that AND for dubious ownership, a malformed `.git/config`,
/// and a corrupt index. Only the first is a normal, uninteresting state for a
/// Porta app; the rest are things the user can act on, so we surface them.
///
/// This classifies by what git *says*: exit 128 is shared by every case, so the
/// code alone tells us nothing. Callers MUST run git under `LC_ALL=C` — a git
/// built with NLS (Homebrew's is; Apple's is not) translates `fatal:` messages,
/// and a French user would then see a warning on every ordinary folder.
///
/// One limit is worth knowing: when `.git` itself can't be validated (HEAD
/// unreadable, `objects/` missing), git reports "not a git repository" too, so
/// such a repo stays silent rather than warning. Widening the match would be
/// worse: we'd warn on every non-repo folder.
fn is_not_a_repo(stderr: &str) -> bool {
    stderr.contains("not a git repository")
}

/// The `git status` invocation, built in one place so the locale pin that
/// `is_not_a_repo` depends on can't drift away from it.
///
/// `--no-optional-locks` keeps us from taking `index.lock`, which would race the
/// user's editor. `core.fsmonitor=false` stops us from spawning (or waking) a
/// long-lived fsmonitor daemon per repo on every poll.
fn status_command(bin: &str, root: &Path) -> Command {
    let mut cmd = Command::new(bin);
    cmd.current_dir(root)
        .env("LC_ALL", "C")
        .args([
            "--no-optional-locks",
            "-c",
            "core.fsmonitor=false",
            "status",
            "--porcelain=v2",
            "--branch",
            "--untracked-files=normal",
        ]);
    cmd
}

/// Read git status for a working directory.
///
/// * `Ok(Some(_))` — a repo we could read.
/// * `Ok(None)`    — not a repo, no `root_dir`, or no `git` binary. Normal;
///                   most Porta apps aren't repos.
/// * `Err(_)`      — git ran and failed for a reason the user should see, e.g.
///                   `detected dubious ownership`. Carries git's own stderr.
pub(crate) fn status_for(root_dir: &str) -> Result<Option<GitStatus>, String> {
    if root_dir.is_empty() {
        return Ok(None);
    }
    let root = Path::new(root_dir);
    if !root.is_dir() {
        return Ok(None);
    }
    let Some(bin) = git_bin() else {
        return Ok(None);
    };

    // `--no-optional-locks` keeps us from taking `index.lock`, which would race
    // the user's editor. `core.fsmonitor=false` stops us from spawning (or
    // waking) a long-lived fsmonitor daemon per repo on every poll.
    let out = status_command(bin, root).output().map_err(|e| e.to_string())?;

    if out.status.success() {
        return Ok(Some(parse_porcelain_v2(&String::from_utf8_lossy(&out.stdout))));
    }

    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if is_not_a_repo(&stderr) {
        Ok(None)
    } else if stderr.is_empty() {
        // Killed by a signal, or a git that failed without a word. The exit
        // status is the only thing left worth telling the user.
        Err(format!("git status failed ({})", out.status))
    } else {
        Err(stderr)
    }
}

#[tauri::command]
pub fn git_status(root_dir: String) -> Result<Option<GitStatus>, String> {
    status_for(&root_dir)
}

/// Run a git subcommand with a wall-clock budget, returning stdout on success
/// and git's own stderr on failure. Thin wrapper over [`run_bin`] using the
/// resolved `git` binary; kept separate so `run_bin` can be exercised against a
/// slow stand-in command (e.g. `/bin/sleep`) in tests.
fn run_git(root_dir: &str, args: &[&str], timeout_secs: u64) -> Result<String, String> {
    let bin = git_bin().ok_or_else(|| "git not found".to_string())?;
    run_bin(bin, root_dir, args, timeout_secs)
}

/// Spawn `bin` with a wall-clock budget, returning stdout on success and the
/// child's own stderr on failure.
///
/// `std::process::Command` has no timeout and we refuse to take a dependency for
/// one. Rather than reap the child in a worker thread (which would free its pid
/// and open a window where we could `kill -9` a pid the kernel has already
/// reassigned), the main thread keeps ownership of `Child` and polls
/// `try_wait()` against a deadline. stdout/stderr are drained concurrently on
/// their own threads so a child writing more than a pipe buffer to either can't
/// deadlock. On expiry we kill and reap — a network op that outlives its budget
/// is almost always a credential prompt we can never answer, and leaving it
/// parked would leak a process per poll.
fn run_bin(bin: &str, root_dir: &str, args: &[&str], timeout_secs: u64) -> Result<String, String> {
    let mut child = Command::new(bin)
        .current_dir(root_dir)
        .args(args)
        // Porta has no tty. Without this, HTTPS auth blocks forever asking for a
        // username. We deliberately do NOT set GIT_SSH_COMMAND — the user may
        // have their own `core.sshCommand` or ssh wrapper, and clobbering it
        // would break exactly the setups we're trying to support.
        .env("GIT_TERMINAL_PROMPT", "0")
        // GIT_TERMINAL_PROMPT governs git's own prompting but not ssh's host-key
        // or passphrase prompts on an inherited tty. Nulling stdin makes the
        // no-hang guarantee structural instead of leaning on the timeout.
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Own process group so a timeout can kill git's descendants (ssh,
        // credential helpers, gpg) too — killing the top pid alone leaks them.
        .process_group(0)
        .spawn()
        .map_err(|e| e.to_string())?;

    let pid = child.id();

    // Drain both pipes concurrently on their own threads — reading them serially
    // would deadlock if the child fills one pipe buffer while we block on the
    // other. This preserves what `wait_with_output()` gave us without letting it
    // reap the child out from under us.
    let mut child_stdout = child.stdout.take().expect("piped stdout");
    let mut child_stderr = child.stderr.take().expect("piped stderr");
    let out_reader = thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = child_stdout.read_to_end(&mut buf);
        buf
    });
    let err_reader = thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = child_stderr.read_to_end(&mut buf);
        buf
    });

    let deadline = Instant::now() + Duration::from_secs(timeout_secs);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                // Reap done; join the readers to collect everything the child
                // wrote before it exited.
                let stdout = out_reader.join().unwrap_or_default();
                let stderr = err_reader.join().unwrap_or_default();
                if status.success() {
                    return Ok(String::from_utf8_lossy(&stdout).trim().to_string());
                }
                let stderr = String::from_utf8_lossy(&stderr).trim().to_string();
                return Err(if stderr.is_empty() {
                    format!("git {} failed", args.join(" "))
                } else {
                    stderr
                });
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    // Negative pid targets the whole process group. `/bin/kill`
                    // because std exposes no group-kill and we take no libc dep.
                    let _ = Command::new("/bin/kill")
                        .args(["-9", &format!("-{pid}")])
                        .output();
                    // Reap our direct child so we don't leave a zombie. We do NOT
                    // join the reader threads here: if a descendant survived the
                    // kill still holding a pipe, read_to_end would block forever.
                    let _ = child.wait();
                    return Err(format!(
                        "git {} timed out after {timeout_secs}s — it may be waiting for credentials. \
                         Open a terminal in this folder and run it there once.",
                        args.join(" ")
                    ));
                }
                thread::sleep(Duration::from_millis(20));
            }
            Err(e) => return Err(e.to_string()),
        }
    }
}

/// Seconds before a network git op is killed.
const NET_TIMEOUT_SECS: u64 = 30;

pub(crate) fn fetch_for(root_dir: &str) -> Result<(), String> {
    run_git(root_dir, &["fetch", "--no-tags", "--prune"], NET_TIMEOUT_SECS).map(|_| ())
}

#[tauri::command]
pub fn git_fetch(root_dir: String) -> Result<(), String> {
    fetch_for(&root_dir)
}

#[tauri::command]
pub fn git_pull(root_dir: String) -> Result<String, String> {
    // `--ff-only` so a pull can never leave a half-finished merge behind. When it
    // can't fast-forward it fails cleanly and the user goes to a terminal.
    run_git(&root_dir, &["pull", "--ff-only"], NET_TIMEOUT_SECS)
}

#[tauri::command]
pub fn git_push(root_dir: String) -> Result<String, String> {
    run_git(&root_dir, &["push"], NET_TIMEOUT_SECS)
}

/// Poll git state for every app whose `root_dir` is a repo.
///
/// Two rhythms, deliberately different:
///
/// * every 15s — `git status`, which only touches local files. This is what
///   makes `↑N` update the moment you commit in a terminal.
/// * every `git_autofetch_interval_secs` — `git fetch`, which touches the
///   network. `behind` is otherwise frozen: `refs/remotes/origin/*` is a
///   snapshot, and nothing refreshes it but a fetch. VS Code's `git.autofetch`
///   exists for exactly this reason.
pub fn spawn_git_poller(app: tauri::AppHandle) {
    thread::spawn(move || {
        // Fetch on the very first visible tick rather than after one interval —
        // opening Porta should show you truth, not a three-minute-old snapshot.
        let mut last_fetch: Option<Instant> = None;

        // Last status emitted per app id, owned by this thread across loop
        // iterations. `GitStatus` derives `PartialEq` so we can skip emitting
        // when nothing actually changed — the frontend deserializes a fresh
        // event payload every tick regardless, so without this gate every
        // `GitBadge` re-renders on a 15s cadence even at rest.
        let mut last_emitted: std::collections::HashMap<String, GitStatus> =
            std::collections::HashMap::new();

        // Same gate as `last_emitted`, for the error channel. Without it a repo
        // with dubious ownership would re-emit the identical error every 15s.
        let mut last_error: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();

        // A fetch pass runs on its own thread so a hung remote can't delay the
        // 15s status tick. This flag stops a second pass starting while one is
        // still going — with 30s timeouts, a slow pass can outlive its interval.
        let fetching = Arc::new(AtomicBool::new(false));

        /// Clears the in-flight flag however the fetch thread ends, panic included.
        struct FetchGuard(Arc<AtomicBool>);
        impl Drop for FetchGuard {
            fn drop(&mut self) {
                self.0.store(false, Ordering::SeqCst);
            }
        }

        loop {
            thread::sleep(Duration::from_secs(15));

            if git_bin().is_none() || !window_visible(&app) {
                continue;
            }

            let roots = repo_roots(&app);
            if roots.is_empty() {
                continue;
            }

            let due = crate::commands::settings::git_autofetch_enabled()
                && last_fetch.map_or(true, |t| {
                    t.elapsed()
                        >= Duration::from_secs(
                            crate::commands::settings::git_autofetch_interval_secs(),
                        )
                });

            // `compare_exchange` rather than a plain check-then-set: if a pass is
            // still running we must NOT stamp `last_fetch`, or the interval would
            // silently restart from a fetch that never happened.
            if due
                && fetching
                    .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                    .is_ok()
            {
                last_fetch = Some(Instant::now());
                let roots_for_fetch: Vec<String> =
                    roots.iter().map(|(_, root)| root.clone()).collect();
                let guard = FetchGuard(Arc::clone(&fetching));
                thread::spawn(move || {
                    // Clearing the flag on drop, not on the last statement:
                    // `thread::scope` re-propagates a panic from a scoped
                    // closure, and a flag left `true` would disable autofetch
                    // for the rest of the session with nothing to show for it.
                    let _guard = guard;
                    // Two at a time. Ten repos hitting the SSH agent at once is
                    // how you get spurious auth failures.
                    for pair in roots_for_fetch.chunks(2) {
                        thread::scope(|s| {
                            for root in pair {
                                s.spawn(|| {
                                    let _ = fetch_for(root);
                                });
                            }
                        });
                    }
                });
            }

            // Drop tracking for apps that no longer appear in `roots` — deleted
            // apps, or ones whose `root_dir` stopped being a repo — so this map
            // can't grow unbounded over the app's lifetime.
            let current_ids: std::collections::HashSet<&str> =
                roots.iter().map(|(id, _)| id.as_str()).collect();
            last_emitted.retain(|id, _| current_ids.contains(id.as_str()));
            last_error.retain(|id, _| current_ids.contains(id.as_str()));

            for (app_id, root) in &roots {
                match status_for(root) {
                    Ok(Some(status)) => {
                        // Recovered: clear a previously-reported error so the
                        // badge stops showing a stale warning.
                        if last_error.remove(app_id).is_some() {
                            app.emit(&format!("app:git-error:{}", app_id), "").ok();
                        }
                        if last_emitted.get(app_id) != Some(&status) {
                            app.emit(&format!("app:git:{}", app_id), &status).ok();
                            last_emitted.insert(app_id.clone(), status);
                        }
                    }
                    Ok(None) => {
                        // Not a repo. Nothing to say, and nothing to retract.
                    }
                    Err(msg) => {
                        if last_error.get(app_id) != Some(&msg) {
                            app.emit(&format!("app:git-error:{}", app_id), &msg).ok();
                            last_error.insert(app_id.clone(), msg);
                        }
                    }
                }
            }
        }
    });
}

/// Apps that could plausibly be repos: anything with a `root_dir` that isn't a
/// pure reverse-proxy (those have no folder at all).
fn repo_roots(app: &tauri::AppHandle) -> Vec<(String, String)> {
    let state = app.state::<AppState>();
    // Hold the DB lock only for the call itself, as `spawn_metrics_poller` does — the
    // loop below must not block start/stop commands.
    //
    // A panic elsewhere poisons the mutex. Recover the guard rather than let it
    // kill this detached thread — a dead poller is silent and permanent.
    let db_apps = state
        .db
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .list_apps()
        .ok();
    db_apps
        .unwrap_or_default()
        .into_iter()
        .filter(|a| !a.is_proxy() && !a.root_dir.is_empty())
        .map(|a| (a.id, a.root_dir))
        .collect()
}

/// No point fetching for cards nobody is looking at.
fn window_visible(app: &tauri::AppHandle) -> bool {
    match app.get_webview_window("main") {
        Some(w) => {
            w.is_visible().unwrap_or(true) && !w.is_minimized().unwrap_or(false)
        }
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn st(out: &str) -> GitStatus {
        parse_porcelain_v2(out)
    }

    #[test]
    fn parses_clean_repo_in_sync() {
        let s = st("\
# branch.oid 3f2a1b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a
# branch.head main
# branch.upstream origin/main
# branch.ab +0 -0
");
        assert_eq!(
            s,
            GitStatus {
                branch: "main".into(),
                detached: false,
                upstream: Some("origin/main".into()),
                ahead: 0,
                behind: 0,
                dirty: 0,
            }
        );
    }

    #[test]
    fn parses_ahead_only() {
        let s = st("\
# branch.oid 3f2a1b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a
# branch.head feat/thing
# branch.upstream origin/feat/thing
# branch.ab +3 -0
");
        assert_eq!(s.ahead, 3);
        assert_eq!(s.behind, 0);
        assert_eq!(s.branch, "feat/thing");
    }

    #[test]
    fn parses_behind_only() {
        let s = st("\
# branch.oid 3f2a1b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a
# branch.head main
# branch.upstream origin/main
# branch.ab +0 -7
");
        assert_eq!(s.ahead, 0);
        assert_eq!(s.behind, 7);
    }

    #[test]
    fn parses_diverged() {
        let s = st("\
# branch.oid 3f2a1b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a
# branch.head main
# branch.upstream origin/main
# branch.ab +2 -5
");
        assert_eq!((s.ahead, s.behind), (2, 5));
    }

    #[test]
    fn parses_detached_head_as_short_sha() {
        let s = st("\
# branch.oid 3f2a1b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a
# branch.head (detached)
");
        assert!(s.detached);
        assert_eq!(s.branch, "3f2a1b9");
        assert_eq!(s.upstream, None);
        assert_eq!((s.ahead, s.behind), (0, 0));
    }

    #[test]
    fn branch_without_upstream_has_no_counts() {
        // No `# branch.ab` line at all — git omits it when there is no upstream.
        let s = st("\
# branch.oid 3f2a1b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a
# branch.head local-only
");
        assert_eq!(s.upstream, None);
        assert_eq!((s.ahead, s.behind), (0, 0));
        assert_eq!(s.branch, "local-only");
    }

    #[test]
    fn counts_changed_renamed_unmerged_and_untracked_as_dirty() {
        let s = st("\
# branch.oid 3f2a1b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a
# branch.head main
# branch.upstream origin/main
# branch.ab +0 -0
1 .M N... 100644 100644 100644 3f2a1b9 3f2a1b9 src/lib.rs
1 M. N... 100644 100644 100644 3f2a1b9 aaaaaaa src/main.rs
2 R. N... 100644 100644 100644 3f2a1b9 3f2a1b9 R100 new.rs\told.rs
u UU N... 100644 100644 100644 100644 3f2a1b9 aaaaaaa bbbbbbb conflict.rs
? untracked.txt
");
        assert_eq!(s.dirty, 5);
    }

    #[test]
    fn fresh_repo_with_no_commits_uses_branch_name() {
        // `git init` + `git status` before the first commit.
        let s = st("\
# branch.oid (initial)
# branch.head main
");
        assert!(!s.detached);
        assert_eq!(s.branch, "main");
    }

    #[test]
    fn not_a_repo_is_recognised_from_git_stderr() {
        assert!(is_not_a_repo(
            "fatal: not a git repository (or any of the parent directories): .git"
        ));
    }

    #[test]
    fn dubious_ownership_is_not_mistaken_for_a_missing_repo() {
        // git exits 128 for this too, but the repo is right there — the user
        // just needs `git config --global --add safe.directory <path>`.
        assert!(!is_not_a_repo(
            "fatal: detected dubious ownership in repository at '/Users/x/app'"
        ));
    }

    #[test]
    fn status_for_returns_ok_none_outside_a_repo() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(status_for(dir.path().to_str().unwrap()), Ok(None));
    }

    #[test]
    fn status_for_returns_ok_none_for_empty_or_missing_path() {
        assert_eq!(status_for(""), Ok(None));
        assert_eq!(status_for("/nonexistent/path/xyzzy"), Ok(None));
    }

    #[test]
    fn status_for_reads_a_real_repo() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        let git = |args: &[&str]| {
            Command::new("git").current_dir(p).args(args).output().unwrap()
        };
        git(&["init", "--initial-branch=main"]);
        git(&["config", "user.email", "t@example.com"]);
        git(&["config", "user.name", "T"]);
        std::fs::write(p.join("a.txt"), "hello").unwrap();

        // Untracked file, no commits yet.
        let s = status_for(p.to_str().unwrap())
            .expect("reading a valid repo must not error")
            .expect("repo should be detected");
        assert_eq!(s.branch, "main");
        assert!(!s.detached);
        assert_eq!(s.upstream, None);
        assert_eq!(s.dirty, 1);
    }

    #[test]
    fn status_for_surfaces_a_real_git_failure() {
        // A malformed `.git/config` makes git exit 128 with `fatal: bad config
        // line 1 in file .git/config` — a genuine failure, worded nothing like
        // "not a git repository". Verified against git 2.50.1 before writing
        // this test; corrupting HEAD or removing `.git/objects` does NOT work
        // as a fixture, because git then fails repo validation and reports
        // "not a git repository" instead.
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        Command::new("git")
            .current_dir(p)
            .args(["init", "--initial-branch=main"])
            .output()
            .unwrap();
        std::fs::write(p.join(".git/config"), "[core\nbroken\n").unwrap();

        let err = status_for(p.to_str().unwrap())
            .expect_err("a malformed config must surface, not read as 'not a repo'");
        assert!(
            err.contains("bad config"),
            "error must carry git's own words, got: {err}"
        );
    }

    #[test]
    fn status_command_pins_the_locale() {
        // `is_not_a_repo` matches English stderr. A git built with NLS (Homebrew's
        // is) would translate it, and every non-repo folder would start warning.
        // This machine's Apple Git has no NLS, so a behavioural test would pass
        // for the wrong reason — assert on the spawned command instead.
        let cmd = status_command("git", Path::new("/tmp"));
        let locale = cmd
            .get_envs()
            .find(|(k, _)| *k == std::ffi::OsStr::new("LC_ALL"))
            .and_then(|(_, v)| v);
        assert_eq!(
            locale,
            Some(std::ffi::OsStr::new("C")),
            "git status must run under LC_ALL=C"
        );
    }

    #[test]
    fn network_op_reports_git_stderr_on_failure() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        let git = |args: &[&str]| {
            Command::new("git").current_dir(p).args(args).output().unwrap()
        };
        git(&["init", "--initial-branch=main"]);
        // A bare `git fetch` with zero remotes configured is a silent no-op on
        // git >= 2.50 (exit 0, no output) rather than an error, so we point
        // `origin` at a path that cannot exist to force a real failure.
        git(&["remote", "add", "origin", "file:///nonexistent/porta-git-ops-test"]);

        let err = run_git(p.to_str().unwrap(), &["fetch", "--no-tags", "--prune"], 30)
            .expect_err("fetch against a bad remote must fail");
        assert!(
            err.contains("remote") || err.contains("origin"),
            "expected git's stderr, got: {err}"
        );
    }

    #[test]
    fn run_bin_times_out_promptly_and_kills_the_process() {
        // Exercise the timeout path against `/bin/sleep` rather than git so we
        // can (a) prove `run_bin` returns long before the sleep would, and (b)
        // prove the spawned process is genuinely dead afterwards — not merely
        // that a "timed out" string came back. Removing the kill call makes this
        // test fail: the process stays alive (and, with the reap kept, the
        // `child.wait()` would block for the full sleep, blowing the budget too).
        let dir = tempfile::tempdir().unwrap();
        let pidfile = dir.path().join("pid");
        let pidfile_str = pidfile.to_str().unwrap();

        // Record our own PID, then `exec sleep` so the recorded PID *is* the
        // sleep's — the exact pid the timeout must kill. sleep(30) far outlives
        // the 1s budget.
        let script = format!("echo $$ > {pidfile_str}; exec sleep 30");

        let start = Instant::now();
        let err = run_bin("/bin/sh", dir.path().to_str().unwrap(), &["-c", &script], 1)
            .expect_err("a 1s budget against a 30s sleep must time out");
        let elapsed = start.elapsed();

        // (a) returned promptly on timeout, not after the 30s sleep.
        assert!(err.contains("timed out"), "got: {err}");
        assert!(elapsed < Duration::from_secs(5), "run_bin took too long: {elapsed:?}");

        // (b) the process is actually dead. `kill -0` succeeds only while it
        // exists; poll briefly to absorb reap latency.
        let pid = std::fs::read_to_string(&pidfile)
            .expect("child should have written its pid")
            .trim()
            .to_string();
        assert!(!pid.is_empty(), "child never recorded a pid");

        let mut alive = true;
        for _ in 0..100 {
            let probe = Command::new("/bin/kill").args(["-0", &pid]).output().unwrap();
            if !probe.status.success() {
                alive = false;
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
        assert!(!alive, "process {pid} survived the timeout kill");
    }
}
