# Kamal Deploy (Porta extension)

Runs Kamal deploy commands from an app card. Every command runs in an embedded
xterm.js terminal driven by the host's `bridge.terminal`; custom commands persist
via `bridge.storage`; kamal presence and accessories are detected via `bridge.shell`.

## Permissions
- `shell` — run `kamal version`, read `deploy.yml`, detect config
- `terminal` — interactive PTY for running commands
- `storage` — persist custom commands + config-path override

## Tests
From this directory: `node --test`
