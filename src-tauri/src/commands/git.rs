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
// Only called from tests so far; Task 2 wires this into the `git status`
// command that shells out and feeds it real output.
#[allow(dead_code)]
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
}
