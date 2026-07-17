//! Channel-aware update check + install.
//!
//! The Tauri updater plugin's JS `check()` reads the endpoints baked into
//! `tauri.conf.json` and offers no way to switch them at runtime — so it can
//! only ever hit the *stable* channel. These commands drive the Rust updater
//! builder directly with an endpoint chosen from the requested channel, giving
//! a real stable/beta switch that the frontend can flip via the Settings
//! toggle (`betaUpdates` in the UI store).
//!
//! Stable is the existing GitHub "latest" convention; beta points at a fixed
//! `beta` git tag whose release must publish its own `latest.json` (see the
//! report / CI notes accompanying this change).

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

/// Stable channel — MUST stay in sync with `tauri.conf.json`'s
/// `plugins.updater.endpoints` so a stable check here is byte-identical to the
/// plugin's built-in check.
const STABLE_ENDPOINT: &str =
    "https://github.com/narakarya/porta/releases/latest/download/latest.json";

/// Beta channel — a fixed `beta` git tag. CI must publish the prerelease
/// bundle + a `latest.json` (with signatures) to this tag for opt-in users.
const BETA_ENDPOINT: &str =
    "https://github.com/narakarya/porta/releases/download/beta/latest.json";

fn endpoint_for(beta: bool) -> &'static str {
    if beta {
        BETA_ENDPOINT
    } else {
        STABLE_ENDPOINT
    }
}

/// Minimal update metadata handed back to the frontend. Mirrors the shape of
/// the JS updater plugin's `Update` (camelCase) so `updater.ts` can populate
/// the same `UpdaterInfo` for the toast/Settings UI.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMeta {
    pub version: String,
    pub current_version: String,
    pub body: Option<String>,
}

async fn build_check(
    app: &AppHandle,
    beta: bool,
) -> Result<Option<tauri_plugin_updater::Update>, String> {
    // `endpoints` wants `Vec<url::Url>`; `url` isn't a direct dependency, so we
    // never name the type — the element type is inferred from the arg position
    // and `str::parse` resolves to `url::Url::from_str`.
    let updater = app
        .updater_builder()
        .endpoints(vec![endpoint_for(beta)
            .parse()
            .map_err(|e| format!("invalid updater endpoint: {e}"))?])
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;
    updater.check().await.map_err(|e| e.to_string())
}

/// Check the given channel's endpoint for an update. Returns `None` when the
/// running version is already current. This is the *real* endpoint switch —
/// stable vs. beta — that the JS plugin can't do on its own.
#[tauri::command]
pub async fn check_update_channel(
    app: AppHandle,
    beta: bool,
) -> Result<Option<UpdateMeta>, String> {
    let update = build_check(&app, beta).await?;
    Ok(update.map(|u| UpdateMeta {
        version: u.version.clone(),
        current_version: u.current_version.clone(),
        body: u.body.clone(),
    }))
}

/// Download + install the update from the given channel's endpoint, emitting
/// progress so the frontend can render a real progress bar:
///   - `updater://started`  `{ contentLength: number | null }`  (once)
///   - `updater://progress` `{ chunkLength: number }`           (per chunk)
///   - `updater://finished` `()`                                (download done)
///
/// The binary is swapped on disk on success; the caller relaunches via the
/// existing `@tauri-apps/plugin-process` `relaunch()` path.
#[tauri::command]
pub async fn install_update_channel(app: AppHandle, beta: bool) -> Result<(), String> {
    let update = build_check(&app, beta)
        .await?
        .ok_or_else(|| "no update available on this channel".to_string())?;

    let started = std::sync::atomic::AtomicBool::new(false);
    let app_chunk = app.clone();
    let app_done = app.clone();

    update
        .download_and_install(
            move |chunk_length, content_length| {
                if !started.swap(true, std::sync::atomic::Ordering::Relaxed) {
                    let _ = app_chunk.emit(
                        "updater://started",
                        serde_json::json!({ "contentLength": content_length }),
                    );
                }
                let _ = app_chunk.emit(
                    "updater://progress",
                    serde_json::json!({ "chunkLength": chunk_length }),
                );
            },
            move || {
                let _ = app_done.emit("updater://finished", ());
            },
        )
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}
