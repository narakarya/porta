//! Discover existing git worktrees of an app's repo and run the app from them
//! as isolated instances. Porta never creates or removes worktrees — it only
//! reads `git worktree list` and runs from what already exists.

use crate::commands::git::git_bin;
use std::path::Path;
use std::process::Command;

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
}
