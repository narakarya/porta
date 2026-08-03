//! Registry credentials, borrowed from whatever `docker login` already set up.
//!
//! Porta deliberately stores no registry credentials of its own. If the user
//! can `docker pull` an image, Porta can check it for updates; if they can't,
//! Porta says so. That keeps one secret store instead of two, and means there
//! is no new place for a token to leak from.
//!
//! Resolution follows the Docker CLI's own order: a per-registry helper from
//! `credHelpers`, then the global `credsStore`, then an inline base64 blob in
//! `auths`. On macOS the usual answer is the second one —
//! `docker-credential-osxkeychain` — and an `auths` entry there carries no
//! `auth` field at all, so an implementation that only read inline blobs would
//! silently do nothing on a normally-configured Mac.

use serde::Deserialize;
use std::io::Write;

/// A username/secret pair for one registry. The secret is a PAT or password;
/// it is fetched at the moment it is needed and never cached.
#[derive(Debug, Clone)]
pub struct RegistryCredential {
    pub username: String,
    pub secret: String,
}

#[derive(Debug, Default, Deserialize)]
struct DockerConfig {
    #[serde(default)]
    auths: std::collections::HashMap<String, AuthEntry>,
    #[serde(default, rename = "credsStore")]
    creds_store: Option<String>,
    #[serde(default, rename = "credHelpers")]
    cred_helpers: std::collections::HashMap<String, String>,
}

#[derive(Debug, Default, Deserialize)]
struct AuthEntry {
    /// base64("user:secret"). Absent when a credential helper owns it, which is
    /// the normal case on macOS.
    #[serde(default)]
    auth: Option<String>,
}

fn config_path() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".docker/config.json"))
}

fn read_config() -> Option<DockerConfig> {
    let raw = std::fs::read_to_string(config_path()?).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Every key a registry might be filed under in `config.json`.
///
/// Docker Hub is the awkward one: the API host is `registry-1.docker.io` but
/// `docker login` files it as `https://index.docker.io/v1/`, so looking up the
/// API host alone finds nothing.
pub(crate) fn config_keys_for(registry: &str) -> Vec<String> {
    let mut keys = vec![registry.to_string(), format!("https://{registry}")];
    if registry == "registry-1.docker.io" || registry == "index.docker.io" {
        keys.push("https://index.docker.io/v1/".to_string());
        keys.push("index.docker.io".to_string());
    }
    keys
}

/// Decode an inline `auth` blob into a username/secret pair.
pub(crate) fn decode_basic(blob: &str) -> Option<RegistryCredential> {
    use base64::Engine as _;
    let raw = base64::engine::general_purpose::STANDARD.decode(blob).ok()?;
    let text = String::from_utf8(raw).ok()?;
    // Split on the FIRST colon: a password may contain colons, a username
    // cannot.
    let (user, secret) = text.split_once(':')?;
    if user.is_empty() || secret.is_empty() {
        return None;
    }
    Some(RegistryCredential {
        username: user.to_string(),
        secret: secret.to_string(),
    })
}

/// Ask a credential helper for one registry.
///
/// The helper prints `{"ServerURL","Username","Secret"}` on success and
/// `credentials not found in native keychain` on a miss — **with exit status
/// 0**, verified against `docker-credential-osxkeychain`. So the exit code says
/// nothing; only a parse that yields a non-empty secret counts as a hit.
fn ask_helper(helper: &str, registry: &str) -> Option<RegistryCredential> {
    #[derive(Deserialize)]
    struct HelperReply {
        #[serde(rename = "Username")]
        username: Option<String>,
        #[serde(rename = "Secret")]
        secret: Option<String>,
    }

    let mut child = std::process::Command::new(format!("docker-credential-{helper}"))
        .arg("get")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    child.stdin.as_mut()?.write_all(registry.as_bytes()).ok()?;
    let out = child.wait_with_output().ok()?;

    let reply: HelperReply = serde_json::from_slice(&out.stdout).ok()?;
    let (username, secret) = (reply.username?, reply.secret?);
    if username.is_empty() || secret.is_empty() {
        return None;
    }
    // Some helpers return the literal token username for OAuth-style logins.
    // Pass it through untouched; the registry decides what it means.
    Some(RegistryCredential { username, secret })
}

/// Credentials for `registry`, or `None` when the user isn't logged in to it.
pub fn credential_for(registry: &str) -> Option<RegistryCredential> {
    let config = read_config()?;
    let keys = config_keys_for(registry);

    // 1. A helper named specifically for this registry wins.
    for key in &keys {
        if let Some(helper) = config.cred_helpers.get(key) {
            if let Some(c) = ask_helper(helper, key) {
                return Some(c);
            }
        }
    }

    // 2. The global store. Ask it under each alias — osxkeychain files Docker
    //    Hub under the index.docker.io URL, not the API host.
    if let Some(store) = &config.creds_store {
        for key in &keys {
            if let Some(c) = ask_helper(store, key) {
                return Some(c);
            }
        }
    }

    // 3. An inline blob, for setups with no helper at all.
    for key in &keys {
        if let Some(blob) = config.auths.get(key).and_then(|a| a.auth.as_deref()) {
            if let Some(c) = decode_basic(blob) {
                return Some(c);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Talks to the real credential store on this machine. Ignored by default;
    /// run after touching resolution:
    ///   cargo test --lib live_credential -- --ignored --nocapture
    #[test]
    #[ignore = "reads the local docker credential store"]
    fn live_credential_lookup() {
        for registry in ["ghcr.io", "registry-1.docker.io", "nope.invalid"] {
            match credential_for(registry) {
                // Never print the secret — only that one was found and how long.
                Some(c) => println!(
                    "{registry}: found, user={}, secret len={}",
                    c.username,
                    c.secret.len()
                ),
                None => println!("{registry}: no credential"),
            }
        }
    }

    #[test]
    fn docker_hub_is_looked_up_under_its_login_alias_too() {
        // `docker login` files Docker Hub as https://index.docker.io/v1/, not
        // as the API host, so searching the API host alone finds nothing.
        let keys = config_keys_for("registry-1.docker.io");
        assert!(keys.contains(&"https://index.docker.io/v1/".to_string()));
        assert!(keys.contains(&"registry-1.docker.io".to_string()));
    }

    #[test]
    fn other_registries_get_plain_and_https_forms() {
        let keys = config_keys_for("ghcr.io");
        assert_eq!(keys, vec!["ghcr.io".to_string(), "https://ghcr.io".to_string()]);
        // No Docker Hub aliases leaking onto an unrelated registry.
        assert!(!keys.iter().any(|k| k.contains("index.docker.io")));
    }

    #[test]
    fn inline_auth_decodes_to_user_and_secret() {
        use base64::Engine as _;
        let blob = base64::engine::general_purpose::STANDARD.encode("alice:s3cret");
        let c = decode_basic(&blob).expect("decodes");
        assert_eq!(c.username, "alice");
        assert_eq!(c.secret, "s3cret");
    }

    #[test]
    fn a_secret_containing_colons_survives() {
        // Split on the FIRST colon only — a PAT can contain them, a username
        // cannot.
        use base64::Engine as _;
        let blob = base64::engine::general_purpose::STANDARD.encode("alice:a:b:c");
        assert_eq!(decode_basic(&blob).unwrap().secret, "a:b:c");
    }

    #[test]
    fn malformed_blobs_are_refused_rather_than_half_read() {
        use base64::Engine as _;
        assert!(decode_basic("not base64!!").is_none());
        let no_colon = base64::engine::general_purpose::STANDARD.encode("alice");
        assert!(decode_basic(&no_colon).is_none());
        let empty_secret = base64::engine::general_purpose::STANDARD.encode("alice:");
        assert!(decode_basic(&empty_secret).is_none());
    }
}
