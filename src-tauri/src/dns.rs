use anyhow::Result;
use std::process::Command;

const RESOLVER_DIR: &str = "/etc/resolver";

pub fn write_resolver(tld: &str) -> Result<()> {
    let path = format!("{}/{}", RESOLVER_DIR, tld);
    let script = format!(
        "do shell script \"echo 'nameserver 127.0.0.1' | tee {}\" with administrator privileges", path
    );
    let status = Command::new("osascript").arg("-e").arg(&script).status()?;
    if !status.success() {
        return Err(anyhow::anyhow!("Failed to write resolver for .{}", tld));
    }
    Ok(())
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
