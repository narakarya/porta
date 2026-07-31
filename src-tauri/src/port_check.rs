use serde::Serialize;
use std::process::Command;

#[derive(Debug, Serialize)]
pub struct PortCheckResult {
    pub available: bool,
    pub pid: Option<u32>,
    pub process_name: Option<String>,
}

/// Check whether a TCP port is currently in use (i.e. something LISTENS on it).
/// Uses `lsof` to find the holding PID, then `ps` to resolve the process name.
///
/// `-sTCP:LISTEN` matters: without it any process with a mere connection
/// touching the port matched — a browser's half-closed socket to a dead dev
/// server, Caddy's upstream dial — and the UI reported "port in use" for a
/// port that was actually free, naming an innocent PID for the user to kill.
pub fn check_port(port: u16) -> PortCheckResult {
    // lsof -nP -ti tcp:{port} -sTCP:LISTEN  →  listener PIDs, one per line
    let lsof = Command::new("lsof")
        .args(["-nP", "-ti", &format!("tcp:{port}"), "-sTCP:LISTEN"])
        .output();

    let pid = match lsof {
        Ok(out) if out.status.success() => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            stdout
                .lines()
                .next()
                .and_then(|line| line.trim().parse::<u32>().ok())
        }
        _ => None,
    };

    let Some(pid) = pid else {
        return PortCheckResult {
            available: true,
            pid: None,
            process_name: None,
        };
    };

    // ps -p {pid} -o comm=  →  prints the process name
    let process_name = Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "comm="])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty());

    PortCheckResult {
        available: false,
        pid: Some(pid),
        process_name,
    }
}
