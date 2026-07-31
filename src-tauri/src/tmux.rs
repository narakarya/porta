//! Long-lived process hosting on top of the `tmux` CLI.
//!
//! Porta used to own the lifetime of everything it ran. App servers were
//! spawned with `Stdio::piped()` (see `process_manager::shell_command`) and
//! terminals with an in-process PTY, so both died with Porta — and because the
//! read end of those pipes went away with the process, they died even when
//! nothing killed them explicitly. An auto-update restart therefore took every
//! running dev server down with it, which is the problem this module exists to
//! solve.
//!
//! Hosting them in a tmux server instead moves that lifetime *out* of Porta:
//! the tmux server daemonises itself and is nobody's child, so a session
//! survives Porta quitting, crashing, or updating, and Porta re-adopts it on
//! the next boot by listing sessions rather than by remembering PIDs.
//!
//! Everything here shells out to the `tmux` binary rather than speaking the
//! control-mode (`-CC`) protocol. Control mode would let Porta drive tmux panes
//! as first-class UI, but it is a stateful protocol with a long tail of edge
//! cases; the CLI covers every operation Porta actually needs (create, list,
//! pipe output, kill) with no protocol state to keep in sync.

use anyhow::{anyhow, Result};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;

/// Session-name prefix for an app server started from an app card.
pub const APP_PREFIX: &str = "porta-app-";
/// Session-name prefix for an interactive terminal pane.
pub const TERM_PREFIX: &str = "porta-term-";

/// Minimum tmux that supports `new-session -e KEY=VAL`, which is how per-app
/// environment (PORT, `.env` contents, inline vars) reaches the process. Older
/// tmux would silently drop it and start apps with the wrong environment, so
/// treat it as unavailable rather than half-working.
const MIN_VERSION: (u32, u32) = (3, 0);

/// A dedicated socket, never tmux's default one.
///
/// Two reasons. Isolation: the user's own `tmux kill-server` (or a stray
/// `tmux ls`) neither destroys nor lists Porta's sessions. And channel
/// separation: stable/beta/dev builds keep separate `porta_dir()`s, so they get
/// separate sockets and can run side by side without adopting each other's
/// apps.
pub fn socket() -> &'static str {
    static SOCKET: OnceLock<String> = OnceLock::new();
    SOCKET.get_or_init(|| {
        // ~/.porta -> "porta", ~/.porta-beta -> "porta-beta", ~/.porta-dev -> "porta-dev".
        crate::porta_dir()
            .file_name()
            .and_then(|s| s.to_str())
            .map(|s| s.trim_start_matches('.').to_string())
            .unwrap_or_else(|| "porta".to_string())
    })
}

/// Absolute path to the `tmux` binary, or `None` if it isn't installed.
///
/// Probed by absolute path rather than through `PATH`: launched from Finder or
/// the Dock, a `.app` bundle inherits a minimal environment in which Homebrew's
/// prefix is absent, so a bare `Command::new("tmux")` fails in the shipped app
/// while working fine under `npm run tauri dev`. The candidate list mirrors
/// `setup::is_installed`.
pub fn binary() -> Option<&'static PathBuf> {
    static BIN: OnceLock<Option<PathBuf>> = OnceLock::new();
    BIN.get_or_init(|| {
        [
            "/opt/homebrew/bin/tmux",
            "/usr/local/bin/tmux",
            "/usr/bin/tmux",
        ]
        .iter()
        .map(PathBuf::from)
        .find(|p| p.exists())
    })
    .as_ref()
}

/// Parse the `major.minor` out of a `tmux -V` line ("tmux 3.7b" -> `(3, 7)`).
/// Point releases carry a letter suffix, so the minor is parsed up to the first
/// non-digit rather than with a plain `parse()`.
fn parse_version(output: &str) -> Option<(u32, u32)> {
    let rest = output.trim().strip_prefix("tmux ")?;
    let mut parts = rest.split('.');
    let major: u32 = parts.next()?.parse().ok()?;
    let minor_raw = parts.next().unwrap_or("0");
    let digits: String = minor_raw.chars().take_while(|c| c.is_ascii_digit()).collect();
    Some((major, digits.parse().unwrap_or(0)))
}

/// Is a usable tmux installed? Cached — this gates every start path, so it must
/// not shell out on the hot path.
pub fn available() -> bool {
    static OK: OnceLock<bool> = OnceLock::new();
    *OK.get_or_init(|| {
        let Some(bin) = binary() else { return false };
        Command::new(bin)
            .arg("-V")
            .output()
            .ok()
            .and_then(|o| parse_version(&String::from_utf8_lossy(&o.stdout)))
            .map(|v| v >= MIN_VERSION)
            .unwrap_or(false)
    })
}

/// Porta's own tmux config, written once and never clobbered afterwards.
///
/// The server is started with `-f` pointing here instead of the user's
/// `~/.tmux.conf`: Porta's terminal panes are rendered inside its own UI, and a
/// user config that turns on a status bar, rebinds keys, or sets a small
/// history limit would change how those panes behave in ways Porta can't
/// predict. Created only when absent, so anyone who wants to customise it can,
/// and an update won't overwrite their edits.
fn config_path() -> PathBuf {
    let path = crate::porta_dir().join("tmux.conf");
    if !path.exists() {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(
            &path,
            "# Porta-managed tmux config. Edit freely — Porta only writes this\n\
             # file when it is missing, and never overwrites your changes.\n\
             \n\
             # Porta draws its own chrome around embedded panes.\n\
             set -g status off\n\
             \n\
             # A reattaching Porta window should drive the size, rather than\n\
             # being clamped to some other client that is still attached from a\n\
             # terminal app. Without this a smaller external client shrinks the\n\
             # pane inside Porta and leaves dead space around it.\n\
             set -g window-size latest\n\
             set -g aggressive-resize on\n\
             \n\
             # Scrollback well past the 256 KB replay buffer Porta keeps.\n\
             set -g history-limit 100000\n\
             \n\
             # No escape-sequence guess delay; xterm.js sends ESC on its own.\n\
             set -sg escape-time 0\n\
             set -g default-terminal \"xterm-256color\"\n",
        );
    }
    path
}

/// A `tmux` invocation against Porta's socket and config.
fn tmux() -> Result<Command> {
    let bin = binary().ok_or_else(|| anyhow!("tmux is not installed"))?;
    let mut cmd = Command::new(bin);
    cmd.arg("-L").arg(socket()).arg("-f").arg(config_path());
    Ok(cmd)
}

/// tmux session names cannot contain `.` or `:` (both are address separators),
/// and whitespace makes every `-t` argument ambiguous. App ids are opaque to
/// this module, so fold anything outside a safe alphabet to `_`.
fn sanitize(raw: &str) -> String {
    raw.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

/// Session name hosting `app_id`'s server process.
pub fn app_session(app_id: &str) -> String {
    format!("{APP_PREFIX}{}", sanitize(app_id))
}

/// Session name hosting one interactive terminal pane.
pub fn term_session(pane_id: &str) -> String {
    format!("{TERM_PREFIX}{}", sanitize(pane_id))
}

/// Recover the app id from a session name produced by [`app_session`].
///
/// Only correct for ids that survive [`sanitize`] unchanged — which is why
/// re-adoption cross-checks the recovered id against the database rather than
/// trusting it.
pub fn app_id_from_session(session: &str) -> Option<&str> {
    session.strip_prefix(APP_PREFIX)
}

/// One pane's live state, as reported by `list-panes`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pane {
    pub session: String,
    /// PID of the process tmux started in the pane — the login shell wrapping
    /// the app's command, and the root of the tree `signal_tree` walks.
    pub pid: u32,
    /// The pane's own tty. `tcgetpgrp` on this reports the pane's *foreground*
    /// process group, which is what tells a busy pane from an idle prompt.
    pub tty: String,
    /// True once the command exited and `remain-on-exit` held the pane open.
    pub dead: bool,
    /// Exit status, present only once `dead`.
    pub dead_status: Option<i32>,
    /// A capture pipe is already attached. Checked before attaching another —
    /// `pipe-pane -o` *toggles*, so re-piping a pane that is already piped
    /// silently turns capture off.
    pub piped: bool,
}

/// Field separator for [`panes`].
///
/// Emphatically not a tab: tmux sanitises control characters out of `-F`
/// output, rewriting every tab as `_`, so a tab-separated format silently
/// arrives as one unsplittable field. `|` survives, and cannot occur in any of
/// the four trailing fields (two integers, a `/dev/...` path, and a flag).
const FIELD_SEP: char = '|';

/// Field order must match the `-F` format string in [`panes`].
///
/// Split from the right, so a session name containing the separator still
/// parses: only `session_name` is user-influenced, and the four fields after it
/// have shapes that can never contain `|`.
fn parse_pane_line(line: &str) -> Option<Pane> {
    let mut f = line.rsplitn(6, FIELD_SEP);
    let piped = f.next()? == "1";
    // Empty for a live pane; tmux only fills it in once the command exits.
    let dead_status = f.next().and_then(|s| s.parse().ok());
    let dead = f.next()? == "1";
    let tty = f.next()?.to_string();
    let pid: u32 = f.next()?.parse().ok()?;
    let session = f.next()?.to_string();
    Some(Pane { session, pid, tty, dead, dead_status, piped })
}

/// Every pane on Porta's socket. Empty when no server is running — that is the
/// normal cold-start state, not an error, so it isn't reported as one.
pub fn panes() -> Vec<Pane> {
    let Ok(mut cmd) = tmux() else { return Vec::new() };
    let Ok(out) = cmd
        .args([
            "list-panes",
            "-a",
            "-F",
            "#{session_name}|#{pane_pid}|#{pane_tty}|#{pane_dead}|#{pane_dead_status}|#{pane_pipe}",
        ])
        .stderr(Stdio::null())
        .output()
    else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(parse_pane_line)
        .collect()
}

/// The single pane of `session`, if it exists.
pub fn pane(session: &str) -> Option<Pane> {
    panes().into_iter().find(|p| p.session == session)
}

/// Does `session` exist (alive *or* holding a dead pane)?
pub fn has_session(session: &str) -> bool {
    let Ok(mut cmd) = tmux() else { return false };
    cmd.args(["has-session", "-t", session])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Start `command` detached in a new session and return its pane.
///
/// `remain-on-exit` is set in the *same* tmux invocation as `new-session`
/// rather than a follow-up call: a command that fails immediately (a typo'd
/// start command, a missing binary) would otherwise take the session down
/// before the second call landed, and its exit status — the only thing that
/// tells a crash from a clean stop — would be lost.
///
/// The command reaches tmux as its own argument, so it is passed through
/// verbatim: no quoting is applied or required, and a start command containing
/// quotes, `$`, or backticks is handed to the shell exactly as the user wrote
/// it.
pub fn start_detached(
    session: &str,
    cwd: &Path,
    shell: &str,
    command: &str,
    env: &[(String, String)],
    pipe: Option<&str>,
) -> Result<Pane> {
    let mut cmd = tmux()?;
    cmd.args(["new-session", "-d", "-s", session, "-c"]).arg(cwd);
    for (key, val) in env {
        cmd.arg("-e").arg(format!("{key}={val}"));
    }
    // The login shell mirrors `process_manager::shell_command`, so a tmux-hosted
    // app sees the same PATH (Homebrew, asdf, nvm) as a piped one.
    cmd.arg(shell).arg("-l").arg("-c").arg(command);
    // A bare `;` is tmux's command separator, not shell syntax. Chaining rather
    // than issuing follow-up calls is what makes both of these reliable: tmux
    // runs the whole list before returning to its event loop, so the pipe is
    // attached before the server ever reads the pane, and `remain-on-exit` is
    // set before a command that fails instantly can take the session down with
    // its exit status. Attaching the pipe in a second invocation lost the first
    // lines of anything that printed at startup.
    if let Some(target) = pipe {
        cmd.args([";", "pipe-pane", "-o", "-t", session]).arg(target);
    }
    cmd.args([";", "set-option", "-t", session, "remain-on-exit", "on"]);

    let out = cmd.output()?;
    if !out.status.success() {
        return Err(anyhow!(
            "tmux new-session failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    pane(session).ok_or_else(|| anyhow!("tmux session {session} vanished immediately after start"))
}

/// Arguments for a PTY-hosted tmux client that creates-or-attaches `session`.
///
/// This is `terminal_open`'s idempotency, delegated: `-A` attaches to the
/// running shell when the session already exists and creates it otherwise, so
/// the shell a user left behind — with its history, its cwd, and whatever was
/// running in it — is still there after Porta restarts. Everything after the
/// binary itself, so the caller can spawn it into a PTY it owns.
pub fn interactive_client_args(session: &str, cwd: &Path, shell: &str) -> Vec<String> {
    vec![
        "-L".into(),
        socket().into(),
        "-f".into(),
        config_path().to_string_lossy().into_owned(),
        "new-session".into(),
        "-A".into(),
        "-s".into(),
        session.into(),
        "-c".into(),
        cwd.to_string_lossy().into_owned(),
        // Explicit `-i -l` rather than tmux's default-command, to match exactly
        // how the non-tmux path spawns a shell.
        shell.into(),
        "-i".into(),
        "-l".into(),
    ]
}

/// The foreground process group of the terminal at `tty`, or `-1`.
///
/// Two layers of indirection are unavoidable here. With tmux in the loop,
/// `tcgetpgrp` on the PTY *master* reports the tmux client — always a different
/// group from the shell, which would make every pane look permanently busy and
/// point ^C at the client instead of the user's command. And `tcgetpgrp` on the
/// pane's own tty is not an option either: macOS rejects it with `ENOTTY` for
/// any process the terminal is not the controlling terminal of, which Porta
/// never is for a pane the tmux server owns.
///
/// So ask `ps`, which reads the same kernel state without the ownership
/// restriction: BSD `stat` marks every process in the terminal's foreground
/// group with `+` (`Ss+` for a shell at its prompt, `S+` for a job running in
/// front of it), and that group is exactly what `tcgetpgrp` would have returned.
pub fn pane_foreground_pgid(tty: &str) -> i32 {
    // `ps -t` wants the device name, not the path.
    let name = tty.strip_prefix("/dev/").unwrap_or(tty);
    let Ok(out) = Command::new("ps")
        .args(["-t", name, "-o", "pgid=,stat="])
        .stderr(Stdio::null())
        .output()
    else {
        return -1;
    };
    if !out.status.success() {
        return -1;
    }
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let mut f = line.split_whitespace();
        let (Some(pgid), Some(stat)) = (f.next(), f.next()) else {
            continue;
        };
        if stat.contains('+') {
            if let Ok(v) = pgid.parse::<i32>() {
                return v;
            }
        }
    }
    -1
}

/// Mirror everything the pane prints into `app_id`'s log, via Porta itself.
///
/// The pipe target is this same binary re-invoked with
/// [`crate::process_manager::LOG_FILTER_FLAG`], for two reasons. It keeps a
/// single definition of how a log line is timestamped, so a tmux-hosted app's
/// log file is shaped exactly like a piped one's and `get_app_logs` never needs
/// to know which backend wrote it. And because tmux spawns it, the filter is a
/// child of the *tmux server* rather than of Porta — so it keeps recording
/// across a Porta quit, crash, or update, which is precisely the window in
/// which losing an app's output would hurt most.
///
/// **Only call this on a pane with no pipe attached.** `pipe-pane -o` toggles:
/// on a pane that is already piped it *closes* the pipe rather than leaving it
/// alone. Re-adoption therefore has to check [`Pane::piped`] first — calling
/// this unconditionally on a surviving session would silently stop the capture
/// that survived, which is exactly the output a restart most needs to keep.
pub fn pipe_to_filter(session: &str, exe: &Path, app_id: &str) -> Result<()> {
    let mut cmd = tmux()?;
    cmd.args(["pipe-pane", "-o", "-t", session])
        .arg(filter_target(exe, app_id));
    cmd.output()?;
    Ok(())
}

/// The shell command tmux runs to capture a pane: Porta, re-invoked as a log
/// filter for `app_id`. Shared by the start path (which chains it into
/// `new-session`) and by re-adoption.
pub fn filter_target(exe: &Path, app_id: &str) -> String {
    format!(
        "{} {} {}",
        sh_quote(&exe.to_string_lossy()),
        crate::process_manager::LOG_FILTER_FLAG,
        sh_quote(app_id),
    )
}

/// Single-quote a value for the `sh -c` that tmux runs a pipe target under.
/// App ids and the executable path both reach the shell as text, and a home
/// directory or app name containing a quote would otherwise break the command.
fn sh_quote(raw: &str) -> String {
    format!("'{}'", raw.replace('\'', r"'\''"))
}

/// Destroy a session and everything running in it.
pub fn kill_session(session: &str) -> Result<()> {
    let mut cmd = tmux()?;
    cmd.args(["kill-session", "-t", session])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()?;
    Ok(())
}

/// Send a literal line plus Enter to a session's pane.
///
/// `-l` disables tmux's key-name parsing, so text like `C-c` or `Enter` inside
/// a startup command is typed rather than interpreted as a keystroke.
pub fn send_line(session: &str, text: &str) -> Result<()> {
    let mut cmd = tmux()?;
    cmd.args(["send-keys", "-l", "-t", session]).arg(text);
    cmd.output()?;
    let mut enter = tmux()?;
    enter.args(["send-keys", "-t", session, "Enter"]);
    enter.output()?;
    Ok(())
}

/// The command a user can run in their own terminal to attach to `session`.
/// Surfaced in the UI so a session hosted by Porta is reachable without it.
pub fn attach_command(session: &str) -> String {
    let bin = binary()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "tmux".to_string());
    format!("{bin} -L {} attach -t {session}", socket())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_parses_point_release_suffixes() {
        assert_eq!(parse_version("tmux 3.7b\n"), Some((3, 7)));
        assert_eq!(parse_version("tmux 3.0a"), Some((3, 0)));
        assert_eq!(parse_version("tmux 2.8"), Some((2, 8)));
        assert_eq!(parse_version("tmux next-3.4"), None);
        assert_eq!(parse_version(""), None);
    }

    #[test]
    fn version_gate_rejects_tmux_without_new_session_env() {
        assert!(parse_version("tmux 2.9a").unwrap() < MIN_VERSION);
        assert!(parse_version("tmux 3.0a").unwrap() >= MIN_VERSION);
        assert!(parse_version("tmux 3.7b").unwrap() >= MIN_VERSION);
    }

    #[test]
    fn session_names_drop_tmux_address_separators() {
        // `.` and `:` would make every `-t` argument ambiguous.
        assert_eq!(app_session("my.app:1"), "porta-app-my_app_1");
        assert_eq!(term_session("pane 2"), "porta-term-pane_2");
        assert_eq!(app_session("keep-these_09"), "porta-app-keep-these_09");
    }

    #[test]
    fn app_id_round_trips_out_of_a_session_name() {
        assert_eq!(app_id_from_session("porta-app-blog"), Some("blog"));
        assert_eq!(app_id_from_session("porta-term-blog"), None);
        assert_eq!(app_id_from_session("unrelated"), None);
    }

    #[test]
    fn pane_line_parses_a_live_pane() {
        let p = parse_pane_line("porta-app-blog|4242|/dev/ttys004|0||1").unwrap();
        assert_eq!(
            p,
            Pane {
                session: "porta-app-blog".into(),
                pid: 4242,
                tty: "/dev/ttys004".into(),
                dead: false,
                dead_status: None,
                piped: true,
            }
        );
    }

    #[test]
    fn pane_line_parses_a_dead_pane_with_its_exit_status() {
        let p = parse_pane_line("porta-app-blog|4242|/dev/ttys004|1|42|0").unwrap();
        assert!(p.dead);
        assert_eq!(p.dead_status, Some(42));
        assert!(!p.piped);
    }

    #[test]
    fn pane_line_rejects_garbage() {
        assert!(parse_pane_line("").is_none());
        assert!(parse_pane_line("only-a-session-name").is_none());
        assert!(parse_pane_line("sess|not-a-pid|/dev/ttys0|0||0").is_none());
    }
}
