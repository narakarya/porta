// Mirrors Rust kamal_work_dir(): config/deploy.yml resolves to the project root.
export function kamalWorkDir(configPath) {
  if (configPath.endsWith("/config/deploy.yml")) {
    return configPath.split("/").slice(0, -2).join("/") || "/";
  }
  return configPath.split("/").slice(0, -1).join("/") || "/";
}
