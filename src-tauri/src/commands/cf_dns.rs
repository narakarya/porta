// Cloudflare DNS records CRUD. Same `cf_api_token` as the rest of the CF
// integration; needs `Zone:Read + DNS:Edit` scopes (DNS:Read alone is enough
// for the list endpoints but Edit is required for create/update/delete).
//
// Surface intentionally pragmatic: cover the everyday record types (A, AAAA,
// CNAME, TXT, MX, NS) with proxied toggle. Anything exotic (SRV options, page
// rules, tiered cache) stays in the Cloudflare dashboard.

use serde::{Deserialize, Serialize};

const CF_API: &str = "https://api.cloudflare.com/client/v4";

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DnsZone {
    pub id: String,
    pub name: String,
    pub status: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DnsRecord {
    pub id: String,
    // Cloudflare API sends `type` (a Rust keyword) — rename only on the way
    // IN. On the way out to the frontend we keep `record_type` so the TS
    // interface matches; otherwise the Type column would render undefined.
    #[serde(rename(deserialize = "type"))]
    pub record_type: String,
    pub name: String,
    pub content: String,
    pub ttl: i64,
    #[serde(default)]
    pub proxied: bool,
    /// Some record types (CNAME → tunnels, NS) can't be proxied. Surfacing
    /// this lets the UI disable the toggle instead of failing on save.
    #[serde(default = "default_true")]
    pub proxiable: bool,
    #[serde(default)]
    pub priority: Option<i64>,
}

fn default_true() -> bool { true }

#[derive(Deserialize)]
struct ZonesEnvelope {
    success: bool,
    result: Vec<DnsZone>,
    #[serde(default)]
    errors: Vec<serde_json::Value>,
    #[serde(default)]
    result_info: Option<ResultInfo>,
}

#[derive(Deserialize)]
struct ResultInfo {
    #[serde(default)]
    total_pages: u32,
}

#[derive(Deserialize)]
struct RecordsEnvelope {
    success: bool,
    result: Vec<DnsRecord>,
    #[serde(default)]
    errors: Vec<serde_json::Value>,
}

#[derive(Deserialize)]
struct RecordEnvelope {
    success: bool,
    result: Option<DnsRecord>,
    #[serde(default)]
    errors: Vec<serde_json::Value>,
}

fn err_with_body(prefix: &str, status: reqwest::StatusCode, body: String) -> String {
    if body.is_empty() { format!("{prefix}: {status}") } else { format!("{prefix} ({status}): {body}") }
}

/// GET with automatic retry on transient errors. Cloudflare's API regularly
/// returns 500/502/503 for healthy tokens — usually a single retry after
/// ~600ms makes it succeed. Without this, the user sees a confusing
/// "An unknown API error occurred" pop-up they can't action.
pub(crate) async fn cf_get_with_retry(
    client: &reqwest::Client,
    url: &str,
    token: &str,
) -> Result<reqwest::Response, String> {
    let mut last_status: Option<reqwest::StatusCode> = None;
    let mut last_body = String::new();
    for attempt in 0..3u32 {
        if attempt > 0 {
            // 600ms, then 1500ms — total worst-case ~2.1s before we give up.
            let delay_ms = if attempt == 1 { 600 } else { 1500 };
            tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
        }
        let resp = client.get(url).bearer_auth(token).send().await.map_err(|e| e.to_string())?;
        let status = resp.status();
        // Success — return the response untouched so callers can JSON-decode.
        if status.is_success() {
            return Ok(resp);
        }
        // 4xx is on us (bad token / wrong scope) — don't retry, surface it.
        if status.is_client_error() {
            let body = resp.text().await.unwrap_or_default();
            return Err(err_with_body("CF API failed", status, body));
        }
        // 5xx — capture and loop. Body has to be read here since reqwest
        // consumes it on .text().
        last_status = Some(status);
        last_body = resp.text().await.unwrap_or_default();
    }
    let status = last_status.unwrap_or(reqwest::StatusCode::INTERNAL_SERVER_ERROR);
    Err(format!(
        "CF API transient error after retries ({status}). This is usually Cloudflare-side — try clicking refresh in a few seconds.\n\nLast body: {last_body}"
    ))
}

#[tauri::command]
pub async fn cf_dns_list_zones(api_token: String) -> Result<Vec<DnsZone>, String> {
    let token = api_token.trim();
    if token.is_empty() {
        return Err("Cloudflare API token required".into());
    }
    let client = reqwest::Client::new();
    let mut all = Vec::new();
    // Cloudflare caps `per_page` at 50 for /zones. Paginate until total_pages
    // is exhausted so accounts with >50 zones aren't silently truncated.
    let mut page = 1u32;
    loop {
        let url = format!("{CF_API}/zones?per_page=50&page={page}");
        let resp = cf_get_with_retry(&client, &url, token).await?;
        let body: ZonesEnvelope = resp.json().await.map_err(|e| e.to_string())?;
        if !body.success {
            return Err(format!("CF API /zones error: {:?}", body.errors));
        }
        all.extend(body.result);
        let total = body.result_info.map(|i| i.total_pages).unwrap_or(1);
        if page >= total { break; }
        page += 1;
    }
    Ok(all)
}

/// List DNS records in a zone. Optional `search` does a case-insensitive
/// name match server-side (Cloudflare's `name` filter is exact, so we use
/// `name.contains` via `match=any` + `name.contains=…`).
#[tauri::command]
pub async fn cf_dns_list_records(
    api_token: String,
    zone_id: String,
    search: Option<String>,
) -> Result<Vec<DnsRecord>, String> {
    let token = api_token.trim();
    if token.is_empty() {
        return Err("Cloudflare API token required".into());
    }
    let client = reqwest::Client::new();
    let mut url = format!("{CF_API}/zones/{zone_id}/dns_records?per_page=500");
    if let Some(q) = search.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        url.push_str(&format!("&name.contains={}", urlencoding::encode(q)));
    }
    let resp = cf_get_with_retry(&client, &url, token).await?;
    let body: RecordsEnvelope = resp.json().await.map_err(|e| e.to_string())?;
    if !body.success {
        return Err(format!("CF API list records error: {:?}", body.errors));
    }
    Ok(body.result)
}

#[derive(Deserialize)]
pub struct DnsRecordInput {
    pub record_type: String,
    pub name: String,
    pub content: String,
    pub ttl: i64,
    pub proxied: bool,
    pub priority: Option<i64>,
}

fn record_payload(input: &DnsRecordInput) -> serde_json::Value {
    let mut payload = serde_json::json!({
        "type": input.record_type,
        "name": input.name,
        "content": input.content,
        "ttl": input.ttl,
        "proxied": input.proxied,
    });
    if let Some(p) = input.priority {
        payload["priority"] = serde_json::json!(p);
    }
    payload
}

#[tauri::command]
pub async fn cf_dns_create_record(
    api_token: String,
    zone_id: String,
    record: DnsRecordInput,
) -> Result<DnsRecord, String> {
    let token = api_token.trim();
    if token.is_empty() {
        return Err("Cloudflare API token required".into());
    }
    let client = reqwest::Client::new();
    let url = format!("{CF_API}/zones/{zone_id}/dns_records");
    let resp = client
        .post(url)
        .bearer_auth(token)
        .json(&record_payload(&record))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(err_with_body("CF API create record failed", status, body));
    }
    let body: RecordEnvelope = resp.json().await.map_err(|e| e.to_string())?;
    if !body.success {
        return Err(format!("CF API create record error: {:?}", body.errors));
    }
    body.result.ok_or_else(|| "CF API returned no record".into())
}

#[tauri::command]
pub async fn cf_dns_update_record(
    api_token: String,
    zone_id: String,
    record_id: String,
    record: DnsRecordInput,
) -> Result<DnsRecord, String> {
    let token = api_token.trim();
    if token.is_empty() {
        return Err("Cloudflare API token required".into());
    }
    let client = reqwest::Client::new();
    let url = format!("{CF_API}/zones/{zone_id}/dns_records/{record_id}");
    let resp = client
        .put(url)
        .bearer_auth(token)
        .json(&record_payload(&record))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(err_with_body("CF API update record failed", status, body));
    }
    let body: RecordEnvelope = resp.json().await.map_err(|e| e.to_string())?;
    if !body.success {
        return Err(format!("CF API update record error: {:?}", body.errors));
    }
    body.result.ok_or_else(|| "CF API returned no record".into())
}

// ── DNS drift diff ─────────────────────────────────────────────────────────
//
// Compare DNS records in a Cloudflare zone against the project's local
// DNS-resolvable hostnames (Caddy routes for the user's apps + workspaces +
// dnsmasq `address=/.../IP` rules). Surfaces what's only on each side and
// hostnames that exist on both sides with conflicting type/content. Pragmatic:
// only A and CNAME are compared — exotic types (MX, TXT, NS) are reported as
// CF-only entries since Porta has no notion of "local MX".

/// A "local DNS record" — synthesized from Caddy routes + dnsmasq rules. We
/// always emit these as A records pointing at 127.0.0.1, since that's what
/// Porta-managed local DNS resolves to.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LocalRecord {
    pub name: String,
    pub record_type: String,
    pub content: String,
    /// Where this came from: "caddy" | "dnsmasq".
    pub source: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RecordMismatch {
    pub name: String,
    pub cf: DnsRecord,
    pub local: LocalRecord,
    pub reason: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ZoneDiff {
    pub zone_name: String,
    pub only_in_cf: Vec<DnsRecord>,
    pub only_local: Vec<LocalRecord>,
    pub mismatched: Vec<RecordMismatch>,
}

fn dnsmasq_conf_paths() -> Vec<String> {
    vec![
        "/opt/homebrew/etc/dnsmasq.conf".into(),
        "/usr/local/etc/dnsmasq.conf".into(),
    ]
}

/// Parse `address=/foo.test/127.0.0.1` lines out of a dnsmasq config, plus
/// any extra files listed via `conf-file=` includes. Returns (host, ip) pairs.
/// Wildcards are kept as `*.<rest>` so the diff can match them as a pattern.
fn parse_dnsmasq_addresses(path: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let content = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => return out,
    };
    for raw in content.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(rest) = line.strip_prefix("address=") {
            // Expected form: /<host-or-domain>/<ip>
            let bytes = rest.as_bytes();
            if bytes.first() != Some(&b'/') { continue; }
            let after = &rest[1..];
            if let Some(slash) = after.find('/') {
                let mut host = after[..slash].to_string();
                let ip = after[slash + 1..].trim().to_string();
                if host.is_empty() || ip.is_empty() { continue; }
                // dnsmasq treats `.test` as "*.test" — surface that explicitly
                // so the diff can pattern-match.
                if let Some(stripped) = host.strip_prefix('.') {
                    host = format!("*.{}", stripped);
                }
                out.push((host, ip));
            }
        }
    }
    out
}

fn collect_dnsmasq_rules() -> Vec<(String, String)> {
    let mut all = Vec::new();
    for p in dnsmasq_conf_paths() {
        all.extend(parse_dnsmasq_addresses(&p));
    }
    all
}

fn caddy_local_hosts(state: &crate::app_state::AppState) -> Vec<String> {
    let db = match state.db.lock() {
        Ok(d) => d,
        Err(_) => return Vec::new(),
    };
    let workspaces = db.list_workspaces().unwrap_or_default();
    let apps = db.list_apps().unwrap_or_default();
    let mut hosts: Vec<String> = Vec::new();
    for app in &apps {
        for route in app.all_routes(&workspaces) {
            let h = match route {
                crate::db::models::Route::ReverseProxy { host, .. } => host,
                crate::db::models::Route::FileServer { host, .. } => host,
                crate::db::models::Route::AliasReverseProxy { host, .. } => host,
            };
            if !hosts.contains(&h) {
                hosts.push(h);
            }
        }
    }
    hosts
}

fn zone_matches(name: &str, zone: &str) -> bool {
    let n = name.trim_end_matches('.').to_lowercase();
    let z = zone.trim_end_matches('.').to_lowercase();
    n == z || n.ends_with(&format!(".{}", z))
}

fn local_record_for_host(host: &str, dnsmasq_rules: &[(String, String)]) -> LocalRecord {
    // If a dnsmasq rule matches this host (exact or wildcard), use its IP and
    // tag the source. Otherwise the default is 127.0.0.1 from Caddy.
    let lower = host.to_lowercase();
    for (pat, ip) in dnsmasq_rules {
        let pl = pat.to_lowercase();
        if pl == lower {
            return LocalRecord {
                name: host.to_string(),
                record_type: "A".into(),
                content: ip.clone(),
                source: "dnsmasq".into(),
            };
        }
        if let Some(suffix) = pl.strip_prefix("*.") {
            if lower == suffix || lower.ends_with(&format!(".{}", suffix)) {
                return LocalRecord {
                    name: host.to_string(),
                    record_type: "A".into(),
                    content: ip.clone(),
                    source: "dnsmasq".into(),
                };
            }
        }
    }
    LocalRecord {
        name: host.to_string(),
        record_type: "A".into(),
        content: "127.0.0.1".into(),
        source: "caddy".into(),
    }
}

#[tauri::command]
pub async fn cf_dns_diff_zone_vs_local(
    api_token: String,
    zone_id: String,
    app_handle: tauri::AppHandle,
) -> Result<ZoneDiff, String> {
    use tauri::Manager;
    let token = api_token.trim();
    if token.is_empty() {
        return Err("Cloudflare API token required".into());
    }

    // 1. Fetch zone metadata so we know the zone name and can scope hostnames.
    let client = reqwest::Client::new();
    let zones = cf_dns_list_zones(api_token.clone()).await?;
    let zone = zones
        .into_iter()
        .find(|z| z.id == zone_id)
        .ok_or_else(|| format!("Zone {} not found in account", zone_id))?;

    // 2. Fetch CF DNS records for the zone.
    let url = format!("{CF_API}/zones/{}/dns_records?per_page=500", zone_id);
    let resp = cf_get_with_retry(&client, &url, token).await?;
    let body: RecordsEnvelope = resp.json().await.map_err(|e| e.to_string())?;
    if !body.success {
        return Err(format!("CF API list records error: {:?}", body.errors));
    }
    let cf_records = body.result;

    // 3. Synthesize local hostnames from Caddy routes + dnsmasq rules, scoped
    //    to this zone.
    let state = app_handle.state::<crate::app_state::AppState>();
    let caddy_hosts: Vec<String> = caddy_local_hosts(&state)
        .into_iter()
        .filter(|h| zone_matches(h, &zone.name))
        .collect();
    let dnsmasq_rules = collect_dnsmasq_rules();

    // Local hostnames = Caddy hosts + any concrete dnsmasq host (skip wildcards
    // since they don't represent a single record to compare).
    let mut local_hosts: Vec<String> = caddy_hosts.clone();
    for (pat, _ip) in &dnsmasq_rules {
        if !pat.starts_with("*.") && zone_matches(pat, &zone.name) && !local_hosts.contains(pat) {
            local_hosts.push(pat.clone());
        }
    }

    // 4. Diff. Match on normalized hostname. CF records that aren't A/CNAME
    //    are always "only_in_cf" since Porta has no local equivalent for them.
    let mut only_in_cf: Vec<DnsRecord> = Vec::new();
    let mut only_local: Vec<LocalRecord> = Vec::new();
    let mut mismatched: Vec<RecordMismatch> = Vec::new();

    let local_norm: std::collections::HashSet<String> =
        local_hosts.iter().map(|h| h.to_lowercase()).collect();

    for rec in &cf_records {
        let rec_name_lc = rec.name.to_lowercase();
        // Records not under this zone (shouldn't happen but be defensive).
        if !zone_matches(&rec_name_lc, &zone.name) {
            continue;
        }
        let local_match = local_norm.contains(&rec_name_lc);
        if !local_match {
            only_in_cf.push(rec.clone());
            continue;
        }
        // Both sides exist — check for mismatch on A/CNAME. Other types stay
        // CF-only since the local side has no equivalent record kind.
        let local = local_record_for_host(&rec.name, &dnsmasq_rules);
        let upper = rec.record_type.to_uppercase();
        if upper == "A" {
            if rec.content.trim() != local.content.trim() {
                let reason = format!(
                    "A record IP differs: CF={} local={}",
                    rec.content, local.content
                );
                mismatched.push(RecordMismatch {
                    name: rec.name.clone(),
                    cf: rec.clone(),
                    local,
                    reason,
                });
            }
        } else if upper == "CNAME" {
            // Local side doesn't really emit CNAMEs — surface as a type
            // mismatch so the user sees that the public side resolves via
            // CNAME while locally it's a direct A.
            mismatched.push(RecordMismatch {
                name: rec.name.clone(),
                cf: rec.clone(),
                local,
                reason: format!("CF is CNAME → {}, locally an A record", rec.content),
            });
        } else {
            only_in_cf.push(rec.clone());
        }
    }

    // Local-only: hosts we have locally that have no CF record (any type).
    let cf_norm: std::collections::HashSet<String> =
        cf_records.iter().map(|r| r.name.to_lowercase()).collect();
    for host in &local_hosts {
        if !cf_norm.contains(&host.to_lowercase()) {
            only_local.push(local_record_for_host(host, &dnsmasq_rules));
        }
    }

    Ok(ZoneDiff {
        zone_name: zone.name,
        only_in_cf,
        only_local,
        mismatched,
    })
}

#[tauri::command]
pub async fn cf_dns_delete_record(
    api_token: String,
    zone_id: String,
    record_id: String,
) -> Result<(), String> {
    let token = api_token.trim();
    if token.is_empty() {
        return Err("Cloudflare API token required".into());
    }
    let client = reqwest::Client::new();
    let url = format!("{CF_API}/zones/{zone_id}/dns_records/{record_id}");
    let resp = client.delete(url).bearer_auth(token).send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    // Treat 404 as success — the desired end state of a delete is "record gone",
    // and CF returns 404 if the record was already deleted (e.g. via the dashboard
    // or another Porta window) since the last list refresh.
    if status == reqwest::StatusCode::NOT_FOUND {
        return Ok(());
    }
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(err_with_body("CF API delete record failed", status, body));
    }
    Ok(())
}
