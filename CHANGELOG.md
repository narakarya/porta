# Changelog

All notable changes to Porta are documented in this file. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows
[SemVer](https://semver.org/spec/v2.0.0.html).

## [0.6.40] — 2026-07-07

### Fixed
- **Terminal printing Unicode as `\x{250C}` escapes**: the embedded terminal
  spawned `zsh` with only `TERM` set, never a UTF-8 locale. macOS launches GUI
  apps without the shell's locale environment, so `LANG`/`LC_*` were unset and
  programs that gate Unicode output on the locale (e.g. the Erlang compiler)
  fell back to latin1 and escaped box-drawing characters. Porta now injects a
  UTF-8 locale (`en_US.UTF-8`) when the environment doesn't already declare one,
  so tables and box-drawing render correctly.

### Removed
- **Claude shortcut on app cards**: dropped the per-app button that opened a
  terminal auto-running `claude`.

## [0.6.39] — 2026-07-06

### Fixed
- **Docker image update that "succeeds" but keeps reappearing**: the update
  check read only the *first* entry of a locally-tagged image's `RepoDigests`.
  A tag that was pulled at an old digest and later re-pulled at a new one keeps
  **multiple** digest aliases, and the stale one can sort first — so the check
  compared a stale local digest against the current remote digest and reported
  `has_digest_update` forever, even right after a successful pull. The badge
  therefore never cleared (most visible on the `postgres`/`clickhouse` services
  inside a compose stack such as Plausible). The digest comparison now checks
  the remote digest against the **whole** `RepoDigests` set: an update is
  reported only when the current remote digest is absent locally.

## [0.6.38] — 2026-07-05

### Fixed
- **Stale image-update results after editing a compose tag**: the update badge
  and "Image updates" dialog read a frontend cache keyed by the compose file
  *path*, so editing an image tag in-place (same file) left the dialog stuck on
  the previous check until the 4-hour background poll. Added a **refresh** button
  to the dialog header that forces a fresh registry re-check on demand; the
  result is written back to the cache so the card badge stays in sync.

## [0.6.37] — 2026-06-18

### Fixed
- **Extension panel wouldn't re-open**: opening an extension from an app card,
  closing just the extension modal (leaving the sidebar open), then clicking the
  same card action again did nothing — the focus effect's dependencies were
  unchanged so it never re-fired. Opening now carries a nonce that re-triggers
  the panel every time.

### Changed
- The app-card files button tooltip is now "Edit config files" (was
  "Edit files (compose / .env)"), reflecting that it edits more than Compose and
  `.env` — `mise.toml`, `package.json`, `.tool-versions`, and friends too.

## [0.6.36] — 2026-06-18

### Added
- **Generic config file editor**: the per-app file editor now discovers and
  edits more than `.env` and Docker Compose. Recognised config files —
  `mise.toml` / `.mise.toml` / `mise.local.toml`, `.tool-versions`,
  `package.json`, `.nvmrc`, `.ruby-version` — open in a syntax-highlighted code
  editor (TOML/JSON/plain text), alongside the existing `.env` rows/secret
  editor and Compose YAML editor. File labels in the sidebar now reflect the
  detected type instead of a hardcoded `env`/`compose` tag.

## [0.6.32] — 2026-06-12

### Added
- **Per-app upload size limit**: each app can now override how large a request
  body Porta's proxy will accept, set from the app's settings (in MB). Leave it
  blank to inherit the global default, or `0` for unlimited. Uploads larger than
  the limit get a 413.
- **Global default upload limit**: a new "Upload size limit" control under
  Settings → Disk Usage sets the default cap (100 MB out of the box, presets up
  to 500 MB plus Unlimited) applied to any app without its own override.

### Fixed
- **64 KB upload cap removed**: Caddy's `request_body` handler was hardcoded to
  64 KB — meant only to bound how much of a body was captured for the Traffic
  Inspector, but it doubled as a hard request limit, so any upload over 64 KB
  was truncated and rejected with a 413. The limit is now configurable
  (per-app + global default) instead of a fixed cap.

## [0.6.31] — 2026-06-12

### Changed
- **Debug log viewer**: grouped log entries now alternate text color by
  block instead of by row. A multiline entry keeps one tone across the
  header, SQL body, and continuation lines, while the next physical block
  uses the alternate tone.
- **Severity colors preserved**: explicit error/warn/info/success lines still
  use their existing palette, so the alternation only affects neutral log
  entries.
- **Release docs**: `README.md` and `CLAUDE.md` now document the release
  flow more completely, including `CHANGELOG.md` updates and the requirement
  to push a single `v*` tag instead of `--tags`.

## [0.6.30] — 2026-06-12

### Changed
- **Debug log viewer**: app/container log rows now use subtle alternating
  background colors while preserving severity colors and active search
  highlighting.
- **Release documentation**: clarified that releases should push a single
  `v*` tag, not `--tags`, because GitHub suppresses tag push events when more
  than three tags are pushed at once.

## [0.3.0-beta] — 2026-04-24

Third beta focused on Tailscale polish and Docker service spawn ergonomics.

### Added
- **Tailscale Funnel support**: public exposure for Tailscale-served apps,
  with provider icons, auto-refresh, and actionable error hints.
- **Global settings section** for Tailscale and notification preferences.
- **Service preset versions**: curated version dropdown per preset (Postgres,
  MySQL, Redis, Mongo, MariaDB, RabbitMQ) via `<datalist>` — users can also
  still type custom tags.
- **Multi-version spawn**: picking a preset whose image already runs
  auto-suggests a unique name, free host port, and per-instance volume
  sources, plus a banner explaining what was adjusted.
- **User-defined service templates**: save the current service form as a
  reusable template, surfaced alongside built-in presets in the grid. Delete
  via inline hover button. Stored in `~/.porta/config.json`.

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
