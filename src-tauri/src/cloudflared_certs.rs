use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// Resolved Cloudflare origin certs (`cert.pem`) keyed by zone, so Porta can
/// route DNS for hostnames whose zone differs from the user's currently-active
/// `~/.cloudflared/cert.pem`. Without this, every `cloudflared tunnel route
/// dns` call would fail (or silently land on the wrong zone) when the active
/// cert isn't authorized for the hostname's zone — forcing the user to swap
/// `cert.pem` files by hand each time they start an app on a different domain.
///
/// Layout:
///   `~/.cloudflared/cert.pem`              — the user's current login (fallback)
///   `~/.cloudflared/porta-certs/<zone>.pem` — Porta-managed per-zone certs
///
/// `<zone>` is the registrable domain (eTLD+1 per the Public Suffix List), so
/// `porta.narakarya.com` and `app.narakarya.com` both resolve to `narakarya.com.pem`.
const CERT_DIR_NAME: &str = "porta-certs";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZoneCert {
    pub zone: String,
    pub path: String,
}

fn cloudflared_dir() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    Some(PathBuf::from(home).join(".cloudflared"))
}

pub fn default_cert_path() -> Option<PathBuf> {
    cloudflared_dir().map(|d| d.join("cert.pem"))
}

pub fn zone_certs_dir() -> Option<PathBuf> {
    cloudflared_dir().map(|d| d.join(CERT_DIR_NAME))
}

/// Registrable domain (eTLD+1) for a hostname — the key under which we store
/// per-zone certs. Returns None for inputs PSL can't classify (bare hostnames,
/// IP literals, empty strings).
pub fn zone_for_hostname(hostname: &str) -> Option<String> {
    let h = hostname.trim();
    if h.is_empty() {
        return None;
    }
    psl::domain_str(h).map(|s| s.to_string())
}

fn cert_path_for_zone(zone: &str) -> Option<PathBuf> {
    let z = zone.trim().to_ascii_lowercase();
    if z.is_empty() {
        return None;
    }
    zone_certs_dir().map(|d| d.join(format!("{}.pem", z)))
}

/// Best cert to use when running cloudflared management commands for the given
/// hostname. Order: zone-specific cert in `porta-certs/` → fallback to default
/// `cert.pem`. None if no cert exists at all.
pub fn cert_for_hostname(hostname: &str) -> Option<PathBuf> {
    if let Some(zone) = zone_for_hostname(hostname) {
        if let Some(p) = cert_path_for_zone(&zone) {
            if p.exists() {
                return Some(p);
            }
        }
    }
    default_cert_path().filter(|p| p.exists())
}

/// Every cert worth trying for `hostname`, most likely first: the zone's own
/// cert, the active login, then sidecar logins the user kept around
/// (`cert.pem.<label>` — a common way to juggle several Cloudflare accounts by
/// hand) and finally certs stored for other zones (one account often owns
/// several zones, so a neighbour's cert frequently works).
///
/// Used to auto-discover which login is authorized for a zone instead of
/// making the user import it in Settings — see `route_dns_verified`.
pub fn cert_candidates(hostname: &str) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let mut push = |p: PathBuf| {
        if p.exists() && !out.contains(&p) {
            out.push(p);
        }
    };

    let zone = zone_for_hostname(hostname);
    if let Some(p) = zone.as_deref().and_then(cert_path_for_zone) {
        push(p);
    }
    if let Some(p) = default_cert_path() {
        push(p);
    }
    // `~/.cloudflared/cert.pem.<label>` — sorted so the order is stable run to
    // run (an unstable order would make failures reproduce differently).
    if let Some(dir) = cloudflared_dir() {
        if let Ok(rd) = fs::read_dir(&dir) {
            let mut siblings: Vec<PathBuf> = rd
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| {
                    p.file_name()
                        .and_then(|n| n.to_str())
                        .map(|n| n.starts_with("cert.pem.") && n != "cert.pem.old")
                        .unwrap_or(false)
                })
                .collect();
            siblings.sort();
            for p in siblings {
                push(p);
            }
        }
    }
    for c in list_zone_certs() {
        push(PathBuf::from(c.path));
    }
    out
}

pub fn list_zone_certs() -> Vec<ZoneCert> {
    let Some(dir) = zone_certs_dir() else { return Vec::new() };
    let Ok(rd) = fs::read_dir(&dir) else { return Vec::new() };
    let mut out: Vec<ZoneCert> = rd
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let zone = name.strip_suffix(".pem")?.to_string();
            if zone.is_empty() { return None; }
            Some(ZoneCert {
                zone,
                path: e.path().to_string_lossy().to_string(),
            })
        })
        .collect();
    out.sort_by(|a, b| a.zone.cmp(&b.zone));
    out
}

/// Import a cert.pem file as the cert for `zone`. Copies (not moves) so the
/// source — typically `~/.cloudflared/cert.pem` after a fresh login — stays
/// where cloudflared expects it for its own default lookups.
pub fn import_cert(zone: &str, source: &std::path::Path) -> Result<PathBuf, String> {
    let z = zone.trim().to_ascii_lowercase();
    if z.is_empty() {
        return Err("zone is required".into());
    }
    if !source.exists() {
        return Err(format!("source cert not found: {}", source.display()));
    }
    let dir = zone_certs_dir().ok_or_else(|| "HOME not set".to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dest = dir.join(format!("{}.pem", z));
    fs::copy(source, &dest).map_err(|e| e.to_string())?;
    Ok(dest)
}

pub fn delete_zone_cert(zone: &str) -> Result<(), String> {
    let path = cert_path_for_zone(zone).ok_or_else(|| "invalid zone".to_string())?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}
