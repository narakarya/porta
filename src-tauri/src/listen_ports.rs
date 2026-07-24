use std::process::Command;

use crate::process_manager::descendant_pids;

/// Every TCP port the process tree rooted at `root_pid` is LISTENing on,
/// deduplicated and ascending.
///
/// Porta exports `PORT` when it spawns an app, but plenty of stacks ignore it:
/// Phoenix reads `config/dev.exs`, Vite reads `vite.config.ts`, Rails takes
/// `-p`. Those apps run perfectly well on a port Porta never hears about — and
/// then every probe against the configured port fails, so the app reads as
/// unhealthy/down while it is in fact serving. Asking the OS what the process
/// actually bound is the only reliable answer.
pub fn listening_ports(root_pid: u32) -> Vec<u16> {
    let mut pids = vec![root_pid];
    pids.extend(descendant_pids(root_pid));
    pids.sort_unstable();
    pids.dedup();

    // -Fn asks lsof for machine-readable field output; we only care about the
    // `n` (name) records, which look like `n*:4000` / `n127.0.0.1:4000` /
    // `n[::1]:4000`.
    let arg = pids
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",");
    let output = Command::new("lsof")
        .args(["-a", "-p", &arg, "-iTCP", "-sTCP:LISTEN", "-P", "-n", "-Fn"])
        .output();

    // lsof exits non-zero when *some* pid is gone even though it printed usable
    // rows for the rest, so the status is deliberately not checked.
    let Ok(out) = output else { return Vec::new() };
    let stdout = String::from_utf8_lossy(&out.stdout);

    let mut ports: Vec<u16> = stdout
        .lines()
        .filter_map(|l| l.strip_prefix('n'))
        .filter_map(parse_port)
        .collect();
    ports.sort_unstable();
    ports.dedup();
    ports
}

/// `*:4000` / `127.0.0.1:4000` / `[::1]:4000` → `4000`. Anything without a
/// numeric port after the last colon (a named service, a unix path) is dropped.
fn parse_port(name: &str) -> Option<u16> {
    let (_, port) = name.rsplit_once(':')?;
    port.trim().parse::<u16>().ok()
}

/// Which port an app is *actually* serving on, given its configured port.
///
/// `None` when the configured port is among the ones it listens on (the normal
/// case), or when nothing is listening at all. `Some(port)` is a genuine
/// mismatch worth surfacing — the lowest listening port, which for a dev server
/// with an extra HMR/websocket port is the one people mean.
pub fn mismatched_port(configured: u16, listening: &[u16]) -> Option<u16> {
    if listening.is_empty() || listening.contains(&configured) {
        return None;
    }
    listening.first().copied()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_every_lsof_address_shape() {
        assert_eq!(parse_port("*:4000"), Some(4000));
        assert_eq!(parse_port("127.0.0.1:3000"), Some(3000));
        assert_eq!(parse_port("[::1]:8080"), Some(8080));
        assert_eq!(parse_port("localhost:http"), None);
        assert_eq!(parse_port("no-colon"), None);
    }

    #[test]
    fn no_mismatch_when_configured_port_is_bound() {
        assert_eq!(mismatched_port(3000, &[3000, 24678]), None);
    }

    #[test]
    fn no_mismatch_when_nothing_is_listening() {
        assert_eq!(mismatched_port(3000, &[]), None);
    }

    #[test]
    fn reports_lowest_bound_port_as_the_mismatch() {
        assert_eq!(mismatched_port(3000, &[4000, 24678]), Some(4000));
    }
}
