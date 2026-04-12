# Porta Roadmap Design — v0.2 → v0.4

**Date:** 2026-04-12  
**Status:** Draft  
**Author:** Nasrul Gunawan  
**Target:** Personal use first → Public release

---

## Overview

Porta is a macOS dev environment manager (Tauri + React + TypeScript) that manages workspaces, apps, Caddy reverse proxy, and dnsmasq DNS. This document defines the feature roadmap across three phases, following a user journey of: **Reliable → Powerful → Shareable**.

---

## Phase v0.2 — "Reliable"

Goal: Porta works without being watched. Core experience is solid before adding new capabilities.

### 1. Auto-restart on Crash

**What:** When an app process exits unexpectedly (non-zero exit code or killed), Porta automatically restarts it up to a configurable max retry count.

**How:**
- In `process_manager.rs`, after spawning a process, watch exit status in a background thread
- If exit is unexpected, check retry count against configured max (default: 3)
- Emit `app:crashed` event to frontend on crash, `app:restarted` on restart, `app:max-retries` when giving up
- Add `restart_policy` field to App model: `"never" | "always" | "on-failure"` (default: `"on-failure"`)
- Add `max_retries: u8` field (default: 3) and `retry_count` in runtime state

**UI:** Toggle in App Settings Modal with retry count input. AppCard shows restart count badge when > 0.

---

### 2. Environment Variables per App

**What:** UI to define key-value env vars per app. Porta injects them when spawning the process.

**How:**
- Add `env_vars` column to `apps` table in SQLite (stored as JSON string)
- In `process_manager.rs`, merge app env vars into `Command::envs()`
- Add DB migration for the new column
- New `EnvVarsEditor` component: key-value table with add/remove rows, no external deps

**UI:** Tab "Environment" in App Settings Modal. Simple table UI — key input | value input | delete button.

**Security note:** Env vars are stored in plaintext in `~/.porta/porta.db`. For secrets, user should use system keychain — out of scope for v0.2.

---

### 3. Desktop Notifications

**What:** macOS native notifications for key app lifecycle events.

**Events to notify:**
- App is ready (port accepting connections) — "✓ app-name is ready"
- App crashed — "✗ app-name crashed (retry 2/3)"
- App hit max retries and gave up — "✗ app-name stopped after 3 retries"
- Setup completed — "Porta setup complete"

**How:**
- Use `tauri-plugin-notification` (already in Tauri ecosystem)
- Emit from existing event hooks in `commands.rs` and `process_manager.rs`
- Add global toggle in Settings: "Enable notifications" (default: on)

---

### 4. Log Search & Filtering

**What:** Search and filter within the existing LogViewer.

**How:**
- LogViewer already stores lines in React state — add client-side filter
- Search input: filters lines containing the query (case-insensitive)
- Level filter: detect common patterns (`ERROR`, `WARN`, `INFO`, `DEBUG`) and add filter chips
- "Clear logs" button (already partially present — confirm it works)
- Auto-scroll toggle (stick to bottom vs. free scroll)

**UI:** Toolbar above log output: `[🔍 search input] [ERROR] [WARN] [INFO] [⬇ auto-scroll]`

---

## Phase v0.3 — "Powerful"

Goal: Porta becomes a full local dev platform — services, smart orchestration, visibility.

### 5. Services (Docker-based)

**What:** Run infrastructure services (PostgreSQL, Redis, MySQL, etc.) as Docker containers managed by Porta.

**Scope:**
- **Hybrid model:** Services are global (shared across workspaces) by default. A workspace can opt to use its own isolated instance per service.
- Services are separate from Apps in the data model — different UI section, different lifecycle.

**How:**
- New `services` table in SQLite: `id, name, image, tag, port, env_vars, scope ("global" | workspace_id), status, container_id`
- New `docker_manager.rs` in Rust: wraps `docker` CLI commands (start, stop, ps, logs)
  - Check Docker availability on startup; warn if not installed
  - Support OrbStack, Colima, Docker Desktop (all expose same CLI)
- Tauri commands: `add_service`, `start_service`, `stop_service`, `list_services`, `get_service_logs`

**Built-in presets (v0.3):**
| Service | Image | Default Port |
|---------|-------|-------------|
| PostgreSQL | postgres:16 | 5432 |
| MySQL | mysql:8 | 3306 |
| Redis | redis:7 | 6379 |
| MongoDB | mongo:7 | 27017 |
| Mailpit | axllent/mailpit | 1025 / 8025 |

**UI:**
- New "Services" section in Sidebar below workspaces
- `ServiceCard` component: similar to AppCard — name, image:tag, port, status dot, start/stop button
- "Add Service" modal: pick preset or custom image, configure port/env vars, choose scope

---

### 6. App Start Order / Dependencies

**What:** Define startup order for apps within a workspace. App B waits for App A to be ready before starting.

**How:**
- Add `depends_on: Vec<app_id>` to App model (stored as JSON array in DB)
- When "Start All" is triggered, Porta topological-sorts apps and starts them in order
- Uses existing `spawn_port_watcher` to know when each app is ready before starting the next
- Circular dependency detection at save time — show error in UI

**UI:**
- In WorkspaceView, apps show numbered order badges when dependency chain is set
- In App Settings Modal: "Start after" multi-select dropdown listing other apps in the workspace
- Drag-to-reorder in WorkspaceView adjusts display order (not dependency — those are separate)

**Future vision (not in scope now):** Interactive n8n-style canvas for visualizing and editing the dependency graph.

---

### 7. Resource Monitoring (CPU & Memory per App)

**What:** Show real-time CPU and memory usage per running app in AppCard.

**How:**
- In Rust, poll `/proc`-equivalent on macOS via `sysinfo` crate (already common in Tauri apps)
- Emit `app:metrics` events every 2 seconds for running apps with `{ id, cpu_percent, mem_mb }`
- Frontend subscribes and updates Zustand store

**UI:** Small metrics row in AppCard when app is running: `CPU 1.2% · MEM 128 MB`. Subtle, not intrusive.

---

### 8. Quick Launch from Menu Bar (Tray)

**What:** Tray menu shows per-workspace submenus with start/stop toggles — without opening the main window.

**How:**
- In `lib.rs`, rebuild tray menu dynamically when app state changes
- Tauri supports dynamic menu rebuilding via `app.tray_by_id().set_menu()`
- Menu structure: `Open Dashboard | --- | [Workspace A] > App1 ▶ | App2 ■ | --- | [Workspace B] > ...`

**Constraint:** Menu rebuilds on app start/stop events. Debounce to avoid rapid rebuilds.

---

## Phase v0.4 — "Shareable"

Goal: Porta is ready for public. Config is portable, onboarding is smooth.

### 9. Config Sync (Multi-machine)

**What:** Sync Porta workspace + app config across machines via a Git repo or iCloud Drive.

**How:**
- Export format: existing `.porta` JSON backup format (already implemented in `backup.rs`)
- Add "Sync" settings tab: configure sync target (Git repo URL or iCloud path)
- On change (add/edit/remove workspace or app), auto-export to sync target
- On startup, import from sync target if newer than local

**Git sync flow:**
- Clone/pull → compare timestamps → merge (last-write-wins on conflict, warn user)
- Commit + push on every change

**Scope boundary:** Services config syncs, but Docker container data does not. Each machine manages its own container state.

---

### 10. App Templates

**What:** Pre-configured app presets for common stacks to speed up adding new apps.

**Templates (v0.4):**
- Next.js — `npm run dev`, port 3000, detect from `next.config.*`
- Vite — `npm run dev`, port 5173
- Rails — `bin/rails server`, port 3000
- Django — `python manage.py runserver`, port 8000
- FastAPI — `uvicorn main:app --reload`, port 8000
- Laravel — `php artisan serve`, port 8000

**How:** Template JSON bundled in app binary. Auto-detect already exists in `auto_detect.rs` — templates augment this with more opinionated defaults.

---

### 11. Startup on Login + Auto-start Apps

**What:** Launch Porta on macOS login. Mark apps to auto-start when Porta launches.

**How:**
- Login item via `tauri-plugin-autostart`
- Add `auto_start: bool` field to App model
- On Porta launch, start all apps where `auto_start = true` in dependency order

**UI:** Toggle in App Settings: "Auto-start when Porta launches". Global toggle in Settings: "Launch Porta on login".

---

## Future Vision (No Timeline)

- **n8n-style dependency canvas** — Interactive drag-and-connect node graph for app orchestration. Would position Porta as "n8n for dev environments".
- **Custom Caddy rules per app** — UI for headers, redirects, rate limiting per app.
- **Team sharing** — Share workspace config with teammates via invite link.
- **Plugin system** — Community service presets, custom auto-detect rules.

---

## Technical Constraints

- macOS only for now (Tauri build targets darwin only per CI config)
- Docker must be installed separately for Services feature — Porta detects and warns if missing
- SQLite migrations must be backward-compatible — older `.porta` backup files should still import
- All Rust crate additions must be evaluated for binary size impact (universal macOS build)

---

## Release Criteria per Phase

| Phase | Ship when... |
|-------|-------------|
| v0.2 | Auto-restart, env vars, notifications, log search all working on personal machine |
| v0.3 | Services can run Postgres + Redis reliably; dependency chain works for 3+ app workspace |
| v0.4 | Config round-trips cleanly between two machines; templates cover 80% of common stacks |
