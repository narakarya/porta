// Cloudflare Access integration: lets a user put a login wall in front of any
// hostname routed through their Cloudflare account. We expose a *preset-driven*
// surface (allowed emails + allowed email-domains, one-time PIN identity) — for
// anything more complex (Google OAuth, IP rules, country blocks, service tokens)
// we link out to the Cloudflare dashboard rather than rebuilding it here.
//
// Token scope required: `Account.Access: Apps and Policies:Edit` plus an
// `Account:Read` scope so we can resolve the account_id. Reused across all the
// commands below — same `cf_api_token` setting as DNS.

use serde::{Deserialize, Serialize};

const CF_API: &str = "https://api.cloudflare.com/client/v4";

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AccessAppInfo {
    pub uid: String,
    pub name: String,
    pub domain: String,
    pub session_duration: String,
    /// Flattened from the first allow-policy. The UI only edits these two
    /// dimensions; multi-policy / country / IP rules round-trip untouched on
    /// re-save (we only mutate the policy we created).
    pub allowed_emails: Vec<String>,
    pub allowed_domains: Vec<String>,
}

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

/// Wire shape returned by /access/apps endpoints. We only deserialize the
/// fields we actually use; everything else round-trips opaquely.
#[derive(Debug, Deserialize)]
struct AccessAppRaw {
    id: String,
    name: String,
    domain: String,
    session_duration: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PolicyRaw {
    #[allow(dead_code)]
    id: String,
    decision: String,
    #[serde(default)]
    include: Vec<serde_json::Value>,
}

fn extract_emails_and_domains(includes: &[serde_json::Value]) -> (Vec<String>, Vec<String>) {
    let mut emails = Vec::new();
    let mut domains = Vec::new();
    for item in includes {
        if let Some(e) = item.get("email").and_then(|v| v.get("email")).and_then(|v| v.as_str()) {
            emails.push(e.to_string());
        } else if let Some(d) = item.get("email_domain").and_then(|v| v.get("domain")).and_then(|v| v.as_str()) {
            domains.push(d.to_string());
        }
    }
    (emails, domains)
}

async fn find_app_by_domain(
    client: &reqwest::Client,
    token: &str,
    account_id: &str,
    hostname: &str,
) -> Result<Option<AccessAppRaw>, String> {
    #[derive(Deserialize)]
    struct Resp { success: bool, result: Vec<AccessAppRaw> }
    let url = format!("{CF_API}/accounts/{account_id}/access/apps?per_page=200");
    let resp = client.get(url).bearer_auth(token).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("CF API /access/apps failed: {}", resp.status()));
    }
    let body: Resp = resp.json().await.map_err(|e| e.to_string())?;
    if !body.success {
        return Err("CF API /access/apps returned success=false".into());
    }
    Ok(body.result.into_iter().find(|a| a.domain.eq_ignore_ascii_case(hostname)))
}

async fn fetch_first_allow_policy(
    client: &reqwest::Client,
    token: &str,
    account_id: &str,
    app_uid: &str,
) -> Result<Option<PolicyRaw>, String> {
    #[derive(Deserialize)]
    struct Resp { success: bool, result: Vec<PolicyRaw> }
    let url = format!("{CF_API}/accounts/{account_id}/access/apps/{app_uid}/policies");
    let resp = client.get(url).bearer_auth(token).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("CF API /policies failed: {}", resp.status()));
    }
    let body: Resp = resp.json().await.map_err(|e| e.to_string())?;
    if !body.success {
        return Err("CF API /policies returned success=false".into());
    }
    Ok(body.result.into_iter().find(|p| p.decision == "allow"))
}

#[tauri::command]
pub async fn cf_access_get_app(
    api_token: String,
    hostname: String,
) -> Result<Option<AccessAppInfo>, String> {
    let token = api_token.trim();
    if token.is_empty() {
        return Err("Cloudflare API token required".into());
    }
    let client = reqwest::Client::new();
    let account_id = cf_account_id(&client, token).await?;
    let Some(app) = find_app_by_domain(&client, token, &account_id, &hostname).await? else {
        return Ok(None);
    };
    let policy = fetch_first_allow_policy(&client, token, &account_id, &app.id).await?;
    let (emails, domains) = match policy {
        Some(p) => extract_emails_and_domains(&p.include),
        None => (Vec::new(), Vec::new()),
    };
    Ok(Some(AccessAppInfo {
        uid: app.id,
        name: app.name,
        domain: app.domain,
        session_duration: app.session_duration.unwrap_or_else(|| "24h".to_string()),
        allowed_emails: emails,
        allowed_domains: domains,
    }))
}

fn build_includes(emails: &[String], domains: &[String]) -> Vec<serde_json::Value> {
    let mut includes = Vec::new();
    for e in emails.iter().filter(|s| !s.trim().is_empty()) {
        includes.push(serde_json::json!({ "email": { "email": e.trim() } }));
    }
    for d in domains.iter().filter(|s| !s.trim().is_empty()) {
        // Strip a leading "@" so "@narakarya.com" and "narakarya.com" both work.
        let trimmed = d.trim().trim_start_matches('@');
        includes.push(serde_json::json!({ "email_domain": { "domain": trimmed } }));
    }
    includes
}

/// Create-or-update the Access app + first allow-policy for `hostname`. Idempotent:
/// calling repeatedly with new email/domain lists rewrites the existing policy.
#[tauri::command]
pub async fn cf_access_protect(
    api_token: String,
    hostname: String,
    allowed_emails: Vec<String>,
    allowed_domains: Vec<String>,
    session_duration: Option<String>,
) -> Result<AccessAppInfo, String> {
    let token = api_token.trim();
    if token.is_empty() {
        return Err("Cloudflare API token required".into());
    }
    let includes = build_includes(&allowed_emails, &allowed_domains);
    if includes.is_empty() {
        return Err("Add at least one allowed email or domain.".into());
    }
    let session = session_duration.unwrap_or_else(|| "24h".to_string());

    let client = reqwest::Client::new();
    let account_id = cf_account_id(&client, token).await?;
    let existing = find_app_by_domain(&client, token, &account_id, &hostname).await?;

    let app_uid = match existing {
        Some(a) => {
            // Patch the existing app's session_duration in case the user changed it.
            let url = format!("{CF_API}/accounts/{account_id}/access/apps/{}", a.id);
            let body = serde_json::json!({
                "session_duration": session,
                "name": a.name,
                "domain": a.domain,
                "type": "self_hosted",
            });
            let resp = client.put(url).bearer_auth(token).json(&body).send().await.map_err(|e| e.to_string())?;
            if !resp.status().is_success() {
                return Err(format!("CF API update app failed: {}", resp.status()));
            }
            a.id
        }
        None => {
            let url = format!("{CF_API}/accounts/{account_id}/access/apps");
            let body = serde_json::json!({
                "name": format!("Porta: {hostname}"),
                "domain": hostname,
                "type": "self_hosted",
                "session_duration": session,
            });
            let resp = client.post(url).bearer_auth(token).json(&body).send().await.map_err(|e| e.to_string())?;
            let status = resp.status();
            if !status.is_success() {
                let txt = resp.text().await.unwrap_or_default();
                return Err(format!("CF API create app failed ({status}): {txt}"));
            }
            #[derive(Deserialize)] struct Resp { result: AccessAppRaw }
            let body: Resp = resp.json().await.map_err(|e| e.to_string())?;
            body.result.id
        }
    };

    // Replace the first allow-policy. Delete-then-create rather than update to
    // avoid leaking obsolete include rules (e.g. an email the user removed).
    let existing_policy = fetch_first_allow_policy(&client, token, &account_id, &app_uid).await?;
    if let Some(p) = existing_policy {
        let url = format!("{CF_API}/accounts/{account_id}/access/apps/{app_uid}/policies/{}", p.id);
        let _ = client.delete(url).bearer_auth(token).send().await;
    }

    let url = format!("{CF_API}/accounts/{account_id}/access/apps/{app_uid}/policies");
    let body = serde_json::json!({
        "name": "Porta-managed allow list",
        "decision": "allow",
        "include": includes,
        "precedence": 1,
    });
    let resp = client.post(url).bearer_auth(token).json(&body).send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        let txt = resp.text().await.unwrap_or_default();
        return Err(format!("CF API create policy failed ({status}): {txt}"));
    }

    Ok(AccessAppInfo {
        uid: app_uid,
        name: format!("Porta: {hostname}"),
        domain: hostname,
        session_duration: session,
        allowed_emails,
        allowed_domains,
    })
}

/// List every Access app in the user's account, each annotated with its
/// first allow-policy (emails + domains). Powers the Access audit tab so the
/// user can see "what hostnames are protected, by whom" at a glance without
/// having to open each app's Tunneling tab one by one.
#[tauri::command]
pub async fn cf_access_list_apps(api_token: String) -> Result<Vec<AccessAppInfo>, String> {
    let token = api_token.trim();
    if token.is_empty() {
        return Err("Cloudflare API token required".into());
    }
    let client = reqwest::Client::new();
    let account_id = cf_account_id(&client, token).await?;

    #[derive(Deserialize)]
    struct Resp { success: bool, result: Vec<AccessAppRaw> }
    let url = format!("{CF_API}/accounts/{account_id}/access/apps?per_page=200");
    let resp = client.get(url).bearer_auth(token).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("CF API /access/apps failed: {}", resp.status()));
    }
    let body: Resp = resp.json().await.map_err(|e| e.to_string())?;
    if !body.success {
        return Err("CF API /access/apps returned success=false".into());
    }

    // Fetch each app's first allow policy in parallel — sequential was slow
    // when an account has many protected hostnames.
    let app_id = account_id.clone();
    let app_token = token.to_string();
    let futs = body.result.into_iter().map(move |app| {
        let client = client.clone();
        let token = app_token.clone();
        let account_id = app_id.clone();
        async move {
            let policy = fetch_first_allow_policy(&client, &token, &account_id, &app.id)
                .await
                .ok()
                .flatten();
            let (emails, domains) = match policy {
                Some(p) => extract_emails_and_domains(&p.include),
                None => (Vec::new(), Vec::new()),
            };
            AccessAppInfo {
                uid: app.id,
                name: app.name,
                domain: app.domain,
                session_duration: app.session_duration.unwrap_or_else(|| "24h".to_string()),
                allowed_emails: emails,
                allowed_domains: domains,
            }
        }
    });
    Ok(futures_util::future::join_all(futs).await)
}

#[tauri::command]
pub async fn cf_access_unprotect(api_token: String, hostname: String) -> Result<(), String> {
    let token = api_token.trim();
    if token.is_empty() {
        return Err("Cloudflare API token required".into());
    }
    let client = reqwest::Client::new();
    let account_id = cf_account_id(&client, token).await?;
    let Some(app) = find_app_by_domain(&client, token, &account_id, &hostname).await? else {
        return Ok(());
    };
    let url = format!("{CF_API}/accounts/{account_id}/access/apps/{}", app.id);
    let resp = client.delete(url).bearer_auth(token).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("CF API delete app failed: {}", resp.status()));
    }
    Ok(())
}
