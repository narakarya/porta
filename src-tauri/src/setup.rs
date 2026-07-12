use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::process::Command;

#[derive(Debug, Serialize, Deserialize)]
pub struct SetupStatus {
    pub caddy_installed: bool,
    pub dnsmasq_installed: bool,
    pub test_resolver_exists: bool,
    pub caddy_running: bool,
    pub mkcert_installed: bool,
    pub certs_generated: bool,
}

pub fn check() -> SetupStatus {
    SetupStatus {
        caddy_installed: is_installed("caddy"),
        dnsmasq_installed: is_installed("dnsmasq"),
        test_resolver_exists: crate::dns::resolver_exists("test"),
        caddy_running: crate::caddy::CaddyManager::new().is_running(),
        mkcert_installed: is_installed("mkcert"),
        certs_generated: certs_exist(),
    }
}

/// Homebrew prefix — /opt/homebrew on Apple Silicon, /usr/local on Intel.
fn brew_path() -> &'static str {
    if std::path::Path::new("/opt/homebrew/bin/brew").exists() {
        "/opt/homebrew/bin/brew"
    } else {
        "/usr/local/bin/brew"
    }
}

fn is_installed(bin: &str) -> bool {
    // Check both bin/ and sbin/ — dnsmasq lives in sbin, caddy in bin
    let candidates = [
        format!("/opt/homebrew/bin/{}", bin),
        format!("/opt/homebrew/sbin/{}", bin),
        format!("/usr/local/bin/{}", bin),
        format!("/usr/local/sbin/{}", bin),
        format!("/usr/bin/{}", bin),
    ];
    candidates.iter().any(|p| std::path::Path::new(p).exists())
}

pub fn brew_install(package: &str, on_log: &dyn Fn(&str)) -> Result<()> {
    use std::io::{BufRead, BufReader};
    use std::sync::mpsc;
    use std::thread;

    let brew = brew_path();
    let mut child = Command::new(brew)
        .arg("install")
        .arg(package)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()?;

    // Read stdout + stderr concurrently via a channel to avoid deadlock
    let (tx, rx) = mpsc::channel::<String>();

    let tx_err = tx.clone();
    let stderr = child.stderr.take().unwrap();
    let t_err = thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(|l| l.ok()) {
            tx_err.send(line).ok();
        }
    });

    let tx_out = tx.clone();
    let stdout = child.stdout.take().unwrap();
    let t_out = thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(|l| l.ok()) {
            tx_out.send(line).ok();
        }
    });

    drop(tx);
    for line in rx {
        on_log(&line);
    }
    t_err.join().ok();
    t_out.join().ok();

    let status = child.wait()?;
    if !status.success() {
        return Err(anyhow::anyhow!("brew install {} failed", package));
    }
    Ok(())
}

fn caddy_path() -> &'static str {
    if std::path::Path::new("/opt/homebrew/opt/caddy/bin/caddy").exists() {
        "/opt/homebrew/opt/caddy/bin/caddy"
    } else if std::path::Path::new("/opt/homebrew/bin/caddy").exists() {
        "/opt/homebrew/bin/caddy"
    } else {
        "/usr/local/bin/caddy"
    }
}

/// Build the child-process command for a dev-profile Caddy: `caddy run --config
/// <init.json>` with XDG dirs pinned to the dev caddy dir so its autosave and
/// cert/ACME data never touch prod's `~/.porta/caddy`. Mirrors the prod plist's
/// env (setup.rs `caddy_plist_content`), just as an un-privileged child.
fn dev_caddy_command(
    caddy: &str,
    init_json: &std::path::Path,
    xdg_dir: &std::path::Path,
) -> Command {
    let mut cmd = Command::new(caddy);
    cmd.arg("run")
        .arg("--config")
        .arg(init_json)
        .env("XDG_CONFIG_HOME", xdg_dir)
        .env("XDG_DATA_HOME", xdg_dir);
    cmd
}

/// Start a dev-profile Caddy as an ordinary child (ports > 1024, no root, no
/// osascript). Idempotent: if the dev admin API already answers, reuse it.
fn start_dev_caddy(on_log: &dyn Fn(&str)) -> Result<()> {
    if crate::caddy::CaddyManager::new().is_running() {
        on_log("Dev Caddy already running.");
        return Ok(());
    }
    let caddy_dir = crate::porta_dir().join("caddy");
    std::fs::create_dir_all(&caddy_dir)?;

    // Seed config already carries the dev admin :2119 + :8443/:8080 listeners.
    let init = crate::caddy::CaddyManager::build_config_with(&[], &crate::caddy::CaddyProfile::DEV);
    let init_path = caddy_dir.join("init.json");
    std::fs::write(&init_path, serde_json::to_vec_pretty(&init)?)?;

    on_log("Starting dev Caddy (child process on :8443/:8080)…");
    dev_caddy_command(caddy_path(), &init_path, &caddy_dir)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()?;

    for i in 0..15 {
        std::thread::sleep(std::time::Duration::from_secs(1));
        if crate::caddy::CaddyManager::new().is_running() {
            on_log("Dev Caddy is running.");
            return Ok(());
        }
        if i == 5 {
            on_log("Still waiting for dev Caddy admin API…");
        }
    }
    Err(anyhow::anyhow!("Dev Caddy did not respond after 15 seconds"))
}

const PLIST_LABEL: &str = "com.narakarya.porta.caddy";

/// Generate the launchd plist that runs Caddy in API mode with --resume.
fn caddy_plist_content() -> String {
    let caddy = caddy_path();
    let config_dir = crate::porta_dir().join("caddy");
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{PLIST_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>{caddy}</string>
        <string>run</string>
        <string>--resume</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>XDG_CONFIG_HOME</key>
        <string>{config_dir}</string>
        <key>XDG_DATA_HOME</key>
        <string>{config_dir}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/porta-caddy.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/porta-caddy.log</string>
</dict>
</plist>"#,
        config_dir = config_dir.display(),
    )
}

/// Run a batch of privileged shell commands in ONE `osascript … with
/// administrator privileges` call, so several root-requiring setup operations
/// share a single password prompt instead of one prompt each.
///
/// Commands must use only single quotes (no `"`), since they're spliced into an
/// AppleScript double-quoted `do shell script`. Non-cancel failures are logged
/// as warnings rather than hard errors (matching the old Caddy path, where a
/// stray `launchctl unload` of a missing daemon exits non-zero); callers that
/// care about the result verify it separately (e.g. the Caddy wait loop).
fn run_privileged_batch(cmds: &[String], on_log: &dyn Fn(&str)) -> Result<()> {
    if cmds.is_empty() {
        return Ok(());
    }
    let script = format!(
        "do shell script \"{}\" with administrator privileges",
        cmds.join("; "),
    );
    let out = Command::new("osascript").arg("-e").arg(&script).output()?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        if stderr.contains("User canceled") || stderr.contains("cancelled") {
            return Err(anyhow::anyhow!("Admin permission was cancelled."));
        }
        on_log(&format!("osascript warning: {}", stderr.trim()));
    }
    Ok(())
}

pub fn start_caddy(on_log: &dyn Fn(&str)) -> Result<()> {
    start_caddy_inner(on_log, &[])
}

/// Start Caddy, optionally folding `extra_privileged` shell commands (e.g. the
/// `/etc/resolver` write) into the same admin prompt used to install the Caddy
/// launchd daemon — so full setup asks for the password once, not per step.
pub fn start_caddy_inner(on_log: &dyn Fn(&str), extra_privileged: &[String]) -> Result<()> {
    // Dev profile: un-privileged child, fully isolated from the prod :443 daemon.
    if !crate::caddy::CaddyProfile::current().privileged {
        // Queued privileged commands (resolver writes) are a prod-setup concern;
        // dev shares the system dnsmasq/resolver already, so run any that exist
        // but don't block dev Caddy on them.
        run_privileged_batch(extra_privileged, on_log).ok();
        return start_dev_caddy(on_log);
    }

    // Fast path: already running — no daemon install needed. But any queued
    // privileged commands still have to run; give them their own single prompt.
    if crate::caddy::CaddyManager::new().is_running() {
        on_log("Caddy is already running.");
        return run_privileged_batch(extra_privileged, on_log);
    }

    let plist_path = format!("/Library/LaunchDaemons/{}.plist", PLIST_LABEL);

    // Ensure the caddy config dir exists
    let config_dir = crate::porta_dir().join("caddy");
    std::fs::create_dir_all(&config_dir)?;

    if certs_exist() {
        // HTTPS mode: Caddy must bind :443 — requires root via launchd daemon.
        // Install a custom plist that runs `caddy run --resume` (API mode).
        on_log("Applying admin configuration (port 443 service + DNS resolver)…");
        on_log("(macOS will ask for your password once)");

        let plist_content = caddy_plist_content();
        // Write plist to temp file, then use osascript to move and load (avoids quoting issues)
        let tmp_plist = "/tmp/porta-caddy-daemon.plist";
        std::fs::write(tmp_plist, &plist_content)?;

        // One prompt covers the queued commands (resolver, …) plus the daemon.
        let mut cmds: Vec<String> = extra_privileged.to_vec();
        cmds.push(format!("launchctl unload '{plist_path}' 2>/dev/null || true"));
        cmds.push(format!("cp '{tmp_plist}' '{plist_path}'"));
        cmds.push(format!("launchctl load -w '{plist_path}'"));
        run_privileged_batch(&cmds, on_log)?;

        on_log("Waiting for Caddy to come up…");
        for i in 0..15 {
            std::thread::sleep(std::time::Duration::from_secs(1));
            if crate::caddy::CaddyManager::new().is_running() {
                on_log("Caddy is running (persistent via launchd).");
                return Ok(());
            }
            if i == 5 {
                on_log("Still waiting for Caddy admin API…");
            }
        }

        return Err(anyhow::anyhow!(
            "Caddy did not respond after 15 seconds. Check /tmp/porta-caddy.log for details."
        ));
    }

    // HTTP-only mode — Caddy needs no admin, but queued privileged commands
    // (resolver) still do; run them in their own prompt first.
    run_privileged_batch(extra_privileged, on_log)?;
    on_log("Starting Caddy (HTTP mode)…");
    let out = Command::new(caddy_path()).arg("start").output()?;
    if out.status.success() { return Ok(()); }
    let stderr = String::from_utf8_lossy(&out.stderr);
    if stderr.contains("already") || stderr.contains("pid file") { return Ok(()); }
    Err(anyhow::anyhow!("Failed to start Caddy: {}", stderr.trim()))
}

/// workspace_domains: list of all workspace domain strings (e.g. ["uq.test", "tanyaobat.test"])
/// on_step: callback called with the step key just before that step runs (for live UI updates)
pub fn run_full_setup(
    workspace_domains: &[String],
    on_step: &dyn Fn(&str),
    on_log: &dyn Fn(&str),
) -> Result<()> {
    let status = check();
    // Root-requiring shell commands are collected here and applied together in a
    // single admin prompt at the Caddy step, so setup asks for the password once
    // (plus mkcert's own keychain prompt) instead of once per privileged step.
    let mut priv_cmds: Vec<String> = Vec::new();
    if !status.caddy_installed {
        on_step("caddy_installed");
        on_log("Installing Caddy via Homebrew — this may take a few minutes…");
        brew_install("caddy", on_log)?;
    }
    if !status.dnsmasq_installed {
        on_step("dnsmasq_installed");
        on_log("Installing dnsmasq via Homebrew…");
        brew_install("dnsmasq", on_log)?;
    }
    if !status.test_resolver_exists {
        on_step("test_resolver_exists");
        on_log("Queuing /etc/resolver/test for the single admin prompt…");
        priv_cmds.push(crate::dns::resolver_write_command("test"));
    }
    if !status.mkcert_installed {
        on_step("mkcert_installed");
        on_log("Installing mkcert via Homebrew…");
        brew_install("mkcert", on_log)?;
        on_log("Installing mkcert CA into macOS Keychain (admin required)…");
        install_mkcert_ca()?;
        on_log("CA installed.");
    }
    on_step("certs_generated");
    on_log(&format!(
        "Generating SSL certs for: *.test {}",
        workspace_domains.iter().map(|d| format!("*.{d}")).collect::<Vec<_>>().join(" ")
    ));
    generate_certs(workspace_domains)?;
    on_log(&format!("Certificates written to {}/certs/", crate::porta_dir().display()));

    on_step("caddy_running");
    // Folds the queued resolver write (if any) into the same admin prompt that
    // installs the Caddy launchd daemon.
    start_caddy_inner(on_log, &priv_cmds)?;
    on_log("Setup complete ✓");
    Ok(())
}

fn mkcert_path() -> Option<String> {
    let candidates = [
        "/opt/homebrew/bin/mkcert",
        "/usr/local/bin/mkcert",
    ];
    candidates.iter()
        .find(|p| std::path::Path::new(p).exists())
        .map(|s| s.to_string())
}

/// Where mkcert keeps its CA (rootCA.pem / rootCA-key.pem).
///
/// mkcert's default is `~/Library/Application Support/mkcert`, but that lives
/// under `~/Library`, which macOS TCC gates for GUI apps: a Terminal shell (as
/// the user) can read the CA key there, yet the Porta app's mkcert subprocess
/// is denied — so cert generation fails with "permission denied" reading the CA
/// key. Point CAROOT at Porta's own data dir instead (the same place we already
/// read/write the DB, config and certs), which the app can always access.
fn caroot_dir() -> std::path::PathBuf {
    crate::porta_dir().join("mkcert")
}

/// Build an mkcert `Command` with `CAROOT` pinned to [`caroot_dir`], creating
/// the directory first so mkcert can write the CA into it.
fn mkcert_command(mkcert: &str) -> Result<Command> {
    let caroot = caroot_dir();
    std::fs::create_dir_all(&caroot)?;
    let mut cmd = Command::new(mkcert);
    cmd.env("CAROOT", &caroot);
    Ok(cmd)
}

pub fn certs_exist() -> bool {
    let cert = crate::porta_dir().join("certs").join("test.pem");
    cert.exists()
}

/// Install the mkcert CA into the macOS Keychain.
///
/// Run mkcert as the *current user* — NOT via `osascript … with administrator
/// privileges`. mkcert adds its root to the System keychain through
/// `security add-trusted-cert`, whose `SecTrustSettingsSetTrustSettings` call
/// needs an interactive authorization from the user's GUI security session.
/// Wrapping it in osascript runs mkcert as root detached from that session, so
/// the nested trust-settings auth fails with "authorization was denied since no
/// user interaction was possible". Running as the user lets macOS present its
/// own native admin prompt. CAROOT is pinned to Porta's own data dir (see
/// [`caroot_dir`]) so the app can always read the CA it just created.
pub fn install_mkcert_ca() -> Result<()> {
    let mkcert = mkcert_path()
        .ok_or_else(|| anyhow::anyhow!("mkcert not found"))?;
    let out = mkcert_command(&mkcert)?.arg("-install").output()?;
    if !out.status.success() {
        // mkcert logs progress and errors to stderr; fall back to stdout.
        let stderr = String::from_utf8_lossy(&out.stderr);
        let stdout = String::from_utf8_lossy(&out.stdout);
        let detail = if stderr.trim().is_empty() {
            stdout.trim()
        } else {
            stderr.trim()
        };
        return Err(anyhow::anyhow!("mkcert -install failed: {}", detail));
    }
    Ok(())
}

/// Generate wildcard certs for *.test + each workspace domain → ~/.porta/certs/
/// Follows the same pattern as nexus-infra: include both apex (uq.test) AND wildcard
/// (*.uq.test) so the cert covers the root domain and all its subdomains.
/// Also re-runs `mkcert -install` to ensure the CA is trusted before generating.
pub fn generate_certs(workspace_domains: &[String]) -> Result<()> {
    let mkcert = mkcert_path()
        .ok_or_else(|| anyhow::anyhow!("mkcert not found"))?;
    let certs_dir = crate::porta_dir().join("certs");
    std::fs::create_dir_all(&certs_dir)?;

    // Re-run -install each time (idempotent) to ensure CA stays trusted in the
    // system keychain — matches the nexus-infra pattern.
    if let Ok(mut c) = mkcert_command(&mkcert) {
        let _ = c.arg("-install").output();
    }

    let cert_file = certs_dir.join("test.pem");
    let key_file = certs_dir.join("test-key.pem");

    // Assemble the SAN list once — we may run mkcert more than once (retry).
    let mut names: Vec<String> = vec!["*.test".into(), "localhost".into()];
    // For each workspace domain add both apex and wildcard:
    //   uq.test        → covers the root domain itself
    //   *.uq.test      → covers api.uq.test, app.uq.test, etc.
    let mut seen = std::collections::HashSet::new();
    for domain in workspace_domains {
        if seen.insert(domain.clone()) {
            names.push(domain.clone());
            names.push(format!("*.{}", domain));
        }
    }

    // Retry guards against a rare transient read of the CAROOT key; with CAROOT
    // pinned to Porta's own data dir (see caroot_dir) the persistent macOS-TCC
    // denial on ~/Library is gone, but a one-off hiccup still shouldn't surface
    // as a hard error.
    let mut last_err = String::new();
    for attempt in 0..3 {
        let out = mkcert_command(&mkcert)?
            .arg("-cert-file").arg(&cert_file)
            .arg("-key-file").arg(&key_file)
            .args(&names)
            .output()?;
        if out.status.success() {
            return Ok(());
        }
        last_err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        if last_err.contains("permission denied") && attempt < 2 {
            std::thread::sleep(std::time::Duration::from_millis(600));
            continue;
        }
        break;
    }
    if last_err.contains("permission denied") {
        return Err(anyhow::anyhow!(
            "mkcert couldn't read its CA key (permission denied). This is usually a \
             transient first-run hiccup — please run setup again. ({last_err})"
        ));
    }
    Err(anyhow::anyhow!("mkcert generate failed: {last_err}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;
    use std::path::Path;

    #[test]
    fn dev_caddy_command_runs_with_init_config_and_isolated_xdg() {
        let cmd = dev_caddy_command(
            "/opt/homebrew/bin/caddy",
            Path::new("/Users/x/.porta-dev/caddy/init.json"),
            Path::new("/Users/x/.porta-dev/caddy"),
        );
        // Args: run --config <init.json>
        let args: Vec<String> = cmd.get_args()
            .map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(args, vec![
            "run".to_string(),
            "--config".to_string(),
            "/Users/x/.porta-dev/caddy/init.json".to_string(),
        ]);
        // XDG env points at the dev caddy dir, isolating autosave + data from prod.
        let has = |k: &str, v: &str| cmd.get_envs()
            .any(|(ek, ev)| ek == OsStr::new(k) && ev == Some(OsStr::new(v)));
        assert!(has("XDG_CONFIG_HOME", "/Users/x/.porta-dev/caddy"), "XDG_CONFIG_HOME isolated");
        assert!(has("XDG_DATA_HOME", "/Users/x/.porta-dev/caddy"), "XDG_DATA_HOME isolated");
    }
}
