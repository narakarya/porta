//! Pre-flight risk assessment for image updates.
//!
//! Classifies an in-flight `update_app_images` call before it touches anything,
//! so the UI can warn the user when the swap is likely to break a stateful
//! service (database refusing to read its old data dir, dependents stuck in
//! restart loops, etc.).
//!
//! Why this exists: the cap incident — `mysql:8.0` (= 8.0.46 in volume) was
//! bumped to `mysql:latest` (= 9.7.0) via Porta's update flow. MySQL refuses
//! to skip major versions outside its LTS path, the data dir got rejected, and
//! `cap-web` + `cap-minio-init` (both `depends_on: cap-db`) couldn't start.
//! The classifier surfaces all three signals (stateful image, major bump,
//! dependents) so the user sees the consequences before the pull happens.

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::app_state::AppState;
use crate::commands::docker_updates::{parse_image_ref, ImageRef};
use crate::compose_parser::{parse_compose, ComposeProject};
use crate::docker_manager::resolve_compose_path;

// ── Stateful image registry ────────────────────────────────────────────────
//
// Entries match against the parsed `repo` field (always lowercase, with the
// `library/` prefix for Docker Hub official images). Substring match keeps the
// list short — e.g. `library/mysql` covers `mysql`, `mysql:8.0`, etc.

struct StatefulPattern {
    /// Substring that must appear in the parsed repo (e.g. `library/mysql`).
    repo_substr: &'static str,
    /// Container paths where this image stores persistent data. We look for any
    /// volume mounted at one of these (or a path that starts with one).
    data_paths: &'static [&'static str],
    /// When the user wants to jump majors, the recommended intermediate tag —
    /// e.g. MySQL forces upgrades to go through the last LTS. `cur_major` is
    /// the parsed major from the current tag; return None when no detour is
    /// known for that origin.
    intermediate_for_major: fn(cur_major: u64, target_major: u64) -> Option<&'static str>,
    /// Friendly name for messages.
    label: &'static str,
}

fn no_intermediate(_: u64, _: u64) -> Option<&'static str> {
    None
}

/// MySQL: only allowed to upgrade major version from the LAST LTS release.
/// 8.4 is LTS; 8.0.x → 9.x must stop at 8.4 first. 9.x → 10.x (when it lands)
/// will follow the same pattern, but we can only encode what's known today.
fn mysql_intermediate(cur_major: u64, target_major: u64) -> Option<&'static str> {
    if cur_major == 8 && target_major >= 9 {
        Some("8.4")
    } else {
        None
    }
}

/// Postgres: data dir is incompatible across majors. There is no in-place
/// upgrade — `pg_upgrade` is needed. We surface the warning but can't suggest
/// an intermediate tag that fixes anything.
fn postgres_intermediate(_: u64, _: u64) -> Option<&'static str> {
    None
}

const STATEFUL_IMAGES: &[StatefulPattern] = &[
    StatefulPattern {
        repo_substr: "library/mysql",
        data_paths: &["/var/lib/mysql"],
        intermediate_for_major: mysql_intermediate,
        label: "MySQL",
    },
    StatefulPattern {
        repo_substr: "library/mariadb",
        data_paths: &["/var/lib/mysql"],
        intermediate_for_major: no_intermediate,
        label: "MariaDB",
    },
    StatefulPattern {
        repo_substr: "library/postgres",
        data_paths: &["/var/lib/postgresql/data"],
        intermediate_for_major: postgres_intermediate,
        label: "PostgreSQL",
    },
    StatefulPattern {
        repo_substr: "library/mongo",
        data_paths: &["/data/db"],
        intermediate_for_major: no_intermediate,
        label: "MongoDB",
    },
    StatefulPattern {
        repo_substr: "library/redis",
        data_paths: &["/data"],
        intermediate_for_major: no_intermediate,
        label: "Redis",
    },
    StatefulPattern {
        repo_substr: "library/clickhouse-server",
        data_paths: &["/var/lib/clickhouse"],
        intermediate_for_major: no_intermediate,
        label: "ClickHouse",
    },
    StatefulPattern {
        repo_substr: "library/influxdb",
        data_paths: &["/var/lib/influxdb", "/var/lib/influxdb2"],
        intermediate_for_major: no_intermediate,
        label: "InfluxDB",
    },
    StatefulPattern {
        repo_substr: "minio/minio",
        data_paths: &["/data"],
        intermediate_for_major: no_intermediate,
        label: "MinIO",
    },
    StatefulPattern {
        repo_substr: "library/elasticsearch",
        data_paths: &["/usr/share/elasticsearch/data"],
        intermediate_for_major: no_intermediate,
        label: "Elasticsearch",
    },
    StatefulPattern {
        repo_substr: "opensearchproject/opensearch",
        data_paths: &["/usr/share/opensearch/data"],
        intermediate_for_major: no_intermediate,
        label: "OpenSearch",
    },
];

fn match_stateful(parsed: &ImageRef) -> Option<&'static StatefulPattern> {
    let repo = parsed.repo.to_ascii_lowercase();
    STATEFUL_IMAGES.iter().find(|p| repo.contains(p.repo_substr))
}

// ── Public types ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RiskLevel {
    /// No data at risk, or no actual change. Caller can proceed silently.
    Safe,
    /// Stateful image with a non-major change, OR a stateless image being
    /// pulled fresh. Show a confirm with backup recommended.
    Caution,
    /// Stateful image with a major bump (or mutable target on a stateful
    /// image) that has volumes attached AND/OR has dependents. Recommend
    /// snapshot + offer intermediate tag.
    Danger,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VolumeMount {
    /// Source as written in the compose / docker config (`cap_db`, `./data`,
    /// `/abs/path`).
    pub source: String,
    /// Container-side path.
    pub container_path: String,
    /// True when source is a docker named volume (no leading `/`, `.`, or `~`
    /// and no path separators).
    pub is_named: bool,
    /// True when the container_path matches a known data path for the image's
    /// stateful pattern.
    pub is_stateful_path: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateRisk {
    pub level: RiskLevel,
    /// Human-readable bullet points the UI can render verbatim.
    pub reasons: Vec<String>,
    /// Compose service names that depend on the target service. Empty for
    /// docker (single-container) apps.
    pub dependents: Vec<String>,
    /// Volumes attached to the target service (whether stateful or not — the
    /// UI needs the full list to render the snapshot toggle).
    pub volumes: Vec<VolumeMount>,
    /// Friendly name when image was matched against the stateful registry,
    /// e.g. "MySQL". `None` for stateless images.
    pub stateful_label: Option<String>,
    /// `true` when both current and target tags parse as semver and the
    /// majors differ. `None` when at least one tag is mutable / unparseable.
    pub is_major_bump: Option<bool>,
    /// Suggested intermediate tag the user should jump to first
    /// (e.g. mysql 8.0 → 8.4 → 9.x). `None` when no detour is known.
    pub recommend_intermediate_tag: Option<String>,
    /// True when the classifier thinks a snapshot would be wise. The frontend
    /// uses this to default the "snapshot first" toggle.
    pub recommend_snapshot: bool,
    /// Echo so the UI can show "old → new" without re-deriving.
    pub current_image: String,
    pub target_image: String,
}

// ── Helpers ────────────────────────────────────────────────────────────────

/// Parse a compose / docker volume spec like:
///   `cap_db:/var/lib/mysql`
///   `cap_db:/var/lib/mysql:ro`
///   `./data:/data`
///   `/abs/host:/data`
/// Returns `(source, container_path)`. Returns `None` for malformed entries.
fn parse_volume_spec(spec: &str) -> Option<(String, String)> {
    // Two or three colon-separated parts. The middle is always container_path.
    // Skip Windows-style absolute paths (`C:/foo:/data`) — Porta is mac-only,
    // not worth handling.
    let parts: Vec<&str> = spec.split(':').collect();
    match parts.len() {
        2 => Some((parts[0].to_string(), parts[1].to_string())),
        3 => Some((parts[0].to_string(), parts[1].to_string())),
        _ => None,
    }
}

fn is_named_volume(source: &str) -> bool {
    !source.is_empty()
        && !source.starts_with('/')
        && !source.starts_with('.')
        && !source.starts_with('~')
        && !source.contains('/')
        && !source.contains('\\')
}

fn matches_stateful_path(container_path: &str, data_paths: &[&str]) -> bool {
    data_paths.iter().any(|dp| {
        // Exact match OR container_path is a child of the data_path
        // (e.g. /var/lib/mysql/data still counts as "the mysql data dir").
        container_path == *dp
            || container_path.starts_with(&format!("{}/", dp))
    })
}

fn find_dependents(project: &ComposeProject, target_service: &str) -> Vec<String> {
    project
        .services
        .iter()
        .filter(|s| s.name != target_service && s.depends_on.iter().any(|d| d == target_service))
        .map(|s| s.name.clone())
        .collect()
}

/// Compare two semver-ish tags. Returns:
///   `Some(true)`  — both parse and majors differ
///   `Some(false)` — both parse and majors match
///   `None`        — one or both can't be parsed (mutable like `latest`, or
///                   non-semver tag like `alpine`).
fn is_major_bump(current_tag: &str, target_tag: &str) -> Option<bool> {
    let cur = parse_semver_first(current_tag)?;
    let tgt = parse_semver_first(target_tag)?;
    Some(cur != tgt)
}

/// Pull just the first numeric component from a tag (`1.25.3` → 1, `v8` → 8,
/// `8.0-alpine` → 8, `latest` → None, `alpine` → None).
fn parse_semver_first(tag: &str) -> Option<u64> {
    let bytes = tag.as_bytes();
    let mut i = 0;
    if i < bytes.len() && (bytes[i] == b'v' || bytes[i] == b'V') {
        i += 1;
    }
    let start = i;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    if i == start {
        return None;
    }
    tag[start..i].parse::<u64>().ok()
}

const MUTABLE_TAGS: &[&str] = &[
    "latest", "stable", "edge", "lts", "main", "master", "develop", "dev",
    "nightly", "rolling", "current", "release",
];

fn is_mutable_tag(tag: &str) -> bool {
    MUTABLE_TAGS.iter().any(|t| t.eq_ignore_ascii_case(tag))
}

// ── Tauri command ──────────────────────────────────────────────────────────

/// Classify an upcoming image update. Pass the same arguments you'd pass to
/// `update_app_images`:
///
/// - `service_name`: Some(name) for compose apps, None for single docker apps.
/// - `target_tag`: the tag the user wants to switch to. Pass `None` to assess
///   "re-pulling the same tag" (digest update on a mutable tag) — the level
///   will usually be Safe unless the image is stateful.
#[tauri::command]
pub fn classify_image_update(
    state: State<'_, AppState>,
    id: String,
    service_name: Option<String>,
    target_tag: Option<String>,
) -> Result<UpdateRisk, String> {
    let app = {
        let db = state.db.lock().unwrap();
        db.list_apps()
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|a| a.id == id)
            .ok_or_else(|| format!("app {} not found", id))?
    };

    if app.is_docker() {
        let image = app
            .docker_image
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| "docker app has no image".to_string())?;
        let parsed = parse_image_ref(image).ok_or_else(|| "invalid current image ref".to_string())?;
        let target_image = match &target_tag {
            Some(new_tag) => rebuild_with_tag(&parsed, new_tag),
            None => image.to_string(),
        };
        let volumes = parse_docker_volumes(&app.docker_volumes, &parsed);
        return Ok(build_risk(
            image,
            &target_image,
            &parsed,
            &target_tag,
            volumes,
            Vec::new(),
        ));
    }

    if app.is_compose() {
        let svc_name = service_name
            .as_ref()
            .ok_or_else(|| "compose app needs service_name".to_string())?
            .clone();
        let file = app
            .compose_file
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| "compose app has no compose file".to_string())?;
        let root = if app.root_dir.is_empty() { None } else { Some(app.root_dir.as_str()) };
        let resolved = resolve_compose_path(file, root);
        let project = parse_compose(&resolved).map_err(|e| format!("parse compose: {}", e))?;
        let svc = project
            .services
            .iter()
            .find(|s| s.name == svc_name)
            .ok_or_else(|| format!("service '{}' not found in compose", svc_name))?;
        let image = svc
            .image
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| format!("service '{}' has no image", svc_name))?;
        let parsed = parse_image_ref(image).ok_or_else(|| "invalid current image ref".to_string())?;
        let target_image = match &target_tag {
            Some(new_tag) => rebuild_with_tag(&parsed, new_tag),
            None => image.to_string(),
        };
        let volumes = parse_compose_volumes(&svc.volumes, &parsed);
        let dependents = find_dependents(&project, &svc_name);
        return Ok(build_risk(
            image,
            &target_image,
            &parsed,
            &target_tag,
            volumes,
            dependents,
        ));
    }

    Err("classify only supports docker / compose apps".into())
}

/// Build the risk struct from already-resolved inputs. Centralizing this means
/// the docker / compose paths above only differ in how they collect volumes
/// and dependents — the scoring logic is shared.
fn build_risk(
    current_image: &str,
    target_image: &str,
    parsed: &ImageRef,
    target_tag: &Option<String>,
    volumes: Vec<VolumeMount>,
    dependents: Vec<String>,
) -> UpdateRisk {
    let stateful = match_stateful(parsed);
    let stateful_label = stateful.map(|s| s.label.to_string());

    let stateful_volumes: Vec<&VolumeMount> = volumes.iter().filter(|v| v.is_stateful_path).collect();
    let has_persistent_data = !stateful_volumes.is_empty();

    let target_tag_str = target_tag.as_deref().unwrap_or(&parsed.tag);
    let is_target_mutable = is_mutable_tag(target_tag_str);
    let is_current_mutable = is_mutable_tag(&parsed.tag);
    let major_bump = is_major_bump(&parsed.tag, target_tag_str);

    let mut reasons: Vec<String> = Vec::new();
    let mut level = RiskLevel::Safe;

    if let Some(label) = stateful.map(|s| s.label) {
        if has_persistent_data {
            reasons.push(format!(
                "{} stores data in a persistent volume — pulling a different version may make it unreadable.",
                label
            ));
        }
    }

    match major_bump {
        Some(true) => {
            reasons.push(format!(
                "Major version change: `{}` → `{}`. Most stateful services don't support skipping majors.",
                parsed.tag, target_tag_str
            ));
            if stateful.is_some() && has_persistent_data {
                level = RiskLevel::Danger;
            } else {
                level = RiskLevel::Caution;
            }
        }
        Some(false) => {
            // Same major. If stateful + persistent volume, still warn caution
            // — minor bumps occasionally need data dir migrations too.
            if stateful.is_some() && has_persistent_data && parsed.tag != target_tag_str {
                reasons.push(format!(
                    "Minor / patch change: `{}` → `{}`. Usually safe, but a snapshot is cheap insurance.",
                    parsed.tag, target_tag_str
                ));
                level = level.max(RiskLevel::Caution);
            }
        }
        None => {
            // Mutable tag involved on either side — we can't predict the version.
            if (is_target_mutable || is_current_mutable) && stateful.is_some() && has_persistent_data {
                reasons.push(format!(
                    "Tag `{}` is mutable — the actual version can jump unexpectedly. With a stateful volume attached this can corrupt the data dir if the new image is a different major.",
                    if is_target_mutable { target_tag_str } else { parsed.tag.as_str() }
                ));
                level = level.max(RiskLevel::Danger);
            }
        }
    }

    if !dependents.is_empty() {
        reasons.push(format!(
            "{} other service{} wait{} for this one to be healthy: {}.",
            dependents.len(),
            if dependents.len() == 1 { "" } else { "s" },
            if dependents.len() == 1 { "s" } else { "" },
            dependents.join(", ")
        ));
        // Dependents alone don't escalate to danger, but a stuck DB blocking
        // the rest of the stack deserves at least a confirm.
        level = level.max(RiskLevel::Caution);
    }

    let recommend_intermediate_tag = match (stateful, parse_semver_first(&parsed.tag), parse_semver_first(target_tag_str)) {
        (Some(p), Some(cur_major), Some(tgt_major)) => {
            (p.intermediate_for_major)(cur_major, tgt_major).map(|s| s.to_string())
        }
        _ => None,
    };

    if let Some(ref intermediate) = recommend_intermediate_tag {
        reasons.push(format!(
            "Recommended path: jump to `{}` first to let the data dir auto-upgrade safely, then to `{}`.",
            intermediate, target_tag_str
        ));
    }

    if reasons.is_empty() {
        reasons.push("No data-loss signals detected.".to_string());
    }

    UpdateRisk {
        recommend_snapshot: matches!(level, RiskLevel::Caution | RiskLevel::Danger) && has_persistent_data,
        level,
        reasons,
        dependents,
        volumes,
        stateful_label,
        is_major_bump: major_bump,
        recommend_intermediate_tag,
        current_image: current_image.to_string(),
        target_image: target_image.to_string(),
    }
}

fn rebuild_with_tag(parsed: &ImageRef, new_tag: &str) -> String {
    // Mirror docker_updates::rebuild_image_ref but inline to avoid pub'ing it.
    let repo_display = if parsed.registry == "registry-1.docker.io" {
        parsed.repo.strip_prefix("library/").unwrap_or(&parsed.repo)
    } else {
        &parsed.repo
    };
    if parsed.registry == "registry-1.docker.io" {
        format!("{}:{}", repo_display, new_tag)
    } else {
        format!("{}/{}:{}", parsed.registry, repo_display, new_tag)
    }
}

fn parse_docker_volumes(specs: &[String], parsed: &ImageRef) -> Vec<VolumeMount> {
    let stateful = match_stateful(parsed);
    let data_paths: &[&str] = stateful.map(|s| s.data_paths).unwrap_or(&[]);
    specs
        .iter()
        .filter_map(|s| parse_volume_spec(s))
        .map(|(source, container_path)| {
            let is_stateful_path = matches_stateful_path(&container_path, data_paths);
            let is_named = is_named_volume(&source);
            VolumeMount { source, container_path, is_named, is_stateful_path }
        })
        .collect()
}

fn parse_compose_volumes(specs: &[String], parsed: &ImageRef) -> Vec<VolumeMount> {
    parse_docker_volumes(specs, parsed)
}

// PartialOrd impl for RiskLevel comparisons (`level.max(...)`).
impl PartialOrd for RiskLevel {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for RiskLevel {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        let rank = |l: &RiskLevel| match l {
            RiskLevel::Safe => 0,
            RiskLevel::Caution => 1,
            RiskLevel::Danger => 2,
        };
        rank(self).cmp(&rank(other))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pr(s: &str) -> ImageRef {
        parse_image_ref(s).expect("parse image ref")
    }

    #[test]
    fn matches_mysql_pattern() {
        let m = match_stateful(&pr("mysql:8.0")).expect("matched");
        assert_eq!(m.label, "MySQL");
    }

    #[test]
    fn matches_minio_pattern() {
        let m = match_stateful(&pr("minio/minio:latest")).expect("matched");
        assert_eq!(m.label, "MinIO");
    }

    #[test]
    fn does_not_match_random_image() {
        assert!(match_stateful(&pr("nginx:1.25")).is_none());
        assert!(match_stateful(&pr("ghcr.io/capsoftware/cap-web:latest")).is_none());
    }

    #[test]
    fn parses_volume_specs() {
        assert_eq!(
            parse_volume_spec("cap_db:/var/lib/mysql"),
            Some(("cap_db".into(), "/var/lib/mysql".into()))
        );
        assert_eq!(
            parse_volume_spec("cap_db:/var/lib/mysql:ro"),
            Some(("cap_db".into(), "/var/lib/mysql".into()))
        );
        assert_eq!(
            parse_volume_spec("./data:/data"),
            Some(("./data".into(), "/data".into()))
        );
        assert_eq!(parse_volume_spec("nopath"), None);
    }

    #[test]
    fn detects_named_vs_bind() {
        assert!(is_named_volume("cap_db"));
        assert!(is_named_volume("postgres-data-2"));
        assert!(!is_named_volume("./data"));
        assert!(!is_named_volume("/abs/path"));
        assert!(!is_named_volume("~/dir"));
        assert!(!is_named_volume("foo/bar"));
    }

    #[test]
    fn stateful_path_match_handles_subdirs() {
        assert!(matches_stateful_path("/var/lib/mysql", &["/var/lib/mysql"]));
        assert!(matches_stateful_path("/var/lib/mysql/data", &["/var/lib/mysql"]));
        assert!(!matches_stateful_path("/var/lib/mysqlfoo", &["/var/lib/mysql"]));
        assert!(!matches_stateful_path("/data", &["/var/lib/mysql"]));
    }

    #[test]
    fn semver_first_extracts_major() {
        assert_eq!(parse_semver_first("8.0.46"), Some(8));
        assert_eq!(parse_semver_first("8.0"), Some(8));
        assert_eq!(parse_semver_first("v9"), Some(9));
        assert_eq!(parse_semver_first("16-alpine"), Some(16));
        assert_eq!(parse_semver_first("latest"), None);
        assert_eq!(parse_semver_first("alpine"), None);
    }

    #[test]
    fn major_bump_detection() {
        assert_eq!(is_major_bump("8.0", "9.7"), Some(true));
        assert_eq!(is_major_bump("8.0.46", "9.7.0"), Some(true));
        assert_eq!(is_major_bump("8.0", "8.4"), Some(false));
        assert_eq!(is_major_bump("16-alpine", "17-alpine"), Some(true));
        // Either side mutable → we can't tell.
        assert_eq!(is_major_bump("8.0", "latest"), None);
        assert_eq!(is_major_bump("latest", "9.7"), None);
    }

    #[test]
    fn mysql_intermediate_recommends_lts() {
        assert_eq!(mysql_intermediate(8, 9), Some("8.4"));
        assert_eq!(mysql_intermediate(8, 10), Some("8.4"));
        // Same major or downgrade: no detour.
        assert_eq!(mysql_intermediate(8, 8), None);
        assert_eq!(mysql_intermediate(9, 10), None);
    }

    #[test]
    fn finds_dependents_in_compose() {
        let yaml = r#"
services:
  cap-web:
    image: ghcr.io/capsoftware/cap-web:latest
    depends_on:
      cap-db:
        condition: service_healthy
      cap-minio-init:
        condition: service_completed_successfully
  cap-db:
    image: mysql:8.0
  cap-minio:
    image: minio/minio:latest
  cap-minio-init:
    image: minio/mc:latest
    depends_on:
      - cap-minio
"#;
        let project = crate::compose_parser::parse_compose_str(yaml).unwrap();
        let dep_of_db = find_dependents(&project, "cap-db");
        assert_eq!(dep_of_db, vec!["cap-web"]);
        let dep_of_minio = find_dependents(&project, "cap-minio");
        assert_eq!(dep_of_minio, vec!["cap-minio-init"]);
        let dep_of_web = find_dependents(&project, "cap-web");
        assert!(dep_of_web.is_empty());
    }

    #[test]
    fn cap_scenario_is_danger() {
        // Reproduce the exact incident: mysql:8.0 → mysql:latest, with
        // /var/lib/mysql attached as a named volume, and cap-web depending
        // on cap-db.
        let parsed = pr("mysql:8.0");
        let volumes = parse_docker_volumes(
            &["cap_db:/var/lib/mysql".to_string()],
            &parsed,
        );
        let risk = build_risk(
            "mysql:8.0",
            "mysql:latest",
            &parsed,
            &Some("latest".into()),
            volumes,
            vec!["cap-web".into(), "cap-minio-init".into()],
        );
        assert_eq!(risk.level, RiskLevel::Danger);
        assert_eq!(risk.stateful_label.as_deref(), Some("MySQL"));
        assert!(risk.recommend_snapshot);
        // Mutable target on stateful image — we don't know if it's a major
        // bump (target tag doesn't parse as semver), so is_major_bump is None.
        assert_eq!(risk.is_major_bump, None);
        assert_eq!(risk.dependents.len(), 2);
        // The reasons list should mention the dependents and the mutable risk.
        assert!(risk.reasons.iter().any(|r| r.contains("mutable")));
        assert!(risk.reasons.iter().any(|r| r.contains("cap-web")));
    }

    #[test]
    fn cap_scenario_with_explicit_target_recommends_intermediate() {
        // Same volume situation, but user picked 9.x explicitly — we should
        // detect the major bump AND recommend 8.4 as the intermediate.
        let parsed = pr("mysql:8.0");
        let volumes = parse_docker_volumes(
            &["cap_db:/var/lib/mysql".to_string()],
            &parsed,
        );
        let risk = build_risk(
            "mysql:8.0",
            "mysql:9.7",
            &parsed,
            &Some("9.7".into()),
            volumes,
            vec![],
        );
        assert_eq!(risk.level, RiskLevel::Danger);
        assert_eq!(risk.is_major_bump, Some(true));
        assert_eq!(risk.recommend_intermediate_tag.as_deref(), Some("8.4"));
        assert!(risk.reasons.iter().any(|r| r.contains("8.4")));
    }

    #[test]
    fn stateless_image_is_safe() {
        let parsed = pr("nginx:1.25");
        let risk = build_risk(
            "nginx:1.25",
            "nginx:1.26",
            &parsed,
            &Some("1.26".into()),
            vec![],
            vec![],
        );
        assert_eq!(risk.level, RiskLevel::Safe);
        assert!(!risk.recommend_snapshot);
    }

    #[test]
    fn stateless_with_dependents_is_caution() {
        let parsed = pr("nginx:1.25");
        let risk = build_risk(
            "nginx:1.25",
            "nginx:1.26",
            &parsed,
            &Some("1.26".into()),
            vec![],
            vec!["api-worker".into()],
        );
        assert_eq!(risk.level, RiskLevel::Caution);
    }

    #[test]
    fn postgres_minor_bump_is_caution() {
        // Postgres 16.2 → 16.3: same major, but data dir lives in a named
        // volume — caution + snapshot recommended, but not danger.
        let parsed = pr("postgres:16.2");
        let volumes = parse_docker_volumes(
            &["pgdata:/var/lib/postgresql/data".to_string()],
            &parsed,
        );
        let risk = build_risk(
            "postgres:16.2",
            "postgres:16.3",
            &parsed,
            &Some("16.3".into()),
            volumes,
            vec![],
        );
        assert_eq!(risk.level, RiskLevel::Caution);
        assert!(risk.recommend_snapshot);
        // Postgres has no intermediate tag for major bumps (pg_upgrade only)
        // and we're not even doing a major bump here.
        assert_eq!(risk.recommend_intermediate_tag, None);
    }

    #[test]
    fn postgres_major_bump_is_danger_without_intermediate() {
        let parsed = pr("postgres:16");
        let volumes = parse_docker_volumes(
            &["pgdata:/var/lib/postgresql/data".to_string()],
            &parsed,
        );
        let risk = build_risk(
            "postgres:16",
            "postgres:17",
            &parsed,
            &Some("17".into()),
            volumes,
            vec![],
        );
        assert_eq!(risk.level, RiskLevel::Danger);
        assert_eq!(risk.is_major_bump, Some(true));
        // No safe in-place jump exists — pg_upgrade is the official path.
        assert_eq!(risk.recommend_intermediate_tag, None);
    }
}
