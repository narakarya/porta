# Changelog

All notable changes to Porta are documented in this file. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows
[SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.7.20] — 2026-07-12

### Changed
- **Nested instances region is collapsible** and its cards are indented under
  the parent for a clearer parent/child hierarchy.
- **"Run from worktree" launcher shows 5 entries by default** with a "Show N
  more…" toggle (search still reveals all; worktrees with an active instance
  always stay visible).

### Fixed
- **Instances inherit the parent app's `.env`.** A relative `env_file` was
  resolved against the worktree dir (where `.env` is gitignored and absent);
  it now resolves against the parent app's root, so instances load the same
  env as the primary checkout.

## [0.7.19] — 2026-07-12

### Added
- **Worktree instances now render as full nested cards** under their parent
  app (logs, health, terminal, git, quick tunnel), max 3 inline with a
  fullscreen "View all" modal for more.
- **Per-instance health checks and per-instance quick (trycloudflare)
  tunnels.**

### Changed
- **Removed the PORT note and "Open terminal" shortcut** from the git
  worktree menu.

## [0.7.18] — 2026-07-12

### Changed
- **GitBadge marquee only in the popover, slower.** The app-card branch badge
  goes back to a plain ellipsis truncation (no hover-scroll); the marquee now
  lives only in the popover header and scrolls at half the previous speed.

## [0.7.17] — 2026-07-12

### Changed
- **GitBadge branch names auto-scroll on hover** instead of hard-truncating,
  and the popover header drops the `→ upstream` arrow for a cleaner look.

### Added
- **Directional git-op loading in GitBadge.** Fetch spins a sync icon, Pull
  shows a down arrow that bounces downward, Push an up arrow that bounces
  upward — the loading animation now mirrors each operation's direction.

## [0.7.16] — 2026-07-12

### Changed
- **Dev builds now run an isolated Caddy on `:8443`** (admin `:2119`) instead
  of sharing the production `:443` daemon. Running `npm run tauri dev` no
  longer disturbs the production Caddy config, certs, or routes.

## [0.7.15] — 2026-07-12

### Added
- **Run apps from a git worktree.** GitBadge gains a picker that lists an
  app's existing worktrees and starts each as an isolated instance: its own
  process, an auto-allocated port, and a dedicated Caddy route at
  `<app>-<branch>.<domain>`. Instances get a store slice with
  start/stop/list actions, and their routes are torn down when the app is
  deleted.

### Fixed
- **Instance subdomains no longer collide with a primary app's host.**
  Disambiguation now also avoids every primary app label sharing the same
  effective domain, so a rare instance label can't produce two Caddy routes
  for one host.
- **Instance port allocation is serialized** to close a TOCTOU between
  picking a free port and reserving it, preventing two concurrent starts
  from grabbing the same port.
- **Stale instance rows are reconciled on boot** — instances left
  `running`/`starting` after a Porta restart are marked `stopped` so Caddy
  rebuilds without their dead routes.

## [0.7.14] — 2026-07-11

### Added
- **Find-in-file search in the file editor.** Cmd+F opens a search bar that
  highlights matches with next/prev (Enter / Shift+Enter) across compose
  YAML, generic config (TOML/JSON/text), and `.env` files. The `.env` rows
  view highlights and steps through matching key/value rows; the `.env` raw
  view is now a CodeMirror editor and stays masked + read-only while secrets
  are hidden. Native Cmd+F search is preserved in the Add App / App Settings
  compose editors.

## [0.7.13] — 2026-07-11

### Fixed
- **A running image update no longer races a manual Start/Stop of the same app.**
  Updating a Docker or Compose app stops the container, pulls, and starts it
  again; that sequence now holds the same per-app lock the Start/Stop/Restart
  buttons use, so clicking Stop mid-update (or kicking off a second update)
  queues behind it instead of interleaving `down` and `up -d` on one project.
  Other apps are unaffected.

## [0.7.12] — 2026-07-11

### Fixed
- **Starting, stopping, or restarting an app froze the window.** The lifecycle
  commands ran synchronously on the main thread, and for a Compose app they
  waited inline on `docker compose down`/`up -d` — several seconds during which
  the whole UI was unresponsive. They now run off the main thread, still waiting
  for the work to finish so the card reflects reality, just without locking the
  window. Ops on the same app are serialized (a Start clicked mid-Stop queues
  behind it rather than racing `down` against `up -d`); different apps still act
  in parallel.

### Performance
- **The git poller stopped re-scanning folders that aren't repos.** It ran
  `git status` on every app folder every 15 seconds and `git fetch` on each one
  every interval, including the ones with no `.git`. Folders known not to be
  repos are now checked about every 2 minutes instead, and skipped by the fetch
  pass — cutting most of the poller's background process churn on setups with
  many plain (non-git) app folders. A folder that becomes a repo shows its badge
  within ~2 minutes instead of 15 seconds.

## [0.7.11] — 2026-07-11

### Fixed
- **Fetch, Pull, and Push froze the whole window.** The git network commands ran
  synchronously on the main thread, so the WebView locked up until git returned —
  up to the 30-second timeout on a slow remote. They now run off the main thread,
  the same way the Porta Relay operations do, and the button you clicked shows a
  spinner. A spinner also appears on the card's git badge, so an operation you
  kicked off stays visible after you close the popover.

## [0.7.10] — 2026-07-10

### Fixed
- **A repo Porta couldn't read looked like it wasn't a repo at all.** `git status`
  exits 128 both for "not a git repository" and for real problems — `detected
  dubious ownership` on a folder owned by another user, a malformed
  `.git/config`, a corrupt index. Porta treated them alike and simply hid the git
  badge, with no way to tell why. It now shows `git ⚠` on the card; clicking it
  gives you git's own error and a copy button. An unreadable repo also takes
  precedence over the last status Porta saw: once git stops answering, the branch
  and ahead/behind counts on screen are a claim Porta can no longer stand behind.
- **On a git built with translations, every ordinary folder would have warned.**
  Telling "not a repo" apart from a real failure means reading git's message, and
  Homebrew's git — unlike Apple's — localizes it. Porta now runs `git status`
  under `LC_ALL=C`.
- **A hung remote could freeze the ahead/behind counts for minutes.** The
  background `git fetch` pass ran on the same thread as the 15-second status
  poll, two repos at a time with a 30-second timeout each, so fifteen repos
  behind an unreachable remote stalled every card's `↑N` for up to four minutes.
  Fetching now runs on its own thread and never overlaps itself.
- **A panic anywhere could silently kill a background poller for the rest of the
  session.** Auto-start, idle-sleep, wake-on-request, metrics, and git status all
  took the app database's lock with `.unwrap()`, so one poisoned mutex ended the
  thread — no CPU readings, no git status, no auto-sleep, and no sign anything
  had stopped. They now recover the lock instead.
- **Autofetch could switch itself off for the session.** A panicking fetch pass
  left its in-flight flag raised, and no later pass could start. The flag is now
  cleared however the pass ends.

## [0.7.9] — 2026-07-10

### Added
- **App cards show git state instead of resource numbers.** A card whose folder
  is a git repo now displays its branch, plus `↑N` for commits waiting to be
  pushed and `↓N` for commits waiting to be pulled. Unlike the badges it
  replaces, it is visible at rest rather than on hover — a repo that needs a
  pull should not require you to go looking. Clicking it opens Fetch, Pull, and
  Push, and a shortcut to open a Porta terminal in the repo for anything more
  involved. Pull is always `--ff-only` and push is never forced, so neither can
  leave a half-finished merge or overwrite a remote branch. When git fails, its
  own error is shown verbatim with a copy button.
- **Background autofetch, so `↓N` tells the truth.** Git can only know how far
  behind you are by asking the remote; without a fetch, `refs/remotes/origin/*`
  is a frozen snapshot and the count stays at zero. Porta now runs
  `git fetch --no-tags --prune` on an interval — never touching your working
  tree, index, or HEAD. Settings → Git has the toggle and the interval (1, 3, 5,
  or 10 minutes); it is on by default, every 3 minutes, and pauses whenever the
  Porta window is hidden. Network operations time out after 30 seconds and never
  prompt for credentials, so a repo with a passphrase-locked key fails with a
  readable message instead of hanging.
- **Resource monitoring moved to its own drawer (`⌘⇧M`).** It lists every app in
  the workspace with CPU, memory, and a rolling CPU sparkline; container rows
  expand to show network and disk I/O — the same figures the old per-card
  tooltip carried. Polling stops entirely when the drawer is closed.

### Removed
- **Three badges are gone from the app card**: the CPU·memory readout (now in the
  resource drawer), the extra-subdomains `+N` count (the subdomains themselves
  are still in the card's open-in-browser menu), and the start-order number. The
  start-order number is removed outright, not relocated; what determined it —
  each app's `depends_on` — remains editable in App Settings.
- The internal `get_git_status` command, superseded by the new git module. It had
  no callers.

## [0.7.8] — 2026-07-10

### Added
- **Create `.env` from `.env.example` without leaving Porta.** The config editor
  now spots a template whose target is missing and offers a one-click create.
  The target name is derived by stripping the template suffix, so `.env.example`
  makes `.env` and `.env.dev.example` makes `.env.dev`; `.env.sample`,
  `.env.template`, and `.env.dist` work the same way. Creation refuses to
  overwrite an existing file.
- **Secret values are blanked on copy, and empty values are flagged.** Keys that
  look like credentials (`SECRET`, `PASSWORD`, `TOKEN`, `API_KEY`, …) come across
  with an empty value, while defaults worth keeping — `API_URL`, `AUTH_URL`,
  `SIGNUP_ENABLED` — are preserved. Any variable with an empty value gets an
  amber marker in the rows editor and a "N values need filling" count in the
  toolbar.

## [0.7.7] — 2026-07-10

### Fixed
- **Setup persistently failed with "mkcert couldn't read its CA key (permission
  denied)"**: mkcert's default CAROOT is `~/Library/Application Support/mkcert`,
  and macOS TCC blocks the Porta app (unlike a Terminal shell) from reading the
  CA key there — so cert generation failed every time, and the 0.7.6 retry
  couldn't help because the denial is persistent, not transient. mkcert's CAROOT
  is now pinned (via the `CAROOT` env) to Porta's own data dir
  (`~/.porta/mkcert`), which the app can always access. Note: this creates a
  fresh local CA there on the next setup run, so macOS will prompt once to trust
  it; the old CA under `~/Library` is left untouched and can be removed.

## [0.7.6] — 2026-07-10

### Fixed
- **Setup could fail with a one-off "mkcert generate failed: … permission
  denied"**: on the first run right after install/update, the app's initial
  read of the mkcert CAROOT key could be briefly denied and then succeed on a
  retry. `generate_certs` now retries the mkcert run up to 3× on a transient
  permission-denied, and if it still fails surfaces a clear "transient first-run
  hiccup — please run setup again" message instead of the raw mkcert error.

## [0.7.5] — 2026-07-10

### Fixed
- **First-time setup failed at "Installing mkcert CA" on a fresh Mac**:
  `install_mkcert_ca` ran `mkcert -install` as root via `osascript … with
  administrator privileges`. mkcert's `security add-trusted-cert` needs an
  interactive authorization from the user's GUI security session, which a
  detached root shell doesn't have — so it failed with *"SecTrustSettings…: The
  authorization was denied since no user interaction was possible."* mkcert now
  runs as the current user, letting macOS present its own native trust prompt,
  and keeping CAROOT in the user's home where Caddy looks for the CA.
- **Setup errors couldn't be copied**: the setup wizard's error box (and live
  log) had no way to copy the text. Added a Copy button and selectable text, and
  the live log is now colored per level (errors red) so failures stand out.

### Changed
- **Setup now asks for the admin password once, not per privileged step**: the
  `/etc/resolver` write and the Caddy launchd-daemon install are batched into a
  single `osascript` admin prompt at the end of setup. Combined with mkcert's
  own (unavoidable) keychain prompt, a fresh-Mac setup now shows two prompts
  instead of three.

## [0.7.4] — 2026-07-10

### Added
- **Fullscreen mode for the Docker image-update log**: the update-progress
  popover now has an expand button that blows the streamed log up to a
  full-screen overlay (Esc to exit), so long `docker compose` pull/up output is
  actually readable instead of scrolling inside a tiny 180px box.

### Fixed
- **Update-progress log errors were invisible and uncopyable**: every line in
  the image-update progress box rendered in the same neutral gray, so a failing
  `docker compose pull`/`up` error blended into ordinary output and there was no
  way to copy it. Lines are now colored per level (errors red + bold, warn amber,
  success emerald), the text is selectable, and there is a Copy button. The
  popover also stays mounted while an update runs so a stray outside click no
  longer discards in-flight progress.
- **Fresh-Mac setup failed at "Configure .test resolver"**: on a clean macOS
  install `/etc/resolver` does not exist yet, and the resolver write only ran
  `tee /etc/resolver/test`, which fails because `tee` won't create the parent
  directory. The privileged script now `mkdir -p /etc/resolver` first, so setup
  succeeds on machines that have never had a custom resolver.
- **Setup froze the UI and gave no live progress**: `run_setup` ran as a
  synchronous command on the main thread, so the multi-minute Homebrew installs
  blocked the WebView and the per-step / log events only painted after the whole
  run finished. It now runs on a background thread (like `start_caddy`), so the
  window stays responsive and progress streams live.
- **A failed setup step marked every later step as failed**: on error the wizard
  drew a red ✗ on all remaining rows even though they never ran. Now only the
  step that actually failed shows the error; unreached steps stay idle, and a
  single spinner marks the active step instead of every pending one.

## [0.7.3] — 2026-07-09

### Fixed
- **Delete/Remove in Remote Servers had no confirmation dialog**: the confirmation
  used `window.confirm`, which can silently no-op inside the app's WebView (no
  dialog appears, the action just proceeds). Switched to the native Tauri dialog
  so deleting a remote server or removing foreign routes now actually prompts.
- **Duplicate Test error**: a failed Test connection showed its error twice (a
  standalone line and again in the Activity log); removed the standalone line.

## [0.7.2] — 2026-07-09

### Added
- **Multiple domains per Porta Relay host**: a remote server can now serve several
  domains (a primary plus additional ones, all pointing at the VPS). When exposing
  an app, the tunnel menu shows a domain dropdown if the host has more than one, and
  each route remembers which domain it used. Existing single-domain hosts are
  unaffected.
- **Explicit provider picker in the tunnel menu**: choosing how to expose an app now
  shows a Cloudflare / Tailscale / Porta Relay switch, so Porta Relay is always
  reachable instead of being hidden behind the app's current provider.

### Changed
- **Remote Servers: Edit is now a toggle** — clicking Edit again closes the form
  (like Cancel).
- **Per-host activity log** in Remote Servers shows what Test, Sync, Push, and Remove
  actually do (endpoints probed, drift compared, results), so actions aren't opaque.

## [0.7.1] — 2026-07-09

### Fixed
- **Delete confirmation for remote servers**: deleting a host in Settings →
  Remote Servers now asks for confirmation first (it previously deleted
  immediately with no prompt).
- **UI freezing during Porta Relay operations**: Test connection, the WireGuard
  status poll, expose/unexpose, sync/push, and remote-log tail ran their blocking
  work (`wg show`, HTTP to the VPS Caddy admin API, `ssh`) on synchronous Tauri
  commands — which run on the main thread — so the window froze while they waited
  (most visibly the 15-second WireGuard poll and Test against an unreachable VPS).
  These commands now run off the main thread, keeping the UI responsive.

## [0.7.0] — 2026-07-09

### Added
- **Porta Relay — expose local apps through your own VPS.** A third expose
  backend alongside Cloudflare Tunnel and Tailscale Funnel, for developers who
  run a VPS + WireGuard. Public traffic hits the VPS's Caddy (which Porta manages
  over the tunnel via its admin API) and is reverse-proxied back to your Mac's
  local Caddy, so `localhost`-bound dev servers work unchanged. Pick **Porta
  Relay** in an app's tunnel menu to get `https://<sub>.<yourdomain>` in a few
  seconds; disconnect removes the route cleanly. Route state is persisted, so a
  failed push is marked pending (never a silent partial) with a one-click retry.
  See `docs/porta-relay-setup.md`.
- **Remote Servers settings section** — register/edit/delete VPS hosts (tunnel IP,
  Caddy admin port, base domain, Mac tunnel IP), with a **Test** button that
  probes the Caddy admin API over the tunnel.
- **Live WireGuard status** — per-host handshake age (green <2 min, amber <5 min,
  red ≥5 min), RX/TX, and endpoint, polled while visible. Exposed apps show an
  amber **degraded** indicator when their tunnel handshake goes stale.
- **Per-route basic auth** on relay routes — reuses an app's existing HTTP basic
  auth, shown with a lock indicator on the public URL.
- **Sync & drift detection** — compare Porta's routes against the live VPS config;
  **Push** restores missing routes and **Remove** drops unmanaged (foreign) ones.
- **Cloudflare DNS auto-record** — opt in per host (with the VPS public IP) to
  auto-create a DNS-only A record for the exposed subdomain on expose.
- **Remote access logs** — tail the VPS Caddy access log over your system SSH
  (no credentials stored in Porta) with a one-shot and live viewer per host.

### Changed
- The internal Caddy client is now multi-target: the local Caddy path is
  unchanged (byte-identical config), with a new remote target that manages a
  dedicated `porta` server on the VPS.

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
