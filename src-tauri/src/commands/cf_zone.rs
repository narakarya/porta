// Cloudflare Zone-level operations: settings (Dev Mode, Always Use HTTPS,
// security level, etc.) + cache purge. Both are scoped to a zone, both are
// "things you do to a whole zone", so they share one Tauri module + one UI
// tab. Token scopes required: `Zone:Settings:Edit + Zone:Cache Purge`.

use serde::{Deserialize, Serialize};

const CF_API: &str = "https://api.cloudflare.com/client/v4";

/// One row of the zone-settings panel. We collapse Cloudflare's wide schema
/// (boolean / string / object / TTL number / nested editable_value) into a
/// single shape the frontend can render uniformly. The "kind" tells the UI
/// which control to show.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ZoneSetting {
    pub id: String,
    /// "on" / "off" / a number-as-string / freeform string.
    pub value: String,
    /// "toggle" (on/off), "select" (one of options), "number" (TTL etc.).
    pub kind: String,
    /// Available choices for "select" kind. Empty for toggle/number.
    pub options: Vec<String>,
    pub editable: bool,
}

#[derive(Deserialize)]
struct RawSetting {
    id: String,
    value: serde_json::Value,
    #[serde(default)]
    editable: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct SettingsEnvelope {
    success: bool,
    result: Vec<RawSetting>,
    #[serde(default)]
    errors: Vec<serde_json::Value>,
}

/// Settings we surface in the UI. Other settings (advanced WAF tweaks, image
/// resizing, etc.) stay in the Cloudflare dashboard so we don't replicate
/// the entire dashboard surface.
const EXPOSED_SETTINGS: &[&str] = &[
    "always_use_https",
    "automatic_https_rewrites",
    "development_mode",
    "ssl",
    "min_tls_version",
    "opportunistic_encryption",
    "tls_1_3",
    "brotli",
    "security_level",
    "browser_cache_ttl",
    "challenge_ttl",
];

fn classify_setting(id: &str) -> &'static str {
    match id {
        "ssl" | "min_tls_version" | "security_level" => "select",
        "browser_cache_ttl" | "challenge_ttl" => "number",
        _ => "toggle",
    }
}

fn options_for(id: &str) -> Vec<String> {
    match id {
        "ssl" => vec!["off", "flexible", "full", "strict"]
            .into_iter().map(String::from).collect(),
        "min_tls_version" => vec!["1.0", "1.1", "1.2", "1.3"]
            .into_iter().map(String::from).collect(),
        "security_level" => vec!["off", "essentially_off", "low", "medium", "high", "under_attack"]
            .into_iter().map(String::from).collect(),
        _ => Vec::new(),
    }
}

fn raw_value_to_string(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Bool(b) => if *b { "on".into() } else { "off".into() },
        serde_json::Value::Number(n) => n.to_string(),
        _ => v.to_string(),
    }
}

#[tauri::command]
pub async fn cf_zone_get_settings(
    api_token: String,
    zone_id: String,
) -> Result<Vec<ZoneSetting>, String> {
    let token = api_token.trim();
    if token.is_empty() {
        return Err("Cloudflare API token required".into());
    }
    let client = reqwest::Client::new();
    let url = format!("{CF_API}/zones/{zone_id}/settings");
    let resp = super::cf_dns::cf_get_with_retry(&client, &url, token).await?;
    let body: SettingsEnvelope = resp.json().await.map_err(|e| e.to_string())?;
    if !body.success {
        return Err(format!("CF API zone settings error: {:?}", body.errors));
    }
    let mut out: Vec<ZoneSetting> = body.result
        .into_iter()
        .filter(|s| EXPOSED_SETTINGS.contains(&s.id.as_str()))
        .map(|s| {
            let kind = classify_setting(&s.id).to_string();
            let options = options_for(&s.id);
            // editable is sometimes a bool, sometimes absent. Default true.
            let editable = s.editable
                .as_ref()
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            ZoneSetting {
                id: s.id.clone(),
                value: raw_value_to_string(&s.value),
                kind,
                options,
                editable,
            }
        })
        .collect();
    // Stable order matching EXPOSED_SETTINGS so the UI doesn't shuffle on refresh.
    out.sort_by_key(|s| EXPOSED_SETTINGS.iter().position(|e| *e == s.id).unwrap_or(usize::MAX));
    Ok(out)
}

#[tauri::command]
pub async fn cf_zone_set_setting(
    api_token: String,
    zone_id: String,
    setting_id: String,
    value: String,
) -> Result<ZoneSetting, String> {
    let token = api_token.trim();
    if token.is_empty() {
        return Err("Cloudflare API token required".into());
    }
    let client = reqwest::Client::new();
    let url = format!("{CF_API}/zones/{zone_id}/settings/{setting_id}");

    // Coerce the wire value back to the right JSON type. Toggles want bools
    // for some endpoints but Cloudflare accepts "on"/"off" strings too — we
    // use strings for toggles and numbers for TTL fields.
    let json_value: serde_json::Value = match classify_setting(&setting_id) {
        "number" => value.parse::<i64>().map(serde_json::Value::from).unwrap_or(serde_json::Value::String(value.clone())),
        _ => serde_json::Value::String(value.clone()),
    };
    let body = serde_json::json!({ "value": json_value });

    let resp = client.patch(url).bearer_auth(token).json(&body).send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        let txt = resp.text().await.unwrap_or_default();
        return Err(format!("CF API set setting failed ({status}): {txt}"));
    }
    Ok(ZoneSetting {
        id: setting_id.clone(),
        value,
        kind: classify_setting(&setting_id).to_string(),
        options: options_for(&setting_id),
        editable: true,
    })
}

#[tauri::command]
pub async fn cf_zone_purge_all(
    api_token: String,
    zone_id: String,
) -> Result<(), String> {
    let token = api_token.trim();
    if token.is_empty() {
        return Err("Cloudflare API token required".into());
    }
    let client = reqwest::Client::new();
    let url = format!("{CF_API}/zones/{zone_id}/purge_cache");
    let resp = client
        .post(url)
        .bearer_auth(token)
        .json(&serde_json::json!({ "purge_everything": true }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        let txt = resp.text().await.unwrap_or_default();
        return Err(format!("CF API purge_all failed ({status}): {txt}"));
    }
    Ok(())
}

#[tauri::command]
pub async fn cf_zone_purge_hosts(
    api_token: String,
    zone_id: String,
    hosts: Vec<String>,
) -> Result<(), String> {
    let token = api_token.trim();
    if token.is_empty() {
        return Err("Cloudflare API token required".into());
    }
    let cleaned: Vec<String> = hosts.into_iter().map(|h| h.trim().to_string()).filter(|s| !s.is_empty()).collect();
    if cleaned.is_empty() {
        return Err("at least one hostname required".into());
    }
    let client = reqwest::Client::new();
    let url = format!("{CF_API}/zones/{zone_id}/purge_cache");
    let resp = client
        .post(url)
        .bearer_auth(token)
        .json(&serde_json::json!({ "hosts": cleaned }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        let txt = resp.text().await.unwrap_or_default();
        return Err(format!("CF API purge_hosts failed ({status}): {txt}"));
    }
    Ok(())
}

#[tauri::command]
pub async fn cf_zone_purge_files(
    api_token: String,
    zone_id: String,
    files: Vec<String>,
) -> Result<(), String> {
    let token = api_token.trim();
    if token.is_empty() {
        return Err("Cloudflare API token required".into());
    }
    let cleaned: Vec<String> = files.into_iter().map(|f| f.trim().to_string()).filter(|s| !s.is_empty()).collect();
    if cleaned.is_empty() {
        return Err("at least one URL required".into());
    }
    let client = reqwest::Client::new();
    let url = format!("{CF_API}/zones/{zone_id}/purge_cache");
    let resp = client
        .post(url)
        .bearer_auth(token)
        .json(&serde_json::json!({ "files": cleaned }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        let txt = resp.text().await.unwrap_or_default();
        return Err(format!("CF API purge_files failed ({status}): {txt}"));
    }
    Ok(())
}
