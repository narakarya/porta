//! Keychain-backed storage for Porta's own credentials.
//!
//! The Cloudflare API token used to live as plaintext under `cf_api_token` in
//! `~/.porta/config.json`. That token is broadly scoped — DNS edit, Tunnel,
//! Access apps, Email routing — so any process running as the user could read
//! it out of a world-readable dotfile. It now lives in the macOS Keychain,
//! alongside the SSH secrets (`crate::ssh::keychain`).
//!
//! Two constraints shape the design:
//!
//! * **Existing installs must keep working.** The first read after upgrading
//!   finds the plaintext token, copies it into the keychain, and deletes the
//!   plaintext copy — no user action, no re-paste.
//! * **A keychain failure must not brick Cloudflare.** If the keychain is
//!   unavailable (locked, denied, or a non-macOS dev build) we fall back to
//!   the config file rather than dropping the token on the floor, and report
//!   the fallback through [`TokenStorage`] so the UI can say so out loud
//!   instead of silently implying the token is protected.

use crate::commands::settings::{read_porta_config, write_porta_config};

const CF_SERVICE: &str = "dev.narakarya.porta.cloudflare";
const CF_ACCOUNT: &str = "api_token";
const LEGACY_CF_KEY: &str = "cf_api_token";

/// Where the Cloudflare token is actually stored right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenStorage {
    Keychain,
    /// Plaintext in `config.json` — the keychain was not usable.
    Config,
    /// No token saved.
    None,
}

impl TokenStorage {
    pub fn as_str(self) -> &'static str {
        match self {
            TokenStorage::Keychain => "keychain",
            TokenStorage::Config => "config",
            TokenStorage::None => "none",
        }
    }
}

/// What to do given what each backend currently holds. Split out from the I/O
/// so the migration ordering — the part that is easy to get subtly wrong — is
/// unit-testable without a keychain or a config file.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Resolution {
    pub token: String,
    pub storage: TokenStorage,
    /// Copy `token` into the keychain: a plaintext token was found.
    pub migrate: bool,
    /// Delete the plaintext copy from `config.json`.
    pub clear_legacy: bool,
}

pub(crate) fn resolve(keychain: Option<&str>, legacy: Option<&str>) -> Resolution {
    let keychain = keychain.map(str::trim).filter(|s| !s.is_empty());
    let legacy = legacy.map(str::trim).filter(|s| !s.is_empty());

    match (keychain, legacy) {
        // The keychain is authoritative. A plaintext copy alongside it is a
        // leftover from a half-finished migration — stale, and worth deleting
        // even when the two values agree.
        (Some(k), l) => Resolution {
            token: k.to_string(),
            storage: TokenStorage::Keychain,
            migrate: false,
            clear_legacy: l.is_some(),
        },
        (None, Some(l)) => Resolution {
            token: l.to_string(),
            storage: TokenStorage::Config,
            migrate: true,
            clear_legacy: true,
        },
        (None, None) => Resolution {
            token: String::new(),
            storage: TokenStorage::None,
            migrate: false,
            clear_legacy: false,
        },
    }
}

// ── Keychain I/O ─────────────────────────────────────────────────────────────

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(CF_SERVICE, CF_ACCOUNT).map_err(|e| e.to_string())
}

fn keychain_read() -> Option<String> {
    match entry().and_then(|e| match e.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }) {
        Ok(v) => v,
        Err(_) => None,
    }
}

fn keychain_write(token: &str) -> Result<(), String> {
    entry()?.set_password(token).map_err(|e| e.to_string())
}

fn keychain_delete() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// ── config.json fallback ─────────────────────────────────────────────────────

fn legacy_read() -> Option<String> {
    read_porta_config()[LEGACY_CF_KEY]
        .as_str()
        .map(str::to_string)
}

fn legacy_write(token: &str) {
    let mut cfg = read_porta_config();
    cfg[LEGACY_CF_KEY] = serde_json::json!(token);
    write_porta_config(&cfg);
}

fn legacy_clear() {
    let mut cfg = read_porta_config();
    if let Some(map) = cfg.as_object_mut() {
        if map.remove(LEGACY_CF_KEY).is_none() {
            return;
        }
    }
    write_porta_config(&cfg);
}

// ── Public API ───────────────────────────────────────────────────────────────

/// Read the token, migrating a legacy plaintext value into the keychain on the
/// way out. Returns `""` when nothing is saved — callers treat empty as unset.
pub fn cf_token_get() -> String {
    let r = resolve(keychain_read().as_deref(), legacy_read().as_deref());

    if r.migrate && !r.token.is_empty() {
        // Only drop the plaintext copy once the keychain has definitely taken
        // it. If the write fails we keep the fallback and try again next read.
        if keychain_write(&r.token).is_ok() && r.clear_legacy {
            legacy_clear();
        }
    } else if r.clear_legacy {
        legacy_clear();
    }

    r.token
}

/// Save (or, given an empty string, clear) the token. Returns where it landed.
pub fn cf_token_set(token: &str) -> TokenStorage {
    let token = token.trim();

    if token.is_empty() {
        let _ = keychain_delete();
        legacy_clear();
        return TokenStorage::None;
    }

    match keychain_write(token) {
        Ok(()) => {
            legacy_clear();
            TokenStorage::Keychain
        }
        Err(_) => {
            // Keychain unavailable — keep Cloudflare working, but the caller
            // now knows the token is sitting in plaintext.
            legacy_write(token);
            TokenStorage::Config
        }
    }
}

/// Where the saved token currently lives, without migrating anything.
pub fn cf_token_storage() -> TokenStorage {
    resolve(keychain_read().as_deref(), legacy_read().as_deref()).storage
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_saved_anywhere() {
        let r = resolve(None, None);
        assert_eq!(r.token, "");
        assert_eq!(r.storage, TokenStorage::None);
        assert!(!r.migrate && !r.clear_legacy);
    }

    #[test]
    fn keychain_only_is_the_steady_state() {
        let r = resolve(Some("tok-abc"), None);
        assert_eq!(r.token, "tok-abc");
        assert_eq!(r.storage, TokenStorage::Keychain);
        assert!(!r.migrate, "already in the keychain — nothing to migrate");
        assert!(!r.clear_legacy, "no plaintext copy to delete");
    }

    #[test]
    fn legacy_only_migrates_and_clears() {
        let r = resolve(None, Some("tok-legacy"));
        assert_eq!(r.token, "tok-legacy");
        assert_eq!(r.storage, TokenStorage::Config);
        assert!(r.migrate);
        assert!(r.clear_legacy);
    }

    #[test]
    fn keychain_wins_and_stale_plaintext_is_dropped() {
        // Half-finished migration: keychain took it, config.json never got
        // cleaned. The keychain value is the live one.
        let r = resolve(Some("tok-new"), Some("tok-old"));
        assert_eq!(r.token, "tok-new");
        assert_eq!(r.storage, TokenStorage::Keychain);
        assert!(!r.migrate);
        assert!(r.clear_legacy, "the stale plaintext copy must go");
    }

    #[test]
    fn identical_plaintext_copy_is_still_dropped() {
        let r = resolve(Some("same"), Some("same"));
        assert_eq!(r.storage, TokenStorage::Keychain);
        assert!(r.clear_legacy);
    }

    #[test]
    fn blank_values_count_as_unset() {
        // An empty string is how the UI clears the token; whitespace is what a
        // fat-fingered paste leaves behind. Neither is a token.
        assert_eq!(resolve(Some(""), None).storage, TokenStorage::None);
        assert_eq!(resolve(Some("   "), Some("\n")).storage, TokenStorage::None);
        assert_eq!(resolve(Some(""), Some("tok")).storage, TokenStorage::Config);
        assert_eq!(resolve(Some(""), Some("tok")).token, "tok");
    }

    #[test]
    fn surrounding_whitespace_is_trimmed_off_the_token() {
        assert_eq!(resolve(Some("  tok-abc\n"), None).token, "tok-abc");
        assert_eq!(resolve(None, Some(" tok-legacy ")).token, "tok-legacy");
    }

    #[test]
    fn storage_labels_match_the_frontend_union() {
        assert_eq!(TokenStorage::Keychain.as_str(), "keychain");
        assert_eq!(TokenStorage::Config.as_str(), "config");
        assert_eq!(TokenStorage::None.as_str(), "none");
    }
}
