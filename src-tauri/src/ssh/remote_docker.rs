//! Read-only view of Docker on a remote host, over an existing SSH session.
//!
//! Read-only is the whole design, not a first milestone. Porta's Docker tooling
//! was built for a laptop: Caddy dials `127.0.0.1`, ports are picked by binding
//! a local socket, snapshots bind-mount a local directory. Pointed at a real
//! server, the *scoped* operations quietly no-op (they filter on Porta's own
//! compose project label) while the unscoped destructive one — `image prune
//! -af` — works perfectly. So this module can look and cannot touch: there is
//! no start, stop, pull, prune or restart here to be reached by accident.
//!
//! What it does give you is the thing the terminal is bad at: knowing that a
//! host is three versions behind, and that one of those is a major bump on a
//! database with dependents.

use serde::{Deserialize, Serialize};

use crate::ssh::engine::Transport;

/// `docker ps` can be slow on a loaded host, but not minutes-slow.
const PS_TIMEOUT_SECS: u64 = 20;

/// One container running on the remote host.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteContainer {
    pub name: String,
    /// Image reference as the daemon reports it, e.g. `ghcr.io/org/api:1.4.2`.
    pub image: String,
    /// Human status line, e.g. `Up 3 days`.
    pub status: String,
    /// `running`, `exited`, … — the machine-readable half of `status`.
    pub state: String,
    /// Compose project, when the container carries the label. Lets the UI group
    /// a stack the way `docker compose ps` would.
    pub project: Option<String>,
    /// Digests the remote daemon has for this image, used to decide whether a
    /// registry push is actually newer than what is running.
    #[serde(skip)]
    pub digests: Vec<String>,
}

/// `docker ps --format '{{json .}}'` emits one JSON object per line. Only the
/// fields we use are declared; the rest of the (large) object is ignored.
#[derive(Deserialize)]
struct PsLine {
    #[serde(rename = "Names")]
    names: Option<String>,
    #[serde(rename = "Image")]
    image: Option<String>,
    #[serde(rename = "Status")]
    status: Option<String>,
    #[serde(rename = "State")]
    state: Option<String>,
    #[serde(rename = "Labels")]
    labels: Option<String>,
}

/// Pull the compose project out of `docker ps`'s flattened label string, which
/// is `k=v,k=v,…` with no escaping.
pub(crate) fn compose_project(labels: &str) -> Option<String> {
    labels
        .split(',')
        .filter_map(|kv| kv.split_once('='))
        .find(|(k, _)| *k == "com.docker.compose.project")
        .map(|(_, v)| v.to_string())
}

/// Parse the output of `docker ps --format '{{json .}}'`.
///
/// Tolerant by design: a single unparseable line is skipped rather than failing
/// the whole listing. Docker's JSON field set differs across versions, and one
/// odd container should not blank the view.
pub(crate) fn parse_ps(stdout: &str) -> Vec<RemoteContainer> {
    stdout
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<PsLine>(l).ok())
        .filter_map(|l| {
            let image = l.image?;
            Some(RemoteContainer {
                name: l.names.unwrap_or_default(),
                status: l.status.unwrap_or_default(),
                state: l.state.unwrap_or_default(),
                project: l.labels.as_deref().and_then(compose_project),
                image,
                digests: Vec::new(),
            })
        })
        .collect()
}

/// Parse `docker image inspect --format '{{json .RepoDigests}}'`, which prints
/// one JSON array per image, in the order the images were asked for.
pub(crate) fn parse_digest_lines(stdout: &str) -> Vec<Vec<String>> {
    stdout
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str::<Vec<String>>(l).unwrap_or_default())
        .collect()
}

/// A `repo@sha256:…` entry reduced to the bare digest.
pub(crate) fn digest_of(repo_digest: &str) -> Option<String> {
    repo_digest.split_once('@').map(|(_, d)| d.to_string())
}

/// List the containers running on the far side, with the digests their images
/// resolve to on that host.
pub async fn list_containers(transport: &Transport) -> Result<Vec<RemoteContainer>, String> {
    // `command -v docker` first so a host without Docker says so plainly
    // instead of surfacing a shell's "not found" as a parse failure.
    let probe = transport
        .exec("command -v docker >/dev/null 2>&1 && echo yes || echo no", 10)
        .await?;
    if probe.trim() != "yes" {
        return Err("No docker command on this host (or it isn't on the login PATH).".into());
    }

    let ps = transport
        .exec("docker ps --format '{{json .}}'", PS_TIMEOUT_SECS)
        .await?;
    let mut containers = parse_ps(&ps);
    if containers.is_empty() {
        return Ok(containers);
    }

    // One inspect for every distinct image, in a stable order so the reply
    // lines can be matched back positionally.
    let mut images: Vec<String> = containers.iter().map(|c| c.image.clone()).collect();
    images.sort();
    images.dedup();

    // Shell-quote each ref: image names are daemon-supplied and a crafted one
    // must not become shell syntax.
    let args = images
        .iter()
        .map(|i| format!("'{}'", i.replace('\'', r"'\''")))
        .collect::<Vec<_>>()
        .join(" ");
    let inspect = transport
        .exec(
            &format!("docker image inspect --format '{{{{json .RepoDigests}}}}' {args}"),
            PS_TIMEOUT_SECS,
        )
        .await
        .unwrap_or_default();

    let per_image = parse_digest_lines(&inspect);
    for (image, digests) in images.iter().zip(per_image.into_iter()) {
        let parsed: Vec<String> = digests.iter().filter_map(|d| digest_of(d)).collect();
        for c in containers.iter_mut().filter(|c| &c.image == image) {
            c.digests = parsed.clone();
        }
    }
    Ok(containers)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_docker_ps_line() {
        let out = r#"{"Command":"'/docker-entrypoint.sh'","CreatedAt":"2026-07-01 10:00:00 +0700 WIB","ID":"abc123","Image":"ghcr.io/org/api:1.4.2","Labels":"com.docker.compose.project=shop,com.docker.compose.service=api","Names":"shop-api-1","State":"running","Status":"Up 3 days"}"#;
        let got = parse_ps(out);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].name, "shop-api-1");
        assert_eq!(got[0].image, "ghcr.io/org/api:1.4.2");
        assert_eq!(got[0].state, "running");
        assert_eq!(got[0].project.as_deref(), Some("shop"));
    }

    #[test]
    fn one_bad_line_does_not_blank_the_listing() {
        // Docker's JSON field set moves between versions; a single odd line
        // must not cost the user the whole view.
        let out = "not json at all\n\
                   {\"Image\":\"nginx:1.27\",\"Names\":\"web\",\"State\":\"running\",\"Status\":\"Up 1 hour\"}\n";
        let got = parse_ps(out);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].image, "nginx:1.27");
        // Absent Labels must not be an error, just no project.
        assert_eq!(got[0].project, None);
    }

    #[test]
    fn a_line_without_an_image_is_useless_and_dropped() {
        let out = r#"{"Names":"ghost","State":"running"}"#;
        assert!(parse_ps(out).is_empty());
    }

    #[test]
    fn compose_project_is_read_out_of_the_flat_label_string() {
        assert_eq!(
            compose_project("com.docker.compose.service=db,com.docker.compose.project=shop"),
            Some("shop".into())
        );
        assert_eq!(compose_project("maintainer=someone"), None);
        assert_eq!(compose_project(""), None);
    }

    #[test]
    fn digests_are_reduced_to_the_bare_hash() {
        assert_eq!(
            digest_of("nginx@sha256:abc"),
            Some("sha256:abc".to_string())
        );
        // A RepoDigest without an @ is malformed; drop it rather than invent one.
        assert_eq!(digest_of("nginx"), None);
    }

    #[test]
    fn digest_lines_survive_an_image_with_no_repo_digests() {
        // A locally-built image has `[]` — that is not an error, it just means
        // there is nothing to compare against a registry.
        let out = "[\"nginx@sha256:aaa\"]\n[]\n[\"ghcr.io/org/api@sha256:bbb\"]\n";
        let got = parse_digest_lines(out);
        assert_eq!(got.len(), 3);
        assert_eq!(got[0], vec!["nginx@sha256:aaa".to_string()]);
        assert!(got[1].is_empty());
    }
}
