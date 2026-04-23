use std::collections::HashMap;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct ComposeService {
    pub name: String,
    pub image: Option<String>,
    pub build_context: Option<String>,
    pub ports: Vec<(u16, u16)>,
    pub environment: HashMap<String, String>,
    pub volumes: Vec<String>,
    pub depends_on: Vec<String>,
    pub command: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ComposeProject {
    pub services: Vec<ComposeService>,
}

// ── Raw YAML shapes ─────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct RawCompose {
    services: Option<HashMap<String, RawService>>,
}

#[derive(Deserialize)]
struct RawService {
    image: Option<String>,
    build: Option<RawBuild>,
    ports: Option<Vec<serde_yaml::Value>>,
    environment: Option<RawEnvironment>,
    volumes: Option<Vec<String>>,
    depends_on: Option<RawDependsOn>,
    command: Option<RawCommand>,
}

/// `build:` can be a plain string (the context path) or a mapping with a `context` key.
#[derive(Deserialize)]
#[serde(untagged)]
enum RawBuild {
    Simple(String),
    Extended { context: Option<String> },
}

/// `environment:` can be a list of "KEY=VALUE" strings or a mapping.
#[derive(Deserialize)]
#[serde(untagged)]
enum RawEnvironment {
    List(Vec<String>),
    Map(HashMap<String, serde_yaml::Value>),
}

/// `depends_on:` can be a list of strings or a mapping (with condition keys).
#[derive(Deserialize)]
#[serde(untagged)]
enum RawDependsOn {
    List(Vec<String>),
    Map(HashMap<String, serde_yaml::Value>),
}

/// `command:` can be a single string or a list of strings.
#[derive(Deserialize)]
#[serde(untagged)]
enum RawCommand {
    Single(String),
    List(Vec<String>),
}

// ── Public API ──────────────────────────────────────────────────────────────

pub fn parse_compose(path: &str) -> Result<ComposeProject, String> {
    let content = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read {}: {}", path, e))?;
    parse_compose_str(&content)
}

pub fn parse_compose_str(content: &str) -> Result<ComposeProject, String> {
    let raw: RawCompose = serde_yaml::from_str(content)
        .map_err(|e| format!("Failed to parse YAML: {}", e))?;

    let raw_services = raw.services.unwrap_or_default();

    let mut services: Vec<ComposeService> = raw_services
        .into_iter()
        .map(|(name, svc)| parse_service(name, svc))
        .collect();

    // Sort by name for stable ordering
    services.sort_by(|a, b| a.name.cmp(&b.name));

    Ok(ComposeProject { services })
}

fn parse_service(name: String, svc: RawService) -> ComposeService {
    let build_context = svc.build.map(|b| match b {
        RawBuild::Simple(s) => s,
        RawBuild::Extended { context } => context.unwrap_or_else(|| ".".into()),
    });

    let ports = svc
        .ports
        .unwrap_or_default()
        .into_iter()
        .filter_map(|v| parse_port_mapping(&v))
        .collect();

    let environment = match svc.environment {
        Some(RawEnvironment::List(list)) => {
            let mut map = HashMap::new();
            for entry in list {
                if let Some((k, v)) = entry.split_once('=') {
                    map.insert(k.to_string(), v.to_string());
                } else {
                    // KEY without value — treat as empty
                    map.insert(entry, String::new());
                }
            }
            map
        }
        Some(RawEnvironment::Map(m)) => m
            .into_iter()
            .map(|(k, v)| {
                let val = match v {
                    serde_yaml::Value::String(s) => s,
                    serde_yaml::Value::Number(n) => n.to_string(),
                    serde_yaml::Value::Bool(b) => b.to_string(),
                    serde_yaml::Value::Null => String::new(),
                    other => format!("{:?}", other),
                };
                (k, val)
            })
            .collect(),
        None => HashMap::new(),
    };

    let volumes = svc.volumes.unwrap_or_default();

    let depends_on = match svc.depends_on {
        Some(RawDependsOn::List(list)) => list,
        Some(RawDependsOn::Map(m)) => m.into_keys().collect(),
        None => Vec::new(),
    };

    let command = svc.command.map(|c| match c {
        RawCommand::Single(s) => s,
        RawCommand::List(parts) => parts.join(" "),
    });

    ComposeService {
        name,
        image: svc.image,
        build_context,
        ports,
        environment,
        volumes,
        depends_on,
        command,
    }
}

/// Parse a port mapping value. Supports "HOST:CONTAINER", "CONTAINER", and numeric forms.
fn parse_port_mapping(val: &serde_yaml::Value) -> Option<(u16, u16)> {
    match val {
        serde_yaml::Value::String(s) => parse_port_string(s),
        serde_yaml::Value::Number(n) => {
            let port = n.as_u64()? as u16;
            Some((port, port))
        }
        _ => None,
    }
}

fn parse_port_string(s: &str) -> Option<(u16, u16)> {
    // Strip protocol suffix like "/tcp" or "/udp"
    let s = s.split('/').next().unwrap_or(s);

    if let Some((host_part, container)) = s.rsplit_once(':') {
        // Could be "HOST:CONTAINER" or "IP:HOST:CONTAINER"
        let container: u16 = container.parse().ok()?;
        // Take the last segment before ':' as host port (handles 0.0.0.0:8080:80)
        let host_str = host_part.rsplit(':').next().unwrap_or(host_part);
        let host: u16 = host_str.parse().ok()?;
        Some((host, container))
    } else {
        let port: u16 = s.parse().ok()?;
        Some((port, port))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_port_string() {
        assert_eq!(parse_port_string("8080:80"), Some((8080, 80)));
        assert_eq!(parse_port_string("3000"), Some((3000, 3000)));
        assert_eq!(parse_port_string("0.0.0.0:5432:5432"), Some((5432, 5432)));
        assert_eq!(parse_port_string("8080:80/tcp"), Some((8080, 80)));
    }
}
