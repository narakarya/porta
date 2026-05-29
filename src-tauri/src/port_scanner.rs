use std::net::TcpListener;

pub fn find_available_port(used: &[u16], start: u16, end: u16) -> Option<u16> {
    (start..=end)
        .filter(|p| !used.contains(p))
        .find(|p| TcpListener::bind(("127.0.0.1", *p)).is_ok())
}

pub fn is_port_free(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_find_available_port_returns_in_range() {
        let port = find_available_port(&[], 3000, 9999);
        assert!(port.is_some());
        let p = port.unwrap();
        assert!((3000..=9999).contains(&p));
    }

    #[test]
    fn test_find_available_port_skips_used() {
        let port = find_available_port(&[3000], 3000, 3010);
        if let Some(p) = port {
            assert_ne!(p, 3000);
        }
    }

    #[test]
    fn test_is_port_free() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let taken = listener.local_addr().unwrap().port();
        assert!(!is_port_free(taken));
    }
}
