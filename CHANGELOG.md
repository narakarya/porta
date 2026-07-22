# Changelog

All notable changes to Porta are documented in this file. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows
[SemVer](https://semver.org/spec/v2.0.0.html).

## [0.14.0-beta.7]

### Added

- **The Status file list can be filtered.** Type to narrow both the staged and
  unstaged sections; the matching part of each path is marked so it is obvious
  *why* a row survived. While a filter is active the section header reads
  `1 of 2`, and the bulk button becomes `Stage shown` and touches only the rows
  you can actually see — staging files hidden behind a filter would be a nasty
  surprise.

### Where the Git tab rebuild stands

The Workspace Git tab is being rebuilt natively, one screen at a time, to catch
up with the `porta-git-manager` extension. Closed so far, all on the Status
tab: markdown and diagram previews, syntax-highlighted code and diff lines,
seven themes, and now filtering.

Still ahead of core, and by a fair margin: file-type icons, right-click menus,
multi-select, keyboard navigation, submodules — and the Branches, History,
Stash, Rebase, Sync, Tags and Pull Requests tabs, which have not been started.
For serious git work the extension remains the better tool, and it is not going
anywhere until every screen has caught up.

## [0.14.0-beta.6]

Diffs are syntax-coloured now, and diagram previews can be zoomed.

### Added

- **Diff lines are coloured by syntax**, and coloured *correctly*: each side of
  the file is tokenised in full and then sliced per line, so a line that happens
  to sit inside a multi-line string or a block comment is coloured as string or
  comment rather than guessed at. Tokenising a diff line on its own — the usual
  shortcut — gets exactly those lines wrong, because a fragment carries no
  context. Word-diff emphasis still shows through on changed runs; the two
  compose rather than one replacing the other. Each file is tokenised once and
  cached, so staging a hunk or refreshing does not re-do the work.
- **Diagram previews have zoom and fullscreen controls.** Zoom resizes the
  diagram rather than scaling it, so labels stay sharp at every step.

### Fixed

- **Switching files no longer risks a line borrowing the previous file's
  colours.** The old file's tokens are dropped as soon as the file changes,
  rather than lingering until the new ones arrive.
- **A failed syntax highlighter can recover.** A highlighter that failed to load
  was being remembered as a failure for that file, so it never retried.

## [0.14.0-beta.5]

Terminal sessions now outlive the view that shows them, the chrome around them
stops repeating itself, and the Git tab learns to preview files properly.

### Added

- **The Git tab previews any text file** as syntax-highlighted code, and
  renders markdown and diagrams inline rather than showing their source.

### Fixed

- **The terminal follows the app you selected.** `AppWorkbench` is reused
  across apps rather than remounted, so the tab strip — which kept its state in
  the component — stayed on screen under the next app, still pointed at the
  previous app's directory. Tab state now lives in a store slice keyed by app.
- **Navigating away no longer kills a running shell.** The PTY's lifetime was
  bound to a React component whose lifetime was bound to navigation, so
  deselecting an app SIGHUPed whatever was running, silently. Rust owns the
  session now: it keeps the last 256 KB of output, `terminal_open` reattaches
  instead of respawning, and only closing a tab, closing a pane, or deleting
  the app tears a shell down.
- **An exited shell keeps its last screen.** It used to leave a line of text in
  the scrollback and an inert tab with no way back.
- **Staging a file no longer rebuilds its diff view**, and the diff stays
  mounted through the refetch instead of blanking.
- **Access control is inert until the app actually serves**, rather than
  offering switches that cannot take effect yet.

### Changed

- **The tab dot reports whether the shell is alive** — running, idle, or
  exited — instead of whether it has output you haven't looked at. Unseen
  output now shows as a brighter tab label. One dot, one meaning.
- **The per-pane header row is gone.** It repeated the tab's own label directly
  beneath it. Split panes get an ordinal and a focus edge; a single-pane tab
  gets no chrome at all.
- **A status bar under the terminal** shows the focused pane's state, its pid,
  and line and match counts, and offers Restart once a shell exits.
- **Closing a tab with a process still running asks first.** Sessions survive
  navigation now, so closing is the only way left to lose work.

## [0.14.0-beta.4]

Makes starting an app stop freezing the rest of the window, and gives the
lifecycle buttons something honest to show while they work. Also starts the
native Git tab rebuild, beginning with themes.

### Added

- **The Git tab has its own theme.** Seven palettes — Dark, Graphite, Soft Dark,
  Midnight, Paper, Forest, Sunset — picked from the tab's header and remembered
  across restarts. The tab deliberately owns its full chrome, so the light
  `Paper` palette sits inside Porta's dark window by design rather than by
  accident.

### Fixed

- **Starting an app no longer freezes the whole window.** The backend emits one
  event per log line, and each one was written straight to the store: an O(10k)
  array copy, a spread of the entire logs map, a global state notification and a
  React render pass — per line. A dev server booting at a few hundred lines a
  second saturated the main thread, so every *other* app's controls went dead
  too. Lines are now buffered per app and flushed on a timer, which caps render
  pressure regardless of how loud the app is.
- **Stop stays responsive while an app is starting or stopping.** Stopping marks
  the app stopped optimistically while the command is still running — a compose
  stack takes 5–30s to come down — which unmounted the very button the user had
  just clicked. The card and the workbench both snapped back to "Start" with no
  spinner, and a Start click in that window queued silently behind the per-app
  lifecycle lock. Both surfaces now hold the in-flight state until the command
  actually returns.
- **Open and tunnel connect are inert until the app is running.** They used to be
  live on a stopped app, where Open lands on a connection error and a tunnel
  publishes a dead origin. Disconnect stays available so a tunnel whose origin
  died can still be torn down, and copying a URL stays available throughout.
- **The CPU readout stops resizing its tile.** Rounded to two decimals and
  rendered at fixed width; at one decimal the value jittered between one and four
  characters on every 2s sample.

### Groundwork

- **The native Git tab rebuild has begun.** The Workspace Git tab duplicates the
  `porta-git-manager` extension and loses to it, so it is being rebuilt natively,
  one tab at a time. This release lands the foundation and nothing more: a
  preview subsystem (markdown, syntax highlighting, lazy mermaid) checked against
  golden fixtures captured from the extension so core can never render less than
  it does, shared filter/facet/context-menu primitives, and a split of the
  911-line tab file into a shell plus its Status tab. The preview subsystem has
  no user-facing surface yet — the Status tab port wires it up next.

## [0.14.0-beta.3]

Makes "Check for updates" tell the truth while a beta is being built.

### Fixed

- **The beta channel stays readable during a build.** The release pipeline
  opened by deleting the `beta` release and recreating it as a draft, then spent
  the whole build with `releases/download/beta/latest.json` returning a 404 — so
  checking for updates in that window reported `Could not fetch a valid release
  JSON from the remote`. Build artifacts now live on the per-version
  `beta-v<version>` release, whose urls are unique and never overwritten, while
  `beta` holds only `latest.json` and is never deleted. The manifest is written
  last, in one step: until then clients keep seeing the previous beta intact.
  A failed build no longer takes the channel down with it.
- **An unreachable manifest no longer reads as a crash.** A manual check that
  couldn't fetch the manifest showed the updater plugin's internal wording under
  a red "Update failed". That case is now neutral — "No update available yet" —
  with a Retry. Genuine faults (a malformed manifest, a signature mismatch) stay
  red and still show their message.

## [0.14.0-beta.2]

Fixes SSH connections to hosts on the local network, which macOS was blocking
outright.

### Fixed

- **Local network access.** Tauri left the bundle linker-signed, so its
  code-signing identifier was a per-build hash. macOS ties the Local Network
  permission to that identity, so every rebuild registered as a different app:
  the grant never stuck and the prompt never reappeared. Connecting to a LAN
  host failed with `connect: No route to host (os error 65)` even when the host
  answered fine from a shell. The bundle is now signed ad-hoc explicitly, which
  takes the identifier from `CFBundleIdentifier` and keeps it stable across
  builds. Still ad-hoc — no Apple Developer account required.
- **SSH retry no longer stacks dead tabs.** Retry on the connection-failed card
  opened an additional session instead of replacing the one that failed, so a
  host that kept failing left a row of red tabs nobody had opened.

## [0.14.0-beta.1]

Recovers the surfaces the Shell C redesign left behind when the workbench
replaced the app grid, and gives failures somewhere to go. Opening an app hides
the whole grid subtree with `hidden`, and `display: none` takes fixed-position
descendants with it — three separate features were unreachable that way.

### Added

- **Notice surface.** An app-wide, non-blocking stack for successes and
  failures, mounted at the App root. Errors persist until dismissed and carry
  the backend's own message; successes fade.
- **Resizable sidebar.** Drag the right edge, clamped to 180–420px so it cannot
  collapse; double-click resets. Width is shared by Workspaces and Hosts and
  persists. The sidebar also moves to the raised surface, which previously matched
  the content area exactly and read as flat.
- **Pinned extension tabs.** Up to two extensions can be pinned as workbench
  tabs beside Config, rendering their panel inline. Pins are global, so an
  extension follows every app it activates for.
- **Version indicator** as a dot above Settings: setup health by colour, version
  on hover, click to check for updates. It replaces an inert version row that
  could never be clicked and an account initial the update popover anchored to.
- **Frontend test suite** (vitest + testing-library) covering the regressions
  fixed here.

### Changed

- **Terminal tabs and splits reach the workbench.** The tabbed/split surface,
  transcript search and ⌘T/⌘W/⌘D/⌘1-9 shortcuts were owned by the grid's
  terminal modal; the workbench's Terminal tab was a bare single pane. Both now
  share one surface. ⌘F no longer focuses the wrong search box when both are
  mounted.
- **No more alert walls.** Nine `window.alert` call sites — two on the app-start
  path — became notices instead of modal dialogs that block the whole WebView.
- **Lifecycle buttons keep their slot.** Start/Restart become their own spinner
  rather than being swapped for a separate disabled pill, and Stop is appended
  while starting rather than prepended, so no control shifts under the cursor.

### Fixed

- **Crashes are visible again in the workbench.** A crash rides on a non-zero
  exit code, which the workbench never read, so a died app showed a neutral
  "stopped". Restores the crash badge, exit-code banner and Restart label.
- **The start/crash log toast** works from the workbench, and stays quiet while
  the Logs tab is already showing the same output.
- **SSH connect failures explain themselves.** A failed connect showed a red dot
  over a blank terminal; the reason was dropped in three places. Failed sessions
  now render the reason with a retry. Agent auth with no `SSH_AUTH_SOCK` ran zero
  methods yet reported "all authentication methods failed"; that case is named,
  and auth errors quote the username and methods tried.
- **Silent failures.** A failed start/stop/restart from the workbench, a failed
  SSH host save or delete, and Activity's start/stop all rejected into nothing.
  They report now.
- **Two copies of one build no longer fight over the database.** A single-instance
  guard focuses the existing window instead of opening a second one onto the same
  SQLite file with its own stale in-memory state, and `busy_timeout` replaces the
  default of failing a contended write immediately.

### Internal

- Two-phase release driver for the beta and stable lines.

## [0.13.0] — 2026-07-21

Promotes the whole "Shell C" line to stable. This is the largest release since
0.10.0: a new content-forward app shell, a native Git manager, first-class
worktree instances, a unified access surface, and a full restyle onto the design
tokens. It supersedes the 0.11.0-era redesign previews and the entire
0.12.0-beta channel (beta.1 – beta.11), which were never released as stable.

### Added

- **Native Git manager** as a first-class workbench tab. Status with a
  folder-nested collapsible file tree, per-file insertion/deletion counts,
  unified/split diffs with selectable context and whitespace handling,
  word-level intra-line highlighting, a line-number gutter, per-hunk and
  per-file stage/unstage/discard, multi-file and folder bulk actions, rename and
  copy-path, and visual previews for images, Markdown, sandboxed HTML, CSV and
  TSV. Commit, commit & push, and amend (with a clean-tree guard) plus a ⌘↵ hint
  and staged count.
- **Git History, Branches, Sync, Stash and Tags.** Cross-branch message search,
  commit bodies, cherry-pick (with continue/abort), soft/mixed/hard reset;
  branch compare-base selection, create-from-ref,
  All/Identical/Merged/Unmerged/Local-only/On-remote facets, ahead/behind and
  unique-commit counts, worktree-safe switching and confirmed local/remote/bulk
  removal; fetch/prune, pull, pull-with-rebase, push, force-with-lease, rebase
  from main/master and remote management; stash search/preview/apply/bulk-drop;
  lightweight and annotated tags with push/delete on origin.
- **Interactive rebase editor** — reorder commits and mark each as pick, edit,
  reword, squash, fixup or drop, with multiline reword messages and explicit
  continue/abort handling when a rebase pauses.
- **Native GitHub pull requests** — list and search open PRs, inspect
  descriptions and checks, browse file-tree diffs, create or checkout a PR, open
  it on GitHub, and squash-merge with confirmation. Detects GitHub CLI install
  and auth before enabling the workflow.
- **Worktree instances as first-class workbenches.** `git_worktree_add` creates
  a worktree for an existing or new branch and launches an instance from it;
  each instance gets its own Overview / Logs / Git / Terminal workbench,
  sidebar and card entry points, a breadcrumb back to the parent, and the same
  context actions as its parent app.
- **Activity domain** — host CPU / memory / disk via `system_metrics`, a live
  per-app CPU/memory panel on the workbench Overview, and a session-lived
  recent-events feed.
- **Docker image panel** in the workbench Overview (image, update status, and a
  check-for-updates / apply control) so the affordance survives opening an app.
- **Publish surface** — unified routing panel, shareable QR code, and a live
  streaming pane of the tunnel's `cloudflared` output.
- **Open in Editor** from the app and instance context menus, and an
  **Advanced Git tools** setting (Settings → Git & defaults, default on) that
  shows or hides the History/Stash/Tags/Rebase tabs.
- On-demand app volume snapshot (`create_app_volume_snapshot`).
- Persisted view preferences — sidebar collapse state and per-card instance
  expansion survive a reload (stored locally, not in the backed-up database).

### Changed

- **"Shell C" app redesign.** Content-forward workbench shell: an icon rail of
  domains (Workspaces / Hosts / Services / Activity / Extensions), a thin
  workspace-grouped app list, and a rich app workbench (header plus Overview /
  Logs / Git / Terminal / Publish / Config tabs). App settings render inline as
  a **Config** tab instead of a full-screen modal. Sidebar gains hover
  start/stop, a per-app context menu, and an always-visible "＋" per workspace;
  Services gains "Add from template" prefill (Postgres / MySQL / Redis / Mongo /
  RabbitMQ / MariaDB / MinIO). Loading, spinner and skeleton states across async
  controls.
- **Unified access popover.** Open and Publish are one control listing every
  local route and live public destination, with Quick and Named Cloudflare
  tunnel modes, access-policy shortcuts and a collapsed live tunnel-output
  stream. Domain and Tunneling left the Config tab; their non-redundant editing
  controls now live once in a focused **Routes & Access** drawer opened from the
  popover.
- **Full restyle onto the design tokens.** ~22 Settings panels and every Config
  sub-panel migrated off legacy `zinc`/`blue`/`emerald` onto `--surface-*`,
  `--ink-*`, `--accent`, `--success`/`--warning`/`--danger`; radii normalized
  (`rounded-card` / `rounded-control`) and opacity-on-token classes replaced
  with explicit rgba.
- **Config tab refactored** from the 2900-line settings modal into a thin shell
  plus focused section components (General / Domain / Environment / Tunneling)
  over a shared draft context, width-constrained so fields don't stretch across
  the workbench.
- **"Ready" now means serving, not just bound.** An app is marked ready (and its
  Open affordances light up) only once it answers HTTP — via its configured
  health path, or a `GET /` probe otherwise — rather than at the first TCP
  accept. Genuinely non-HTTP processes still fall back to the port-open signal.
- **Git manager is worktree-aware** — branches checked out in another worktree
  are labeled, disabled before switching, and show the checkout path instead of
  failing after the Git command runs.
- **One update surface.** The redundant sidebar self-update popover was removed
  in favour of the rail-anchored update popover; the sidebar row keeps only the
  version and system-health dot. The Hosts sidebar now shares the Workspaces
  sidebar shell instead of hand-rolling its own column.
- Cleaner instance workbench header (parent navigation, branch, status, domain,
  port without repetition; no parent-only aliases), a neutral app icon on the
  parent header, and merged Cloudflare "DNS Records" + "Zone" settings tabs.
- Log severity rail spans the whole error/warn block (header plus continuation
  lines) so a severity block reads as one unit.

### Fixed

- **Per-app CPU % was wrong twice over** — normalized to 0–100% of the machine
  (previously summed per-core, reading up to ~100×cores), and cast to `f64`
  before rounding so it no longer prints a representation artefact like
  `2.9000000953`.
- **Lifecycle controls lied about state.** Start / Restart / Stop cleared their
  spinner the instant the IPC returned; they now stay in a loading state until
  the readiness event arrives, don't flicker back to "Start" mid-startup, and
  worktree instances use the same HTTP/health-check gate as primary apps instead
  of a fixed timeout.
- **"Open" did nothing** in the workbench — raw `window.open` is a no-op in the
  Tauri WebView; all Open affordances now use `openExternalUrl`. The Open menu
  also uses the app's effective Caddy domain and local certificate scheme, and
  lists the primary route plus every registered extra subdomain instead of
  hardcoded `.test` or bare custom-domain URLs.
- **Log viewer regressions from the redesign** — the line-number gutter, six
  colored level badges (ERR/WARN/INFO/DBG/TRC/OK), copy-entry as one unit, the
  Success and Debug filter chips, per-level text coloring and the colored
  continuation rail / alternating block tint are all back, keeping the beta
  additions (timestamp toggle, export, "Paused · N new", error-count badge).
- **Extensions were unreachable from the workbench** and could not open or run
  shell commands for instances. The workbench header has an extensions toggle,
  Overview lists each matching extension's app-actions, and extension shell
  commands resolve synthetic instance apps and scope their working directory to
  the instance worktree.
- **Shell extensions could hang or leak processes.** The extension shell runner
  disables interactive git prompts, runs commands in their own process group
  with a group-kill on timeout, and drains stdout/stderr concurrently — matching
  the core git runner. A credential prompt no longer hangs until the timeout,
  and orphaned git/ssh children are cleaned up.
- **Git discard was unsafe and incomplete.** Discarding now asks for
  confirmation, works for untracked files and directories, staged new files and
  staged tracked edits, offers a confirmed "Discard all", resets diff state on
  file switch (a stale per-hunk "Discard?" could target the wrong file), and
  gates individual file actions while a bulk operation is in flight. Untracked
  files show their content instead of "No changes"; binary and mode-only diffs
  render; option-injection guards were added to tag and stash messages.
- **Reorder could silently diverge from disk** — workspace and service
  reordering now awaits the write and reloads the authoritative order on failure
  instead of fire-and-forget.
- **Updater noise.** A background check that fails on a transient release or
  network hiccup no longer pops a blocking "Update failed" toast covering the
  rail's Settings and account buttons; only user-initiated checks report errors.
- Restored the inline **Kill port** action on stopped worktree instances so
  orphaned port holders can be cleared without discovering the context menu.
- **Docker image update visibility** — the workspace rollup marks the exact app
  row with a pending image update (naming the affected Compose service/image in
  its tooltip) instead of an ambiguous workspace-level count.
- Hosts, Services, Activity, Extensions and app workbenches begin at the top of
  their content area instead of below a blank 44px drag bar; the rail logo lines
  up with the Workspaces title.
- Porta now explains when Git refuses a branch switch because another worktree
  has that branch checked out, instead of looking broken.
- Git branch/switch is interactive again on the app surface (`GitBadge` with
  branch indicator, switch-branch and fetch/pull/push), the workbench Details
  card lists every host the app answers on, and the Config save footer no longer
  sticks on "Unsaved changes" when only out-of-band tunnel settings changed.
- Switching workspaces no longer re-scans every app card (a visible shimmer);
  cards paint cached extension state and re-detect only when the cache is empty.
- Low-contrast solid-green fills on Docker **Disk Usage** cleanup and
  **Backup → Export Database** (white-on-mint, ~1.9:1) replaced with a legible
  green tint and the standard accent primary; tunnel-log auto-scroll survives
  the ring-buffer cap; per-hunk diffs refresh after staging.

### Removed

- Dead code: the unused `SettingsModal` component and the unreachable
  store-driven full-screen app-settings modal path.

## [0.11.0] — 2026-07-19

Workspace-app UI polish batch answering a round of feedback: lifecycle and
link-surface fixes plus a few small view-preference and updater improvements.
(Larger redesign items — sidebar app tree, Open/Publish popover, Inspect
tabs, bundled git-manager, config re-skin — are tracked for a later release.)

### Fixed

- **CPU reading showed a garbage float** (e.g. `0.0000000953`). The metric was
  rounded as `f32` then serialized, which promoted to `f64` and exposed the
  representation error. Now cast to `f64` before rounding so a clean value is
  emitted, for both process and Docker apps.
- **Open button linked to the wrong/incomplete host.** The card's link list had
  drifted from the routes the backend actually serves — it omitted port
  bindings, the tunnel alias domain, and the public tunnel URL, and only showed
  a picker when extra subdomains existed. A single resolver now mirrors the
  backend route set (Local and Public groups) and shows a popover whenever there
  is more than one target.
- **Start button gave no loading feedback.** During an initial start the Restart
  and Stop buttons appeared live with no spinner; the primary control now shows
  a disabled "Starting…" spinner, while Stop stays enabled to act as Cancel.
- **Git badge was hidden on Docker/Compose repos** even though status was already
  being computed for them; the badge now shows for any app with a working
  directory.
- **Log view layout.** Severity badges (ERR/WARN/…) are now fixed-width and
  centered so they align in a tidy column, and the line-number gutter widens for
  large line counts instead of overflowing into the badge.
- **Shell extensions could hang or leak processes.** The extension shell runner
  now disables interactive git prompts, runs commands in their own process group
  with a group-kill on timeout, and drains stdout/stderr concurrently — matching
  the hardening the core git runner already had.
- **Reorder could silently diverge from disk.** Workspace/service reordering now
  awaits the write and reloads authoritative order on failure.
- **Switching workspaces re-scanned every app card** (a visible shimmer); cards
  now paint cached extension state and only re-detect when the cache is empty.

### Added

- **Persisted view preferences.** Sidebar section collapse/expand state and each
  card's instances-expanded state now survive a reload (stored locally, not in
  the backed-up database).
- **Update button in the sidebar.** When an update is available or ready, a
  labelled Update button appears above the settings gear showing the target
  version, so updating no longer requires digging into About.

### Changed

- **Log severity rail** now spans the whole error/warn block (header plus
  continuation lines) instead of only the continuations, so a severity block
  reads as one consistently marked unit.
- **"Ready" now means serving, not just bound.** An app is marked ready (and the
  Open button appears) only once it actually answers HTTP — via its configured
  health path, or a `GET /` probe otherwise — rather than at the first TCP
  accept; the health indicator also refreshes immediately on ready. Genuinely
  non-HTTP processes still fall back to the port-open signal.
- Dropped the redundant app-name label in the About card (the version line
  stands on its own).

## [0.10.0] — 2026-07-17

### Added

- **Remote OS detection.** On first connect, Porta probes the host
  (`/etc/os-release` / `uname`) over a throwaway channel and shows an OS glyph
  on the host card — à la Termius.
- **Session-aware host list.** Hosts with a live session get a green dot (and a
  count); clicking a host now focuses its existing session instead of always
  opening a new one — use the hover **＋** to force a new session.

### Changed

- **Faster terminal streaming.** SSH output is sent as base64 rather than a
  JSON integer array (~¼ the payload, much cheaper to parse) — noticeably more
  responsive.
- **Terminal rendering.** Fit the terminal after the web font loads and focus
  it on activation, fixing overlapping/"joined" glyphs and keeping keystrokes on
  the active session.
- **Host form redesign.** Sectioned layout; the free-text Group field is gone
  (workspaces organize the vault now); workspace attachment is a searchable
  checklist popover that scales past a handful of workspaces; key-file field
  defaults to `~/.ssh/id_ed25519` with a Browse picker.
- **Vault filter** moved to a compact funnel popover instead of a full-width
  dropdown.
- Sidebar no longer shows a workspace as "active" while the Hosts view is open.

### Fixed

- **Host delete now confirms.** It used `window.confirm`, which the Tauri
  webview silently treats as accepted; it now uses the native dialog plugin.


### Added

- **Attach SSH hosts to workspaces (many-to-many).** A host can belong to
  several workspaces; the vault gains an "All workspaces" filter and shows
  workspace badges on host cards, and each workspace view gets a "Hosts"
  section with one-click connect that drops you straight into a terminal.
- **Key file browse + default.** The host form's key field pre-fills
  `~/.ssh/id_ed25519` and adds a "Browse…" native file picker.

## [0.8.0] — 2026-07-16

### Added

- **SSH Host Manager.** A new "Hosts" sidebar entry adds a saved-host vault
  (add/edit/delete, groups, search) backed by a local store, and interactive
  SSH terminals over a pure-Rust `russh` transport — multiple concurrent
  sessions in tabs, kept warm when you switch away to a workspace and back.
  Authentication tries agent, then key, then password, with an optional
  "remember" that stores the secret in the macOS Keychain (secrets are never
  written to the database). Unknown host keys prompt for trust before
  connecting; a changed host key hard-blocks the connection instead of
  silently proceeding.

## [0.7.35] — 2026-07-16

### Changed

- **Instance cards get the full right-click menu, scoped to the instance.** The
  context menu on a worktree instance card now acts on that instance instead of
  the parent app — Copy URL/host use the instance host, Open in Editor/Terminal
  open the worktree, and Force Kill / Kill port holder target the instance's own
  process and port. Force Kill on an instance routes through a new
  `kill_instance` command (SIGKILL + status flip + Caddy resync), so the row,
  route, and tunnel stay consistent.
- **Removed the redundant "Kill port" button from instance cards.** The
  right-click menu now covers it (Force Kill while running, Kill port holder
  while stopped).

## [0.7.34] — 2026-07-15

### Fixed

- **Git badge fully hidden on non-process apps.** 0.7.33 removed the branch
  workflow from docker/compose/static/proxy cards but left the badge itself
  (branch name, ahead/behind, fetch/pull/push). The badge now only renders on
  process apps — including worktree instance cards.

## [0.7.33] — 2026-07-15

### Fixed

- **Branch workflow hidden on apps that can't use it.** "Switch branch" and
  "Run from worktree" in the git badge popover now only show for process apps
  with a start command — the backend's `start_instance` rejects docker,
  compose, static, and proxy apps anyway, so the popover offered rows that
  could only error. Those apps keep the badge itself (branch, ahead/behind,
  fetch/pull/push).

## [0.7.32] — 2026-07-15

### Changed

- **Tunnel icon on app cards stays visible while it has something to say.**
  Previously the icon was hover-only like the rest of the card's action row,
  so a connect-in-flight (pulsing amber) or a failure was invisible unless you
  happened to be hovering. The icon now opts out of hover-gating while
  connecting, on tunnel error, while its menu is open, and for a few seconds
  after connecting — then returns to hover-only.
- **"Tunnel connected" toast.** When a tunnel flips from connecting to
  connected, a small pill appears under the icon with the tunnel hostname and
  auto-dismisses after 4 seconds.

## [0.7.31] — 2026-07-14

### Fixed

- **Quick-tunnel URLs no longer surface before they resolve
  (ERR_NAME_NOT_RESOLVED).** Porta used to emit the trycloudflare URL the moment
  cloudflared printed it, but the hostname is brand-new and local resolvers —
  especially VPN/Tailscale MagicDNS paths — can lag behind, so clicking the
  fresh link died with a browser DNS error while the tunnel itself was fine.
  The backend now polls the system resolver (the same lookup path browsers use,
  which also warms the DNS cache) and only flips the tunnel to "connected" once
  the hostname actually resolves; the card keeps its pulsing connecting state
  meanwhile. If it still hasn't resolved after ~30s the URL is shown with an
  actionable warning instead of a silent mystery. Applies to app and worktree
  instance quick tunnels.

## [0.7.30] — 2026-07-14

### Fixed

- **Tunneled pages 502'd on every request after 0.7.28/0.7.29 (regression).**
  0.7.28 switched tunnel origins from `localhost` to `127.0.0.1` to dodge the
  IPv6-first resolution race — correct for the TCP dial, but Go sends **no SNI**
  when connecting to an IP address, and Caddy selects its TLS certificate *by
  SNI*. The handshake died with `tlsv1 alert internal error` and cloudflared
  returned 502 for every request routed through Caddy's :443. Ingress rules now
  set `originServerName` (and the CLI path `--origin-server-name`) to the local
  Caddy host, restoring the SNI while keeping the IPv4-only dial. Verified live:
  the same Caddy that rejected an SNI-less handshake serves 200 with the SNI
  set.

## [0.7.29] — 2026-07-14

Resources drawer now focuses on what's actually running, is searchable, and
lets you drill into process rows.

### Changed

- **Resources drawer only shows running apps.** Stopped apps are hidden
  entirely instead of sinking to the bottom with a dash, so the list reflects
  live resource usage only. Rows are sorted by CPU descending.

### Added

- **Search box in the Resources drawer** filters running apps by name.
- **Process rows are now expandable** (click to toggle), matching Docker rows.
  Expanded detail shows memory, PID, and port.
- **Tunnel connect shows a "connecting" state on app & instance cards.** The
  tunnel icon pulses amber and re-clicks are ignored while a connect is in
  flight, so a named-tunnel connect (which takes a few seconds to route DNS,
  spawn cloudflared, and register at the edge) no longer looks frozen.

### Fixed

- **Intermittent 502s from ghost tunnel connections at the Cloudflare edge.**
  Killed/crashed connectors (reconcile churn, force-quit, laptop sleep) leave
  their connection registrations behind at the edge, and Cloudflare load-balances
  requests across **all** registered connections — dead ones included — so pages
  502'd or succeeded depending on which connection the edge picked (this machine
  had 8 dead registrations on a single tunnel). Named-tunnel (re)starts now
  SIGTERM the old connector and **wait for it to actually exit**, then run
  `cloudflared tunnel cleanup` to sweep stale edge registrations before spawning
  the fresh connector — every connect self-heals the edge state. Full
  disconnects sweep too.
- **Connecting a Cloudflare tunnel from an app card is now as reliable as from
  Settings.** The card started the tunnel without passing the provider, so it
  fell back to the store's in-memory `tunnel_provider` — which could be stale
  and launch the app's *previous* provider instead of Cloudflare. It also had no
  connecting feedback or re-click guard, so an impatient second click during the
  multi-second connect restarted the shared connector mid-attempt. The card now
  passes `cloudflare` explicitly and blocks re-clicks until the connect settles.

## [0.7.28] — 2026-07-14

Tunnel reliability release: correct routing when apps share a named tunnel,
named tunnels for worktree instances, and the elimination of intermittent 502s
from IPv4/IPv6 loopback mismatches.

### Added

- **Worktree instances can use a named Cloudflare tunnel.** When an instance's
  parent app has a named tunnel configured, connecting the instance now joins
  that tunnel's shared connector as a member exposed at
  `<instance-subdomain>.<parent-domain>` (e.g. `nexus-feat-x.nasrulgunawan.com`),
  routed straight to the worktree port. This gives a stable URL on your own
  domain instead of a throwaway trycloudflare link. Instances whose parent has
  no named tunnel still fall back to a quick tunnel. Stopping or removing an
  instance drops it from the shared connector automatically.

### Fixed

- **Cloudflare named tunnels shared across apps now route correctly.** When two
  or more apps pointed at the *same* named tunnel (e.g. several hostnames on
  `nasrulgunawan.com`), Porta spawned one `cloudflared` process per app. Each
  became an HA replica of the same tunnel carrying only its own ingress, so the
  Cloudflare edge forwarded a hostname to whichever replica answered — and on
  the single-host `--url` path each replica force-rewrote *all* traffic to its
  own app's Host header, letting the last-started app capture every hostname on
  the tunnel. Porta now runs exactly **one connector per tunnel name** with a
  **merged ingress table** covering every member app (Cloudflare's intended
  model). Connecting/disconnecting an app reconciles the shared connector;
  members keep serving while others come and go. Single-app named tunnels are
  unaffected in behavior, and quick (trycloudflare) tunnels stay per-app.
- **Intermittent "Bad Gateway" (502) on tunneled pages that a refresh cleared.**
  Caddy's per-app `reverse_proxy` upstream dialed `localhost:<port>`, but macOS
  resolves `localhost` to IPv6 `::1` first while dev servers usually bind IPv4
  `127.0.0.1` only — so Caddy attempted `::1` first and Go's dual-stack fallback
  is racy, yielding sporadic 502s that vanished on retry. Both Caddy upstreams
  and every cloudflared tunnel origin now dial `127.0.0.1` explicitly. This is a
  local origin issue, not a Cloudflare request limit.
- **Quick (trycloudflare) tunnels that provisioned a URL but 502'd on access** —
  same IPv4/IPv6 loopback cause, fixed by the `127.0.0.1` origins above.

## [0.7.25] — 2026-07-13

### Changed
- **Stop no longer removes an instance.** Stopping an instance now kills its
  process and marks the row **stopped** (port + Caddy route retained), so the
  card stays put — mirroring how a stopped primary app behaves. Removal is a
  separate, explicit action.
- **Instance cards gain Kill port + Remove.** A stopped instance shows
  **Start · Kill port · Remove**. *Kill port* frees the instance's *own* port
  (`inst.port`, for an orphan child that outlived the stop); *Remove* deletes
  the row for good behind a confirm bar.
- **Terminal runs a login+interactive shell** (`zsh -i -l`, was `-i`) so
  `~/.zprofile` is sourced. In a `.app` bundle the login file is where Homebrew
  puts `/opt/homebrew/bin` on PATH — without it, `starship` isn't found and the
  prompt silently falls back to bare zsh (notably in worktree terminals).

### Added
- `remove_instance` command — the destructive counterpart to `stop_instance`.

### Fixed
- **Remove now asks for confirmation** — a confirm bar on instance cards and a
  two-step `Remove → Confirm?` in the branch flyout, so an instance isn't wiped
  on a single stray click.
- **No spurious crash banner on Stop.** An intentional stop now reports exit 0
  (matching the primary-app path), so the now-persistent stopped row doesn't
  render a crash banner for a process the user killed deliberately.

## [0.7.24] — 2026-07-13

### Changed
- **Branch flyout opens on hover.** The "Switch branch" row now reveals the
  branch list on hover — no click needed — with a short grace delay on leave so
  the cursor can cross the gap into the flyout without it snapping shut. Click
  still toggles it (keyboard/touch), and the search field autofocuses so you can
  start typing immediately.
- **Real tooltips replace native `title=`** across the app-card and GitBadge
  surfaces (current-branch badge, each branch row, worktree paths, instance
  status, port-conflict badges, root-dir path, cleanup buttons) — portal-based,
  viewport-clamped, no clipping by `overflow:hidden` ancestors.

### Fixed
- **Branch list was sometimes unclickable.** The WebView's native autocomplete
  dropdown (surfacing prior search text) floated over the branch/worktree lists
  and swallowed clicks. The search inputs now set `autoComplete="off"` (plus
  `autoCorrect`/`autoCapitalize`/`spellCheck` off), so the list stays reachable.

## [0.7.23] — 2026-07-12

### Changed
- **Branch switching moves to a flyout.** The GitBadge now leads with a git
  branch icon + the current branch name; clicking it opens the popover with
  fetch/pull/push (unchanged) plus a **Switch branch** row. That row opens a
  second popover to the *right* — a searchable branch list where you click a
  branch name to check it out directly (no separate "Switch" button) or
  "Create <name>". Instance cards keep only the git-ops popover (branch-pinned).
- **Instance cards drop the config-editor and HTTP-traffic buttons.** Both were
  primary-app affordances that didn't belong on a branch-pinned worktree card.

### Fixed
- **Terminal opens on instance cards.** The terminal button on a sub-instance
  did nothing: the modal render loop only iterated real apps, so an instance id
  (which never appears in `apps`) never mounted a `TerminalModal`. It now
  resolves running instances too, so their terminal opens against the worktree
  path.

## [0.7.22] — 2026-07-12

### Added
- **Switch branches from an app card.** The GitBadge popover gains a "Switch
  branch" section: a searchable list of local and remote-tracking branches,
  in-place checkout of the primary repo, and a "Create <name>" row when the
  search matches nothing (branches from current HEAD). The current branch and
  any branch already checked out in a worktree are shown but disabled. Picking
  a remote-only branch creates a local tracking branch; ambiguous names shared
  across multiple remotes are omitted. Hidden on instance cards, which are
  branch-pinned.
- **Instances are removable.** Running instances remove on Stop (process
  killed, row deleted, Caddy route dropped); a crashed/stopped instance card
  now has a **Remove** button to clear it. The worktree launcher labels the
  action "Stop" while running and "Remove" once stopped.

### Fixed
- **Instances inherit the parent app's `.env` for `source .env` too.** The
  parent's env file is symlinked into the worktree before launch, so a
  `source .env` in the start command no longer fails with "no such file"
  (exit 127) in a fresh worktree where `.env` is gitignored.
- **Collapse chevron on the nested instances region is aligned and centered**,
  and the region's content lines up with the parent card's header.

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
