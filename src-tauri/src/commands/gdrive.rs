use crate::db::Database;

use super::settings::{read_porta_config, write_porta_config};

fn gdrive_token_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager as _;
    app.path().app_data_dir().ok().map(|d| d.join("gdrive_token.json"))
}

/// Persist the user's Google OAuth client_id + client_secret to porta config.
#[tauri::command]
pub fn set_gdrive_credentials(client_id: String, client_secret: String) {
    let mut cfg = read_porta_config();
    cfg["gdrive_client_id"] = serde_json::json!(client_id);
    cfg["gdrive_client_secret"] = serde_json::json!(client_secret);
    write_porta_config(&cfg);
}

/// Return the currently configured gdrive client_id (empty string if not set).
#[tauri::command]
pub fn get_gdrive_credentials() -> serde_json::Value {
    let cfg = read_porta_config();
    serde_json::json!({
        "client_id": cfg["gdrive_client_id"].as_str().unwrap_or(""),
        "client_secret": cfg["gdrive_client_secret"].as_str().unwrap_or(""),
    })
}

#[tauri::command]
pub async fn gdrive_connect(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    // Priority: build-time env vars → runtime config (~/.porta/config.json)
    // Developers embed credentials via GDRIVE_CLIENT_ID/GDRIVE_CLIENT_SECRET
    // at build time so end users never see any credential setup.
    let build_client_id     = option_env!("GDRIVE_CLIENT_ID").unwrap_or("");
    let build_client_secret = option_env!("GDRIVE_CLIENT_SECRET").unwrap_or("");

    let cfg = read_porta_config();
    let client_id = if !build_client_id.is_empty() {
        build_client_id.to_string()
    } else {
        cfg["gdrive_client_id"].as_str().unwrap_or("").to_string()
    };
    let client_secret = if !build_client_secret.is_empty() {
        build_client_secret.to_string()
    } else {
        cfg["gdrive_client_secret"].as_str().unwrap_or("").to_string()
    };

    if client_id.is_empty() {
        return Err("not_configured".to_string());
    }

    // Bind a local port for the OAuth redirect
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect_uri = format!("http://127.0.0.1:{}/callback", port);

    // Build consent URL
    let auth_url = reqwest::Url::parse_with_params(
        "https://accounts.google.com/o/oauth2/v2/auth",
        &[
            ("client_id",     client_id.as_str()),
            ("redirect_uri",  redirect_uri.as_str()),
            ("response_type", "code"),
            ("scope",         "https://www.googleapis.com/auth/drive.file email"),
            ("access_type",   "offline"),
            ("prompt",        "consent"),
        ],
    )
    .map_err(|e| e.to_string())?
    .to_string();

    // Open browser (macOS)
    std::process::Command::new("open")
        .arg(&auth_url)
        .spawn()
        .map_err(|e| format!("Cannot open browser: {e}"))?;

    // Wait up to 5 minutes for the redirect
    let code = tokio::time::timeout(
        std::time::Duration::from_secs(300),
        accept_oauth_code(listener),
    )
    .await
    .map_err(|_| "Google auth timed out (5 min). Please try again.")?
    .map_err(|e| e.to_string())?;

    // Exchange code for tokens
    let client = reqwest::Client::new();
    let token_resp: serde_json::Value = client
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("code",          code.as_str()),
            ("client_id",     client_id.as_str()),
            ("client_secret", client_secret.as_str()),
            ("redirect_uri",  redirect_uri.as_str()),
            ("grant_type",    "authorization_code"),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    if let Some(err) = token_resp["error"].as_str() {
        return Err(format!("Token exchange failed: {err}"));
    }

    let access_token = token_resp["access_token"].as_str().unwrap_or("").to_string();

    // Fetch user email
    let user_info: serde_json::Value = client
        .get("https://www.googleapis.com/oauth2/v3/userinfo")
        .bearer_auth(&access_token)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    let email = user_info["email"].as_str().unwrap_or("").to_string();

    // Persist token
    let stored = serde_json::json!({
        "access_token":  access_token,
        "refresh_token": token_resp["refresh_token"],
        "email":         email,
    });
    if let Some(path) = gdrive_token_path(&app) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        std::fs::write(&path, serde_json::to_string(&stored).unwrap_or_default()).ok();
    }

    Ok(serde_json::json!({ "email": email }))
}

/// Accept one HTTP request from the local OAuth redirect and extract the `code` query param.
async fn accept_oauth_code(
    listener: tokio::net::TcpListener,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let (mut stream, _) = listener.accept().await?;
    let mut buf = vec![0u8; 4096];
    let n = stream.read(&mut buf).await?;
    let request = String::from_utf8_lossy(&buf[..n]);

    // GET /callback?code=XXX HTTP/1.1
    let raw_code = request
        .lines()
        .find(|l| l.starts_with("GET "))
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|path| path.split_once('?').map(|(_, q)| q))
        .and_then(|query| {
            query.split('&').find_map(|kv| {
                kv.strip_prefix("code=").map(|v| v.to_string())
            })
        })
        .ok_or("No 'code' in OAuth redirect")?;

    // URL-decode the authorization code (Google percent-encodes special chars)
    let code = urlencoding::decode(&raw_code)
        .unwrap_or(std::borrow::Cow::Borrowed(&raw_code))
        .into_owned();

    let html = b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n\
        <html><body style='font-family:sans-serif;padding:2rem'>\
        <h2 style='color:#22c55e'>Connected!</h2>\
        <p>Google Drive is now linked to Porta. You can close this tab.</p>\
        </body></html>";
    stream.write_all(html).await.ok();

    Ok(code)
}

#[tauri::command]
pub fn gdrive_status(app: tauri::AppHandle) -> serde_json::Value {
    if let Some(path) = gdrive_token_path(&app) {
        if let Ok(raw) = std::fs::read_to_string(&path) {
            if let Ok(token) = serde_json::from_str::<serde_json::Value>(&raw) {
                let email = token["email"].as_str().unwrap_or("").to_string();
                if !email.is_empty() {
                    return serde_json::json!({ "connected": true, "email": email });
                }
            }
        }
    }
    serde_json::json!({ "connected": false, "email": null })
}

#[tauri::command]
pub fn gdrive_disconnect(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(path) = gdrive_token_path(&app) {
        if path.exists() {
            std::fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

// ── Google Drive sync ─────────────────────────────────────────────────────────

async fn get_gdrive_access_token(app: &tauri::AppHandle) -> Result<String, String> {
    let token_path = gdrive_token_path(app).ok_or("no token path")?;
    let raw = std::fs::read_to_string(&token_path)
        .map_err(|_| "Not connected to Google Drive".to_string())?;
    let token: serde_json::Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;

    let refresh_token = token["refresh_token"].as_str().unwrap_or("").to_string();
    if refresh_token.is_empty() {
        return Err("No refresh token — please reconnect Google Drive".to_string());
    }

    let build_client_id = option_env!("GDRIVE_CLIENT_ID").unwrap_or("");
    let build_client_secret = option_env!("GDRIVE_CLIENT_SECRET").unwrap_or("");
    let cfg = read_porta_config();
    let client_id = if !build_client_id.is_empty() {
        build_client_id.to_string()
    } else {
        cfg["gdrive_client_id"].as_str().unwrap_or("").to_string()
    };
    let client_secret = if !build_client_secret.is_empty() {
        build_client_secret.to_string()
    } else {
        cfg["gdrive_client_secret"].as_str().unwrap_or("").to_string()
    };

    if client_id.is_empty() {
        return Err("not_configured".to_string());
    }

    let client = reqwest::Client::new();
    let resp: serde_json::Value = client
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
            ("refresh_token", refresh_token.as_str()),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    if let Some(err) = resp["error"].as_str() {
        return Err(format!("Token refresh failed: {err} — please reconnect Google Drive"));
    }

    resp["access_token"]
        .as_str()
        .ok_or_else(|| "No access_token in response".to_string())
        .map(|s| s.to_string())
}

#[tauri::command]
pub async fn gdrive_sync(app: tauri::AppHandle) -> Result<String, String> {
    let access_token = get_gdrive_access_token(&app).await?;

    // Export current DB state
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    let db_path = std::path::PathBuf::from(home).join(".porta").join("porta.db");
    let db = Database::open(db_path).map_err(|e| e.to_string())?;
    let workspaces = db.list_workspaces().map_err(|e| e.to_string())?;
    let apps = db.list_apps().map_err(|e| e.to_string())?;
    let json = crate::backup::export(&workspaces, &apps).map_err(|e| e.to_string())?;

    let client = reqwest::Client::new();

    // Check if porta-config.json already exists in Drive
    let search: serde_json::Value = client
        .get("https://www.googleapis.com/drive/v3/files")
        .query(&[
            ("q", "name='porta-config.json' and trashed=false"),
            ("fields", "files(id)"),
        ])
        .bearer_auth(&access_token)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    let existing_id = search["files"]
        .as_array()
        .and_then(|f| f.first())
        .and_then(|f| f["id"].as_str())
        .map(|s| s.to_string());

    if let Some(file_id) = existing_id {
        // Overwrite existing file
        let resp = client
            .patch(format!(
                "https://www.googleapis.com/upload/drive/v3/files/{}?uploadType=media",
                file_id
            ))
            .bearer_auth(&access_token)
            .header("Content-Type", "application/json")
            .body(json)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("Drive upload failed ({}): {}", status, body));
        }
    } else {
        // Create new file (multipart: JSON metadata + body)
        let boundary = "porta_multipart_boundary";
        let body = format!(
            "--{b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n\
             {{\"name\":\"porta-config.json\",\"mimeType\":\"application/json\"}}\r\n\
             --{b}\r\nContent-Type: application/json\r\n\r\n{json}\r\n--{b}--",
            b = boundary,
            json = json
        );
        let resp = client
            .post("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart")
            .bearer_auth(&access_token)
            .header(
                "Content-Type",
                format!("multipart/related; boundary={}", boundary),
            )
            .body(body)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("Drive upload failed ({}): {}", status, body));
        }
    }

    Ok(chrono::Utc::now().to_rfc3339())
}
