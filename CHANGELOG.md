# Changelog

All notable changes to Porta are documented in this file. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows
[SemVer](https://semver.org/spec/v2.0.0.html).

## [0.2.0-beta] — 2026-04-24

Second beta with a large batch of UX, deploy, and infra improvements.

### Added
- **Kamal deploy console**: per-command isolated log state, interactive PTY
  console for bash/accessory-exec commands, custom command definitions stored
  per-app, confirmation step for destructive actions, log search + level
  filters, follow-tail mode, copy-line.
- **Stop/cancel for kamal runs**: Stop button in the deploy modal interrupts
  the running command (SIGINT to the process group → SIGKILL after 2 s).
- **Docker Compose import**: parse `docker-compose.yml` into Porta app +
  service definitions; edit compose YAML in-app.
- **Team sharing**: export/import full Porta config (workspaces, apps,
  services, env profiles) via Google Drive and JSON backup.
- **Metrics dashboard**: per-app CPU/RAM polling, tray app activity, health
  checks (`/health` endpoint), bulk start/stop, workspace-level run controls.
- **App filter + log search**: filter apps within a workspace, search app logs
  with level-based highlighting (err/warn/info/ok).
- **Env profiles**: multiple named `.env` variants per app with one active at
  a time.
- **Multi-port bindings**: declare additional host-container port mappings
  alongside the primary.
- **Extra subdomains + custom domain** per app (Caddy wildcard auto-routing).
- **Cloudflare tunnel integration**: list / create / delete tunnels, route
  DNS, set tunnel config, named + quick tunnel modes; wildcard certificate
  helper docs.
- **Tailscale serve** setup flow for apps.
- **Window state memory** (position, size) across restarts.
- **Command palette (⌘K)**: scoped search, app + workspace + settings
  results, navigation + quick actions.
- **Tray menu**: richer entries, notification settings, search scope.
- **Drag-to-add app**: drop a folder on the window to create an app stub.
- **Backup system**: full DB snapshot, list/restore backups, auto-Caddy start.
- **Icons + logo refresh** for macOS / Windows / Android / iOS bundle targets.

### Changed
- **Zsh shim for `kamal_run`**: redirected `ZDOTDIR` to a porta-managed shim
  that stubs `kiro` / `kiro-cli-autocomplete` functions before sourcing the
  user's `.zshenv` / `.zprofile` / `.zshrc`. Keeps aliases and PATH config
  while silencing plugins that panic inside non-TTY PTYs.
- **PTY child setup (`spawn_pty_command`)**: calls `setsid()` + `TIOCSCTTY`
  so the shell has a proper controlling terminal and its own process group,
  enabling reliable cancel and preventing `waitpid()` hangs.
- **Child reaping**: non-blocking polling with `try_wait()` + `kill(pid, 0)`
  probe instead of a blocking `child.wait()` that could deadlock when another
  thread reaps the child.
- Title bar: compact, no redundancy, drag region + search trigger + status +
  settings.
- Sidebar: PORTA label aligned with title bar, wider search, running count on
  right, persistent search filter per workspace.
- Sync buttons: SVG spinner with a minimum visible duration so state changes
  don't flash.
- Modals: Esc-close wired consistently; Share moved to context menu.
- Settings: simplified sections, auto-start Caddy, editor command fix.
- `auto_start`: skips apps already running from a previous Porta session.
- `kill_pid`: kills the whole process group and every port holder.
- Metrics are tracked even for apps that survived a Porta restart.
- Command palette: literal ellipsis instead of `…` escape.
- Backend: split monolithic `commands.rs` into per-domain modules
  (`app`, `deploy`, `terminal`, `tunnel`, `backup`, …); extracted `tray` and
  `auto_start` from `lib.rs`; added `useLogScroll` / `useLogFilter` hooks on
  the frontend.

### Fixed
- Kamal run hanging after a quick-exit failure (missing controlling terminal
  caused `waitpid` to never return).
- Canvas view: removed redundant filter layer (parent `WorkspaceView` already
  filters).
- Port-check UX: clearer inline feedback, handle conflicts without blocking.
- Search filter resetting on workspace switch.
- Google Drive sync: credential UI, OAuth code decoding, upload error
  reporting.
- Process manager: source shell config before spawning app processes so
  asdf / mise / rbenv shims resolve.
- Instant spinner on sync buttons via `requestAnimationFrame` flush.

### Known issues
- kiro-cli-autocomplete: the shim suppresses init-time panics, but if your
  `.zshrc` invokes kiro via a fully-qualified path (e.g.
  `/usr/local/bin/kiro init zsh`) the stub function won't shadow it. Workaround:
  switch to `kiro init zsh` (no path) or uninstall the plugin.
- Multi-server kamal deploy with SSL requires a custom certificate (e.g.
  Cloudflare Origin Certificate) — see `docs/plans/` in your app repo.

## [0.1.0-beta] — initial

Initial beta with workspace/app management, process lifecycle, Caddy reverse
proxy, and basic Kamal config detection.
