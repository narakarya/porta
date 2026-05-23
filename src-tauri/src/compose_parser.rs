use std::collections::HashMap;
use std::path::Path;
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
    // serde_yaml::Mapping preserves YAML declaration order. Compose authors
    // conventionally put the user-facing service first, so order is a stronger
    // primary-service signal than alphabetical name.
    services: Option<serde_yaml::Mapping>,
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
    let env = compose_env_for(Path::new(path));
    parse_compose_str_with_env(&content, &env)
}

pub fn parse_compose_str(content: &str) -> Result<ComposeProject, String> {
    parse_compose_str_with_env(content, &process_env_map())
}

/// Parse compose YAML, expanding `${VAR}` / `${VAR:-default}` references
/// against `env` first. Caller is responsible for assembling `env` (typically:
/// `.env` next to the compose file, overlaid by process env, like Docker
/// Compose itself). Use `parse_compose` if you have a path on disk.
pub fn parse_compose_str_with_env(
    content: &str,
    env: &HashMap<String, String>,
) -> Result<ComposeProject, String> {
    let expanded = expand_env_vars(content, env);
    let raw: RawCompose = serde_yaml::from_str(&expanded)
        .map_err(|e| format!("Failed to parse YAML: {}", e))?;

    let raw_services = raw.services.unwrap_or_default();

    let mut services: Vec<ComposeService> = Vec::with_capacity(raw_services.len());
    for (key, val) in raw_services {
        let name = match key.as_str() {
            Some(s) if !s.is_empty() => s.to_string(),
            _ => continue,
        };
        let svc: RawService = serde_yaml::from_value(val)
            .map_err(|e| format!("Failed to parse service '{}': {}", name, e))?;
        services.push(parse_service(name, svc));
    }

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
        .filter_map(|v| {
            let parsed = parse_port_mapping(&v);
            if parsed.is_none() {
                // Used to silently drop values like "${LIVEBOOK_PORT:-8090}:8080"
                // when env var expansion was skipped. Log so future regressions
                // surface in the dev console instead of producing 502s downstream.
                eprintln!("[compose_parser] dropped unparsable port mapping in service '{}': {:?}", name, v);
            }
            parsed
        })
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

// ── Env var loading & substitution ──────────────────────────────────────────
//
// Docker Compose auto-loads `.env` from the compose file's directory and
// expands `${VAR}` / `${VAR:-default}` references in the YAML before parsing.
// Without this, port mappings like `"${LIVEBOOK_PORT:-8090}:8080"` parse as a
// non-numeric string, get dropped by `parse_port_string`, and the service
// looks portless to Porta — which then allocates its own host port and sets
// up a Caddy upstream that doesn't match what the container actually exposes.

/// Build the env map Porta uses to expand a compose file at `compose_path`.
/// Mirrors Docker Compose precedence: `.env` next to the compose file is the
/// base, process env wins on conflict.
fn compose_env_for(compose_path: &Path) -> HashMap<String, String> {
    let mut env = compose_path
        .parent()
        .map(|dir| dir.join(".env"))
        .filter(|p| p.exists())
        .and_then(|p| std::fs::read_to_string(&p).ok())
        .map(|s| parse_dotenv_str(&s))
        .unwrap_or_default();
    for (k, v) in std::env::vars() {
        env.insert(k, v);
    }
    env
}

fn process_env_map() -> HashMap<String, String> {
    std::env::vars().collect()
}

/// Minimal `.env` parser: `KEY=VALUE` per line, `#` comments, optional
/// surrounding quotes on the value. Not a full POSIX shell parser — Compose's
/// own `.env` reader is similarly conservative.
fn parse_dotenv_str(content: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for raw_line in content.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        // Allow `export FOO=bar` for shells-style files.
        let line = line.strip_prefix("export ").unwrap_or(line).trim_start();
        let Some((key, value)) = line.split_once('=') else { continue };
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        // Strip a single matched pair of surrounding quotes if present.
        let value = value.trim();
        let value = if (value.starts_with('"') && value.ends_with('"') && value.len() >= 2)
            || (value.starts_with('\'') && value.ends_with('\'') && value.len() >= 2)
        {
            &value[1..value.len() - 1]
        } else {
            // Trim trailing inline comment for unquoted values.
            value.split('#').next().unwrap_or(value).trim_end()
        };
        out.insert(key.to_string(), value.to_string());
    }
    out
}

/// Expand `${VAR}`, `${VAR:-default}`, `${VAR-default}`, `${VAR:?msg}`,
/// `${VAR?msg}`, and `$VAR` references against `env`. `$$` escapes a literal
/// `$`. Unknown / unset variables resolve to empty (with a warning) — Porta is
/// a read-only inspector, not an executor, so we don't fail loud on the `?`
/// error forms; the user will see the missing var via the warning.
fn expand_env_vars(input: &str, env: &HashMap<String, String>) -> String {
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < bytes.len() {
        // Copy any run up to the next `$` verbatim. Slicing on a `$` boundary
        // is safe because `$` is ASCII (0x24) and never appears inside a
        // UTF-8 multi-byte sequence — `as char` would otherwise mangle e.g.
        // `≥` (e2 89 a5) into individual Latin-1 codepoints, one of which
        // (U+0089) is a C1 control char and trips serde_yaml's parser.
        let chunk_end = bytes[i..]
            .iter()
            .position(|&b| b == b'$')
            .map(|p| p + i)
            .unwrap_or(bytes.len());
        if chunk_end > i {
            out.push_str(&input[i..chunk_end]);
            i = chunk_end;
            if i >= bytes.len() {
                break;
            }
        }
        // c == '$'
        if i + 1 >= bytes.len() {
            out.push('$');
            i += 1;
            continue;
        }
        let next = bytes[i + 1];
        if next == b'$' {
            // `$$` → literal `$`
            out.push('$');
            i += 2;
            continue;
        }
        if next == b'{' {
            // `${...}` form. Find matching `}`. Compose doesn't support
            // nested braces, so a simple scan is sufficient.
            if let Some(end_rel) = input[i + 2..].find('}') {
                let inner = &input[i + 2..i + 2 + end_rel];
                out.push_str(&resolve_braced(inner, env));
                i += 2 + end_rel + 1;
                continue;
            } else {
                // Unterminated — leave as-is.
                out.push('$');
                i += 1;
                continue;
            }
        }
        // `$VAR` bare form: read identifier chars [A-Za-z_][A-Za-z0-9_]*
        if next.is_ascii_alphabetic() || next == b'_' {
            let start = i + 1;
            let mut j = start;
            while j < bytes.len() {
                let b = bytes[j];
                if b.is_ascii_alphanumeric() || b == b'_' {
                    j += 1;
                } else {
                    break;
                }
            }
            let key = &input[start..j];
            match env.get(key) {
                Some(v) => out.push_str(v),
                None => {
                    eprintln!("[compose_parser] env var '{}' not set; expanding to empty", key);
                }
            }
            i = j;
            continue;
        }
        // `$` followed by something else → literal.
        out.push('$');
        i += 1;
    }
    out
}

/// Resolve the inner part of a `${...}` expression. Supports:
///   `VAR`            → value or empty (with warning)
///   `VAR:-default`   → value if set & non-empty, else `default`
///   `VAR-default`    → value if set (even empty), else `default`
///   `VAR:?msg`       → value if set & non-empty, else empty + warning
///   `VAR?msg`        → value if set, else empty + warning
fn resolve_braced(inner: &str, env: &HashMap<String, String>) -> String {
    // Find the first operator (`:-`, `-`, `:?`, `?`). We scan manually so
    // `:-` is preferred over `-` and only the operator that appears first
    // wins.
    let bytes = inner.as_bytes();
    let mut op_at: Option<(usize, &'static str)> = None;
    for k in 0..bytes.len() {
        match bytes[k] {
            b':' if k + 1 < bytes.len() && (bytes[k + 1] == b'-' || bytes[k + 1] == b'?') => {
                let op = if bytes[k + 1] == b'-' { ":-" } else { ":?" };
                op_at = Some((k, op));
                break;
            }
            b'-' | b'?' if k > 0 => {
                let op = if bytes[k] == b'-' { "-" } else { "?" };
                op_at = Some((k, op));
                break;
            }
            _ => {}
        }
    }

    let (key, op, rest) = match op_at {
        Some((k, op)) => (&inner[..k], op, &inner[k + op.len()..]),
        None => (inner, "", ""),
    };
    let key = key.trim();

    match op {
        "" => match env.get(key) {
            Some(v) => v.clone(),
            None => {
                eprintln!("[compose_parser] env var '{}' not set; expanding to empty", key);
                String::new()
            }
        },
        ":-" => match env.get(key) {
            Some(v) if !v.is_empty() => v.clone(),
            _ => rest.to_string(),
        },
        "-" => match env.get(key) {
            Some(v) => v.clone(),
            None => rest.to_string(),
        },
        ":?" => match env.get(key) {
            Some(v) if !v.is_empty() => v.clone(),
            _ => {
                eprintln!("[compose_parser] env var '{}' required ({}); expanding to empty", key, rest);
                String::new()
            }
        },
        "?" => match env.get(key) {
            Some(v) => v.clone(),
            None => {
                eprintln!("[compose_parser] env var '{}' required ({}); expanding to empty", key, rest);
                String::new()
            }
        },
        _ => String::new(),
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

    #[test]
    fn services_preserve_declaration_order() {
        // Cap-style stack: web service declared first, MinIO/storage later.
        // Default-port pickers in the UI rely on declaration order.
        let yaml = r#"
services:
  cap-web:
    image: ghcr.io/capsoftware/cap-web:latest
    ports: ["3000:3000"]
  cap-db:
    image: mysql:8.0
  cap-minio:
    image: minio/minio:latest
    ports: ["9000:9000", "9001:9001"]
"#;
        let proj = parse_compose_str(yaml).expect("parse");
        let names: Vec<&str> = proj.services.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["cap-web", "cap-db", "cap-minio"]);
        // First service-with-ports is the web app, not alphabetically-first cap-minio.
        let first_with_ports = proj.services.iter().find(|s| !s.ports.is_empty()).unwrap();
        assert_eq!(first_with_ports.name, "cap-web");
        assert_eq!(first_with_ports.ports[0], (3000, 3000));
    }

    // ── env substitution ──

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn expands_braced_default_when_unset() {
        // The livebook regression: `${VAR:-default}` in a port mapping must
        // resolve to the default when the env is empty, otherwise the port
        // gets silently dropped and Porta picks its own host port.
        let yaml = r#"
services:
  livebook:
    image: livebook
    ports: ["${LIVEBOOK_PORT:-8090}:8080"]
"#;
        let proj = parse_compose_str_with_env(yaml, &HashMap::new()).expect("parse");
        let livebook = &proj.services[0];
        assert_eq!(livebook.ports, vec![(8090, 8080)]);
    }

    #[test]
    fn env_value_overrides_default() {
        let yaml = r#"
services:
  app:
    image: app
    ports: ["${PORT:-8080}:80"]
"#;
        let proj = parse_compose_str_with_env(yaml, &env(&[("PORT", "9999")])).expect("parse");
        assert_eq!(proj.services[0].ports, vec![(9999, 80)]);
    }

    #[test]
    fn empty_env_value_falls_back_for_colon_dash_but_not_dash() {
        // `:-` treats empty as unset; `-` treats empty as set.
        let yaml_colon = r#"
services:
  a:
    image: x
    ports: ["${P:-7000}:80"]
"#;
        let proj = parse_compose_str_with_env(yaml_colon, &env(&[("P", "")])).expect("parse");
        assert_eq!(proj.services[0].ports, vec![(7000, 80)]);

        // Without the colon: empty wins → port string "<empty>:80" → drops.
        let yaml_dash = r#"
services:
  a:
    image: x
    ports: ["${P-7000}:80"]
"#;
        let proj = parse_compose_str_with_env(yaml_dash, &env(&[("P", "")])).expect("parse");
        assert!(proj.services[0].ports.is_empty());
    }

    #[test]
    fn bare_dollar_var_form() {
        let yaml = r#"
services:
  a:
    image: x
    ports:
      - "$HOST_PORT:80"
"#;
        let proj = parse_compose_str_with_env(yaml, &env(&[("HOST_PORT", "4321")])).expect("parse");
        assert_eq!(proj.services[0].ports, vec![(4321, 80)]);
    }

    #[test]
    fn double_dollar_escapes_to_literal() {
        // `$$` should become a literal `$` in the output (compose convention).
        // Use it inside an environment value and check it survives expansion.
        let yaml = r#"
services:
  a:
    image: x
    environment:
      PRICE: "$$5"
"#;
        let proj = parse_compose_str_with_env(yaml, &HashMap::new()).expect("parse");
        assert_eq!(proj.services[0].environment.get("PRICE").map(|s| s.as_str()), Some("$5"));
    }

    #[test]
    fn unterminated_brace_left_as_literal() {
        // `${FOO` with no closing brace shouldn't blow up parsing.
        let yaml = r#"
services:
  a:
    image: x
    environment:
      WEIRD: "literal-${FOO"
"#;
        let proj = parse_compose_str_with_env(yaml, &HashMap::new()).expect("parse");
        assert_eq!(
            proj.services[0].environment.get("WEIRD").map(|s| s.as_str()),
            Some("literal-${FOO")
        );
    }

    // ── .env loader ──

    #[test]
    fn dotenv_basic_kv() {
        let s = "FOO=bar\nBAZ=qux\n";
        let m = parse_dotenv_str(s);
        assert_eq!(m.get("FOO").map(|s| s.as_str()), Some("bar"));
        assert_eq!(m.get("BAZ").map(|s| s.as_str()), Some("qux"));
    }

    #[test]
    fn dotenv_strips_quotes_and_comments() {
        let s = r#"
# a comment
FOO="hello world"
BAR='single quoted'
BAZ=plain # trailing comment
EMPTY=
export EXPORTED=ok
"#;
        let m = parse_dotenv_str(s);
        assert_eq!(m.get("FOO").map(|s| s.as_str()), Some("hello world"));
        assert_eq!(m.get("BAR").map(|s| s.as_str()), Some("single quoted"));
        assert_eq!(m.get("BAZ").map(|s| s.as_str()), Some("plain"));
        assert_eq!(m.get("EMPTY").map(|s| s.as_str()), Some(""));
        assert_eq!(m.get("EXPORTED").map(|s| s.as_str()), Some("ok"));
    }

    #[test]
    fn dotenv_skips_blank_and_malformed_lines() {
        let s = "\n\n=novalue\nNOVAL\nGOOD=1\n";
        let m = parse_dotenv_str(s);
        assert_eq!(m.len(), 1);
        assert_eq!(m.get("GOOD").map(|s| s.as_str()), Some("1"));
    }

    #[test]
    fn parse_compose_loads_dotenv_from_compose_dir() {
        // End-to-end: drop a compose + .env in a temp dir, parse via the
        // path-based entry point, and confirm the .env value drove port choice.
        use std::io::Write;
        let dir = std::env::temp_dir().join(format!("porta-compose-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let compose_path = dir.join("docker-compose.yml");
        let env_path = dir.join(".env");
        std::fs::File::create(&env_path)
            .unwrap()
            .write_all(b"LIVEBOOK_PORT=3016\n")
            .unwrap();
        std::fs::File::create(&compose_path)
            .unwrap()
            .write_all(
                b"services:\n  livebook:\n    image: livebook\n    ports:\n      - \"${LIVEBOOK_PORT:-8090}:8080\"\n",
            )
            .unwrap();

        let proj = parse_compose(compose_path.to_str().unwrap()).expect("parse");
        assert_eq!(proj.services[0].ports, vec![(3016, 8080)]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn expand_env_vars_preserves_utf8_in_comments() {
        // Regression: byte-by-byte `as char` cast turned UTF-8 sequences like
        // `≥` (e2 89 a5) into Latin-1 codepoints, one of which (U+0089) is a
        // C1 control char that serde_yaml rejects with "control characters
        // are not allowed at position N".
        let yaml = "services:\n  web:\n    image: nginx\n    # NocoDB ≥ 0.301.4 — em dash too\n";
        let env = HashMap::new();
        let out = expand_env_vars(yaml, &env);
        assert_eq!(out, yaml, "expand_env_vars must preserve UTF-8 verbatim");
        // And the result must still parse as YAML.
        parse_compose_str(yaml).expect("UTF-8 comments must parse");
    }
}
