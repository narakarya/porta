//! `~/.ssh/config` parser, used to seed the host vault from what the user
//! already has on disk.
//!
//! This is deliberately *not* a full OpenSSH config implementation — it reads
//! the handful of keywords a Porta host row needs (`HostName`, `User`, `Port`,
//! `IdentityFile`, `ProxyJump`) and follows `Include`. Everything else is
//! ignored rather than guessed at: connecting still goes through russh with the
//! host row's own settings, so a keyword we silently drop can only mean "not
//! imported", never "imported wrong".
//!
//! Matching follows OpenSSH's two rules that actually change the result:
//! every `Host` block whose pattern matches contributes, and the *first* value
//! seen for a keyword wins (later blocks cannot override an earlier one).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// How many levels of `Include` to follow before giving up. Real configs nest
/// one or two deep; anything past this is a cycle (`Include` of a parent).
const MAX_INCLUDE_DEPTH: usize = 8;

/// One importable entry parsed out of an OpenSSH config file.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SshConfigEntry {
    /// The `Host` alias — becomes the vault label.
    pub alias: String,
    pub hostname: String,
    pub port: u16,
    pub username: String,
    /// `IdentityFile`, un-expanded (`~` is resolved at connect time).
    pub identity_file: Option<String>,
    /// The *alias* named by `ProxyJump`, not a host id — resolving it to a
    /// vault row can only happen at import time, once every selected entry
    /// exists and has an id.
    pub proxy_jump: Option<String>,
}

/// A `Host` block: the patterns it applies to and the keywords it sets.
#[derive(Debug, Default)]
struct Block {
    patterns: Vec<String>,
    /// Kept as an ordered list, not a map — first-wins is the whole point.
    settings: Vec<(String, String)>,
}

/// Parse a config file and every file it `Include`s, returning one entry per
/// concrete (non-wildcard) alias, in file order.
///
/// `default_user` fills in hosts with no `User` — OpenSSH would use the local
/// username there, and a blank username field in the vault is just a failed
/// connection waiting to happen.
pub fn scan(path: &Path, default_user: &str) -> Vec<SshConfigEntry> {
    let blocks = read_blocks(path, 0);
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for block in &blocks {
        for pattern in &block.patterns {
            // A pattern is a template, not a host — `Host *.internal` has
            // nothing to connect to. Its settings still apply to concrete
            // aliases through `matches`, below.
            if is_pattern(pattern) || !seen.insert(pattern.clone()) {
                continue;
            }
            if let Some(entry) = materialize(pattern, &blocks, default_user) {
                out.push(entry);
            }
        }
    }
    out
}

/// Collect every setting that applies to `alias`, first-wins, and turn it into
/// an entry. Returns `None` for an alias that resolves to nothing usable.
fn materialize(alias: &str, blocks: &[Block], default_user: &str) -> Option<SshConfigEntry> {
    let get = |key: &str| -> Option<String> {
        blocks
            .iter()
            .filter(|b| matches_any(&b.patterns, alias))
            .flat_map(|b| b.settings.iter())
            .find(|(k, _)| k.eq_ignore_ascii_case(key))
            .map(|(_, v)| v.clone())
    };

    let hostname = get("hostname").unwrap_or_else(|| alias.to_string());
    if hostname.trim().is_empty() {
        return None;
    }
    // `ProxyJump none` is OpenSSH's way of cancelling an inherited jump host.
    let proxy_jump = get("proxyjump")
        .filter(|v| !v.eq_ignore_ascii_case("none"))
        .map(|v| strip_jump_spec(&v));

    Some(SshConfigEntry {
        alias: alias.to_string(),
        hostname,
        port: get("port").and_then(|p| p.parse().ok()).unwrap_or(22),
        username: get("user").unwrap_or_else(|| default_user.to_string()),
        identity_file: get("identityfile"),
        proxy_jump,
    })
}

/// `ProxyJump` takes `[user@]host[:port]`, and may list several hops
/// comma-separated. Porta models one jump per host and chains them through the
/// vault, so keep the first hop's bare alias — that is the one this host dials.
fn strip_jump_spec(spec: &str) -> String {
    let first = spec.split(',').next().unwrap_or(spec).trim();
    let no_user = first.rsplit('@').next().unwrap_or(first);
    no_user.split(':').next().unwrap_or(no_user).to_string()
}

/// Read `path` into blocks, inlining `Include`d files at the point they appear
/// (which is what makes first-wins ordering come out right).
fn read_blocks(path: &Path, depth: usize) -> Vec<Block> {
    let mut blocks: Vec<Block> = Vec::new();
    let Ok(text) = std::fs::read_to_string(path) else {
        return blocks;
    };

    for line in text.lines() {
        let Some((key, value)) = split_directive(line) else {
            continue;
        };

        if key.eq_ignore_ascii_case("host") {
            blocks.push(Block {
                patterns: value.split_whitespace().map(str::to_string).collect(),
                settings: Vec::new(),
            });
        } else if key.eq_ignore_ascii_case("include") {
            if depth < MAX_INCLUDE_DEPTH {
                for included in expand_include(&value, path) {
                    blocks.extend(read_blocks(&included, depth + 1));
                }
            }
        } else if key.eq_ignore_ascii_case("match") {
            // `Match` blocks are conditional on runtime state (exec, canonical,
            // final). Guessing which branch applies would import hosts the user
            // never sees, so start a block that matches nothing instead.
            blocks.push(Block::default());
        } else if let Some(block) = blocks.last_mut() {
            block.settings.push((key, value));
        } else {
            // A keyword before any `Host` line is a global default, which
            // OpenSSH applies to everything — same as `Host *`.
            blocks.push(Block {
                patterns: vec!["*".to_string()],
                settings: vec![(key, value)],
            });
        }
    }
    blocks
}

/// Resolve one `Include` value to real paths. Supports the `dir/*` form used by
/// nearly every drop-in setup; other glob metacharacters are not expanded.
fn expand_include(value: &str, parent: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for token in value.split_whitespace() {
        let raw = expand_tilde(token);
        // Relative includes resolve against ~/.ssh, per ssh_config(5).
        let path = if raw.is_absolute() {
            raw
        } else {
            parent.parent().unwrap_or(Path::new(".")).join(raw)
        };

        match path.file_name().and_then(|n| n.to_str()) {
            Some("*") => {
                let dir = path.parent().unwrap_or(Path::new("."));
                let Ok(entries) = std::fs::read_dir(dir) else {
                    continue;
                };
                let mut found: Vec<PathBuf> = entries
                    .flatten()
                    .map(|e| e.path())
                    .filter(|p| p.is_file())
                    .collect();
                // read_dir order is filesystem-defined; first-wins resolution
                // would otherwise vary between machines for the same config.
                found.sort();
                out.extend(found);
            }
            _ => out.push(path),
        }
    }
    out
}

/// Split `Key Value` / `Key=Value`, dropping comments and blank lines.
fn split_directive(line: &str) -> Option<(String, String)> {
    let line = line.split('#').next().unwrap_or("").trim();
    if line.is_empty() {
        return None;
    }
    let (key, value) = match line.find(['=', ' ', '\t']) {
        Some(i) => (&line[..i], line[i + 1..].trim_start_matches(['=', ' ', '\t'])),
        None => return None,
    };
    let value = value.trim().trim_matches('"');
    if value.is_empty() {
        return None;
    }
    Some((key.trim().to_string(), value.to_string()))
}

fn is_pattern(s: &str) -> bool {
    s.contains(['*', '?', '!'])
}

fn matches_any(patterns: &[String], alias: &str) -> bool {
    // A negated pattern vetoes the whole block, matching OpenSSH.
    if patterns
        .iter()
        .filter_map(|p| p.strip_prefix('!'))
        .any(|p| matches_pattern(p, alias))
    {
        return false;
    }
    patterns
        .iter()
        .filter(|p| !p.starts_with('!'))
        .any(|p| matches_pattern(p, alias))
}

/// Glob match over `*` (any run) and `?` (one char) — the only two wildcards
/// ssh_config patterns support.
fn matches_pattern(pattern: &str, text: &str) -> bool {
    let (p, t): (Vec<char>, Vec<char>) = (pattern.chars().collect(), text.chars().collect());
    // Iterative backtracking: `*` records where it matched so a later mismatch
    // can resume one character further along instead of recursing.
    let (mut pi, mut ti) = (0usize, 0usize);
    let (mut star, mut resume) = (None, 0usize);

    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            resume = ti;
            pi += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            resume += 1;
            ti = resume;
        } else {
            return false;
        }
    }
    p[pi..].iter().all(|&c| c == '*')
}

fn expand_tilde(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(path)
}

/// `~/.ssh/config`, or `None` when `$HOME` is unset.
pub fn default_config_path() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".ssh").join("config"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write(dir: &Path, name: &str, body: &str) -> PathBuf {
        let p = dir.join(name);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        let mut f = std::fs::File::create(&p).unwrap();
        f.write_all(body.as_bytes()).unwrap();
        p
    }

    #[test]
    fn parses_basic_entries() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = write(
            dir.path(),
            "config",
            "Host web\n  HostName 10.0.0.1\n  User deploy\n  Port 2222\n\n\
             Host db\n  HostName db.internal\n  IdentityFile ~/.ssh/id_db\n",
        );
        let got = scan(&cfg, "fallback");
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].alias, "web");
        assert_eq!(got[0].hostname, "10.0.0.1");
        assert_eq!(got[0].username, "deploy");
        assert_eq!(got[0].port, 2222);
        // No User line: falls back to the local username, not empty.
        assert_eq!(got[1].username, "fallback");
        assert_eq!(got[1].port, 22);
        assert_eq!(got[1].identity_file.as_deref(), Some("~/.ssh/id_db"));
    }

    #[test]
    fn wildcard_blocks_apply_but_are_not_importable() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = write(
            dir.path(),
            "config",
            "Host *\n  User globaluser\n  Port 2200\n\nHost prod\n  HostName p.example.com\n",
        );
        let got = scan(&cfg, "fallback");
        assert_eq!(got.len(), 1, "`Host *` must not become a vault row");
        assert_eq!(got[0].alias, "prod");
        assert_eq!(got[0].username, "globaluser");
        assert_eq!(got[0].port, 2200);
    }

    #[test]
    fn first_value_wins_across_blocks() {
        let dir = tempfile::tempdir().unwrap();
        // OpenSSH takes the *first* value seen, so the specific block leading
        // the wildcard must win — the reverse would silently rewrite the port.
        let cfg = write(
            dir.path(),
            "config",
            "Host prod\n  HostName p.example.com\n  Port 2022\n\nHost *\n  Port 2200\n",
        );
        assert_eq!(scan(&cfg, "u")[0].port, 2022);
    }

    #[test]
    fn equals_separator_and_comments() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = write(
            dir.path(),
            "config",
            "# lead comment\nHost=api\n  HostName=api.example.com # trailing\n  Port = 8022\n",
        );
        let got = scan(&cfg, "u");
        assert_eq!(got[0].hostname, "api.example.com");
        assert_eq!(got[0].port, 8022);
    }

    #[test]
    fn proxy_jump_keeps_bare_first_hop() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = write(
            dir.path(),
            "config",
            "Host inner\n  HostName 10.0.0.9\n  ProxyJump admin@bastion:2222,other\n",
        );
        assert_eq!(scan(&cfg, "u")[0].proxy_jump.as_deref(), Some("bastion"));
    }

    #[test]
    fn proxy_jump_none_clears_inherited_value() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = write(
            dir.path(),
            "config",
            "Host direct\n  HostName d.example.com\n  ProxyJump none\n\nHost *\n  ProxyJump bastion\n",
        );
        assert_eq!(scan(&cfg, "u")[0].proxy_jump, None);
    }

    #[test]
    fn follows_include_in_order() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "conf.d/10-work", "Host work\n  HostName w.example.com\n");
        write(dir.path(), "conf.d/20-home", "Host home\n  HostName h.example.com\n");
        let cfg = write(
            dir.path(),
            "config",
            &format!("Include {}/conf.d/*\nHost solo\n  HostName s.example.com\n", dir.path().display()),
        );
        let got = scan(&cfg, "u");
        let aliases: Vec<_> = got.iter().map(|e| e.alias.as_str()).collect();
        assert_eq!(aliases, vec!["work", "home", "solo"]);
    }

    #[test]
    fn include_cycle_terminates() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = dir.path().join("config");
        write(
            dir.path(),
            "config",
            &format!("Include {}\nHost a\n  HostName a.example.com\n", cfg.display()),
        );
        // Depth-capped rather than hung; the alias is still picked up once per
        // nesting level, and dedup keeps a single row.
        assert_eq!(scan(&cfg, "u").len(), 1);
    }

    #[test]
    fn match_blocks_are_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = write(
            dir.path(),
            "config",
            "Match exec \"true\"\n  User conditional\n\nHost plain\n  HostName p.example.com\n",
        );
        let got = scan(&cfg, "fallback");
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].username, "fallback", "Match settings must not leak");
    }

    #[test]
    fn negated_pattern_vetoes_block() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = write(
            dir.path(),
            "config",
            "Host * !secret\n  User shared\n\nHost secret\n  HostName s.example.com\n\
             \nHost open\n  HostName o.example.com\n",
        );
        let got = scan(&cfg, "fallback");
        let secret = got.iter().find(|e| e.alias == "secret").unwrap();
        let open = got.iter().find(|e| e.alias == "open").unwrap();
        assert_eq!(secret.username, "fallback");
        assert_eq!(open.username, "shared");
    }

    #[test]
    fn glob_matching() {
        assert!(matches_pattern("*", "anything"));
        assert!(matches_pattern("*.example.com", "a.example.com"));
        assert!(matches_pattern("web-?", "web-1"));
        assert!(!matches_pattern("web-?", "web-12"));
        assert!(!matches_pattern("*.example.com", "example.com"));
        assert!(matches_pattern("a*b*c", "axxbyyc"));
        assert!(!matches_pattern("a*b*c", "axxbyy"));
    }

    #[test]
    fn missing_file_is_empty_not_an_error() {
        assert!(scan(Path::new("/nonexistent/ssh/config"), "u").is_empty());
    }
}
