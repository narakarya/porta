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
    /// Lines added, summed across staged + unstaged `--numstat` (a partially
    /// staged file has counts on both sides). `0` for a binary file (numstat
    /// reports `-`) or a path `--numstat` didn't mention at all (e.g. untracked).
    pub insertions: u32,
    /// Lines removed — same sourcing and binary/untracked fallback as `insertions`.
    pub deletions: u32,
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
                insertions: 0,
                deletions: 0,
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
                    insertions: 0,
                    deletions: 0,
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
                    insertions: 0,
                    deletions: 0,
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
                    insertions: 0,
                    deletions: 0,
                });
            }
        }
    }
    files
}

/// Parse `git diff --numstat` output into per-path (insertions, deletions).
///
/// Each line is `<ins>\t<del>\t<path>`. A binary file reports `-\t-\t<path>`
/// instead of numbers — treated as `(0, 0)` since there is no meaningful line
/// count to show.
fn parse_numstat(raw: &str) -> std::collections::HashMap<String, (u32, u32)> {
    let mut map = std::collections::HashMap::new();
    for line in raw.lines() {
        let mut parts = line.splitn(3, '\t');
        let (Some(ins), Some(del), Some(path)) = (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let ins = ins.parse::<u32>().unwrap_or(0);
        let del = del.parse::<u32>().unwrap_or(0);
        map.insert(path.to_string(), (ins, del));
    }
    map
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
        let mut files = parse_changed_files(&String::from_utf8_lossy(&out.stdout));
        apply_numstat(root_dir, &mut files);
        return Ok(files);
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

/// Fill in `insertions`/`deletions` on each `ChangedFile` from `git diff
/// --numstat` (unstaged) and `git diff --cached --numstat` (staged), summed per
/// path — a partially staged file has a real count on both sides. A path with
/// no numstat entry at all (untracked, or a rename `--numstat` reported under a
/// different path than the one we matched on) is left at `0`/`0`, which is
/// acceptable per the brief: best-effort, not exact for every rename shape.
///
/// Best-effort throughout: either `git diff` invocation failing (e.g. a
/// detached-HEAD edge case) just leaves the counts at `0` rather than failing
/// the whole changed-files read, since the status list itself is still valid
/// and more useful to the caller than an error.
fn apply_numstat(root_dir: &str, files: &mut [ChangedFile]) {
    let unstaged = run_git_raw(root_dir, &["diff", "--numstat"], LOCAL_TIMEOUT_SECS)
        .map(|raw| parse_numstat(&raw))
        .unwrap_or_default();
    let staged = run_git_raw(root_dir, &["diff", "--cached", "--numstat"], LOCAL_TIMEOUT_SECS)
        .map(|raw| parse_numstat(&raw))
        .unwrap_or_default();

    for file in files.iter_mut() {
        let (u_ins, u_del) = unstaged.get(&file.path).copied().unwrap_or((0, 0));
        let (s_ins, s_del) = staged.get(&file.path).copied().unwrap_or((0, 0));
        file.insertions = u_ins + s_ins;
        file.deletions = u_del + s_del;
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

#[derive(Debug, Clone, serde::Serialize)]
pub struct CommitEntry {
    pub hash: String,
    pub short_hash: String,
    pub author: String,
    pub date: String,
    pub subject: String,
    pub refs: String,
}

/// Parse `git log --pretty=format:%H\x1f%h\x1f%an\x1f%aI\x1f%D\x1f%s%x1e` output
/// into commit entries. Records are separated by `\x1e` (RS); fields within a
/// record by `\x1f` (US) — both control characters a commit subject can never
/// contain, unlike a plain delimiter such as `|` or a tab.
fn parse_log(raw: &str) -> Vec<CommitEntry> {
    raw.split('\x1e')
        .map(str::trim)
        .filter(|record| !record.is_empty())
        .filter_map(|record| {
            let mut fields = record.split('\x1f');
            let hash = fields.next()?.to_string();
            let short_hash = fields.next()?.to_string();
            let author = fields.next()?.to_string();
            let date = fields.next()?.to_string();
            let refs = fields.next()?.to_string();
            let subject = fields.next()?.to_string();
            Some(CommitEntry { hash, short_hash, author, date, subject, refs })
        })
        .collect()
}

#[tauri::command]
pub async fn git_log(root_dir: String, limit: u32, skip: u32) -> Result<Vec<CommitEntry>, String> {
    tokio::task::spawn_blocking(move || {
        let fmt = "--pretty=format:%H\x1f%h\x1f%an\x1f%aI\x1f%D\x1f%s%x1e";
        let limit_s = limit.to_string();
        let skip_s = skip.to_string();
        let args = ["log", fmt, "--max-count", &limit_s, "--skip", &skip_s];
        let raw = run_git_raw(&root_dir, &args, LOCAL_TIMEOUT_SECS)?;
        Ok(parse_log(&raw))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_show(root_dir: String, hash: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        // Guard against option-injection: reject a hash that starts with '-'.
        if hash.starts_with('-') {
            return Err("invalid revision".into());
        }
        run_git_raw(&root_dir, &["show", "--patch", "--stat", &hash], LOCAL_TIMEOUT_SECS)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct StashEntry {
    pub index: u32,
    pub message: String,
}

/// Parse `git stash list --pretty=format:%gd\x1f%gs` output into stash entries.
/// Each line is `stash@{N}\x1f<message>` — `N` becomes `index`, the remainder
/// becomes `message` (the `%gs` format bundles the branch name into the message
/// text itself, e.g. "WIP on main: ...").
fn parse_stash_list(raw: &str) -> Vec<StashEntry> {
    raw.lines()
        .filter(|line| !line.is_empty())
        .filter_map(|line| {
            let (ref_part, message) = line.split_once('\x1f')?;
            let index_str = ref_part.strip_prefix("stash@{")?.strip_suffix('}')?;
            let index = index_str.parse::<u32>().ok()?;
            Some(StashEntry { index, message: message.to_string() })
        })
        .collect()
}

#[tauri::command]
pub async fn git_stash_list(root_dir: String) -> Result<Vec<StashEntry>, String> {
    tokio::task::spawn_blocking(move || {
        let raw = run_git(
            &root_dir,
            &["stash", "list", "--pretty=format:%gd\x1f%gs"],
            LOCAL_TIMEOUT_SECS,
        )?;
        Ok(parse_stash_list(&raw))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_stash_push(root_dir: String, message: Option<String>) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        // Guard against option-injection: reject a message that starts with '-'.
        if message.as_deref().map_or(false, |m| m.starts_with('-')) {
            return Err("invalid stash message".into());
        }
        let mut args: Vec<&str> = vec!["stash", "push"];
        if let Some(msg) = message.as_deref() {
            if !msg.is_empty() {
                args.push("-m");
                args.push(msg);
            }
        }
        run_git(&root_dir, &args, LOCAL_TIMEOUT_SECS).map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_stash_pop(root_dir: String, index: u32) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let stash_ref = format!("stash@{{{index}}}");
        run_git(&root_dir, &["stash", "pop", "--index", &stash_ref], LOCAL_TIMEOUT_SECS)
            .map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_stash_drop(root_dir: String, index: u32) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let stash_ref = format!("stash@{{{index}}}");
        run_git(&root_dir, &["stash", "drop", &stash_ref], LOCAL_TIMEOUT_SECS).map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct TagEntry {
    pub name: String,
    pub subject: String,
}

/// Parse `for-each-ref --format=%(refname:short)\x1f%(subject) refs/tags` output
/// into tag entries. Each line is `<name>\x1f<subject>` — `subject` may be empty
/// for a lightweight tag.
fn parse_tags(raw: &str) -> Vec<TagEntry> {
    raw.lines()
        .filter(|line| !line.is_empty())
        .filter_map(|line| {
            let (name, subject) = line.split_once('\x1f')?;
            Some(TagEntry { name: name.to_string(), subject: subject.to_string() })
        })
        .collect()
}

#[tauri::command]
pub async fn git_tags(root_dir: String) -> Result<Vec<TagEntry>, String> {
    tokio::task::spawn_blocking(move || {
        let raw = run_git(
            &root_dir,
            &[
                "for-each-ref",
                "--sort=-creatordate",
                "--format=%(refname:short)\x1f%(subject)",
                "refs/tags",
            ],
            LOCAL_TIMEOUT_SECS,
        )?;
        Ok(parse_tags(&raw))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_create_tag(
    root_dir: String,
    name: String,
    message: Option<String>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        // Guard against option-injection: reject a name or message that starts with '-'.
        if name.starts_with('-') || message.as_deref().map_or(false, |m| m.starts_with('-')) {
            return Err("invalid tag name or message".into());
        }
        match message.as_deref() {
            Some(msg) if !msg.is_empty() => {
                run_git(&root_dir, &["tag", "-a", &name, "-m", msg], LOCAL_TIMEOUT_SECS).map(|_| ())
            }
            _ => run_git(&root_dir, &["tag", &name], LOCAL_TIMEOUT_SECS).map(|_| ()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_delete_tag(root_dir: String, name: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        // Guard against option-injection: reject a name that starts with '-'.
        if name.starts_with('-') {
            return Err("invalid tag name".into());
        }
        run_git(&root_dir, &["tag", "-d", &name], LOCAL_TIMEOUT_SECS).map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Rebase the current branch onto `branch`. No interactive editor involved —
/// this is rebase-lite: start it, and on conflict the caller resolves files
/// and calls `git_rebase_continue`/`git_rebase_abort`. Split out from the
/// `#[tauri::command]` so the option-injection guard is unit-testable without
/// going through `spawn_blocking`.
fn rebase_onto_core(root_dir: &str, branch: &str) -> Result<String, String> {
    // Guard against option-injection: reject a branch that starts with '-'.
    if branch.starts_with('-') {
        return Err("invalid branch".into());
    }
    run_git(root_dir, &["rebase", branch], LOCAL_TIMEOUT_SECS)
}

#[tauri::command]
pub async fn git_rebase_onto(root_dir: String, branch: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || rebase_onto_core(&root_dir, &branch))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_rebase_abort(root_dir: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        run_git(&root_dir, &["rebase", "--abort"], LOCAL_TIMEOUT_SECS).map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_rebase_continue(root_dir: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        // `-c core.editor=true` avoids blocking on an interactive editor for
        // the commit message when the rebase resumes cleanly after a conflict.
        run_git(
            &root_dir,
            &["-c", "core.editor=true", "rebase", "--continue"],
            LOCAL_TIMEOUT_SECS,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Apply a caller-supplied patch (one file header, one hunk) to the index —
/// per-hunk stage/unstage for the changes panel. `reverse=false` stages the
/// hunk (`apply --cached`); `reverse=true` unstages it (`apply --cached
/// --reverse`). `--unidiff-zero` allows a zero-context hunk (a patch built
/// from a single-line selection) to still apply. Split out from the
/// `#[tauri::command]` so it's unit-testable without going through
/// `spawn_blocking`.
fn apply_hunk_core(root_dir: &str, patch: &str, reverse: bool) -> Result<(), String> {
    let mut args = vec!["apply", "--cached", "--unidiff-zero"];
    if reverse {
        args.push("--reverse");
    }
    run_git_stdin(root_dir, &args, patch, LOCAL_TIMEOUT_SECS).map(|_| ())
}

#[tauri::command]
pub async fn git_apply_hunk(root_dir: String, patch: String, reverse: bool) -> Result<(), String> {
    tokio::task::spawn_blocking(move || apply_hunk_core(&root_dir, &patch, reverse))
        .await
        .map_err(|e| e.to_string())?
}

/// Reverse-apply a caller-supplied patch (one file header, one hunk) to the
/// WORKING TREE — not the index — discarding just that hunk while leaving the
/// rest of the file's unstaged changes (and anything already staged) alone.
/// No `--cached`, unlike [`apply_hunk_core`]: this is the working-tree sibling
/// of the discard-hunk action in the changes panel. `--unidiff-zero` allows a
/// zero-context hunk to still apply. Split out from the `#[tauri::command]` so
/// it's unit-testable without going through `spawn_blocking`.
fn discard_hunk_core(root_dir: &str, patch: &str) -> Result<(), String> {
    run_git_stdin(root_dir, &["apply", "--reverse", "--unidiff-zero"], patch, LOCAL_TIMEOUT_SECS)
        .map(|_| ())
}

#[tauri::command]
pub async fn git_discard_hunk(root_dir: String, patch: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || discard_hunk_core(&root_dir, &patch))
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

    #[test]
    fn parse_log_reads_nul_delimited_records() {
        // Format: %H\x1f%h\x1f%an\x1f%aI\x1f%D\x1f%s  then records joined by \x1e
        let raw = "abc123\x1fabc\x1fAda\x1f2026-01-01T00:00:00Z\x1fHEAD -> main\x1finit\x1e\
                   def456\x1fdef\x1fLin\x1f2026-01-02T00:00:00Z\x1f\x1fsecond commit\x1e";
        let out = parse_log(raw);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].hash, "abc123");
        assert_eq!(out[0].short_hash, "abc");
        assert_eq!(out[0].author, "Ada");
        assert_eq!(out[0].subject, "init");
        assert_eq!(out[0].refs, "HEAD -> main");
        assert_eq!(out[1].subject, "second commit");
        assert_eq!(out[1].refs, "");
    }

    #[test]
    fn git_log_reads_a_real_repo_newest_first() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        let git = |args: &[&str]| Command::new("git").current_dir(p).args(args).output().unwrap();
        git(&["init", "--initial-branch=main"]);
        git(&["config", "user.email", "t@example.com"]);
        git(&["config", "user.name", "T"]);
        std::fs::write(p.join("a.txt"), "one\n").unwrap();
        git(&["add", "a.txt"]);
        git(&["commit", "-m", "first commit"]);
        std::fs::write(p.join("a.txt"), "one\ntwo\n").unwrap();
        git(&["add", "a.txt"]);
        git(&["commit", "-m", "second commit"]);

        let ps = p.to_str().unwrap();
        let fmt = "--pretty=format:%H\x1f%h\x1f%an\x1f%aI\x1f%D\x1f%s%x1e";
        let raw = run_git_raw(ps, &["log", fmt, "--max-count", "50", "--skip", "0"], LOCAL_TIMEOUT_SECS)
            .unwrap();
        let entries = parse_log(&raw);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].subject, "second commit");
        assert_eq!(entries[1].subject, "first commit");
    }

    #[test]
    fn parse_stash_list_reads_entries() {
        let raw = "stash@{0}\x1fWIP on main: abc123 fix\nstash@{1}\x1fOn feature: manual note";
        let out = parse_stash_list(raw);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].index, 0);
        assert_eq!(out[0].message, "WIP on main: abc123 fix");
        assert_eq!(out[1].index, 1);
    }

    #[test]
    fn stash_push_list_pop_round_trips_a_change() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        let ps = p.to_str().unwrap();
        let git = |args: &[&str]| Command::new("git").current_dir(p).args(args).output().unwrap();
        git(&["init", "--initial-branch=main"]);
        git(&["config", "user.email", "t@example.com"]);
        git(&["config", "user.name", "T"]);
        std::fs::write(p.join("a.txt"), "one\n").unwrap();
        git(&["add", "a.txt"]);
        git(&["commit", "-m", "init"]);

        // Dirty the working tree, then stash it via the raw plumbing (mirrors
        // what the async command does inside spawn_blocking).
        std::fs::write(p.join("a.txt"), "one\ntwo\n").unwrap();
        run_git(ps, &["stash", "push", "-m", "wip: two"], LOCAL_TIMEOUT_SECS).unwrap();

        // Working tree is clean again post-stash.
        let after_push = std::fs::read_to_string(p.join("a.txt")).unwrap();
        assert_eq!(after_push, "one\n");

        let raw = run_git(ps, &["stash", "list", "--pretty=format:%gd\x1f%gs"], LOCAL_TIMEOUT_SECS)
            .unwrap();
        let entries = parse_stash_list(&raw);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].index, 0);
        assert!(entries[0].message.contains("wip: two"), "got: {}", entries[0].message);

        run_git(ps, &["stash", "pop", "--index", "stash@{0}"], LOCAL_TIMEOUT_SECS).unwrap();
        let after_pop = std::fs::read_to_string(p.join("a.txt")).unwrap();
        assert_eq!(after_pop, "one\ntwo\n");

        let raw_after = run_git(ps, &["stash", "list", "--pretty=format:%gd\x1f%gs"], LOCAL_TIMEOUT_SECS)
            .unwrap();
        assert!(parse_stash_list(&raw_after).is_empty(), "stash should be gone after pop");
    }

    #[test]
    fn parse_tags_reads_name_and_subject() {
        let raw = "v1.0\x1frelease one\nv0.9\x1f";
        let out = parse_tags(raw);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].name, "v1.0");
        assert_eq!(out[0].subject, "release one");
        assert_eq!(out[1].name, "v0.9");
        assert_eq!(out[1].subject, "");
    }

    #[test]
    fn create_list_delete_tag_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        let ps = p.to_str().unwrap();
        let git = |args: &[&str]| Command::new("git").current_dir(p).args(args).output().unwrap();
        git(&["init", "--initial-branch=main"]);
        git(&["config", "user.email", "t@example.com"]);
        git(&["config", "user.name", "T"]);
        std::fs::write(p.join("a.txt"), "one\n").unwrap();
        git(&["add", "a.txt"]);
        git(&["commit", "-m", "init"]);

        run_git(ps, &["tag", "-a", "v1", "-m", "first release"], LOCAL_TIMEOUT_SECS).unwrap();

        let raw = run_git(
            ps,
            &["for-each-ref", "--sort=-creatordate", "--format=%(refname:short)\x1f%(subject)", "refs/tags"],
            LOCAL_TIMEOUT_SECS,
        )
        .unwrap();
        let tags = parse_tags(&raw);
        assert_eq!(tags.len(), 1);
        assert_eq!(tags[0].name, "v1");
        assert_eq!(tags[0].subject, "first release");

        run_git(ps, &["tag", "-d", "v1"], LOCAL_TIMEOUT_SECS).unwrap();
        let raw_after = run_git(
            ps,
            &["for-each-ref", "--sort=-creatordate", "--format=%(refname:short)\x1f%(subject)", "refs/tags"],
            LOCAL_TIMEOUT_SECS,
        )
        .unwrap();
        assert!(parse_tags(&raw_after).is_empty(), "tag should be gone after delete");
    }

    #[test]
    fn rebase_onto_replays_feature_commits_on_top_of_main() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        let ps = p.to_str().unwrap();
        let git = |args: &[&str]| Command::new("git").current_dir(p).args(args).output().unwrap();
        git(&["init", "--initial-branch=main"]);
        git(&["config", "user.email", "t@example.com"]);
        git(&["config", "user.name", "T"]);
        std::fs::write(p.join("a.txt"), "one\n").unwrap();
        git(&["add", "a.txt"]);
        git(&["commit", "-m", "commit A"]);

        git(&["branch", "feature"]);

        // Back on main, add commit C.
        std::fs::write(p.join("c.txt"), "c\n").unwrap();
        git(&["add", "c.txt"]);
        git(&["commit", "-m", "commit C"]);

        // On feature, add commit B (diverging from main at A).
        git(&["checkout", "feature"]);
        std::fs::write(p.join("b.txt"), "b\n").unwrap();
        git(&["add", "b.txt"]);
        git(&["commit", "-m", "commit B"]);

        let result = rebase_onto_core(ps, "main");
        assert!(result.is_ok(), "rebase should succeed: {result:?}");

        let log = run_git_raw(ps, &["log", "--pretty=format:%s"], LOCAL_TIMEOUT_SECS).unwrap();
        assert!(log.contains("commit C"), "feature history should include commit C: {log}");
        assert!(log.contains("commit B"), "feature history should still include commit B: {log}");
        assert!(log.contains("commit A"), "feature history should still include commit A: {log}");
    }

    #[test]
    fn apply_hunk_core_stages_and_unstages_a_change() {
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

        // Modify one line in the working tree and capture the full-file patch.
        std::fs::write(p.join("a.txt"), "one\nTWO\nthree\n").unwrap();
        let patch = run_git_raw(ps, &["diff", "--", "a.txt"], LOCAL_TIMEOUT_SECS).unwrap();

        // Stage it via the core the command wraps.
        apply_hunk_core(ps, &patch, false).expect("applying the patch to the index should succeed");
        let staged = run_git_raw(ps, &["diff", "--cached", "--", "a.txt"], LOCAL_TIMEOUT_SECS).unwrap();
        let unstaged = run_git_raw(ps, &["diff", "--", "a.txt"], LOCAL_TIMEOUT_SECS).unwrap();
        assert!(!staged.is_empty(), "change should now be staged");
        assert!(unstaged.is_empty(), "no unstaged diff should remain once fully staged");

        // Unstage it again with reverse=true.
        apply_hunk_core(ps, &patch, true).expect("reversing the patch should succeed");
        let staged_after = run_git_raw(ps, &["diff", "--cached", "--", "a.txt"], LOCAL_TIMEOUT_SECS).unwrap();
        let unstaged_after = run_git_raw(ps, &["diff", "--", "a.txt"], LOCAL_TIMEOUT_SECS).unwrap();
        assert!(staged_after.is_empty(), "change should be unstaged again");
        assert!(!unstaged_after.is_empty(), "the modification should be back in the working tree");
    }

    #[test]
    fn discard_hunk_core_reverts_a_working_tree_change() {
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

        // Modify one line in the working tree and capture the full-file patch.
        std::fs::write(p.join("a.txt"), "one\nTWO\nthree\n").unwrap();
        let patch = run_git_raw(ps, &["diff", "--", "a.txt"], LOCAL_TIMEOUT_SECS).unwrap();

        discard_hunk_core(ps, &patch).expect("reverting the hunk in the working tree should succeed");

        let content = std::fs::read_to_string(p.join("a.txt")).unwrap();
        assert_eq!(content, "one\ntwo\nthree\n", "working-tree file should be back to committed content");

        let unstaged = run_git_raw(ps, &["diff", "--", "a.txt"], LOCAL_TIMEOUT_SECS).unwrap();
        assert!(unstaged.is_empty(), "no unstaged diff should remain once the hunk is discarded");
    }

    #[test]
    fn rebase_onto_rejects_a_branch_starting_with_dash() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        let ps = p.to_str().unwrap();
        let git = |args: &[&str]| Command::new("git").current_dir(p).args(args).output().unwrap();
        git(&["init", "--initial-branch=main"]);
        git(&["config", "user.email", "t@example.com"]);
        git(&["config", "user.name", "T"]);
        std::fs::write(p.join("a.txt"), "one\n").unwrap();
        git(&["add", "a.txt"]);
        git(&["commit", "-m", "init"]);

        let result = rebase_onto_core(ps, "--exec=touch /tmp/pwned");
        assert!(result.is_err(), "a branch starting with '-' must be rejected");
        assert_eq!(result.unwrap_err(), "invalid branch");
    }

    #[test]
    fn parse_numstat_reads_counts() {
        let map = parse_numstat("40\t2\tapi/posts.ts\n-\t-\tlogo.png\n");
        assert_eq!(map.len(), 2);
        assert_eq!(map.get("api/posts.ts"), Some(&(40, 2)));
        assert_eq!(map.get("logo.png"), Some(&(0, 0)));
    }

    #[test]
    fn changed_files_for_reports_insertions_for_a_modified_file() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        let ps = p.to_str().unwrap();
        let git = |args: &[&str]| Command::new("git").current_dir(p).args(args).output().unwrap();
        git(&["init", "--initial-branch=main"]);
        git(&["config", "user.email", "t@example.com"]);
        git(&["config", "user.name", "T"]);
        std::fs::write(p.join("a.txt"), "one\n").unwrap();
        git(&["add", "a.txt"]);
        git(&["commit", "-m", "init"]);

        // Modify the tracked file, adding 3 lines.
        std::fs::write(p.join("a.txt"), "one\ntwo\nthree\nfour\n").unwrap();

        let files = changed_files_for(ps).expect("reading a valid repo must not error");
        let f = files.iter().find(|f| f.path == "a.txt").expect("a.txt should be listed");
        assert!(f.insertions >= 3, "expected at least 3 insertions, got {}", f.insertions);
    }
}
