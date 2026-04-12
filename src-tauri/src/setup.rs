use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::process::Command;

#[derive(Debug, Serialize, Deserialize)]
pub struct SetupStatus {
    pub caddy_installed: bool,
    pub dnsmasq_installed: bool,
    pub test_resolver_exists: bool,
    pub caddy_running: bool,
}

pub fn check() -> SetupStatus {
    SetupStatus {
        caddy_installed: is_installed("caddy"),
        dnsmasq_installed: is_installed("dnsmasq"),
        test_resolver_exists: crate::dns::resolver_exists("test"),
        caddy_running: crate::caddy::CaddyManager::new().is_running(),
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

pub fn brew_install(package: &str) -> Result<()> {
    let brew = brew_path();
    // Run brew as the current user — brew refuses to run as root,
    // so we must NOT use osascript "with administrator privileges".
    // brew install to /opt/homebrew does not need root on Apple Silicon.
    let out = Command::new(brew)
        .arg("install")
        .arg(package)
        .output()?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let stdout = String::from_utf8_lossy(&out.stdout);
        return Err(anyhow::anyhow!(
            "brew install {} failed:\n{}{}",
            package,
            stderr.trim(),
            stdout.trim()
        ));
    }
    Ok(())
}

pub fn start_caddy() -> Result<()> {
    let brew = brew_path();
    // Use `restart` so it works whether Caddy is already registered or not.
    // launchctl exit 5 (Bootstrap failed: already loaded) is treated as success.
    let out = Command::new(brew)
        .args(["services", "restart", "caddy"])
        .output()?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let msg = stderr.trim().to_string();
        // exit 5 = service already bootstrapped — that's fine, Caddy is up
        if msg.contains("Bootstrap failed: 5") || msg.contains("already") {
            return Ok(());
        }
        return Err(anyhow::anyhow!("Failed to start Caddy: {}", msg));
    }
    Ok(())
}

pub fn run_full_setup() -> Result<()> {
    let status = check();
    if !status.caddy_installed {
        brew_install("caddy")?;
    }
    if !status.dnsmasq_installed {
        brew_install("dnsmasq")?;
    }
    if !status.test_resolver_exists {
        crate::dns::write_resolver("test")?;
    }
    if !status.caddy_running {
        start_caddy()?;
    }
    Ok(())
}
