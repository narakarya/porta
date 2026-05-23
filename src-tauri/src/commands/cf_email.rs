// Cloudflare Email Routing: forward `whatever@yourdomain.com` to your real
// inbox. Two-level structure on Cloudflare's side:
//
//   • Account-level: destination addresses (your real Gmail/etc) — must
//     verify each via a confirmation email before they can receive forwards.
//   • Zone-level: routing rules + the zone-wide "enabled?" toggle. Each
//     rule matches an email pattern and forwards to one or more verified
//     destinations. The catch-all rule is a special always-last rule.
//
// Token scopes required: `Account.Email Routing Addresses:Edit + Zone.Email
// Routing Rules:Edit`. Account ID is fetched the same way as Access (first
// /accounts result).

use serde::{Deserialize, Serialize};

const CF_API: &str = "https://api.cloudflare.com/client/v4";

async fn cf_account_id(client: &reqwest::Client, token: &str) -> Result<String, String> {
    #[derive(Deserialize)]
    struct Account { id: String }
    #[derive(Deserialize)]
    struct Resp { success: bool, result: Vec<Account> }
    let url = format!("{CF_API}/accounts?per_page=1");
    let resp = super::cf_dns::cf_get_with_retry(client, &url, token).await?;
    let body: Resp = resp.json().await.map_err(|e| e.to_string())?;
    if !body.success || body.result.is_empty() {
        return Err("No Cloudflare account found for this token".into());
    }
    Ok(body.result[0].id.clone())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct EmailRoutingStatus {
    pub enabled: bool,
    /// "ready" / "needs DNS" / "missing MX" / "" — surfaced from CF's status string.
    pub status: String,
    /// MX records the zone must have for routing to work. CF auto-provisions
    /// these when enable_with_dns is called, but we expose the list so the UI
    /// can confirm they exist.
    pub mx_count: usize,
}

#[derive(Deserialize)]
struct RoutingSettingsRaw {
    enabled: Option<bool>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    name: Option<String>,
}

#[derive(Deserialize)]
struct RoutingSettingsEnvelope {
    success: bool,
    result: Option<RoutingSettingsRaw>,
    #[serde(default)]
    errors: Vec<serde_json::Value>,
}

#[tauri::command]
pub async fn cf_email_routing_status(
    api_token: String,
    zone_id: String,
) -> Result<EmailRoutingStatus, String> {
    let token = api_token.trim();
    if token.is_empty() {
        return Err("Cloudflare API token required".into());
    }
    let client = reqwest::Client::new();
    let url = format!("{CF_API}/zones/{zone_id}/email/routing");
    let resp = client.get(url).bearer_auth(token).send().await.map_err(|e| e.to_string())?;
    let status_code = resp.status();
    // 404 = routing never enabled on this zone — treat as "disabled" rather
    // than an error so the UI can show an enable button.
    if status_code == reqwest::StatusCode::NOT_FOUND {
        return Ok(EmailRoutingStatus { enabled: false, status: "not_configured".into(), mx_count: 0 });
    }
    if !status_code.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("CF API routing status failed ({status_code}): {body}"));
    }
    let body: RoutingSettingsEnvelope = resp.json().await.map_err(|e| e.to_string())?;
    if !body.success {
        return Err(format!("CF API routing status error: {:?}", body.errors));
    }
    let result = body.result.ok_or_else(|| "no routing settings".to_string())?;
    Ok(EmailRoutingStatus {
        enabled: result.enabled.unwrap_or(false),
        status: result.status.unwrap_or_default(),
        mx_count: if result.name.is_some() { 3 } else { 0 },
    })
}

/// Enable email routing on a zone — provisions MX/SPF/TXT records automatically.
#[tauri::command]
pub async fn cf_email_routing_enable(
    api_token: String,
    zone_id: String,
) -> Result<(), String> {
    let token = api_token.trim();
    if token.is_empty() {
        return Err("Cloudflare API token required".into());
    }
    let client = reqwest::Client::new();
    let url = format!("{CF_API}/zones/{zone_id}/email/routing/dns");
    let resp = client.post(url).bearer_auth(token).send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        let txt = resp.text().await.unwrap_or_default();
        return Err(format!("CF API enable routing failed ({status}): {txt}"));
    }
    // Then flip the routing service on.
    let url2 = format!("{CF_API}/zones/{zone_id}/email/routing/enable");
    let resp2 = client.post(url2).bearer_auth(token).send().await.map_err(|e| e.to_string())?;
    let s2 = resp2.status();
    if !s2.is_success() {
        let txt = resp2.text().await.unwrap_or_default();
        return Err(format!("CF API toggle routing failed ({s2}): {txt}"));
    }
    Ok(())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct EmailDestination {
    pub tag: String,
    pub email: String,
    pub verified: bool,
}

#[derive(Deserialize)]
struct DestinationRaw {
    tag: String,
    email: String,
    #[serde(default)]
    verified: Option<String>,
}

#[derive(Deserialize)]
struct DestinationsEnvelope {
    success: bool,
    result: Vec<DestinationRaw>,
    #[serde(default)]
    errors: Vec<serde_json::Value>,
}

#[tauri::command]
pub async fn cf_email_list_addresses(api_token: String) -> Result<Vec<EmailDestination>, String> {
    let token = api_token.trim();
    if token.is_empty() {
        return Err("Cloudflare API token required".into());
    }
    let client = reqwest::Client::new();
    let account_id = cf_account_id(&client, token).await?;
    let url = format!("{CF_API}/accounts/{account_id}/email/routing/addresses?per_page=100");
    let resp = client.get(url).bearer_auth(token).send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("CF API list destinations failed ({status}): {body}"));
    }
    let body: DestinationsEnvelope = resp.json().await.map_err(|e| e.to_string())?;
    if !body.success {
        return Err(format!("CF API list destinations error: {:?}", body.errors));
    }
    Ok(body.result.into_iter().map(|d| EmailDestination {
        tag: d.tag,
        email: d.email,
        verified: d.verified.is_some(),
    }).collect())
}

#[tauri::command]
pub async fn cf_email_create_address(
    api_token: String,
    email: String,
) -> Result<EmailDestination, String> {
    let token = api_token.trim();
    if token.is_empty() {
        return Err("Cloudflare API token required".into());
    }
    let trimmed = email.trim().to_string();
    if trimmed.is_empty() {
        return Err("email required".into());
    }
    let client = reqwest::Client::new();
    let account_id = cf_account_id(&client, token).await?;
    let url = format!("{CF_API}/accounts/{account_id}/email/routing/addresses");
    let resp = client
        .post(url)
        .bearer_auth(token)
        .json(&serde_json::json!({ "email": trimmed }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        let txt = resp.text().await.unwrap_or_default();
        return Err(format!("CF API create destination failed ({status}): {txt}"));
    }
    #[derive(Deserialize)] struct Resp { result: DestinationRaw }
    let body: Resp = resp.json().await.map_err(|e| e.to_string())?;
    Ok(EmailDestination {
        tag: body.result.tag,
        email: body.result.email,
        verified: body.result.verified.is_some(),
    })
}

#[tauri::command]
pub async fn cf_email_delete_address(api_token: String, tag: String) -> Result<(), String> {
    let token = api_token.trim();
    if token.is_empty() {
        return Err("Cloudflare API token required".into());
    }
    let client = reqwest::Client::new();
    let account_id = cf_account_id(&client, token).await?;
    let url = format!("{CF_API}/accounts/{account_id}/email/routing/addresses/{tag}");
    let resp = client.delete(url).bearer_auth(token).send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("CF API delete destination failed: {status}"));
    }
    Ok(())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct EmailRule {
    pub tag: String,
    pub name: String,
    /// Email pattern this rule matches (e.g. "hello@example.com" or "*@example.com").
    pub matcher_value: String,
    pub forward_to: Vec<String>,
    pub enabled: bool,
    pub priority: i64,
    /// True for the special catch-all rule. Catch-all has no matcher and
    /// always runs last.
    pub catch_all: bool,
}

#[derive(Deserialize)]
struct RuleRaw {
    tag: String,
    name: Option<String>,
    enabled: Option<bool>,
    #[serde(default)]
    priority: i64,
    #[serde(default)]
    matchers: Vec<RuleMatcher>,
    #[serde(default)]
    actions: Vec<RuleAction>,
}

#[derive(Deserialize)]
struct RuleMatcher {
    #[serde(rename = "type")]
    matcher_type: String,
    #[serde(default)]
    value: Option<String>,
}

#[derive(Deserialize)]
struct RuleAction {
    #[serde(rename = "type")]
    action_type: String,
    #[serde(default)]
    value: Vec<String>,
}

fn rule_from_raw(raw: RuleRaw) -> EmailRule {
    let catch_all = raw.matchers.iter().any(|m| m.matcher_type == "all");
    let matcher_value = raw.matchers.iter()
        .find_map(|m| m.value.clone())
        .unwrap_or_default();
    let forward_to = raw.actions.into_iter()
        .filter(|a| a.action_type == "forward")
        .flat_map(|a| a.value)
        .collect();
    EmailRule {
        tag: raw.tag,
        name: raw.name.unwrap_or_default(),
        matcher_value,
        forward_to,
        enabled: raw.enabled.unwrap_or(true),
        priority: raw.priority,
        catch_all,
    }
}

#[derive(Deserialize)]
struct RulesEnvelope {
    success: bool,
    result: Vec<RuleRaw>,
    #[serde(default)]
    errors: Vec<serde_json::Value>,
}

#[tauri::command]
pub async fn cf_email_list_rules(
    api_token: String,
    zone_id: String,
) -> Result<Vec<EmailRule>, String> {
    let token = api_token.trim();
    if token.is_empty() {
        return Err("Cloudflare API token required".into());
    }
    let client = reqwest::Client::new();
    let url = format!("{CF_API}/zones/{zone_id}/email/routing/rules?per_page=200");
    let resp = client.get(url).bearer_auth(token).send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("CF API list rules failed ({status}): {body}"));
    }
    let body: RulesEnvelope = resp.json().await.map_err(|e| e.to_string())?;
    if !body.success {
        return Err(format!("CF API list rules error: {:?}", body.errors));
    }
    let mut rules: Vec<EmailRule> = body.result.into_iter().map(rule_from_raw).collect();
    // Catch-all comes from a separate endpoint — fetch and append.
    let url2 = format!("{CF_API}/zones/{zone_id}/email/routing/rules/catch_all");
    if let Ok(resp2) = client.get(url2).bearer_auth(token).send().await {
        if resp2.status().is_success() {
            #[derive(Deserialize)] struct OneEnvelope { success: bool, result: Option<RuleRaw> }
            if let Ok(body2) = resp2.json::<OneEnvelope>().await {
                if body2.success {
                    if let Some(r) = body2.result {
                        let mut rule = rule_from_raw(r);
                        rule.catch_all = true;
                        rules.push(rule);
                    }
                }
            }
        }
    }
    Ok(rules)
}

#[tauri::command]
pub async fn cf_email_create_rule(
    api_token: String,
    zone_id: String,
    name: String,
    matcher_value: String,
    forward_to: Vec<String>,
) -> Result<EmailRule, String> {
    let token = api_token.trim();
    if token.is_empty() {
        return Err("Cloudflare API token required".into());
    }
    let m = matcher_value.trim().to_string();
    let fwd: Vec<String> = forward_to.into_iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    if m.is_empty() || fwd.is_empty() {
        return Err("matcher and at least one destination required".into());
    }
    let client = reqwest::Client::new();
    let url = format!("{CF_API}/zones/{zone_id}/email/routing/rules");
    let body = serde_json::json!({
        "name": name,
        "enabled": true,
        "matchers": [
            { "type": "literal", "field": "to", "value": m }
        ],
        "actions": fwd.iter().map(|f| serde_json::json!({ "type": "forward", "value": [f] })).collect::<Vec<_>>()
    });
    let resp = client.post(url).bearer_auth(token).json(&body).send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        let txt = resp.text().await.unwrap_or_default();
        return Err(format!("CF API create rule failed ({status}): {txt}"));
    }
    #[derive(Deserialize)] struct Resp { result: RuleRaw }
    let body: Resp = resp.json().await.map_err(|e| e.to_string())?;
    Ok(rule_from_raw(body.result))
}

#[tauri::command]
pub async fn cf_email_delete_rule(
    api_token: String,
    zone_id: String,
    tag: String,
) -> Result<(), String> {
    let token = api_token.trim();
    if token.is_empty() {
        return Err("Cloudflare API token required".into());
    }
    let client = reqwest::Client::new();
    let url = format!("{CF_API}/zones/{zone_id}/email/routing/rules/{tag}");
    let resp = client.delete(url).bearer_auth(token).send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        let txt = resp.text().await.unwrap_or_default();
        return Err(format!("CF API delete rule failed ({status}): {txt}"));
    }
    Ok(())
}

/// Set or update the catch-all rule. Pass empty `forward_to` to disable.
#[tauri::command]
pub async fn cf_email_set_catchall(
    api_token: String,
    zone_id: String,
    forward_to: Vec<String>,
) -> Result<(), String> {
    let token = api_token.trim();
    if token.is_empty() {
        return Err("Cloudflare API token required".into());
    }
    let client = reqwest::Client::new();
    let url = format!("{CF_API}/zones/{zone_id}/email/routing/rules/catch_all");
    let fwd: Vec<String> = forward_to.into_iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    let body = if fwd.is_empty() {
        serde_json::json!({
            "name": "Catch-all",
            "enabled": false,
            "matchers": [{ "type": "all" }],
            "actions": [{ "type": "drop" }]
        })
    } else {
        serde_json::json!({
            "name": "Catch-all",
            "enabled": true,
            "matchers": [{ "type": "all" }],
            "actions": fwd.iter().map(|f| serde_json::json!({ "type": "forward", "value": [f] })).collect::<Vec<_>>()
        })
    };
    let resp = client.put(url).bearer_auth(token).json(&body).send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        let txt = resp.text().await.unwrap_or_default();
        return Err(format!("CF API set catch-all failed ({status}): {txt}"));
    }
    Ok(())
}
