use serde::Serialize;
use std::process::Command;

#[derive(Debug, Serialize)]
pub struct PortCheckResult {
    pub available: bool,
    pub pid: Option<u32>,
    pub process_name: Option<String>,
}

/// Check whether a TCP port is currently in use.
/// Uses `lsof` to find the holding PID, then `ps` to resolve the process name.
pub fn check_port(port: u16) -> PortCheckResult {
    // lsof -i :{port} -t  →  prints PIDs (one per line) holding the port
    let lsof = Command::new("lsof")
        .args(["-i", &format!(":{port}"), "-t"])
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
