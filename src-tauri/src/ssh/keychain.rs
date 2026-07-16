use std::collections::HashMap;
use std::sync::Mutex;

pub trait SecretStore: Send + Sync {
    fn set(&self, host_id: &str, secret: &str) -> Result<(), String>;
    fn get(&self, host_id: &str) -> Result<Option<String>, String>;
    fn delete(&self, host_id: &str) -> Result<(), String>;
}

pub struct MemoryStore(Mutex<HashMap<String, String>>);
impl MemoryStore {
    pub fn new() -> Self {
        Self(Mutex::new(HashMap::new()))
    }
}

impl SecretStore for MemoryStore {
    fn set(&self, host_id: &str, secret: &str) -> Result<(), String> {
        self.0
            .lock()
            .unwrap()
            .insert(host_id.to_string(), secret.to_string());
        Ok(())
    }
    fn get(&self, host_id: &str) -> Result<Option<String>, String> {
        Ok(self.0.lock().unwrap().get(host_id).cloned())
    }
    fn delete(&self, host_id: &str) -> Result<(), String> {
        self.0.lock().unwrap().remove(host_id);
        Ok(())
    }
}

const SERVICE: &str = "dev.narakarya.porta.ssh";

/// Wraps the macOS Keychain via the `keyring` crate. Consumed by the SSH
/// engine in a later task to optionally remember passwords/passphrases.
pub struct KeychainStore;

impl SecretStore for KeychainStore {
    fn set(&self, host_id: &str, secret: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(SERVICE, host_id).map_err(|e| e.to_string())?;
        entry.set_password(secret).map_err(|e| e.to_string())
    }
    fn get(&self, host_id: &str) -> Result<Option<String>, String> {
        let entry = keyring::Entry::new(SERVICE, host_id).map_err(|e| e.to_string())?;
        match entry.get_password() {
            Ok(p) => Ok(Some(p)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }
    fn delete(&self, host_id: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(SERVICE, host_id).map_err(|e| e.to_string())?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_store_round_trip() {
        let s = MemoryStore::new();
        assert_eq!(s.get("h1").unwrap(), None);
        s.set("h1", "hunter2").unwrap();
        assert_eq!(s.get("h1").unwrap(), Some("hunter2".to_string()));
        s.delete("h1").unwrap();
        assert_eq!(s.get("h1").unwrap(), None);
    }
}
