use anyhow::Result;
use std::process::Command;

const RESOLVER_DIR: &str = "/etc/resolver";

pub fn write_resolver(tld: &str) -> Result<()> {
    let script = format!(
        "do shell script \"{}\" with administrator privileges",
        resolver_write_command(tld)
    );
    let status = Command::new("osascript").arg("-e").arg(&script).status()?;
    if !status.success() {
        return Err(anyhow::anyhow!("Failed to write resolver for .{}", tld));
    }
    Ok(())
}

/// The bare shell command that writes the resolver file, without the osascript
/// wrapper. Uses only single quotes so it composes safely inside an AppleScript
/// double-quoted `do shell script`, letting setup batch it together with other
/// privileged commands under a single password prompt.
pub fn resolver_write_command(tld: &str) -> String {
    format!(
        "mkdir -p {dir} && echo 'nameserver 127.0.0.1' | tee {dir}/{tld} >/dev/null",
        dir = RESOLVER_DIR,
        tld = tld,
    )
}

pub fn resolver_exists(tld: &str) -> bool {
    std::path::Path::new(&format!("{}/{}", RESOLVER_DIR, tld)).exists()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resolver_exists_false_for_unknown() {
        assert!(!resolver_exists("__porta_test_tld_xyz__"));
    }
}
