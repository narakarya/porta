//! Docker disk usage and prune commands.
//!
//! Layered on top of `docker system df` and `docker image prune`. We parse
//! line-delimited JSON from `docker system df --format '{{json .}}'` to get
//! per-section sizes, and parse the human "Total reclaimed space: …" line
//! from prune output for freed bytes.
//!
//! Per-app sizing scopes to the compose project label
//! (`com.docker.compose.project=porta-<app_id>`) for compose apps, and to
//! the `porta-<app_id>` container for single docker apps.

use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::process::Command;

use crate::app_state::AppState;
use crate::docker_manager::{docker_bin, DockerManager};

// ── Public response types ──────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct DiskSection {
    pub kind: String,
    pub total_count: u64,
    pub active_count: u64,
    pub size_bytes: u64,
    pub reclaimable_bytes: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct SystemDiskUsage {
    pub images: DiskSection,
    pub containers: DiskSection,
    pub volumes: DiskSection,
    pub build_cache: DiskSection,
    /// Size of truly-dangling (untagged) images — what `image prune -f`
    /// actually removes. The `images.reclaimable_bytes` from `docker system df`
    /// also includes tagged-but-unused images, which only `prune -af` removes.
    pub dangling_image_bytes: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct AppDiskUsage {
    pub image_bytes: u64,
    pub volume_bytes: u64,
    pub container_bytes: u64,
    /// Best-effort count of images tagged for this app's compose project that
    /// are NOT currently used by a running container — i.e. candidates for
    /// `prune_app_old_images`.
    pub stale_image_count: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct PruneResult {
    pub removed_count: u64,
    pub freed_bytes: u64,
}

// ── Helpers ────────────────────────────────────────────────────────────────

/// Parse strings like "1.234GB", "512MB", "128 kB", "0B" into bytes.
/// Docker is loose with spacing/case, so we normalize.
pub(crate) fn parse_size(s: &str) -> u64 {
    let s = s.trim();
    if s.is_empty() || s == "0" || s == "0B" {
        return 0;
    }
    // Split numeric prefix from unit suffix.
    let split_at = s
        .char_indices()
        .find(|(_, c)| !(c.is_ascii_digit() || *c == '.' || *c == ',' || c.is_whitespace()))
        .map(|(i, _)| i)
        .unwrap_or(s.len());
    let (num_part, unit_part) = s.split_at(split_at);
    let num: f64 = num_part.trim().replace(',', ".").parse().unwrap_or(0.0);
    let unit = unit_part.trim().to_ascii_lowercase();
    let mult: f64 = match unit.as_str() {
        "" | "b" => 1.0,
        "k" | "kb" | "kib" => 1024.0,
        "m" | "mb" | "mib" => 1024.0 * 1024.0,
        "g" | "gb" | "gib" => 1024.0 * 1024.0 * 1024.0,
        "t" | "tb" | "tib" => 1024.0 * 1024.0 * 1024.0 * 1024.0,
        _ => 1.0,
    };
    (num * mult) as u64
}

/// Pull "Total reclaimed space: …" out of docker prune stdout and return the
/// byte count. Returns 0 if the line isn't present (nothing to prune).
fn parse_reclaimed(stdout: &str) -> u64 {
    for line in stdout.lines() {
        if let Some(rest) = line.trim().strip_prefix("Total reclaimed space:") {
            return parse_size(rest);
        }
    }
    0
}

/// Count "Deleted:" / "Untagged:" lines in prune output as a proxy for
/// removed entities. Docker doesn't report a count, just a list.
fn count_removed(stdout: &str) -> u64 {
    stdout
        .lines()
        .filter(|l| {
            let t = l.trim();
            t.starts_with("Deleted:") || t.starts_with("untagged:") || t.starts_with("Untagged:")
        })
        .count() as u64
}

async fn docker_output(args: &[&str]) -> Result<String, String> {
    let out = Command::new(docker_bin())
        .args(args)
        .output()
        .await
        .map_err(|e| format!("docker {:?}: {}", args, e))?;
    if !out.status.success() {
        return Err(format!(
            "docker {:?} exited {}: {}",
            args,
            out.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

// ── system_disk_usage ──────────────────────────────────────────────────────

#[derive(Deserialize)]
struct DfRow {
    #[serde(rename = "Type")]
    kind: String,
    #[serde(rename = "TotalCount")]
    total_count: serde_json::Value,
    #[serde(rename = "Active")]
    active: serde_json::Value,
    #[serde(rename = "Size")]
    size: String,
    #[serde(rename = "Reclaimable")]
    reclaimable: String,
}

fn coerce_count(v: &serde_json::Value) -> u64 {
    match v {
        serde_json::Value::Number(n) => n.as_u64().unwrap_or(0),
        serde_json::Value::String(s) => s.trim().parse().unwrap_or(0),
        _ => 0,
    }
}

/// `Reclaimable` looks like `"1.2GB (50%)"` — strip the percentage.
fn parse_reclaimable_field(s: &str) -> u64 {
    let head = s.split('(').next().unwrap_or(s);
    parse_size(head)
}

#[tauri::command]
pub async fn system_disk_usage() -> Result<SystemDiskUsage, String> {
    let out = docker_output(&["system", "df", "--format", "{{json .}}"]).await?;
    let mut usage = SystemDiskUsage::default();
    for line in out.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let row: DfRow = match serde_json::from_str(line) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let section = DiskSection {
            kind: row.kind.clone(),
            total_count: coerce_count(&row.total_count),
            active_count: coerce_count(&row.active),
            size_bytes: parse_size(&row.size),
            reclaimable_bytes: parse_reclaimable_field(&row.reclaimable),
        };
        match row.kind.to_ascii_lowercase().as_str() {
            "images" => usage.images = section,
            "containers" => usage.containers = section,
            "local volumes" | "volumes" => usage.volumes = section,
            "build cache" => usage.build_cache = section,
            _ => {}
        }
    }

    // Dangling-only image size: what `image prune -f` will actually free.
    // Best-effort — if the call fails, leave at 0.
    if let Ok(out) = docker_output(&[
        "images",
        "-f", "dangling=true",
        "--format", "{{.Size}}",
    ])
    .await
    {
        usage.dangling_image_bytes = out
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(parse_size)
            .sum();
    }

    Ok(usage)
}

// ── app_disk_usage ─────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct ImageRow {
    #[serde(rename = "Repository")]
    repository: String,
    #[serde(rename = "Tag")]
    tag: String,
    #[serde(rename = "Size")]
    size: String,
    #[serde(rename = "ID")]
    id: String,
}

#[derive(Deserialize)]
struct ContainerRow {
    #[serde(rename = "Image")]
    image: String,
    #[serde(rename = "Size")]
    #[serde(default)]
    size: String,
}

#[derive(Deserialize)]
struct VolumeRow {
    #[serde(rename = "Name")]
    name: String,
}

#[derive(Deserialize)]
struct DfVolumeRow {
    #[serde(rename = "Name")]
    name: String,
    #[serde(rename = "Size")]
    size: String,
}

/// Container "Size" looks like `"123MB (virtual 1.2GB)"` — we want the writable
/// layer (the part before the parens) only. Bare `"0B"` is fine.
fn parse_container_size(s: &str) -> u64 {
    parse_size(s.split('(').next().unwrap_or(s))
}

#[tauri::command]
pub async fn app_disk_usage(
    state: State<'_, AppState>,
    app_id: String,
) -> Result<AppDiskUsage, String> {
    let app = {
        let db = state.db.lock().unwrap();
        db.list_apps()
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|a| a.id == app_id)
            .ok_or_else(|| format!("app {} not found", app_id))?
    };

    let project = DockerManager::compose_project(&app_id);
    let mut usage = AppDiskUsage::default();

    // ── Containers ─────────────────────────────────────────────────────────
    // Compose containers carry the project label; single docker apps use the
    // deterministic `porta-<id>` name.
    if app.is_compose() {
        let label = format!("label=com.docker.compose.project={}", project);
        let out = docker_output(&[
            "ps", "-a",
            "--filter", &label,
            "--format", "{{json .}}",
            "--size",
        ])
        .await
        .unwrap_or_default();
        for line in out.lines().filter(|l| !l.trim().is_empty()) {
            if let Ok(row) = serde_json::from_str::<ContainerRow>(line) {
                usage.container_bytes += parse_container_size(&row.size);
            }
        }
    } else if app.is_docker() {
        let name = DockerManager::container_name(&app_id);
        let out = docker_output(&[
            "ps", "-a",
            "--filter", &format!("name=^{}$", name),
            "--format", "{{json .}}",
            "--size",
        ])
        .await
        .unwrap_or_default();
        for line in out.lines().filter(|l| !l.trim().is_empty()) {
            if let Ok(row) = serde_json::from_str::<ContainerRow>(line) {
                usage.container_bytes += parse_container_size(&row.size);
            }
        }
    }

    // ── Images ─────────────────────────────────────────────────────────────
    // For compose: any image referenced by a container with the project label.
    // For docker: the configured image (if any).
    let mut wanted_images: std::collections::HashSet<String> =
        std::collections::HashSet::new();
    let mut active_images: std::collections::HashSet<String> =
        std::collections::HashSet::new();

    if app.is_compose() {
        let label = format!("label=com.docker.compose.project={}", project);
        // -a so stopped containers also count toward sizing.
        let out = docker_output(&[
            "ps", "-a",
            "--filter", &label,
            "--format", "{{json .}}",
        ])
        .await
        .unwrap_or_default();
        for line in out.lines().filter(|l| !l.trim().is_empty()) {
            if let Ok(row) = serde_json::from_str::<ContainerRow>(line) {
                wanted_images.insert(row.image);
            }
        }
        // Track which images are bound to *running* containers — those are
        // considered active and not "stale".
        let out_running = docker_output(&[
            "ps",
            "--filter", &label,
            "--format", "{{json .}}",
        ])
        .await
        .unwrap_or_default();
        for line in out_running.lines().filter(|l| !l.trim().is_empty()) {
            if let Ok(row) = serde_json::from_str::<ContainerRow>(line) {
                active_images.insert(row.image);
            }
        }
    } else if app.is_docker() {
        if let Some(img) = app
            .docker_image
            .as_deref()
            .filter(|s| !s.trim().is_empty())
        {
            wanted_images.insert(img.to_string());
            // Only count as active if the porta container is actually running.
            let name = DockerManager::container_name(&app_id);
            let running = docker_output(&[
                "ps",
                "--filter", &format!("name=^{}$", name),
                "--format", "{{json .}}",
            ])
            .await
            .unwrap_or_default();
            if !running.trim().is_empty() {
                active_images.insert(img.to_string());
            }
        }
    }

    if !wanted_images.is_empty() {
        // Pull the full image list once and filter — cheaper than N inspects.
        let out = docker_output(&["images", "--format", "{{json .}}"])
            .await
            .unwrap_or_default();
        let mut seen_ids: std::collections::HashSet<String> =
            std::collections::HashSet::new();
        for line in out.lines().filter(|l| !l.trim().is_empty()) {
            let Ok(row) = serde_json::from_str::<ImageRow>(line) else { continue };
            let bare = format!("{}:{}", row.repository, row.tag);
            // Match by `repo:tag` OR by image ID prefix — compose sometimes
            // reports the digest-pinned form and we want to catch both.
            let in_use = wanted_images.contains(&bare)
                || wanted_images.iter().any(|w| w.starts_with(&row.id) || w == &row.repository);
            if in_use {
                if seen_ids.insert(row.id.clone()) {
                    usage.image_bytes += parse_size(&row.size);
                }
                // Stale = matches our project but no running container holds it.
                let used_now = active_images.contains(&bare)
                    || active_images.iter().any(|w| w.starts_with(&row.id));
                if !used_now {
                    usage.stale_image_count += 1;
                }
            }
        }
    }

    // ── Volumes ────────────────────────────────────────────────────────────
    // Compose creates volumes prefixed with the project name. We list them and
    // sum their `Size` from `docker system df -v` (which reports per-volume).
    let label = format!("label=com.docker.compose.project={}", project);
    let vol_out = docker_output(&["volume", "ls", "--filter", &label, "--format", "{{json .}}"])
        .await
        .unwrap_or_default();
    let mut wanted_volumes: std::collections::HashSet<String> =
        std::collections::HashSet::new();
    for line in vol_out.lines().filter(|l| !l.trim().is_empty()) {
        if let Ok(row) = serde_json::from_str::<VolumeRow>(line) {
            wanted_volumes.insert(row.name);
        }
    }

    // Fallback: also pick up volumes named with the project prefix even if the
    // label is missing (older compose versions / manually-named volumes).
    if wanted_volumes.is_empty() {
        let prefix = format!("{}_", project);
        let all_vols = docker_output(&["volume", "ls", "--format", "{{json .}}"])
            .await
            .unwrap_or_default();
        for line in all_vols.lines().filter(|l| !l.trim().is_empty()) {
            if let Ok(row) = serde_json::from_str::<VolumeRow>(line) {
                if row.name.starts_with(&prefix) {
                    wanted_volumes.insert(row.name);
                }
            }
        }
    }

    if !wanted_volumes.is_empty() {
        let df_out = docker_output(&["system", "df", "-v", "--format", "{{json .}}"])
            .await
            .unwrap_or_default();
        // `system df -v --format json` emits a single JSON object with a
        // `Volumes` array (older docker emits per-section line JSON). Try
        // both shapes.
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(df_out.trim()) {
            if let Some(arr) = v.get("Volumes").and_then(|x| x.as_array()) {
                for item in arr {
                    let Some(name) = item.get("Name").and_then(|x| x.as_str()) else { continue };
                    if !wanted_volumes.contains(name) {
                        continue;
                    }
                    if let Some(sz) = item.get("Size").and_then(|x| x.as_str()) {
                        usage.volume_bytes += parse_size(sz);
                    }
                }
            }
        } else {
            // Line-delimited per-volume rows.
            for line in df_out.lines().filter(|l| !l.trim().is_empty()) {
                if let Ok(row) = serde_json::from_str::<DfVolumeRow>(line) {
                    if wanted_volumes.contains(&row.name) {
                        usage.volume_bytes += parse_size(&row.size);
                    }
                }
            }
        }
    }

    Ok(usage)
}

// ── list_docker_images ─────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ImageDetail {
    pub id: String,
    pub repository: String,
    pub tag: String,
    pub size_bytes: u64,
    /// "dangling" | "unused" | "used"
    pub category: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct DockerImageList {
    pub dangling: Vec<ImageDetail>,
    pub unused: Vec<ImageDetail>,
    pub used: Vec<ImageDetail>,
    pub dangling_bytes: u64,
    pub unused_bytes: u64,
    pub used_bytes: u64,
}

#[derive(Deserialize)]
struct RawImageRow {
    #[serde(rename = "ID")]
    id: String,
    #[serde(rename = "Repository")]
    repository: String,
    #[serde(rename = "Tag")]
    tag: String,
    #[serde(rename = "Size")]
    size: String,
}

#[tauri::command]
pub async fn list_docker_images() -> Result<DockerImageList, String> {
    // Images currently referenced by running containers.
    let running_out = docker_output(&["ps", "--format", "{{json .}}"]).await.unwrap_or_default();
    let mut used_refs: std::collections::HashSet<String> = std::collections::HashSet::new();
    for line in running_out.lines().filter(|l| !l.trim().is_empty()) {
        if let Ok(row) = serde_json::from_str::<ContainerRow>(line) {
            used_refs.insert(row.image);
        }
    }

    // All container image refs (running + stopped) — everything that has a container.
    let all_containers_out = docker_output(&["ps", "-a", "--format", "{{json .}}"]).await.unwrap_or_default();
    let mut all_container_refs: std::collections::HashSet<String> = std::collections::HashSet::new();
    for line in all_containers_out.lines().filter(|l| !l.trim().is_empty()) {
        if let Ok(row) = serde_json::from_str::<ContainerRow>(line) {
            all_container_refs.insert(row.image);
        }
    }

    // All images.
    let images_out = docker_output(&["images", "--format", "{{json .}}"]).await?;
    let mut result = DockerImageList::default();
    // De-dupe by ID — docker reports one row per tag, same underlying layer.
    let mut seen_ids: std::collections::HashSet<String> = std::collections::HashSet::new();

    for line in images_out.lines().filter(|l| !l.trim().is_empty()) {
        let Ok(row) = serde_json::from_str::<RawImageRow>(line) else { continue };
        let size = parse_size(&row.size);
        let is_dangling = row.repository == "<none>" && row.tag == "<none>";
        let full_ref = format!("{}:{}", row.repository, row.tag);

        let is_used = used_refs.contains(&full_ref)
            || used_refs.contains(&row.id)
            || used_refs.iter().any(|r| r.starts_with(&row.id));

        // For "in use by any container" check (not just running).
        let has_container = all_container_refs.contains(&full_ref)
            || all_container_refs.contains(&row.id)
            || all_container_refs.iter().any(|r| r.starts_with(&row.id));

        let category = if is_dangling {
            "dangling"
        } else if is_used || has_container {
            "used"
        } else {
            "unused"
        };

        let detail = ImageDetail {
            id: row.id.clone(),
            repository: row.repository.clone(),
            tag: row.tag.clone(),
            size_bytes: size,
            category: category.to_string(),
        };

        // Only add size once per unique image ID.
        let new_id = seen_ids.insert(row.id.clone());
        match category {
            "dangling" => {
                if new_id { result.dangling_bytes += size; }
                result.dangling.push(detail);
            }
            "unused" => {
                if new_id { result.unused_bytes += size; }
                result.unused.push(detail);
            }
            _ => {
                if new_id { result.used_bytes += size; }
                result.used.push(detail);
            }
        }
    }

    // Sort each category largest-first.
    result.dangling.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));
    result.unused.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));
    result.used.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));

    Ok(result)
}

// ── Prune commands ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn prune_dangling_images() -> Result<PruneResult, String> {
    let out = docker_output(&["image", "prune", "-f"]).await?;
    Ok(PruneResult {
        removed_count: count_removed(&out),
        freed_bytes: parse_reclaimed(&out),
    })
}

#[tauri::command]
pub async fn prune_unused_images() -> Result<PruneResult, String> {
    let out = docker_output(&["image", "prune", "-af"]).await?;
    Ok(PruneResult {
        removed_count: count_removed(&out),
        freed_bytes: parse_reclaimed(&out),
    })
}

#[tauri::command]
pub async fn prune_app_old_images(
    state: State<'_, AppState>,
    app_id: String,
) -> Result<PruneResult, String> {
    let app = {
        let db = state.db.lock().unwrap();
        db.list_apps()
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|a| a.id == app_id)
            .ok_or_else(|| format!("app {} not found", app_id))?
    };

    let project = DockerManager::compose_project(&app_id);
    // ── Determine active images (those still referenced by a running
    // container under this project / app).
    let mut active_refs: std::collections::HashSet<String> =
        std::collections::HashSet::new();

    if app.is_compose() {
        let label = format!("label=com.docker.compose.project={}", project);
        let out = docker_output(&[
            "ps",
            "--filter", &label,
            "--format", "{{json .}}",
        ])
        .await
        .unwrap_or_default();
        for line in out.lines().filter(|l| !l.trim().is_empty()) {
            if let Ok(row) = serde_json::from_str::<ContainerRow>(line) {
                active_refs.insert(row.image);
            }
        }
    } else if app.is_docker() {
        if let Some(img) = app
            .docker_image
            .as_deref()
            .filter(|s| !s.trim().is_empty())
        {
            active_refs.insert(img.to_string());
        }
    } else {
        return Ok(PruneResult::default());
    }

    // ── Collect candidate images that belong to this app's universe.
    // For compose, we look at images referenced by ANY container (running or
    // stopped) under the project label, then strip out the active ones — what
    // remains was tagged for an old version of this app.
    let mut candidate_refs: std::collections::HashSet<String> =
        std::collections::HashSet::new();
    if app.is_compose() {
        let label = format!("label=com.docker.compose.project={}", project);
        let out = docker_output(&[
            "ps", "-a",
            "--filter", &label,
            "--format", "{{json .}}",
        ])
        .await
        .unwrap_or_default();
        for line in out.lines().filter(|l| !l.trim().is_empty()) {
            if let Ok(row) = serde_json::from_str::<ContainerRow>(line) {
                candidate_refs.insert(row.image);
            }
        }
    }

    // Map each ref to an image ID, then drop active IDs. Anything left is
    // safe to remove via `docker rmi`.
    let mut active_ids: std::collections::HashSet<String> =
        std::collections::HashSet::new();
    for r in &active_refs {
        if let Some(id) = image_id_for_ref(r).await {
            active_ids.insert(id);
        }
    }
    let mut removed_count: u64 = 0;
    let mut freed_bytes: u64 = 0;

    for r in candidate_refs.difference(&active_refs) {
        let Some(id) = image_id_for_ref(r).await else { continue };
        if active_ids.contains(&id) {
            continue;
        }
        let size = image_size_for_id(&id).await.unwrap_or(0);
        // `docker rmi <id>` may fail if another container still references it.
        // We don't `-f` to avoid breaking other unrelated apps.
        let out = Command::new(docker_bin())
            .args(["rmi", &id])
            .output()
            .await;
        if let Ok(o) = out {
            if o.status.success() {
                removed_count += 1;
                freed_bytes += size;
            }
        }
    }

    Ok(PruneResult { removed_count, freed_bytes })
}

async fn image_id_for_ref(image_ref: &str) -> Option<String> {
    let out = Command::new(docker_bin())
        .args(["image", "inspect", "--format", "{{.Id}}", image_ref])
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

async fn image_size_for_id(id: &str) -> Option<u64> {
    let out = Command::new(docker_bin())
        .args(["image", "inspect", "--format", "{{.Size}}", id])
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_size_units() {
        assert_eq!(parse_size("0B"), 0);
        assert_eq!(parse_size("0"), 0);
        assert_eq!(parse_size("512B"), 512);
        assert_eq!(parse_size("1kB"), 1024);
        assert_eq!(parse_size("1.5MB"), (1.5 * 1024.0 * 1024.0) as u64);
        assert_eq!(parse_size("2GB"), 2 * 1024 * 1024 * 1024);
        assert_eq!(parse_size("1.234 GB"), (1.234 * 1024.0 * 1024.0 * 1024.0) as u64);
    }

    #[test]
    fn parse_reclaimable_strips_percent() {
        assert_eq!(parse_reclaimable_field("1.2GB (50%)"), (1.2 * 1024.0 * 1024.0 * 1024.0) as u64);
        assert_eq!(parse_reclaimable_field("512MB"), 512 * 1024 * 1024);
    }

    #[test]
    fn parse_reclaimed_finds_line() {
        let out = "Deleted: sha256:abc\nDeleted: sha256:def\nTotal reclaimed space: 1.5GB\n";
        assert_eq!(parse_reclaimed(out), (1.5 * 1024.0 * 1024.0 * 1024.0) as u64);
        assert_eq!(count_removed(out), 2);
    }

    #[test]
    fn parse_reclaimed_handles_zero() {
        let out = "Total reclaimed space: 0B\n";
        assert_eq!(parse_reclaimed(out), 0);
    }
}
