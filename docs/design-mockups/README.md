# Porta redesign — design mockups (source of truth)

These 32 HTML mockups were rendered during the design session and are the **agreed visual target** for the app redesign. Open `index.html` to browse them (iframed gallery), or open any `NN_*.html` directly.

## Agreed direction: **Shell C** (`00_porta_shell_redesign_directions`)

The user compared three shells and chose **C · Rail + content-forward**:

- **Icon rail (~44px)** — top-level domains: Workspaces · Hosts · Activity · Extensions · Settings (bottom). Icons only.
- **Thin contextual list (~170px)** — for Workspaces: apps grouped under workspace headers (e.g. `Mediapress → frontend :3000, api :4000`), status dot + port + update badge baked into each row. Collapse/expand per workspace; add-app from here.
- **Content-forward main** — no card grid. Selecting an app shows its **workbench**: header (`frontend · running · :3000 · pid · Restart · Open`) + tabs (**Logs / Git / Terminal**, extended per `04`) + live content.

NOT direction B (unified 220px sidebar) — that is what the abandoned codex branch (`codex/porta-workbench-redesign`, PR #26) implemented, which is why it looked wrong.

## Base branch

`feat/app-redesign-shell-c` (PR #25). Already scaffolds Shell C: `GlobalRail` (icon rail), `activeDomain` store state, `AppWorkbench` (tabbed), Activity/Extensions domain views, design tokens + `src/components/ui/` primitives. This is the correct foundation — continue here, matching the mockups below. Keep the SSH client (Hosts domain) from v0.10.0 intact.

## Functional guarantees (MUST hold through the redesign)

This is a **big** redesign across many surfaces — the visual change must NOT break
existing, working behavior. The redesign re-skins/relayouts; it does not regress
features. Non-negotiables:

- **Logs** — keep the real LogViewer working: live streaming, severity filter,
  search + match-count, follow, wrap, clear. Wire the redesigned Logs tab to the
  actual log stream, not a static mock.
- **Git** — the core git (poller-backed `appGit`, GitBadge fetch/pull/push/branch
  switch) must keep working. The workbench Git tab / full manager builds on the
  same commands + store; reconcile with the `git-manager` extension rather than
  replacing working core git.
- **Terminal** — must keep working AND gain the agreed improvements: **split panes**
  and **multiple tabs** (plus fullscreen). Preserve keep-warm mounting so switching
  domains/tabs never disposes an xterm/PTY or drops listeners.
- **SSH (Hosts)** — the v0.10.0 SSH client stays fully functional.
- **Tunnel / Publish** — the existing Cloudflare tunnel + DNS + quick/named tunnel
  flows must keep working, AND get the improved UI/UX from mockup **`11` (v2)**:
  local→public routing hero (copy/open/QR), Quick-vs-Named mode switch with
  descriptions, public hostnames list (primary/alias + Add), and access control
  (Public / Password / CF Access). Wire to the real tunnel state/commands.
- General: every redesigned surface must be wired to real state/commands; a mockup
  that currently shows placeholder data must be connected before it's "done".

Because the scope is large, implement **phase by phase**, validating each increment
(tsc + in-browser smoke test) and never leaving a surface half-wired.

## Key decisions from the session

- Workspaces list: **collapse/expand per workspace**, **add app inline** from the list (`03`).
- App primary actions: Start/Stop/Restart **+ Open-in-browser**, accommodate tunnel state (`05`).
- Terminal: **multi-tab, split, fullscreen** (`06`).
- Git: keep the **core git** (GitBadge) but the workbench Git tab is a **full manager** — reconcile with the `git-manager` extension (`08`, `19`); reference the `porta-git-manager` project.
- Deploy = **kamal** extension, Packages = **phoenix-packages** extension (`14`, `16`, `30`).
- Settings: **regroup**, fold updater in (currently under Settings), Cloudflare hub (`07`, `13`, `15`).
- Design tokens + motion language defined (`18`); redesign-friendly architecture = Tokens → Primitives → Features → Shell (`31`).

## Mockup index

> Where a **v2** exists it supersedes v1 — use **`11` (tunnel/publish)** over `09`,
> and **`12` (logs)** over `10`.

| # | File | Surface |
|---|------|---------|
| 00 | porta_shell_redesign_directions | A/B/**C** shell options (C chosen) |
| 01 | porta_A_vs_C_hosts_domain | A vs C on the Hosts domain |
| 02 | porta_C_workspaces_domain | **C applied to Workspaces** (canonical) |
| 03 | porta_workspaces_sidebar_interactions | collapse/expand + add app |
| 04 | porta_workbench_tabs_git_terminal_ext | workbench tab bar (Overview/Logs/Terminal/Git/ext) |
| 05 | porta_app_open_link_actions | app header actions + open-in-browser/tunnel |
| 06 | porta_terminal_tabs_split_fullscreen | terminal multi-tab / split / fullscreen |
| 07 | porta_settings_grouped_cloudflare_hub | settings regroup + Cloudflare hub |
| 08 | porta_git_tab_full | workbench Git tab |
| 09 | porta_tunnel_publish_tab | tunnel / publish |
| 10 | porta_logs_tab | logs tab |
| 11 | porta_tunnel_publish_v2 | tunnel / publish (revised) |
| 12 | porta_logs_tab_v2 | logs tab (revised) |
| 13 | porta_app_update_section | app update section |
| 14 | porta_kamal_deploy_extension | kamal deploy (extension) |
| 15 | porta_self_update | Porta self-update UI |
| 16 | porta_kamal_deploy_redesign_full | kamal deploy (full redesign) |
| 17 | porta_activity_domain | Activity domain |
| 18 | porta_design_tokens_motion | design tokens + motion |
| 19 | porta_git_manager_full_redesign | full git manager |
| 20 | porta_app_config_tab | app config tab |
| 21 | porta_add_app_flow | add app flow |
| 22 | porta_services | services |
| 23 | porta_vps_relay | VPS relay |
| 24 | porta_setup_onboarding | setup / onboarding |
| 25 | porta_command_palette | command palette |
| 26 | porta_worktree_instances | worktree instances |
| 27 | porta_file_editor | file editor |
| 28 | porta_traffic_inspector | traffic inspector |
| 29 | porta_backup_snapshots | backup / snapshots |
| 30 | porta_phoenix_packages | phoenix packages |
| 31 | porta_redesign_friendly_architecture | Tokens→Primitives→Features→Shell |
