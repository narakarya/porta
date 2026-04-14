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

pub fn start_caddy(on_log: &dyn Fn(&str)) -> Result<()> {
    // Fast path: already running — skip everything, no password dialog needed
    if crate::caddy::CaddyManager::new().is_running() {
        on_log("Caddy is already running.");
        return Ok(());
    }

    let plist_path = format!("/Library/LaunchDaemons/{}.plist", PLIST_LABEL);

    // Ensure the caddy config dir exists
    let config_dir = crate::porta_dir().join("caddy");
    std::fs::create_dir_all(&config_dir)?;

    if certs_exist() {
        // HTTPS mode: Caddy must bind :443 — requires root via launchd daemon.
        // Install a custom plist that runs `caddy run --resume` (API mode).
        on_log("Installing Caddy as a persistent service (port 443, admin required)…");
        on_log("(macOS will ask for your password)");

        let plist_content = caddy_plist_content();
        // Write plist to temp file, then use osascript to move and load (avoids quoting issues)
        let tmp_plist = "/tmp/porta-caddy-daemon.plist";
        std::fs::write(tmp_plist, &plist_content)?;

        let script = format!(
            "do shell script \"launchctl unload '{plist_path}' 2>/dev/null; \
             cp '{tmp_plist}' '{plist_path}'; \
             launchctl load -w '{plist_path}'\" \
             with administrator privileges",
            plist_path = plist_path,
            tmp_plist = tmp_plist,
        );
        let out = Command::new("osascript")
            .arg("-e").arg(&script)
            .output()?;

        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            if stderr.contains("User canceled") || stderr.contains("cancelled") {
                return Err(anyhow::anyhow!("Admin permission was cancelled. HTTPS requires Caddy to run with admin privileges."));
            }
            on_log(&format!("osascript warning: {}", stderr.trim()));
        }

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

    // HTTP-only mode — no admin needed, just start directly
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
        on_log("Writing /etc/resolver/test…");
        crate::dns::write_resolver("test")?;
        on_log("Done.");
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
    start_caddy(on_log)?;
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

pub fn certs_exist() -> bool {
    let cert = crate::porta_dir().join("certs").join("test.pem");
    cert.exists()
}

/// Install the mkcert CA into the macOS Keychain (requires admin).
pub fn install_mkcert_ca() -> Result<()> {
    let mkcert = mkcert_path()
        .ok_or_else(|| anyhow::anyhow!("mkcert not found"))?;
    // mkcert -install modifies the macOS Keychain — needs admin privileges
    let script = format!(
        "do shell script \"{}  -install\" with administrator privileges",
        mkcert
    );
    let out = Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(anyhow::anyhow!("mkcert -install failed: {}", stderr.trim()));
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
    let _ = Command::new(&mkcert).arg("-install").output();

    let cert_file = certs_dir.join("test.pem");
    let key_file = certs_dir.join("test-key.pem");

    let mut cmd = Command::new(&mkcert);
    cmd.arg("-cert-file").arg(&cert_file);
    cmd.arg("-key-file").arg(&key_file);
    cmd.arg("*.test");   // covers foo.test (one level)
    cmd.arg("localhost");

    // For each workspace domain add both apex and wildcard:
    //   uq.test        → covers the root domain itself
    //   *.uq.test      → covers api.uq.test, app.uq.test, etc.
    let mut seen = std::collections::HashSet::new();
    for domain in workspace_domains {
        if seen.insert(domain.clone()) {
            cmd.arg(domain);
            cmd.arg(format!("*.{}", domain));
        }
    }

    let out = cmd.output()?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(anyhow::anyhow!("mkcert generate failed: {}", stderr.trim()));
    }
    Ok(())
}
