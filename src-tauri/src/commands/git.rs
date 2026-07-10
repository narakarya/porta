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

use std::path::Path;
use std::process::Command;
use std::process::Stdio;
use std::sync::mpsc;
use std::sync::OnceLock;
use std::thread;
use std::time::Duration;

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

/// Read git status for a working directory. Returns `None` — not `Err` — when
/// the path is empty, missing, or simply isn't a repo. Most Porta apps aren't
/// repos, and that is not an error worth surfacing.
pub(crate) fn status_for(root_dir: &str) -> Option<GitStatus> {
    if root_dir.is_empty() {
        return None;
    }
    let root = Path::new(root_dir);
    if !root.is_dir() {
        return None;
    }
    let bin = git_bin()?;

    // `--no-optional-locks` keeps us from taking `index.lock`, which would race
    // the user's editor. `core.fsmonitor=false` stops us from spawning (or
    // waking) a long-lived fsmonitor daemon per repo on every poll.
    let out = Command::new(bin)
        .current_dir(root)
        .args([
            "--no-optional-locks",
            "-c",
            "core.fsmonitor=false",
            "status",
            "--porcelain=v2",
            "--branch",
            "--untracked-files=normal",
        ])
        .output()
        .ok()?;

    if !out.status.success() {
        return None; // not a repo
    }
    Some(parse_porcelain_v2(&String::from_utf8_lossy(&out.stdout)))
}

#[tauri::command]
pub fn git_status(root_dir: String) -> Option<GitStatus> {
    status_for(&root_dir)
}

/// Run a git subcommand with a wall-clock budget, returning stdout on success
/// and git's own stderr on failure.
///
/// `std::process::Command` has no timeout and we refuse to take a dependency for
/// one, so the child is moved into a worker thread and awaited through a
/// channel. On expiry we kill it by pid — a network op that outlives its budget
/// is almost always a credential prompt we can never answer, and leaving it
/// parked would leak a process per poll.
fn run_git(root_dir: &str, args: &[&str], timeout_secs: u64) -> Result<String, String> {
    let bin = git_bin().ok_or_else(|| "git not found".to_string())?;

    let child = Command::new(bin)
        .current_dir(root_dir)
        .args(args)
        // Porta has no tty. Without this, HTTPS auth blocks forever asking for a
        // username. We deliberately do NOT set GIT_SSH_COMMAND — the user may
        // have their own `core.sshCommand` or ssh wrapper, and clobbering it
        // would break exactly the setups we're trying to support.
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;

    let pid = child.id();
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });

    match rx.recv_timeout(Duration::from_secs(timeout_secs)) {
        Ok(Ok(out)) if out.status.success() => {
            Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
        }
        Ok(Ok(out)) => {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            Err(if stderr.is_empty() {
                format!("git {} failed", args.join(" "))
            } else {
                stderr
            })
        }
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => {
            let _ = Command::new("/bin/kill").args(["-9", &pid.to_string()]).output();
            Err(format!(
                "git {} timed out after {timeout_secs}s — it may be waiting for credentials. \
                 Open a terminal in this folder and run it there once.",
                args.join(" ")
            ))
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
    fn status_for_returns_none_outside_a_repo() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(status_for(dir.path().to_str().unwrap()), None);
    }

    #[test]
    fn status_for_returns_none_for_empty_or_missing_path() {
        assert_eq!(status_for(""), None);
        assert_eq!(status_for("/nonexistent/path/xyzzy"), None);
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
        let s = status_for(p.to_str().unwrap()).expect("repo should be detected");
        assert_eq!(s.branch, "main");
        assert!(!s.detached);
        assert_eq!(s.upstream, None);
        assert_eq!(s.dirty, 1);
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
    fn run_git_kills_the_child_on_timeout() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        Command::new("git").current_dir(p).args(["init"]).output().unwrap();

        // `git ... --paginate log` on an empty repo returns fast, so instead we
        // assert the timeout path directly with a 0-second budget.
        let err = run_git(p.to_str().unwrap(), &["status"], 0)
            .expect_err("a zero-second budget must time out");
        assert!(err.contains("timed out"), "got: {err}");
    }
}
