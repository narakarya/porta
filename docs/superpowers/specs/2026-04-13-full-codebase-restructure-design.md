# Full Codebase Restructure — Hybrid Approach

**Date:** 2026-04-13
**Approach:** Layer-based backend + Domain-based frontend
**Scope:** Big bang restructure of entire Porta codebase

## Problem

Porta's codebase has grown organically to the point where navigation, maintenance, and feature development are slowed by:

1. **Backend monoliths:** `commands.rs` (2,021 lines, 67 handlers across 7+ domains), `db/mod.rs` (all CRUD in one module), `lib.rs` (tray + auto-start + setup tangled)
2. **Frontend component bloat:** DeployModal (1,038 lines), SettingsPage (922), AppSettingsModal (723), AppCard (690)
3. **Code duplication:** ANSI/log utilities copy-pasted 3 times, tunnel status UI duplicated in AppCard + AppSettingsModal
4. **No extraction patterns:** Zero custom hooks, no shared UI primitives, monolithic Zustand store (694 lines)

## Approach

**Hybrid: Layer Backend + Domain Frontend**

- Backend uses layer-based separation (idiomatic Rust: `commands/`, `db/` with sub-modules) because Rust's module system naturally fits `mod.rs` re-export patterns
- Frontend uses domain-based grouping (`components/app/`, `components/deploy/`, etc.) because related React components (modal + card + form) are tightly coupled and benefit from co-location
- Shared utilities and hooks extracted to common layers on both sides

## Backend Restructure

### `commands.rs` (2,021 lines) -> `commands/` module

```
src-tauri/src/commands/
  mod.rs              — re-exports all sub-modules
  setup.rs            — check_setup, run_setup, start_caddy, reload_caddy,
                        caddy_status, regenerate_certs (6 handlers)
  workspace.rs        — list/add/update/delete/reorder workspaces (5 handlers)
  app.rs              — list/add/update/delete apps, detect_start_command,
                        list_available_commands, next_available_port (7 handlers)
  app_lifecycle.rs    — start/stop/restart/kill app, kill_pid, kill_port_holder,
                        mark_app_ready, mark_app_stopped + helpers: start_single,
                        wait_for_port, spawn_port_watcher (8 handlers)
  app_files.rs        — get_app_logs, save_file, reveal_in_finder,
                        open_in_editor (4 handlers)
  service.rs          — list/add/update/delete/reorder services,
                        start/stop service (7 handlers)
  deploy.rs           — check_kamal, kamal_run, install_kamal,
                        parse_kamal_accessories, add/update/delete
                        deploy_custom_cmd + spawn_pty_command helper (7 handlers)
  tunnel.rs           — check_cloudflared, start/stop tunnel (3 handlers)
  terminal.rs         — terminal_open/write/resize/close + TerminalHandle
                        struct + terminals() store (4 handlers)
  gdrive.rs           — set/get gdrive_credentials, gdrive_connect,
                        gdrive_status, gdrive_disconnect, gdrive_sync
                        + OAuth helpers (6 handlers)
  settings.rs         — get/set notifications_enabled, get/set launch_at_login,
                        detect_gdrive_path + config read/write helpers
                        + notify/notify_crash (5 handlers)
  backup.rs           — export_data, import_data, list_backups,
                        restore_backup (4 handlers)
```

Each file owns its domain's command handlers. `mod.rs` re-exports everything so `lib.rs` registration doesn't change pattern — just the import path.

### `db/mod.rs` -> split repos

```
src-tauri/src/db/
  mod.rs              — Database struct + open() + migrate() only
  models.rs           — App, Workspace, Service, CustomDeployCmd (unchanged)
  workspace_repo.rs   — insert/update/delete/list/reorder workspace
  app_repo.rs         — insert/update/delete/list app + port_registry
                        + get/set deploy_custom_cmds + used_ports
  service_repo.rs     — insert/update/delete/list/reorder service
                        + update_service_status
```

Repos are implemented as `impl Database` blocks in separate files. `mod.rs` includes them via `mod workspace_repo;` etc. No trait abstraction needed — just file separation.

### `lib.rs` decomposition

```
src-tauri/src/
  lib.rs              — Tauri Builder setup, plugin registration, window
                        close-to-hide event handler. ~100 lines.
  app_state.rs        — AppState struct definition (Mutex<Database>,
                        ProcessManager, CaddyManager)
  tray.rs             — build_tray_menu(), on_menu_event(),
                        rebuild_tray_menu(). Currently split between
                        lib.rs and commands.rs — consolidate here.
  auto_start.rs       — topo_sort_auto_start() + the background thread
                        that starts apps in dependency order on launch.
                        Currently inlined in lib.rs run() function.
```

### Key tangles to resolve

- `start_single`, `wait_for_port`, `spawn_port_watcher` are currently `pub(crate)` in `commands.rs` and called from `lib.rs` auto-start logic. Move to `commands/app_lifecycle.rs`, have `auto_start.rs` depend on that module.
- `rebuild_tray_menu` is called from multiple command handlers. Move to `tray.rs`, command handlers call `tray::rebuild_tray_menu(app_handle)`.
- `gdrive_sync` inlines its own DB open (bypasses AppState) to avoid lock contention. Document this when moving; it's a known workaround, not a bug.
- `notify()` and `notify_crash()` are utility functions used by multiple domains. Move to `commands/settings.rs` (they depend on notification config) and make `pub(crate)`.

## Frontend Restructure

### New shared utilities

```
src/lib/
  commands.ts         — (unchanged) all Tauri invoke wrappers
  mock-data.ts        — (unchanged)
  log-utils.ts        — NEW: extracted from 3 duplicate locations:
                        ANSI_RE, stripAnsi(), detectLevel(),
                        LEVEL_CLS, LEVEL_BADGE, FILTER_PILLS,
                        highlightLine()
```

### New custom hooks

```
src/hooks/
  useLogScroll.ts     — auto-scroll + manual scroll detection logic
                        (from LogViewer.tsx + DeployModal.tsx)
  useLogFilter.ts     — search text + level filter memoization
                        (from LogViewer.tsx + DeployModal.tsx)
  useAppToast.ts      — registerToast/unregisterToast lifecycle
                        (from AppCard.tsx)
  useKamalStatus.ts   — kamal cache + check_kamal invoke
                        (from DeployModal.tsx)
```

### New shared components

```
src/components/shared/
  Field.tsx            — form field wrapper with label + optional help text.
                         Currently private in AppSettingsModal.tsx, also
                         useful in AddAppModal, AddServiceModal,
                         ServiceSettingsModal.
  EnvVarEditor.tsx     — key/value list editor with add/remove rows.
                         Extracted from AppSettingsModal env section (~80 lines).
  TunnelStatusBadge.tsx — connecting/connected/error badge + URL copy.
                          Duplicated in AppCard tunnel menu +
                          AppSettingsModal tunneling section.
  LogPanel.tsx         — log display with search input, level filter pills,
                         line numbers, copy button, follow-tail scroll.
                         Replaces duplicate implementations in
                         DeployModal (~70 lines) and LogViewer.
  Tooltip.tsx          — (move from components/ root)
```

### Component domain grouping

```
src/components/
  shared/              — Field, EnvVarEditor, TunnelStatusBadge, LogPanel, Tooltip
  layout/              — Layout.tsx, Sidebar.tsx, CommandPalette.tsx
  workspace/           — WorkspaceView.tsx, WorkspaceSettingsModal.tsx,
                         AddWorkspaceModal.tsx, EditWorkspaceModal.tsx,
                         WorkspaceContextMenu.tsx, CanvasView.tsx
  app/                 — AppCard.tsx (~400 lines after extraction),
                         AppDetailSheet.tsx, AppSettingsModal.tsx (~500 lines),
                         AddAppModal.tsx, AppContextMenu.tsx,
                         LogToast.tsx (from AppCard, ~85 lines),
                         TunnelQuickMenu.tsx (from AppCard, ~110 lines)
  service/             — ServiceCard.tsx, ServiceSettingsModal.tsx,
                         AddServiceModal.tsx
  deploy/              — DeployModal.tsx (~350 lines after extraction),
                         DeploymentView.tsx,
                         DeployCommandSidebar.tsx (~180 lines, from DeployModal),
                         DeployCustomCmdForm.tsx (~80 lines, from DeployModal),
                         KamalConsolePane.tsx (~100 lines, from DeployModal)
  settings/            — SettingsPage.tsx (~70 lines shell),
                         SetupSection.tsx (~230 lines),
                         NotificationsSection.tsx (~55 lines),
                         BackupSection.tsx (~245 lines),
                         SyncSection.tsx (~250 lines)
  terminal/            — TerminalModal.tsx, TerminalTab.tsx
  setup/               — SetupWizard.tsx
```

### Zustand store slicing

```
src/store/
  index.ts             — combine all slices via StateCreator pattern,
                         export useStore hook
  slices/
    workspace.ts       — workspaces: Workspace[], addWorkspace(), etc.
    app.ts             — apps, appLogs, appExitCode, appRetryCount,
                         portConflicts, appMetrics + related actions
    service.ts         — services, serviceLogs + related actions
    deploy.ts          — deploySessions + related actions
    ui.ts              — openToasts, setupStatus, notificationsEnabled
                         + related actions
  subscriptions.ts     — _subscribeToAppEvents() extracted (~150 lines
                         of Tauri listen() calls). Called once from
                         App.tsx useEffect.
```

Each slice defines its own interface and actions. Combined in `index.ts` using Zustand's `StateCreator` pattern:

```typescript
// store/slices/workspace.ts
export interface WorkspaceSlice {
  workspaces: Workspace[];
  loadWorkspaces: () => Promise<void>;
  addWorkspace: (name: string, domain: string) => Promise<void>;
  // ...
}

export const createWorkspaceSlice: StateCreator<AllSlices, [], [], WorkspaceSlice> = (set, get) => ({
  workspaces: [],
  loadWorkspaces: async () => { ... },
  // ...
});
```

## Import path updates

All component imports throughout the app need updating. Key patterns:

```typescript
// Before
import { AppCard } from './AppCard';
import { DeployModal } from './DeployModal';

// After
import { AppCard } from './app/AppCard';
import { DeployModal } from './deploy/DeployModal';
```

`App.tsx` and any top-level routing imports are the primary files that need import path changes. Internal imports within a domain folder use relative paths.

## What stays unchanged

- `src/types/index.ts` — centralized types, already well-organized
- `src/lib/commands.ts` — Tauri invoke wrappers, good as-is
- `src/lib/mock-data.ts` — browser mock system, good as-is
- `src-tauri/src/process_manager.rs` — clean, self-contained module
- `src-tauri/src/caddy.rs` — focused on Caddy config generation
- `src-tauri/src/setup.rs` — system dependency installation
- `src-tauri/src/auto_detect.rs` — start command detection
- `src-tauri/src/port_scanner.rs` — port availability checks
- `src-tauri/src/dns.rs` — DNS resolver management
- `src-tauri/src/backup.rs` — export/import logic (the module, not the commands)

## Expected impact

| Metric | Before | After |
|---|---|---|
| Largest backend file | 2,021 lines (commands.rs) | ~200 lines (app_lifecycle.rs) |
| Largest frontend file | 1,038 lines (DeployModal.tsx) | ~400 lines (AppCard.tsx) |
| Code duplication (ANSI/log) | 3 copies | 1 source (log-utils.ts) |
| Custom hooks | 0 | 4 |
| Shared UI primitives | 0 | 5 |
| Zustand store files | 1 (694 lines) | 6 files (~100-150 lines each) |
| Frontend component folders | 1 flat | 9 domain folders |
| Backend command files | 1 | 13 |
| DB operation files | 1 | 4 |

## Risks and mitigations

1. **Rust re-export breakage:** All `#[tauri::command]` handlers must be re-exported through `commands/mod.rs` so the `.invoke_handler(tauri::generate_handler![...])` call in `lib.rs` still works. Mitigation: compile after each module move.

2. **Import path avalanche (frontend):** Moving ~27 component files changes imports across the app. Mitigation: use IDE "move file" refactoring or do a systematic find-replace pass. TypeScript compiler catches all broken imports.

3. **Zustand slice wiring:** Splitting the store requires each slice to access other slices via `get()`. Cross-slice dependencies (e.g., app actions reading workspaces) must use `get()` not direct state access. Mitigation: TypeScript types enforce this — `StateCreator<AllSlices>` gives full access.

4. **Zero behavior change:** This is a pure structural refactor. No logic changes, no API changes, no UI changes. Every test and manual workflow should produce identical results before and after.
