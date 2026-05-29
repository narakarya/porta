//! Docker image update detection + one-click update for managed apps.
//!
//! Scope: **Docker Hub public images only** for now. Other registries (GHCR,
//! Quay, private) are detected and reported as `status: "skipped"` with a
//! reason. Update detection works two ways depending on the tag:
//!
//! - **Mutable tags** (`latest`, `stable`, `edge`, `lts`, `nightly`, `main`,
//!   `master`, `develop`, `dev`, `rolling`, `current`): compare local manifest
//!   digest with the registry's `Docker-Content-Digest` header. If different,
//!   a new image was pushed under the same tag.
//! - **Semver-pinned tags** (`1.25.3`, `v2.1`, `16-alpine`): list the repo's
//!   tags and suggest the highest matching variant (same suffix, higher
//!   version triple).
//!
//! For one-click update we just stop → pull → restart the container. Volumes
//! are part of the run config (named volumes / bind mounts), so they survive
//! container recreation automatically.
//!
//! Why anonymous bearer auth: Docker Hub gates manifest reads behind a token
//! flow even for public images. The token is free, no account required.

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};
use tauri::{Emitter, State};

use crate::app_state::AppState;
use crate::commands::volume_snapshot::{
    restore_volume_snapshot, snapshot_compose_volumes, snapshot_docker_volumes,
    VolumeSnapshotResult,
};
use crate::docker_manager::{docker_bin, resolve_compose_path, DockerManager};

const DOCKER_HUB_REGISTRY: &str = "registry-1.docker.io";
const DOCKER_HUB_AUTH: &str = "https://auth.docker.io/token";

/// Tags whose meaning is "the current release" — we detect updates by
/// comparing manifest digests, not by listing tags.
const MUTABLE_TAGS: &[&str] = &[
    "latest", "stable", "edge", "lts", "main", "master", "develop", "dev",
    "nightly", "rolling", "current", "release",
];

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ImageUpdateInfo {
    /// Original image ref as stored in the app (e.g. `nginx:1.25.3`).
    pub image: String,
    /// For compose apps, the service this image belongs to. `None` for single
    /// docker apps.
    pub service_name: Option<String>,
    /// Normalized repo, e.g. `library/nginx` for Docker Hub.
    pub repo: String,
    /// The tag in `image`. Defaults to `latest` if absent.
    pub tag: String,
    /// `"ok"` (check ran), `"skipped"` (non-Docker-Hub or unsupported), `"error"`.
    pub status: String,
    /// Human-readable detail when `status != "ok"`.
    pub message: Option<String>,
    /// Local manifest digest (sha256:...). `None` if image hasn't been pulled yet.
    pub local_digest: Option<String>,
    /// Registry's current digest for the same tag.
    pub remote_digest: Option<String>,
    /// True when local and remote digests differ — pulling will fetch new bits.
    pub has_digest_update: bool,
    /// For semver-pinned tags, a suggested newer tag (e.g. `1.26.0` when
    /// pinned to `1.25.3`). `None` for mutable tags or when nothing newer.
    pub suggested_tag: Option<String>,
}

impl ImageUpdateInfo {
    fn skipped(image: &str, service_name: Option<String>, msg: &str) -> Self {
        let parsed = parse_image_ref(image);
        Self {
            image: image.to_string(),
            service_name,
            repo: parsed.as_ref().map(|p| p.repo.clone()).unwrap_or_default(),
            tag: parsed.as_ref().map(|p| p.tag.clone()).unwrap_or_else(|| "latest".into()),
            status: "skipped".into(),
            message: Some(msg.to_string()),
            local_digest: None,
            remote_digest: None,
            has_digest_update: false,
            suggested_tag: None,
        }
    }

    fn error(image: &str, service_name: Option<String>, msg: String) -> Self {
        let parsed = parse_image_ref(image);
        Self {
            image: image.to_string(),
            service_name,
            repo: parsed.as_ref().map(|p| p.repo.clone()).unwrap_or_default(),
            tag: parsed.as_ref().map(|p| p.tag.clone()).unwrap_or_else(|| "latest".into()),
            status: "error".into(),
            message: Some(msg),
            local_digest: None,
            remote_digest: None,
            has_digest_update: false,
            suggested_tag: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ImageRef {
    pub registry: String,
    pub repo: String,
    pub tag: String,
}

/// Split an image reference into (registry, repo, tag). Handles:
/// - `nginx`              → docker hub library/nginx:latest
/// - `nginx:1.25`         → docker hub library/nginx:1.25
/// - `user/img:tag`       → docker hub user/img:tag
/// - `ghcr.io/user/img`   → ghcr.io user/img:latest
/// - `localhost:5000/img` → localhost:5000 img:latest
/// - `repo@sha256:...`    → digest-pinned; we treat the @ part as the tag
///   indicator and skip update checks (digest pin is by definition immutable).
pub(crate) fn parse_image_ref(s: &str) -> Option<ImageRef> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }

    // Digest-pinned ref — handled by callers that mark these as skipped.
    let (s, digest_pinned) = match s.split_once('@') {
        Some((head, _)) => (head, true),
        None => (s, false),
    };

    // Decide whether the first segment is a registry host: it has a `.` or `:`,
    // or it is literally `localhost`. Otherwise it's a Docker Hub user/org.
    let (registry, rest) = match s.split_once('/') {
        Some((head, tail))
            if head.contains('.') || head.contains(':') || head == "localhost" =>
        {
            (head.to_string(), tail.to_string())
        }
        _ => (DOCKER_HUB_REGISTRY.to_string(), s.to_string()),
    };

    // Tag — last colon, but only if the suffix has no slash (a colon inside the
    // image path means we already split off a registry like `localhost:5000`).
    let (image, tag) = match rest.rsplit_once(':') {
        Some((i, t)) if !t.contains('/') => (i.to_string(), t.to_string()),
        _ => (rest, "latest".to_string()),
    };

    let repo = if registry == DOCKER_HUB_REGISTRY && !image.contains('/') {
        format!("library/{}", image)
    } else {
        image
    };

    if digest_pinned {
        // Caller can detect this and skip — return a sentinel tag so it's
        // still useful for display.
        return Some(ImageRef { registry, repo, tag: format!("{}@digest", tag) });
    }
    Some(ImageRef { registry, repo, tag })
}

fn is_mutable_tag(tag: &str) -> bool {
    MUTABLE_TAGS.iter().any(|t| t.eq_ignore_ascii_case(tag))
}

/// Parse a semver-ish tag into (numeric components, suffix). Examples:
///   `1.25.3`       → ([1,25,3], "")
///   `v1.25.3`      → ([1,25,3], "")
///   `1.25.3-alpine`→ ([1,25,3], "-alpine")
///   `16-alpine`    → ([16],     "-alpine")
///   `1.25`         → ([1,25],   "")
///   `latest`       → None
fn parse_semver_tag(tag: &str) -> Option<(Vec<u64>, String)> {
    let bytes = tag.as_bytes();
    let mut i = 0;
    if i < bytes.len() && (bytes[i] == b'v' || bytes[i] == b'V') {
        i += 1;
    }
    let mut nums = Vec::new();
    let mut cur = 0u64;
    let mut has_digit = false;
    while i < bytes.len() {
        let c = bytes[i];
        if c.is_ascii_digit() {
            cur = cur.saturating_mul(10).saturating_add((c - b'0') as u64);
            has_digit = true;
            i += 1;
        } else if c == b'.' && has_digit {
            nums.push(cur);
            cur = 0;
            has_digit = false;
            i += 1;
        } else {
            break;
        }
    }
    if has_digit {
        nums.push(cur);
    }
    if nums.is_empty() {
        return None;
    }
    let suffix = if i < bytes.len() {
        tag[i..].to_string()
    } else {
        String::new()
    };
    Some((nums, suffix))
}

/// Given a current tag, find the highest tag in `all_tags` that:
/// - parses as semver,
/// - has the same suffix as the current tag (e.g. `-alpine` stays `-alpine`),
/// - has the same number of numeric components as the current,
/// - has a strictly greater version triple.
pub(crate) fn suggest_newer_tag(current: &str, all_tags: &[String]) -> Option<String> {
    let (cur_nums, cur_suffix) = parse_semver_tag(current)?;
    let mut best: Option<(Vec<u64>, String)> = None;
    for t in all_tags {
        if t == current {
            continue;
        }
        let Some((nums, suffix)) = parse_semver_tag(t) else { continue };
        if suffix != cur_suffix {
            continue;
        }
        if nums.len() != cur_nums.len() {
            continue;
        }
        if nums <= cur_nums {
            continue;
        }
        if best.as_ref().is_none_or(|(b, _)| &nums > b) {
            best = Some((nums, t.clone()));
        }
    }
    best.map(|(_, t)| t)
}

// ── Registry HTTP ──────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct TokenResponse {
    token: String,
}

async fn fetch_anonymous_token(
    client: &reqwest::Client,
    repo: &str,
) -> Result<String, String> {
    let url = format!(
        "{}?service=registry.docker.io&scope=repository:{}:pull",
        DOCKER_HUB_AUTH, repo
    );
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("auth request failed: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("auth status {}", resp.status()));
    }
    let body: TokenResponse = resp
        .json()
        .await
        .map_err(|e| format!("auth body parse: {}", e))?;
    Ok(body.token)
}

const MANIFEST_ACCEPT: &str = concat!(
    "application/vnd.oci.image.index.v1+json,",
    "application/vnd.oci.image.manifest.v1+json,",
    "application/vnd.docker.distribution.manifest.list.v2+json,",
    "application/vnd.docker.distribution.manifest.v2+json"
);

async fn fetch_remote_digest(
    client: &reqwest::Client,
    repo: &str,
    tag: &str,
    token: &str,
) -> Result<Option<String>, String> {
    let url = format!("https://{}/v2/{}/manifests/{}", DOCKER_HUB_REGISTRY, repo, tag);
    let resp = client
        .head(&url)
        .bearer_auth(token)
        .header("Accept", MANIFEST_ACCEPT)
        .send()
        .await
        .map_err(|e| format!("manifest HEAD failed: {}", e))?;
    if resp.status().as_u16() == 404 {
        return Ok(None);
    }
    if !resp.status().is_success() {
        return Err(format!("manifest status {}", resp.status()));
    }
    Ok(resp
        .headers()
        .get("docker-content-digest")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string()))
}

#[derive(Deserialize)]
struct TagsListResponse {
    tags: Option<Vec<String>>,
}

async fn fetch_tags(
    client: &reqwest::Client,
    repo: &str,
    token: &str,
) -> Result<Vec<String>, String> {
    // /tags/list pagination uses Link header; for the common case of <500 tags
    // a single hit at n=500 is enough. Larger repos can grow this later.
    let url = format!(
        "https://{}/v2/{}/tags/list?n=500",
        DOCKER_HUB_REGISTRY, repo
    );
    let resp = client
        .get(&url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("tags list failed: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("tags status {}", resp.status()));
    }
    let body: TagsListResponse = resp
        .json()
        .await
        .map_err(|e| format!("tags parse: {}", e))?;
    Ok(body.tags.unwrap_or_default())
}

// ── Local digest via docker CLI ────────────────────────────────────────────

fn local_digest(image_ref: &str) -> Option<String> {
    let out = Command::new(docker_bin())
        .args(["image", "inspect", "--format", "{{json .RepoDigests}}", image_ref])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    let digests: Vec<String> = serde_json::from_str(s.trim()).ok()?;
    // Each entry looks like `repo@sha256:...`. We just need the digest part —
    // the registry returns the same `sha256:...` regardless of which alias
    // matched locally.
    digests
        .into_iter()
        .find_map(|d| d.split_once('@').map(|(_, dg)| dg.to_string()))
}

// ── Per-image check ────────────────────────────────────────────────────────

async fn check_one(
    client: &reqwest::Client,
    image_ref: &str,
    service_name: Option<String>,
) -> ImageUpdateInfo {
    let parsed = match parse_image_ref(image_ref) {
        Some(p) => p,
        None => return ImageUpdateInfo::error(image_ref, service_name, "invalid image ref".into()),
    };
    if parsed.registry != DOCKER_HUB_REGISTRY {
        return ImageUpdateInfo::skipped(
            image_ref,
            service_name,
            "only Docker Hub is supported right now",
        );
    }
    if parsed.tag.ends_with("@digest") {
        return ImageUpdateInfo::skipped(
            image_ref,
            service_name,
            "digest-pinned image — by definition immutable",
        );
    }

    let token = match fetch_anonymous_token(client, &parsed.repo).await {
        Ok(t) => t,
        Err(e) => return ImageUpdateInfo::error(image_ref, service_name, e),
    };

    let local = local_digest(image_ref);

    let remote = match fetch_remote_digest(client, &parsed.repo, &parsed.tag, &token).await {
        Ok(r) => r,
        Err(e) => return ImageUpdateInfo::error(image_ref, service_name, e),
    };
    let has_digest_update = match (&local, &remote) {
        (Some(l), Some(r)) => l != r,
        // If the user hasn't pulled the image yet, there's no "digest update"
        // to report — Start will pull fresh anyway.
        _ => false,
    };

    // For semver-pinned tags, also surface a newer suggestion. For mutable
    // tags this is meaningless — `latest` doesn't have a "newer latest".
    let suggested_tag = if !is_mutable_tag(&parsed.tag) && parse_semver_tag(&parsed.tag).is_some() {
        match fetch_tags(client, &parsed.repo, &token).await {
            Ok(tags) => suggest_newer_tag(&parsed.tag, &tags),
            Err(_) => None,
        }
    } else {
        None
    };

    ImageUpdateInfo {
        image: image_ref.to_string(),
        service_name,
        repo: parsed.repo,
        tag: parsed.tag,
        status: "ok".into(),
        message: None,
        local_digest: local,
        remote_digest: remote,
        has_digest_update,
        suggested_tag,
    }
}

// ── Progress streaming ─────────────────────────────────────────────────────

/// Tauri event names for the in-flight update flow. The app id is appended so
/// the frontend can subscribe per-app and avoid cross-talk between cards.
const PHASE_EVENT_PREFIX: &str = "app:update-phase:";
const LOG_EVENT_PREFIX: &str = "app:update-log:";

fn emit_phase(app: &tauri::AppHandle, id: &str, phase: &str) {
    app.emit(&format!("{}{}", PHASE_EVENT_PREFIX, id), phase).ok();
}

fn emit_log(app: &tauri::AppHandle, id: &str, line: &str) {
    app.emit(&format!("{}{}", LOG_EVENT_PREFIX, id), line).ok();
}

/// Spawn a docker subprocess, stream its stdout AND stderr line-by-line as
/// Tauri events, and return the exit status. Docker writes pull progress to
/// stderr (because of `\r` redraws) and the final `Status:` line to stdout —
/// streaming both means the user sees everything.
///
/// Runs entirely on the calling thread (we're already inside spawn_blocking).
/// The reader threads it spawns are reaped before this function returns.
fn run_streaming(
    app: tauri::AppHandle,
    app_id: String,
    args: Vec<String>,
    work_dir: Option<std::path::PathBuf>,
) -> Result<ExitStatus, String> {
    let mut cmd = Command::new(docker_bin());
    cmd.args(&args).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(d) = work_dir.as_ref() {
        cmd.current_dir(d);
    }
    let mut child = cmd.spawn().map_err(|e| format!("spawn: {}", e))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let app_a = app.clone();
    let id_a = app_id.clone();
    let h_out = stdout.map(|s| {
        std::thread::spawn(move || {
            for line in BufReader::new(s).lines().map_while(Result::ok) {
                emit_log(&app_a, &id_a, &line);
            }
        })
    });
    let app_b = app;
    let id_b = app_id;
    let h_err = stderr.map(|s| {
        std::thread::spawn(move || {
            for line in BufReader::new(s).lines().map_while(Result::ok) {
                emit_log(&app_b, &id_b, &line);
            }
        })
    });

    let status = child.wait().map_err(|e| format!("wait: {}", e))?;
    if let Some(h) = h_out {
        let _ = h.join();
    }
    if let Some(h) = h_err {
        let _ = h.join();
    }
    Ok(status)
}

// ── Tauri commands ─────────────────────────────────────────────────────────

/// Check for image updates for a single app. Returns one entry per image:
/// - kind="docker" → 1 entry (the app's `docker_image`)
/// - kind="compose" → 1 entry per service that has an `image:` key
/// - other kinds → empty list
#[tauri::command]
pub async fn check_app_image_updates(
    state: State<'_, AppState>,
    id: String,
) -> Result<Vec<ImageUpdateInfo>, String> {
    let app = {
        let db = state.db.lock().unwrap();
        db.list_apps()
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|a| a.id == id)
            .ok_or_else(|| format!("app {} not found", id))?
    };

    let client = reqwest::Client::new();

    if app.is_docker() {
        let Some(image) = app.docker_image.as_deref().filter(|s| !s.trim().is_empty()) else {
            return Ok(vec![]);
        };
        return Ok(vec![check_one(&client, image, None).await]);
    }

    if app.is_compose() {
        let Some(file) = app.compose_file.as_deref().filter(|s| !s.trim().is_empty()) else {
            return Ok(vec![]);
        };
        let root = if app.root_dir.is_empty() { None } else { Some(app.root_dir.as_str()) };
        let resolved = resolve_compose_path(file, root);
        let project = crate::compose_parser::parse_compose(&resolved)
            .map_err(|e| format!("parse compose: {}", e))?;
        let mut out = Vec::new();
        for svc in project.services {
            if let Some(img) = svc.image.as_deref().filter(|s| !s.trim().is_empty()) {
                out.push(check_one(&client, img, Some(svc.name)).await);
            }
        }
        return Ok(out);
    }

    Ok(vec![])
}

/// Pre-update safety options. Defaults to "behave like before" so callers
/// that don't opt in keep the historical no-safety-net flow.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UpdateOptions {
    /// Take a `tar.gz` snapshot of the listed volumes before pulling. The
    /// snapshot is read-only against the live volume so it's safe even when
    /// the container is still up.
    #[serde(default)]
    pub snapshot_first: bool,
    /// After `up -d`, poll container state for `verify_timeout_secs` seconds.
    /// If any affected container fails to reach a healthy `running` state,
    /// revert the compose tag and force-recreate with the old image.
    #[serde(default)]
    pub auto_rollback: bool,
    /// During rollback, also restore the volume contents from the snapshot
    /// taken in this same call. Only meaningful when `snapshot_first` was
    /// also true. Useful when the new image may have written to the data dir
    /// before crashing (corrupting it for the old image).
    #[serde(default)]
    pub restore_on_rollback: bool,
    /// Volumes to snapshot. For compose apps these are the local names from
    /// the compose file (`cap_db`); for single-docker apps these are the
    /// fully-qualified docker volume names. Empty means "snapshot nothing"
    /// even when `snapshot_first` is true.
    #[serde(default)]
    pub snapshot_volumes: Vec<String>,
    /// Verification window, in seconds. Default 45s. Clamped to [10, 300].
    #[serde(default)]
    pub verify_timeout_secs: Option<u64>,
}

impl UpdateOptions {
    fn verify_timeout(&self) -> Duration {
        let s = self.verify_timeout_secs.unwrap_or(45).clamp(10, 300);
        Duration::from_secs(s)
    }
}

/// Pull updated images and recreate containers. Volumes are preserved because
/// docker run / docker compose up reuse the same named volumes / bind mounts.
///
/// Behavior:
/// - kind="docker": stop → optionally rewrite `docker_image` to a new tag →
///   `docker pull <image>` → restart via the normal lifecycle path.
/// - kind="compose": `docker compose pull` then `docker compose up -d`. If
///   `tag_replacements` is non-empty, the user is selecting newer tags for
///   pinned services — we update the compose file in-place before pulling.
///
/// `tag_replacements` is a list of `(image_ref, new_tag)` pairs. For docker
/// apps only the first entry is used. `options` controls the new safety
/// behaviors (snapshot before pull, atomic recreate with auto-rollback,
/// optional volume restore on rollback). Pass `None` for the historical
/// no-safety-net behavior.
#[tauri::command]
pub async fn update_app_images(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    id: String,
    tag_replacements: Vec<(String, String)>,
    options: Option<UpdateOptions>,
) -> Result<(), String> {
    let opts = options.unwrap_or_default();
    let app_data = {
        let db = state.db.lock().unwrap();
        db.list_apps()
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|a| a.id == id)
            .ok_or_else(|| format!("app {} not found", id))?
    };

    if app_data.is_docker() {
        return update_docker_app(state, app, app_data, tag_replacements, opts).await;
    }
    if app_data.is_compose() {
        return update_compose_app(state, app, app_data, tag_replacements, opts).await;
    }
    Err("update only supported for docker / compose apps".into())
}

async fn update_docker_app(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    app_data: crate::db::models::App,
    tag_replacements: Vec<(String, String)>,
    opts: UpdateOptions,
) -> Result<(), String> {
    let id = app_data.id.clone();
    let was_running = app_data.status == "running" || app_data.status == "starting";
    let original_image = app_data
        .docker_image
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "app has no docker_image".to_string())?
        .to_string();

    let target_image = if let Some((_, new_tag)) = tag_replacements.into_iter().next() {
        let parsed = parse_image_ref(&original_image)
            .ok_or_else(|| "invalid current image ref".to_string())?;
        rebuild_image_ref(&parsed, &new_tag)
    } else {
        original_image.clone()
    };

    // Snapshot BEFORE we stop the container — read-only mount is safe.
    let snapshot = if opts.snapshot_first && !opts.snapshot_volumes.is_empty() {
        emit_phase(&app, &id, "snapshotting");
        emit_log(&app, &id, &format!(
            "Snapshotting volume{}: {}",
            if opts.snapshot_volumes.len() == 1 { "" } else { "s" },
            opts.snapshot_volumes.join(", "),
        ));
        let id_for_snap = id.clone();
        let vols = opts.snapshot_volumes.clone();
        match tokio::task::spawn_blocking(move || snapshot_docker_volumes(&id_for_snap, &vols))
            .await
            .map_err(|e| format!("snapshot task join: {}", e))?
        {
            Ok(s) => {
                emit_log(&app, &id, &format!(
                    "Snapshot complete ({} archive{}, {} skipped).",
                    s.entries.len(),
                    if s.entries.len() == 1 { "" } else { "s" },
                    s.missing.len(),
                ));
                Some(s)
            }
            Err(e) => {
                emit_phase(&app, &id, "error");
                emit_log(&app, &id, &format!("snapshot failed: {}", e));
                return Err(format!("snapshot failed: {}", e));
            }
        }
    } else {
        None
    };

    // Persist the new image ref so Start uses it on the next launch.
    if target_image != original_image {
        persist_docker_image(&state, &id, &target_image)?;
    }

    if was_running {
        emit_phase(&app, &id, "stopping");
        emit_log(&app, &id, &format!("Stopping container porta-{}…", id));
        state.docker.stop_and_wait(&id, 10_000).ok();
    }

    emit_phase(&app, &id, "pulling");
    emit_log(&app, &id, &format!("Pulling {}…", target_image));
    let app_clone = app.clone();
    let id_clone = id.clone();
    let target_clone = target_image.clone();
    let pull_status = tokio::task::spawn_blocking(move || {
        run_streaming(
            app_clone,
            id_clone,
            vec!["pull".into(), target_clone],
            None,
        )
    })
    .await
    .map_err(|e| format!("pull task join: {}", e))??;
    if !pull_status.success() {
        emit_phase(&app, &id, "error");
        return Err(format!(
            "docker pull exited with code {}",
            pull_status.code().unwrap_or(-1)
        ));
    }

    if was_running {
        emit_phase(&app, &id, "starting");
        emit_log(&app, &id, "Restarting container with new image…");
        if let Err(e) = crate::commands::start_app(state.clone(), app.clone(), id.clone()) {
            emit_phase(&app, &id, "error");
            emit_log(&app, &id, &format!("start failed: {}", e));
            if opts.auto_rollback {
                rollback_docker(
                    &state, &app, &id, &original_image, &target_image,
                    &opts, snapshot.as_ref(),
                )
                .await;
            }
            return Err(e);
        }
    }

    if was_running && opts.auto_rollback {
        emit_phase(&app, &id, "verifying");
        emit_log(&app, &id, &format!(
            "Verifying container health (up to {}s)…",
            opts.verify_timeout().as_secs()
        ));
        let container_name = DockerManager::container_name(&id);
        let timeout = opts.verify_timeout();
        let verify =
            tokio::task::spawn_blocking(move || verify_single_container(&container_name, timeout))
                .await
                .map_err(|e| format!("verify task join: {}", e))?;
        if let Err(reason) = verify {
            emit_log(&app, &id, &format!("Verification failed: {}", reason));
            rollback_docker(
                &state, &app, &id, &original_image, &target_image,
                &opts, snapshot.as_ref(),
            )
            .await;
            return Err(format!("update rolled back: {}", reason));
        }
        emit_log(&app, &id, "Container is healthy.");
    }

    emit_phase(&app, &id, "done");
    emit_log(&app, &id, "✓ Update complete");
    Ok(())
}

async fn update_compose_app(
    _state: State<'_, AppState>,
    app: tauri::AppHandle,
    app_data: crate::db::models::App,
    tag_replacements: Vec<(String, String)>,
    opts: UpdateOptions,
) -> Result<(), String> {
    let id = app_data.id.clone();
    let file = app_data
        .compose_file
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "compose app has no compose file".to_string())?;
    let root = if app_data.root_dir.is_empty() {
        None
    } else {
        Some(app_data.root_dir.as_str())
    };
    let resolved = resolve_compose_path(file, root);

    let work_dir = Path::new(&resolved)
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    let project = DockerManager::compose_project(&id);

    // Snapshot BEFORE we touch the compose file or pull. Read-only mount is
    // safe even with the live containers running.
    let snapshot = if opts.snapshot_first && !opts.snapshot_volumes.is_empty() {
        emit_phase(&app, &id, "snapshotting");
        emit_log(&app, &id, &format!(
            "Snapshotting volume{}: {}",
            if opts.snapshot_volumes.len() == 1 { "" } else { "s" },
            opts.snapshot_volumes.join(", "),
        ));
        let id_for_snap = id.clone();
        let vols = opts.snapshot_volumes.clone();
        match tokio::task::spawn_blocking(move || snapshot_compose_volumes(&id_for_snap, &vols))
            .await
            .map_err(|e| format!("snapshot task join: {}", e))?
        {
            Ok(s) => {
                emit_log(&app, &id, &format!(
                    "Snapshot complete ({} archive{}, {} skipped).",
                    s.entries.len(),
                    if s.entries.len() == 1 { "" } else { "s" },
                    s.missing.len(),
                ));
                Some(s)
            }
            Err(e) => {
                emit_phase(&app, &id, "error");
                emit_log(&app, &id, &format!("snapshot failed: {}", e));
                return Err(format!("snapshot failed: {}", e));
            }
        }
    } else {
        None
    };

    if !tag_replacements.is_empty() {
        rewrite_compose_image_tags(&resolved, &tag_replacements)?;
    }

    emit_phase(&app, &id, "pulling");
    emit_log(&app, &id, "Pulling updated images…");
    let app_a = app.clone();
    let id_a = id.clone();
    let resolved_a = resolved.clone();
    let project_a = project.clone();
    let work_a = work_dir.clone();
    let pull_status = tokio::task::spawn_blocking(move || {
        run_streaming(
            app_a,
            id_a,
            vec![
                "compose".into(),
                "-f".into(),
                resolved_a,
                "-p".into(),
                project_a,
                "pull".into(),
            ],
            Some(work_a),
        )
    })
    .await
    .map_err(|e| format!("pull task join: {}", e))??;
    if !pull_status.success() {
        emit_phase(&app, &id, "error");
        if !tag_replacements.is_empty() {
            // Pull failed before any container was recreated — put the
            // compose file back so it isn't left in a broken state.
            let _ = revert_compose_image_tags(&resolved, &tag_replacements);
        }
        return Err(format!(
            "docker compose pull exited with code {}",
            pull_status.code().unwrap_or(-1)
        ));
    }

    emit_phase(&app, &id, "starting");
    emit_log(&app, &id, "Recreating containers with new images…");
    let app_b = app.clone();
    let id_b = id.clone();
    let resolved_b = resolved.clone();
    let project_b = project.clone();
    let work_b = work_dir.clone();
    let up_status = tokio::task::spawn_blocking(move || {
        run_streaming(
            app_b,
            id_b,
            vec![
                "compose".into(),
                "-f".into(),
                resolved_b,
                "-p".into(),
                project_b,
                "up".into(),
                "-d".into(),
            ],
            Some(work_b),
        )
    })
    .await
    .map_err(|e| format!("up task join: {}", e))??;
    if !up_status.success() {
        emit_phase(&app, &id, "error");
        if opts.auto_rollback && !tag_replacements.is_empty() {
            rollback_compose(
                &app, &id, &resolved, &project, &work_dir,
                &tag_replacements, &opts, snapshot.as_ref(),
            )
            .await;
        }
        return Err(format!(
            "docker compose up exited with code {}",
            up_status.code().unwrap_or(-1)
        ));
    }

    if opts.auto_rollback {
        emit_phase(&app, &id, "verifying");
        emit_log(&app, &id, &format!(
            "Verifying compose project health (up to {}s)…",
            opts.verify_timeout().as_secs()
        ));
        let project_for_verify = project.clone();
        let timeout = opts.verify_timeout();
        let verify = tokio::task::spawn_blocking(move || {
            verify_compose_project(&project_for_verify, timeout)
        })
        .await
        .map_err(|e| format!("verify task join: {}", e))?;
        if let Err(reasons) = verify {
            for r in &reasons {
                emit_log(&app, &id, &format!("Verification failed: {}", r));
            }
            if !tag_replacements.is_empty() {
                rollback_compose(
                    &app, &id, &resolved, &project, &work_dir,
                    &tag_replacements, &opts, snapshot.as_ref(),
                )
                .await;
            }
            return Err(format!(
                "update rolled back: {}",
                reasons.join("; ")
            ));
        }
        emit_log(&app, &id, "All containers reached a healthy state.");
    }

    emit_phase(&app, &id, "done");
    emit_log(&app, &id, "✓ Update complete");
    Ok(())
}

fn rebuild_image_ref(parsed: &ImageRef, new_tag: &str) -> String {
    // `parsed.repo` is already normalized — strip the `library/` prefix when
    // rebuilding for Docker Hub so the user-visible ref stays compact.
    let repo_display = if parsed.registry == DOCKER_HUB_REGISTRY {
        parsed.repo.strip_prefix("library/").unwrap_or(&parsed.repo)
    } else {
        &parsed.repo
    };
    if parsed.registry == DOCKER_HUB_REGISTRY {
        format!("{}:{}", repo_display, new_tag)
    } else {
        format!("{}/{}:{}", parsed.registry, repo_display, new_tag)
    }
}

fn persist_docker_image(state: &State<AppState>, id: &str, new_image: &str) -> Result<(), String> {
    // Read full app, then re-call update_app preserving everything else.
    // The DB layer doesn't expose a single-field setter for docker_image, so
    // round-tripping through update_app is the safest path.
    let app = state
        .db
        .lock()
        .unwrap()
        .list_apps()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|a| a.id == id)
        .ok_or_else(|| format!("app {} not found", id))?;
    state
        .db
        .lock()
        .unwrap()
        .update_app(
            &app.id,
            &app.name,
            Some(app.root_dir.as_str()),
            app.port,
            app.subdomain.as_deref(),
            &app.start_command,
            app.env_file.as_deref(),
            app.auto_start,
            &app.env_vars,
            &app.restart_policy,
            app.max_retries,
            app.health_check_path.as_deref(),
            &app.depends_on,
            &app.extra_subdomains,
            app.custom_domain.as_deref(),
            &app.port_bindings,
            &app.env_profiles,
            app.active_profile_id.as_deref(),
            Some(new_image),
            app.docker_container_port,
            app.docker_args.as_deref(),
            &app.docker_volumes,
            app.compose_file.as_deref(),
            app.network_share,
            app.tunnel_name.as_deref(),
            app.tunnel_custom_hostname.as_deref(),
            app.basic_auth_enabled,
            app.basic_auth_username.as_deref(),
            app.basic_auth_password_hash.as_deref(),
            app.tunnel_alias_domain.as_deref(),
            app.tunnel_alias_rewrite_host,
        )
        .map_err(|e| e.to_string())
}

/// Rewrite `image:` lines in a compose file to use new tags. Only touches
/// lines whose current `image:` value exactly matches an entry in
/// `replacements` — leaves comments, quoting, and indentation alone.
fn rewrite_compose_image_tags(
    path: &str,
    replacements: &[(String, String)],
) -> Result<(), String> {
    let content = std::fs::read_to_string(path)
        .map_err(|e| format!("read compose: {}", e))?;
    let mut out = String::with_capacity(content.len());
    let mut changed = false;
    for line in content.lines() {
        let trimmed = line.trim_start();
        if let Some(rest) = trimmed.strip_prefix("image:") {
            let value = rest.trim();
            // Strip optional surrounding quotes for the comparison only.
            let raw = value.trim_matches(|c| c == '"' || c == '\'');
            if let Some((orig, new_tag)) = replacements.iter().find(|(o, _)| o == raw) {
                if let Some(parsed) = parse_image_ref(orig) {
                    let new_ref = rebuild_image_ref(&parsed, new_tag);
                    let indent_len = line.len() - trimmed.len();
                    let indent = &line[..indent_len];
                    out.push_str(&format!("{}image: {}\n", indent, new_ref));
                    changed = true;
                    continue;
                }
            }
        }
        out.push_str(line);
        out.push('\n');
    }
    if changed {
        std::fs::write(path, out).map_err(|e| format!("write compose: {}", e))?;
    }
    Ok(())
}

// ── Verification + rollback ────────────────────────────────────────────────

/// Snapshot of one container's runtime state, sampled via `docker inspect`.
#[derive(Debug, Clone)]
struct ContainerState {
    name: String,
    status: String,        // "running" | "exited" | "restarting" | "created" | "dead"
    exit_code: i64,
    restart_count: u64,
    health: Option<String>, // "starting" | "healthy" | "unhealthy" | None
}

/// Inspect a single container by name. `None` if it's gone (rm'd, crashed
/// hard, etc.) — caller should usually treat that as a failure.
fn inspect_container(name_or_id: &str) -> Option<ContainerState> {
    // We use Go-template formatting and a custom delimiter so that fields
    // never collide with characters that appear inside container names.
    let format =
        "{{.Name}}|{{.State.Status}}|{{.State.ExitCode}}|{{.RestartCount}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}";
    let out = Command::new(docker_bin())
        .args(["inspect", "--format", format, name_or_id])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let line = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let parts: Vec<&str> = line.split('|').collect();
    if parts.len() < 5 {
        return None;
    }
    let name = parts[0].trim_start_matches('/').to_string();
    let status = parts[1].to_string();
    let exit_code = parts[2].parse::<i64>().unwrap_or(0);
    let restart_count = parts[3].parse::<u64>().unwrap_or(0);
    let health = match parts[4] {
        "none" | "" => None,
        other => Some(other.to_string()),
    };
    Some(ContainerState { name, status, exit_code, restart_count, health })
}

/// List container IDs belonging to a compose project.
fn project_container_ids(project: &str) -> Vec<String> {
    let out = Command::new(docker_bin())
        .args([
            "ps",
            "-a",
            "-q",
            "--filter",
            &format!("label=com.docker.compose.project={}", project),
        ])
        .output();
    out.ok()
        .filter(|o| o.status.success())
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// Returns Ok when the container reaches a stable healthy `running` state
/// within `timeout`. Otherwise an Err describing what went wrong.
fn verify_single_container(name: &str, timeout: Duration) -> Result<(), String> {
    let start = Instant::now();
    let mut consecutive_ok = 0;
    let mut last_status = String::new();
    while start.elapsed() < timeout {
        match inspect_container(name) {
            Some(s) => {
                last_status = s.status.clone();
                if let Some(verdict) = container_verdict(&s, start.elapsed()) {
                    return verdict;
                }
                if is_provisionally_ok(&s) {
                    consecutive_ok += 1;
                    // Two clean consecutive samples = stable.
                    if consecutive_ok >= 2 {
                        return Ok(());
                    }
                } else {
                    consecutive_ok = 0;
                }
            }
            None => {
                return Err(format!(
                    "container `{}` vanished during verification",
                    name
                ));
            }
        }
        std::thread::sleep(Duration::from_secs(2));
    }
    Err(format!(
        "container `{}` did not stabilise in {}s (last status: {})",
        name,
        timeout.as_secs(),
        if last_status.is_empty() { "<unknown>".into() } else { last_status }
    ))
}

/// Like `verify_single_container` but for every container in a compose
/// project. Returns Err with one message per failing container when at
/// least one didn't stabilise.
fn verify_compose_project(project: &str, timeout: Duration) -> Result<(), Vec<String>> {
    let start = Instant::now();
    let mut last_states: std::collections::HashMap<String, ContainerState> = Default::default();
    let mut consecutive_ok = 0;

    while start.elapsed() < timeout {
        let ids = project_container_ids(project);
        if ids.is_empty() {
            std::thread::sleep(Duration::from_secs(1));
            continue;
        }
        let mut all_ok = true;
        let mut failures: Vec<String> = Vec::new();
        for id in &ids {
            match inspect_container(id) {
                Some(s) => {
                    if let Some(Err(reason)) = container_verdict(&s, start.elapsed()) {
                        failures.push(reason);
                        all_ok = false;
                    } else if !is_provisionally_ok(&s) {
                        all_ok = false;
                    }
                    last_states.insert(s.name.clone(), s);
                }
                None => {
                    all_ok = false;
                }
            }
        }
        if !failures.is_empty() {
            return Err(failures);
        }
        if all_ok {
            consecutive_ok += 1;
            if consecutive_ok >= 2 {
                return Ok(());
            }
        } else {
            consecutive_ok = 0;
        }
        std::thread::sleep(Duration::from_secs(2));
    }
    let stragglers: Vec<String> = last_states
        .values()
        .filter(|s| !is_provisionally_ok(s))
        .map(|s| {
            format!(
                "`{}` did not stabilise (status={}, restart_count={}, health={})",
                s.name,
                s.status,
                s.restart_count,
                s.health.as_deref().unwrap_or("none"),
            )
        })
        .collect();
    if stragglers.is_empty() {
        // Saw at least one ok-ish round but never two in a row — still
        // return a generic timeout so the caller can act.
        Err(vec![format!(
            "compose project `{}` did not reach a stable state in {}s",
            project,
            timeout.as_secs()
        )])
    } else {
        Err(stragglers)
    }
}

/// Verdict on a single sample. `Some(Err(_))` is a definitive failure that
/// stops the verify loop early. `Some(Ok(_))` is reserved for definitive
/// success (currently unused — success requires two stable samples). `None`
/// means "keep polling".
fn container_verdict(s: &ContainerState, elapsed: Duration) -> Option<Result<(), String>> {
    match s.status.as_str() {
        "exited" | "dead" => Some(Err(format!(
            "`{}` exited with code {} after {}s",
            s.name,
            s.exit_code,
            elapsed.as_secs()
        ))),
        // A container in "restarting" has already failed at least once.
        // Give it ~10s grace (slow startup), then declare failure if it's
        // still flapping.
        "restarting" if elapsed > Duration::from_secs(10) => Some(Err(format!(
            "`{}` is in a restart loop ({} restarts so far)",
            s.name, s.restart_count
        ))),
        _ => None,
    }
}

fn is_provisionally_ok(s: &ContainerState) -> bool {
    if s.status != "running" {
        return false;
    }
    match s.health.as_deref() {
        None => true,        // no healthcheck — running is good enough
        Some("healthy") => true,
        Some(_) => false,    // starting / unhealthy — keep waiting
    }
}

/// Roll back a failed compose update: revert the compose file tags, force
/// recreate affected services, and (optionally) restore volume contents.
#[allow(clippy::too_many_arguments)]
async fn rollback_compose(
    app: &tauri::AppHandle,
    id: &str,
    resolved: &str,
    project: &str,
    work_dir: &std::path::Path,
    tag_replacements: &[(String, String)],
    opts: &UpdateOptions,
    snapshot: Option<&VolumeSnapshotResult>,
) {
    emit_phase(app, id, "rolling_back");
    emit_log(app, id, "Reverting compose file to original image tags…");
    if let Err(e) = revert_compose_image_tags(resolved, tag_replacements) {
        emit_log(app, id, &format!("revert compose file failed: {} (continuing rollback)", e));
    }

    // If we need to restore volumes, take everything down first so the
    // volume isn't held open by a container.
    let restoring = opts.restore_on_rollback
        && snapshot.map(|s| !s.entries.is_empty()).unwrap_or(false);
    if restoring {
        emit_phase(app, id, "restoring");
        emit_log(app, id, "Stopping project to restore volume snapshot…");
        let _ = Command::new(docker_bin())
            .args(["compose", "-f", resolved, "-p", project, "down"])
            .current_dir(work_dir)
            .output();
        if let Some(snap) = snapshot {
            for entry in &snap.entries {
                emit_log(app, id, &format!(
                    "Restoring `{}` from snapshot {}…",
                    entry.docker_volume, snap.timestamp,
                ));
                if let Err(e) = restore_volume_snapshot(entry) {
                    emit_log(app, id, &format!("restore failed for `{}`: {}", entry.docker_volume, e));
                }
            }
        }
    }

    emit_log(app, id, "Bringing project back up with the original images…");
    let _ = Command::new(docker_bin())
        .args([
            "compose", "-f", resolved, "-p", project,
            "up", "-d", "--force-recreate",
        ])
        .current_dir(work_dir)
        .output();
    emit_log(app, id, "Rollback complete. Original images are running.");
    emit_phase(app, id, "error");
}

/// Roll back a failed single-container update: persist the original image
/// ref, restart with the old image, optionally restore volume contents.
async fn rollback_docker(
    state: &State<'_, AppState>,
    app: &tauri::AppHandle,
    id: &str,
    original_image: &str,
    target_image: &str,
    opts: &UpdateOptions,
    snapshot: Option<&VolumeSnapshotResult>,
) {
    emit_phase(app, id, "rolling_back");
    if target_image != original_image {
        emit_log(app, id, &format!(
            "Reverting docker_image to `{}`…", original_image
        ));
        let _ = persist_docker_image(state, id, original_image);
    }
    emit_log(app, id, "Stopping failed container…");
    let _ = state.docker.stop_and_wait(id, 5_000);

    if opts.restore_on_rollback {
        if let Some(snap) = snapshot {
            emit_phase(app, id, "restoring");
            for entry in &snap.entries {
                emit_log(app, id, &format!(
                    "Restoring `{}` from snapshot {}…",
                    entry.docker_volume, snap.timestamp,
                ));
                if let Err(e) = restore_volume_snapshot(entry) {
                    emit_log(app, id, &format!(
                        "restore failed for `{}`: {}", entry.docker_volume, e
                    ));
                }
            }
        }
    }

    emit_log(app, id, "Restarting with the original image…");
    if let Err(e) = crate::commands::start_app(state.clone(), app.clone(), id.to_string()) {
        emit_log(app, id, &format!("rollback restart failed: {}", e));
    } else {
        emit_log(app, id, "Rollback complete. Original image is running.");
    }
    emit_phase(app, id, "error");
}

/// Reverse of `rewrite_compose_image_tags`: find lines whose `image:` value
/// matches the rewritten ref and put the original back. Used for atomic
/// rollback when an update fails.
fn revert_compose_image_tags(
    path: &str,
    replacements: &[(String, String)],
) -> Result<(), String> {
    // Build (rewritten_ref → original_ref) lookup from the same inputs we
    // gave to `rewrite_compose_image_tags`.
    let mut reverse_map: Vec<(String, String)> = Vec::new();
    for (orig, new_tag) in replacements {
        if let Some(parsed) = parse_image_ref(orig) {
            let new_ref = rebuild_image_ref(&parsed, new_tag);
            reverse_map.push((new_ref, orig.clone()));
        }
    }
    if reverse_map.is_empty() {
        return Ok(());
    }
    let content = std::fs::read_to_string(path)
        .map_err(|e| format!("read compose: {}", e))?;
    let mut out = String::with_capacity(content.len());
    let mut changed = false;
    for line in content.lines() {
        let trimmed = line.trim_start();
        if let Some(rest) = trimmed.strip_prefix("image:") {
            let value = rest.trim();
            let raw = value.trim_matches(|c| c == '"' || c == '\'');
            if let Some((_, orig)) = reverse_map.iter().find(|(new_ref, _)| new_ref == raw) {
                let indent_len = line.len() - trimmed.len();
                let indent = &line[..indent_len];
                out.push_str(&format!("{}image: {}\n", indent, orig));
                changed = true;
                continue;
            }
        }
        out.push_str(line);
        out.push('\n');
    }
    if changed {
        std::fs::write(path, out).map_err(|e| format!("write compose: {}", e))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_dockerhub_official() {
        let p = parse_image_ref("nginx").unwrap();
        assert_eq!(p.registry, DOCKER_HUB_REGISTRY);
        assert_eq!(p.repo, "library/nginx");
        assert_eq!(p.tag, "latest");
    }

    #[test]
    fn parse_dockerhub_user_with_tag() {
        let p = parse_image_ref("databasus/databasus:1.2.3").unwrap();
        assert_eq!(p.registry, DOCKER_HUB_REGISTRY);
        assert_eq!(p.repo, "databasus/databasus");
        assert_eq!(p.tag, "1.2.3");
    }

    #[test]
    fn parse_ghcr() {
        let p = parse_image_ref("ghcr.io/user/img:v1").unwrap();
        assert_eq!(p.registry, "ghcr.io");
        assert_eq!(p.repo, "user/img");
        assert_eq!(p.tag, "v1");
    }

    #[test]
    fn parse_localhost_registry() {
        let p = parse_image_ref("localhost:5000/myimg:dev").unwrap();
        assert_eq!(p.registry, "localhost:5000");
        assert_eq!(p.repo, "myimg");
        assert_eq!(p.tag, "dev");
    }

    #[test]
    fn parse_digest_pinned() {
        let p = parse_image_ref("nginx@sha256:abcdef").unwrap();
        // tag is mangled with @digest sentinel so callers can detect.
        assert!(p.tag.ends_with("@digest"));
    }

    #[test]
    fn semver_basic() {
        assert_eq!(parse_semver_tag("1.25.3"), Some((vec![1, 25, 3], String::new())));
        assert_eq!(parse_semver_tag("v1.25.3"), Some((vec![1, 25, 3], String::new())));
        assert_eq!(parse_semver_tag("1.25.3-alpine"), Some((vec![1, 25, 3], "-alpine".into())));
        assert_eq!(parse_semver_tag("16-alpine"), Some((vec![16], "-alpine".into())));
        assert_eq!(parse_semver_tag("latest"), None);
        assert_eq!(parse_semver_tag("alpine"), None);
    }

    #[test]
    fn suggest_newer_basic() {
        let tags = vec![
            "1.25.3".to_string(),
            "1.25.4".to_string(),
            "1.26.0".to_string(),
            "1.25.3-alpine".to_string(),
            "1.27.0-alpine".to_string(),
            "latest".to_string(),
        ];
        // Same shape, no suffix → highest 1.x.y
        assert_eq!(suggest_newer_tag("1.25.3", &tags).as_deref(), Some("1.26.0"));
        // Same shape, alpine suffix → only alpine matches
        assert_eq!(
            suggest_newer_tag("1.25.3-alpine", &tags).as_deref(),
            Some("1.27.0-alpine")
        );
        // Already newest
        assert_eq!(suggest_newer_tag("1.26.0", &tags), None);
    }

    #[test]
    fn suggest_newer_respects_component_count() {
        // Pinned `1.25` (2 parts) — `1.25.4` (3 parts) must NOT be returned;
        // moving from a minor pin to a patch pin is a different stability promise.
        let tags = vec!["1.25".to_string(), "1.26".to_string(), "1.25.4".to_string()];
        assert_eq!(suggest_newer_tag("1.25", &tags).as_deref(), Some("1.26"));
    }

    #[test]
    fn rebuild_ref_preserves_form() {
        let p = parse_image_ref("nginx:1.25").unwrap();
        assert_eq!(rebuild_image_ref(&p, "1.26"), "nginx:1.26");
        let p = parse_image_ref("ghcr.io/user/img:v1").unwrap();
        assert_eq!(rebuild_image_ref(&p, "v2"), "ghcr.io/user/img:v2");
        let p = parse_image_ref("databasus/databasus:1.2.3").unwrap();
        assert_eq!(rebuild_image_ref(&p, "1.2.4"), "databasus/databasus:1.2.4");
    }

    #[test]
    fn mutable_tag_detection() {
        assert!(is_mutable_tag("latest"));
        assert!(is_mutable_tag("LATEST"));
        assert!(is_mutable_tag("nightly"));
        assert!(!is_mutable_tag("1.25.3"));
        assert!(!is_mutable_tag("v1"));
    }

    #[test]
    fn revert_undoes_rewrite() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("c.yml");
        let original = r#"services:
  db:
    image: mysql:8.0
  web:
    image: nginx:1.25.3
"#;
        std::fs::write(&path, original).unwrap();
        let p = path.to_string_lossy().to_string();
        let replacements = [("mysql:8.0".to_string(), "9.7".to_string())];
        rewrite_compose_image_tags(&p, &replacements).unwrap();
        // After rewrite: should have mysql:9.7
        let after_rewrite = std::fs::read_to_string(&p).unwrap();
        assert!(after_rewrite.contains("image: mysql:9.7"));
        assert!(!after_rewrite.contains("image: mysql:8.0"));
        // Revert should put the original back exactly.
        revert_compose_image_tags(&p, &replacements).unwrap();
        let after_revert = std::fs::read_to_string(&p).unwrap();
        assert_eq!(after_revert, original);
    }

    #[test]
    fn rewrite_compose_only_replaces_exact_match() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("c.yml");
        std::fs::write(
            &path,
            r#"services:
  web:
    image: nginx:1.25.3
  db:
    image: postgres:16
  other:
    image: nginx:1.25.3-alpine
"#,
        )
        .unwrap();
        let p = path.to_string_lossy().to_string();
        rewrite_compose_image_tags(
            &p,
            &[("nginx:1.25.3".to_string(), "1.26.0".to_string())],
        )
        .unwrap();
        let after = std::fs::read_to_string(&p).unwrap();
        // The exact-match line was rewritten...
        assert!(after.contains("image: nginx:1.26.0"));
        // ...but the alpine variant kept its tag.
        assert!(after.contains("image: nginx:1.25.3-alpine"));
        // Untouched service still there.
        assert!(after.contains("image: postgres:16"));
    }
}
