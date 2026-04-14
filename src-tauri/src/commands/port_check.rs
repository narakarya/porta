#[tauri::command]
pub fn check_port_available(port: u16) -> Result<crate::port_check::PortCheckResult, String> {
    Ok(crate::port_check::check_port(port))
}
