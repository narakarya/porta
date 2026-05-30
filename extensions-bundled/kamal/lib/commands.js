// Ported verbatim from DeployModal.tsx FIXED_COMMANDS.
export const FIXED_COMMANDS = [
  { id: "deploy",        label: "Deploy",       args: ["deploy"],                               group: "Deploy",  confirm: true },
  { id: "rollback",      label: "Rollback",     args: ["rollback"],                             group: "Deploy",  confirm: true },
  { id: "lock-release",  label: "Release Lock", args: ["lock", "release"],                      group: "Deploy",  confirm: true },
  { id: "app-logs",      label: "App Logs",     args: ["app", "logs", "-f"],                    group: "App",     safe: true },
  { id: "app-details",   label: "Details",      args: ["app", "details"],                       group: "App",     safe: true },
  { id: "app-start",     label: "Start",        args: ["app", "start"],                         group: "App" },
  { id: "app-stop",      label: "Stop",         args: ["app", "stop"],                          group: "App" },
  { id: "app-restart",   label: "Restart",      args: ["app", "restart"],                       group: "App",     confirm: true },
  { id: "exec-bash",     label: "Bash Shell",   args: ["app", "exec", "--reuse", "-i", "bash"], group: "Console", interactive: true },
  { id: "server-reboot", label: "Server Reboot", args: ["server", "reboot"],                    group: "Server",  confirm: true },
  { id: "server-exec",   label: "Server Info",  args: ["server", "exec", "hostname && uname -a"], group: "Server", safe: true },
  { id: "audit",         label: "Audit",        args: ["audit"],                                group: "Debug",   safe: true },
  { id: "version",       label: "Version",      args: ["version"],                              group: "Debug",   safe: true },
];

export function buildAccessoryCommands(names) {
  return names.flatMap((name) => [
    { id: `acc-bash-${name}`, label: `${name}: bash`, args: ["accessory", "exec", name, "bash"], group: "Accessories", interactive: true },
    { id: `acc-logs-${name}`, label: `${name}: logs`, args: ["accessory", "logs", name, "-f"],   group: "Accessories", safe: true },
  ]);
}

export function groupCommands(commands) {
  const groups = new Map();
  for (const cmd of commands) {
    if (!groups.has(cmd.group)) groups.set(cmd.group, []);
    groups.get(cmd.group).push(cmd);
  }
  return groups;
}
