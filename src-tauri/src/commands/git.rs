//! Git status + ops for app cards.
//!
//! We shell out to the `git` binary rather than link libgit2. The hard part of
//! this feature is credentials, not parsing: libgit2 ignores `Include` in
//! `~/.ssh/config` and the `osxkeychain` credential helper unless we reimplement
//! them ourselves. The CLI already speaks the user's git config.

#[derive(Debug, Clone, serde::Serialize)]
pub struct BranchList {
    pub local: Vec<String>,
    pub remote: Vec<String>,
    pub current: Option<String>,
}

/// Split `git branch --format=%(refname:short)` output into names, dropping
/// blank lines and git's `origin/HEAD` symref (and any `->` alias line, a
/// defensive guard in case a caller uses a format that includes it).
fn parse_branch_lines(out: &str) -> Vec<String> {
    out.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .filter(|l| *l != "origin/HEAD" && !l.ends_with("/HEAD") && !l.contains("->"))
        .map(|l| l.to_string())
        .collect()
}

/// Remote short names from `git branch -r --format=%(refname:short)`, dropping
/// the `refs/remotes/<remote>/HEAD` symref — which `%(refname:short)` renders as
/// the bare remote name (`origin`, no slash). Real remote-tracking names always
/// contain a `/`, so slash-less entries are exactly the symref.
fn remote_branch_names(out: &str) -> Vec<String> {
    parse_branch_lines(out).into_iter().filter(|b| b.contains('/')).collect()
}

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

/// One entry from `git status --porcelain=v2 --untracked-files=all`, shaped for
/// the changes panel: which side (index / working tree) the change is on, and
/// the raw status chars so the UI can label it (`M`, `A`, `D`, `R`, …).
#[derive(Debug, Clone, serde::Serialize)]
pub struct ChangedFile {
    pub path: String,
    /// The pre-rename path — present only on rename/copy (`2 `) entries.
    pub orig_path: Option<String>,
    /// git's index (staged) status char, or `.` when unchanged there.
    pub staged_status: String,
    /// git's working-tree (unstaged) status char, or `.` when unchanged there.
    pub unstaged_status: String,
    pub staged: bool,
    pub unstaged: bool,
    pub untracked: bool,
}

/// Split a two-char porcelain-v2 `XY` field into its (index, worktree) chars.
fn status_chars(xy: &str) -> (char, char) {
    let mut it = xy.chars();
    (it.next().unwrap_or('.'), it.next().unwrap_or('.'))
}

/// A porcelain-v2 status char signals a real change unless it's `.` (git's
/// "unchanged on this side" marker) or a space (defensive; v2 uses `.`).
fn is_changed(c: char) -> bool {
    c != '.' && c != ' '
}

/// Split a porcelain-v2 entry body (everything after the `1 `/`2 `/`u ` kind
/// prefix) into its leading `XY` field and the path tail that begins after
/// `header_fields` whitespace-separated fixed columns. Returns `None` when the
/// line is too short to hold a path.
///
/// The path is taken as the untouched remainder, not `split_whitespace().last()`
/// — porcelain-v2 paths are unquoted and may contain spaces, so tokenizing would
/// truncate `my file.rs` to `file.rs`.
fn split_header(rest: &str, header_fields: usize) -> Option<(&str, &str)> {
    let xy = rest.split_whitespace().next()?;
    let bytes = rest.as_bytes();
    let mut idx = 0;
    for _ in 0..header_fields {
        while idx < bytes.len() && bytes[idx] == b' ' {
            idx += 1;
        }
        while idx < bytes.len() && bytes[idx] != b' ' {
            idx += 1;
        }
    }
    while idx < bytes.len() && bytes[idx] == b' ' {
        idx += 1;
    }
    if idx >= bytes.len() {
        return None;
    }
    Some((xy, &rest[idx..]))
}

/// Parse `git status --porcelain=v2 --untracked-files=all` into per-file entries.
///
/// The v2 grammar is contractually stable across git versions. Line kinds:
///
/// * `1 XY … <path>`                  — ordinary change (7 header fields then path).
/// * `2 XY … <score> <path>\t<orig>`  — rename/copy (8 header fields; path and
///                                       orig are TAB-separated).
/// * `u XY … <path>`                  — unmerged/conflict (9 header fields then
///                                       path); always an unstaged change until
///                                       resolved.
/// * `? <path>`                       — untracked.
///
/// Anything else (e.g. the `# branch.*` header lines, if `--branch` was passed)
/// matches no prefix and is skipped.
fn parse_changed_files(out: &str) -> Vec<ChangedFile> {
    let mut files = Vec::new();
    for line in out.lines() {
        if let Some(path) = line.strip_prefix("? ") {
            files.push(ChangedFile {
                path: path.to_string(),
                orig_path: None,
                staged_status: ".".to_string(),
                unstaged_status: "?".to_string(),
                staged: false,
                unstaged: true,
                untracked: true,
            });
        } else if let Some(rest) = line.strip_prefix("1 ") {
            if let Some((xy, path)) = split_header(rest, 7) {
                let (x, y) = status_chars(xy);
                files.push(ChangedFile {
                    path: path.to_string(),
                    orig_path: None,
                    staged_status: x.to_string(),
                    unstaged_status: y.to_string(),
                    staged: is_changed(x),
                    unstaged: is_changed(y),
                    untracked: false,
                });
            }
        } else if let Some(rest) = line.strip_prefix("2 ") {
            if let Some((xy, tail)) = split_header(rest, 8) {
                let (x, y) = status_chars(xy);
                let (path, orig) = match tail.split_once('\t') {
                    Some((p, o)) => (p.to_string(), Some(o.to_string())),
                    None => (tail.to_string(), None),
                };
                files.push(ChangedFile {
                    path,
                    orig_path: orig,
                    staged_status: x.to_string(),
                    unstaged_status: y.to_string(),
                    staged: is_changed(x),
                    unstaged: is_changed(y),
                    untracked: false,
                });
            }
        } else if let Some(rest) = line.strip_prefix("u ") {
            if let Some((_xy, path)) = split_header(rest, 9) {
                files.push(ChangedFile {
                    path: path.to_string(),
                    orig_path: None,
                    staged_status: "U".to_string(),
                    unstaged_status: "U".to_string(),
                    staged: false,
                    unstaged: true,
                    untracked: false,
                });
            }
        }
    }
    files
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

/// The `git status` invocation for the changes panel — same locale pin and lock
/// hygiene as [`status_command`], but `--untracked-files=all` so every file in a
/// new directory is listed individually, and no `--branch` (the caller wants the
/// file entries, not the ahead/behind header).
fn changed_files_command(bin: &str, root: &Path) -> Command {
    let mut cmd = Command::new(bin);
    cmd.current_dir(root)
        .env("LC_ALL", "C")
        .args([
            "--no-optional-locks",
            "-c",
            "core.fsmonitor=false",
            "status",
            "--porcelain=v2",
            "--untracked-files=all",
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

/// Read the changed-files list for a working directory. `Ok(vec![])` when it
/// isn't a repo (or `root_dir` is empty / git is missing) — the same "not a repo
/// is normal" contract as [`status_for`]; genuine git failures still surface.
///
/// stdout is parsed verbatim: [`parse_changed_files`] skips blank lines, and a
/// porcelain path must never be trimmed.
fn changed_files_for(root_dir: &str) -> Result<Vec<ChangedFile>, String> {
    if root_dir.is_empty() {
        return Ok(vec![]);
    }
    let root = Path::new(root_dir);
    if !root.is_dir() {
        return Ok(vec![]);
    }
    let Some(bin) = git_bin() else {
        return Ok(vec![]);
    };

    let out = changed_files_command(bin, root).output().map_err(|e| e.to_string())?;
    if out.status.success() {
        return Ok(parse_changed_files(&String::from_utf8_lossy(&out.stdout)));
    }

    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if is_not_a_repo(&stderr) {
        Ok(vec![])
    } else if stderr.is_empty() {
        Err(format!("git status failed ({})", out.status))
    } else {
        Err(stderr)
    }
}

#[tauri::command]
pub async fn git_status(root_dir: String) -> Result<Option<GitStatus>, String> {
    // Off the main thread too: this runs in GitBadge's mount seed and in the
    // post-op refresh right after a pull, and a large repo's status isn't free.
    tokio::task::spawn_blocking(move || status_for(&root_dir))
        .await
        .map_err(|e| e.to_string())?
}

/// Run a git subcommand with a wall-clock budget, returning stdout on success
/// and git's own stderr on failure. Thin wrapper over [`run_bin`] using the
/// resolved `git` binary; kept separate so `run_bin` can be exercised against a
/// slow stand-in command (e.g. `/bin/sleep`) in tests.
fn run_git(root_dir: &str, args: &[&str], timeout_secs: u64) -> Result<String, String> {
    let bin = git_bin().ok_or_else(|| "git not found".to_string())?;
    run_bin(bin, root_dir, args, timeout_secs, true)
}

/// Like [`run_git`] but returns stdout verbatim — no trailing-whitespace trim.
///
/// A unified diff's context lines start with a single leading space, and a blank
/// context line is *only* that space; a trailing-newline/space trim would corrupt
/// the patch. Only diff output needs this, so [`run_git`] keeps trimming for
/// every other caller (branch names, commit summaries), where a stray newline is
/// noise.
fn run_git_raw(root_dir: &str, args: &[&str], timeout_secs: u64) -> Result<String, String> {
    let bin = git_bin().ok_or_else(|| "git not found".to_string())?;
    run_bin(bin, root_dir, args, timeout_secs, false)
}

/// Like [`run_git_raw`] but feeds `stdin_data` to the child's stdin before
/// draining its output — the variant `git apply --cached` needs, since a
/// patch has to arrive on stdin rather than as an argv/file argument.
///
/// Mirrors [`run_bin`]'s contract (env, process group, timeout, two-thread
/// drain) with one difference: stdin is piped instead of nulled, and we write
/// the patch and drop the handle (sending EOF) before spawning the drain
/// threads, so a child that echoes large input back on stdout/stderr can't
/// deadlock against us still holding stdin open.
#[allow(dead_code)] // wired up by a later per-hunk-staging task
fn run_git_stdin(
    root_dir: &str,
    args: &[&str],
    stdin_data: &str,
    timeout_secs: u64,
) -> Result<String, String> {
    let bin = git_bin().ok_or_else(|| "git not found".to_string())?;

    let mut child = Command::new(bin)
        .current_dir(root_dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .spawn()
        .map_err(|e| e.to_string())?;

    let pid = child.id();

    // Write the patch and drop the handle (closing stdin / sending EOF) before
    // draining stdout/stderr. On its own thread: a child that starts writing
    // output before it has finished reading a large patch could otherwise
    // deadlock us here while its own stdout/stderr pipe fills up.
    let mut child_stdin = child.stdin.take().expect("piped stdin");
    let stdin_data = stdin_data.to_string();
    let in_writer = thread::spawn(move || {
        use std::io::Write;
        let _ = child_stdin.write_all(stdin_data.as_bytes());
        // child_stdin drops here, closing the pipe and sending EOF.
    });

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
                let _ = in_writer.join();
                let stdout = out_reader.join().unwrap_or_default();
                let stderr = err_reader.join().unwrap_or_default();
                if status.success() {
                    return Ok(String::from_utf8_lossy(&stdout).into_owned());
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
                    let _ = Command::new("/bin/kill")
                        .args(["-9", &format!("-{pid}")])
                        .output();
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
fn run_bin(
    bin: &str,
    root_dir: &str,
    args: &[&str],
    timeout_secs: u64,
    trim: bool,
) -> Result<String, String> {
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
                    let s = String::from_utf8_lossy(&stdout);
                    return Ok(if trim { s.trim().to_string() } else { s.into_owned() });
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

// The network ops run on `spawn_blocking`, not the main thread: a sync Tauri
// command blocks the WebView, and `run_git`'s wall-clock budget is 30s. Mirrors
// how `remote.rs` keeps its ssh/HTTP work off the UI thread.

#[tauri::command]
pub async fn git_fetch(root_dir: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || fetch_for(&root_dir))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_pull(root_dir: String) -> Result<String, String> {
    // `--ff-only` so a pull can never leave a half-finished merge behind. When it
    // can't fast-forward it fails cleanly and the user goes to a terminal.
    tokio::task::spawn_blocking(move || run_git(&root_dir, &["pull", "--ff-only"], NET_TIMEOUT_SECS))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_push(root_dir: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || run_git(&root_dir, &["push"], NET_TIMEOUT_SECS))
        .await
        .map_err(|e| e.to_string())?
}

fn branches_for(root_dir: &str) -> Result<BranchList, String> {
    let local = parse_branch_lines(&run_git(
        root_dir,
        &["branch", "--format=%(refname:short)"],
        NET_TIMEOUT_SECS,
    )?);
    let remote = remote_branch_names(&run_git(
        root_dir,
        &["branch", "-r", "--format=%(refname:short)"],
        NET_TIMEOUT_SECS,
    )?);
    let cur = run_git(root_dir, &["branch", "--show-current"], NET_TIMEOUT_SECS)?;
    let current = if cur.trim().is_empty() { None } else { Some(cur.trim().to_string()) };
    Ok(BranchList { local, remote, current })
}

#[tauri::command]
pub async fn git_branches(root_dir: String) -> Result<BranchList, String> {
    tokio::task::spawn_blocking(move || branches_for(&root_dir))
        .await
        .map_err(|e| e.to_string())?
}

/// Build the `git` argv for a switch. `create` prepends `-c` so the branch is
/// made from current HEAD; otherwise a bare switch, relying on git DWIM to
/// create a tracking branch from a remote-only match.
fn switch_args(branch: &str, create: bool) -> Vec<&str> {
    if create {
        vec!["switch", "-c", branch]
    } else {
        vec!["switch", branch]
    }
}

#[tauri::command]
pub async fn git_switch_branch(
    root_dir: String,
    branch: String,
    create: bool,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        run_git(&root_dir, &switch_args(&branch, create), NET_TIMEOUT_SECS).map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Wall-clock budget for the changes-panel ops below. They only touch the
/// working tree and index — no network — so they get a short local budget, not
/// `NET_TIMEOUT_SECS`. A local git op that runs longer than this is wedged, not
/// slow.
const LOCAL_TIMEOUT_SECS: u64 = 15;

#[tauri::command]
pub async fn git_changed_files(root_dir: String) -> Result<Vec<ChangedFile>, String> {
    tokio::task::spawn_blocking(move || changed_files_for(&root_dir))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_diff_file(
    root_dir: String,
    path: String,
    staged: bool,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        // `--` so a path that looks like a flag or a revision can't be
        // reinterpreted by git as anything but a pathspec.
        let args: Vec<&str> = if staged {
            vec!["diff", "--cached", "--", &path]
        } else {
            vec!["diff", "--", &path]
        };
        run_git_raw(&root_dir, &args, LOCAL_TIMEOUT_SECS)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_stage(root_dir: String, path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        run_git(&root_dir, &["add", "--", &path], LOCAL_TIMEOUT_SECS).map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_unstage(root_dir: String, path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        // `restore --staged` is the modern unstage, but it needs a HEAD to
        // restore the index from. In a fresh repo with no commits yet there is
        // none, and it errors — `reset` is what unstages there. Fall back rather
        // than surface a confusing "invalid object" to the user.
        match run_git(&root_dir, &["restore", "--staged", "--", &path], LOCAL_TIMEOUT_SECS) {
            Ok(_) => Ok(()),
            Err(_) => run_git(&root_dir, &["reset", "--", &path], LOCAL_TIMEOUT_SECS).map(|_| ()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_discard(root_dir: String, path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        run_git(&root_dir, &["restore", "--", &path], LOCAL_TIMEOUT_SECS).map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_commit(root_dir: String, message: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        run_git(&root_dir, &["commit", "-m", &message], LOCAL_TIMEOUT_SECS)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_commit_amend(root_dir: String, message: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        // Empty message = keep the existing one (`--no-edit`); otherwise replace
        // it. `--amend` rewrites the tip commit with whatever is currently staged.
        let args: Vec<&str> = if message.is_empty() {
            vec!["commit", "--amend", "--no-edit"]
        } else {
            vec!["commit", "--amend", "-m", &message]
        };
        run_git(&root_dir, &args, LOCAL_TIMEOUT_SECS)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// How many 15s status ticks between probes of a folder we already know isn't a
/// repo. Repos and errored folders are probed every tick; non-repos far less
/// often, since a plain folder becoming a repo is rare and a couple of minutes
/// of latency on its first badge is fine. At 8 that's one probe every 2 minutes.
const NON_REPO_PROBE_EVERY: u64 = 8;

/// Should a known non-repo be probed on this tick? Spawning `git status` on
/// every plain folder every 15s is the bulk of the poller's subprocess churn —
/// on a machine with many non-repo apps, most of the spawns are just
/// rediscovering "still not a repo". This keeps that correct (we still run real
/// `git status`, so a subdirectory-of-a-repo is never mis-skipped) but rare.
fn should_probe_non_repo(tick: u64) -> bool {
    tick % NON_REPO_PROBE_EVERY == 0
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

        // Apps last seen to be non-repos. They're probed on a slow cadence
        // (`should_probe_non_repo`) instead of every tick, which is where most of
        // the poller's subprocess churn came from on machines with many plain
        // (non-git) app folders.
        let mut non_repos: std::collections::HashSet<String> =
            std::collections::HashSet::new();
        let mut tick: u64 = 0;

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
            tick = tick.wrapping_add(1);

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
                // Don't fetch folders we already know aren't repos — `git fetch`
                // there just fails fast, but it's still a wasted subprocess.
                let roots_for_fetch: Vec<String> = roots
                    .iter()
                    .filter(|(id, _)| !non_repos.contains(id))
                    .map(|(_, root)| root.clone())
                    .collect();
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
            non_repos.retain(|id| current_ids.contains(id.as_str()));

            for (app_id, root) in &roots {
                // Skip a known non-repo unless its slow cadence is due — this is
                // where most of the every-15s subprocess churn was.
                if non_repos.contains(app_id) && !should_probe_non_repo(tick) {
                    continue;
                }
                match status_for(root) {
                    Ok(Some(status)) => {
                        non_repos.remove(app_id);
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
                        // Not a repo. Nothing to say, nothing to retract — just
                        // remember so we probe it on the slow cadence from now on.
                        non_repos.insert(app_id.clone());
                    }
                    Err(msg) => {
                        non_repos.remove(app_id);
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
    fn non_repos_are_probed_on_the_slow_cadence() {
        // Repos are probed every tick; a known non-repo only every
        // NON_REPO_PROBE_EVERY. Lock the interval and the modulo direction so a
        // refactor can't quietly turn it into "every tick" (no saving) or
        // "never" (a new repo's badge would never appear).
        assert_eq!(NON_REPO_PROBE_EVERY, 8);
        for tick in 1..=7 {
            assert!(!should_probe_non_repo(tick), "tick {tick} should skip");
        }
        assert!(should_probe_non_repo(8), "tick 8 is due");
        for tick in 9..=15 {
            assert!(!should_probe_non_repo(tick), "tick {tick} should skip");
        }
        assert!(should_probe_non_repo(16), "tick 16 is due");
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
    fn parse_branch_lines_filters_symref_and_blanks() {
        let out = "main\nfix/foo\n\n";
        assert_eq!(parse_branch_lines(out), vec!["main", "fix/foo"]);
    }

    #[test]
    fn remote_branch_names_drops_bare_remote_symref() {
        // `git branch -r --format=%(refname:short)` shortens refs/remotes/origin/HEAD
        // to the bare remote name "origin" (no slash), not "origin/HEAD".
        let out = "origin\norigin/main\norigin/fix/foo\n";
        assert_eq!(remote_branch_names(out), vec!["origin/main", "origin/fix/foo"]);
    }

    #[test]
    fn switch_args_create_uses_dash_c() {
        assert_eq!(switch_args("feature", true), vec!["switch", "-c", "feature"]);
    }

    #[test]
    fn switch_args_existing_is_plain_switch() {
        assert_eq!(switch_args("main", false), vec!["switch", "main"]);
    }

    #[test]
    fn changed_files_parses_a_modified_unstaged_file() {
        let f =
            &parse_changed_files("1 .M N... 100644 100644 100644 3f2a1b9 3f2a1b9 src/lib.rs\n")[0];
        assert_eq!(f.path, "src/lib.rs");
        assert_eq!(f.orig_path, None);
        assert_eq!(f.staged_status, ".");
        assert_eq!(f.unstaged_status, "M");
        assert!(!f.staged);
        assert!(f.unstaged);
        assert!(!f.untracked);
    }

    #[test]
    fn changed_files_parses_a_staged_file() {
        let f =
            &parse_changed_files("1 M. N... 100644 100644 100644 3f2a1b9 aaaaaaa src/main.rs\n")[0];
        assert_eq!(f.path, "src/main.rs");
        assert_eq!(f.staged_status, "M");
        assert_eq!(f.unstaged_status, ".");
        assert!(f.staged);
        assert!(!f.unstaged);
    }

    #[test]
    fn changed_files_parses_a_partially_staged_file() {
        // `MM`: modified, staged, then modified again in the working tree.
        let f =
            &parse_changed_files("1 MM N... 100644 100644 100644 3f2a1b9 aaaaaaa src/both.rs\n")[0];
        assert_eq!(f.path, "src/both.rs");
        assert!(f.staged);
        assert!(f.unstaged);
    }

    #[test]
    fn changed_files_parses_a_rename_with_orig_path() {
        // `2 ` entry: the score (`R100`) is an extra header field, and the new
        // and old paths are TAB-separated.
        let f = &parse_changed_files(
            "2 R. N... 100644 100644 100644 3f2a1b9 3f2a1b9 R100 new.rs\told.rs\n",
        )[0];
        assert_eq!(f.path, "new.rs");
        assert_eq!(f.orig_path.as_deref(), Some("old.rs"));
        assert_eq!(f.staged_status, "R");
        assert!(f.staged);
        assert!(!f.unstaged);
    }

    #[test]
    fn changed_files_parses_an_untracked_file() {
        let f = &parse_changed_files("? untracked.txt\n")[0];
        assert_eq!(f.path, "untracked.txt");
        assert!(f.untracked);
        assert!(f.unstaged);
        assert!(!f.staged);
    }

    #[test]
    fn changed_files_parses_all_kinds_together() {
        // Every line kind in one status dump, including an unmerged (`u`) entry.
        let files = parse_changed_files(
            "1 .M N... 100644 100644 100644 3f2a1b9 3f2a1b9 src/lib.rs\n\
             1 M. N... 100644 100644 100644 3f2a1b9 aaaaaaa src/main.rs\n\
             1 MM N... 100644 100644 100644 3f2a1b9 aaaaaaa src/both.rs\n\
             2 R. N... 100644 100644 100644 3f2a1b9 3f2a1b9 R100 new.rs\told.rs\n\
             u UU N... 100644 100644 100644 100644 3f2a1b9 aaaaaaa bbbbbbb conflict.rs\n\
             ? untracked.txt\n",
        );
        assert_eq!(files.len(), 6);
        let conflict = files.iter().find(|f| f.path == "conflict.rs").unwrap();
        assert_eq!(conflict.staged_status, "U");
        assert!(!conflict.staged);
        assert!(conflict.unstaged);
        assert!(!conflict.untracked);
    }

    #[test]
    fn changed_files_keeps_paths_with_spaces_intact() {
        // Porcelain v2 leaves spaces unquoted; the path is the remainder, not the
        // last whitespace token.
        let f = &parse_changed_files(
            "1 .M N... 100644 100644 100644 3f2a1b9 3f2a1b9 my dir/a file.rs\n",
        )[0];
        assert_eq!(f.path, "my dir/a file.rs");
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
        let err = run_bin("/bin/sh", dir.path().to_str().unwrap(), &["-c", &script], 1, true)
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

    #[test]
    fn run_git_stdin_applies_a_patch_to_the_index() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        let ps = p.to_str().unwrap();
        let git = |args: &[&str]| Command::new("git").current_dir(p).args(args).output().unwrap();
        git(&["init", "--initial-branch=main"]);
        git(&["config", "user.email", "t@example.com"]);
        git(&["config", "user.name", "T"]);
        std::fs::write(p.join("a.txt"), "one\ntwo\nthree\n").unwrap();
        git(&["add", "a.txt"]);
        git(&["commit", "-m", "init"]);
        // Modify working tree, get the full-file diff, feed it back via apply --cached.
        std::fs::write(p.join("a.txt"), "one\nTWO\nthree\n").unwrap();
        let patch = run_git_raw(ps, &["diff", "--", "a.txt"], LOCAL_TIMEOUT_SECS).unwrap();
        run_git_stdin(ps, &["apply", "--cached"], &patch, LOCAL_TIMEOUT_SECS).unwrap();
        // Now the change is staged: `diff --cached` is non-empty, `diff` (unstaged) is empty.
        let staged = run_git_raw(ps, &["diff", "--cached", "--", "a.txt"], LOCAL_TIMEOUT_SECS).unwrap();
        assert!(staged.contains("+one\n TWO") || staged.contains("+TWO"), "staged diff should show TWO");
    }
}
