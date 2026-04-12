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

fn is_installed(bin: &str) -> bool {
    Command::new("which")
        .arg(bin)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

pub fn brew_install(package: &str) -> Result<()> {
    let script = format!(
        "do shell script \"brew install {}\" with administrator privileges",
        package
    );
    let status = Command::new("osascript").arg("-e").arg(&script).status()?;
    if !status.success() {
        return Err(anyhow::anyhow!("brew install {} failed", package));
    }
    Ok(())
}

pub fn start_caddy() -> Result<()> {
    Command::new("brew")
        .args(["services", "start", "caddy"])
        .status()?;
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
