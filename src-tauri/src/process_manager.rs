use anyhow::{anyhow, Result};
use nix::sys::signal::{kill, Signal};
use nix::unistd::Pid;
use std::collections::HashMap;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

pub struct ProcessManager {
    children: Arc<Mutex<HashMap<String, Child>>>,
}

impl ProcessManager {
    pub fn new() -> Self {
        ProcessManager {
            children: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn start(&self, app_id: &str, command: &str, root_dir: &Path) -> Result<u32> {
        let mut parts = command.split_whitespace();
        let bin = parts.next().ok_or_else(|| anyhow!("empty command"))?;
        let args: Vec<&str> = parts.collect();

        let child = Command::new(bin)
            .args(&args)
            .current_dir(root_dir)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()?;

        let pid = child.id();
        self.children.lock().unwrap().insert(app_id.to_string(), child);
        Ok(pid)
    }

    pub fn stop(&self, app_id: &str) -> Result<()> {
        let mut children = self.children.lock().unwrap();
        if let Some(child) = children.remove(app_id) {
            let pid = Pid::from_raw(child.id() as i32);
            let _ = kill(pid, Signal::SIGTERM);
        }
        Ok(())
    }

    pub fn stop_all(&self) {
        let mut children = self.children.lock().unwrap();
        for (_, child) in children.iter() {
            let pid = Pid::from_raw(child.id() as i32);
            let _ = kill(pid, Signal::SIGTERM);
        }
        children.clear();
    }

    pub fn is_running(&self, app_id: &str) -> bool {
        self.children.lock().unwrap().contains_key(app_id)
    }
}
