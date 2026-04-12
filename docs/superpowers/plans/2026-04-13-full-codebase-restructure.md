# Full Codebase Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure Porta's entire codebase from flat monolithic files into well-organized modules (layer-based backend, domain-based frontend) with zero behavior changes.

**Architecture:** Hybrid approach — Rust backend splits by technical layer (commands/, db/ sub-modules), React frontend groups by domain (components/app/, components/deploy/, etc.) with shared utilities, custom hooks, and Zustand store slices.

**Tech Stack:** Rust/Tauri 2, React 19, TypeScript, Zustand 5, Tailwind CSS

**Spec:** `docs/superpowers/specs/2026-04-13-full-codebase-restructure-design.md`

**Verification strategy:** This is a pure structural refactor. After each task: `cargo build` (backend) or `npx tsc --noEmit` (frontend). Final verification: `cargo build && npm run build` + manual smoke test.

---

## Task 1: Extract AppState to its own module

**Files:**
- Create: `src-tauri/src/app_state.rs`
- Modify: `src-tauri/src/commands.rs` — remove AppState struct
- Modify: `src-tauri/src/lib.rs` — update import path

- [ ] **Step 1: Create `app_state.rs`**

```rust
// src-tauri/src/app_state.rs
use std::path::PathBuf;
use std::sync::Mutex;

use crate::caddy::CaddyManager;
use crate::db::Database;
use crate::process_manager::ProcessManager;

pub struct AppState {
    pub db: Mutex<Database>,
    pub processes: ProcessManager,
    pub caddy: CaddyManager,
    pub db_path: PathBuf,
}
```

- [ ] **Step 2: Update `commands.rs` — remove AppState, import from app_state**

Remove lines 27-32 (the `pub struct AppState { ... }` block). Add at the top of `commands.rs`:

```rust
pub use crate::app_state::AppState;
```

The `pub use` re-export ensures all existing code that does `commands::AppState` still works.

- [ ] **Step 3: Register module in `lib.rs`**

Add `pub mod app_state;` to the module declarations at the top of `lib.rs` (after `pub mod auto_detect;`). The existing `use commands::AppState;` in lib.rs continues to work because of the re-export.

- [ ] **Step 4: Verify compilation**

Run: `cd src-tauri && cargo build 2>&1 | tail -5`
Expected: `Finished` with no errors.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/app_state.rs src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "refactor(backend): extract AppState to its own module"
```

---

## Task 2: Split `db/mod.rs` into domain repos

**Files:**
- Create: `src-tauri/src/db/workspace_repo.rs`
- Create: `src-tauri/src/db/app_repo.rs`
- Create: `src-tauri/src/db/service_repo.rs`
- Modify: `src-tauri/src/db/mod.rs` — keep only Database struct, open(), migrate()

The repos use `impl Database` blocks in separate files. Rust allows multiple `impl` blocks for the same struct across files included via `mod`.

- [ ] **Step 1: Identify the DB method groups**

Read `src-tauri/src/db/mod.rs` and identify exact line ranges for:
- Workspace methods: `insert_workspace`, `update_workspace`, `delete_workspace`, `list_workspaces`, `reorder_workspaces`
- App methods: `insert_app`, `list_apps`, `update_app`, `delete_app`, `update_app_status`, `update_app_status_only`, `get_deploy_custom_cmds`, `set_deploy_custom_cmds`, `used_ports`
- Service methods: `insert_service`, `list_services`, `update_service`, `update_service_status`, `delete_service`, `reorder_services`
- Keep in `mod.rs`: `Database` struct, `open()`, `migrate()`

- [ ] **Step 2: Create `workspace_repo.rs`**

Move all workspace `impl Database` methods into this file:

```rust
// src-tauri/src/db/workspace_repo.rs
use super::models::Workspace;
use super::Database;

impl Database {
    // paste workspace methods here: insert_workspace, update_workspace,
    // delete_workspace, list_workspaces, reorder_workspaces
}
```

- [ ] **Step 3: Create `app_repo.rs`**

Move all app `impl Database` methods into this file:

```rust
// src-tauri/src/db/app_repo.rs
use super::models::{App, CustomDeployCmd};
use super::Database;

impl Database {
    // paste app methods here: insert_app, list_apps, update_app, delete_app,
    // update_app_status, update_app_status_only, get_deploy_custom_cmds,
    // set_deploy_custom_cmds, used_ports
}
```

- [ ] **Step 4: Create `service_repo.rs`**

Move all service `impl Database` methods into this file:

```rust
// src-tauri/src/db/service_repo.rs
use super::models::Service;
use super::Database;

impl Database {
    // paste service methods here: insert_service, list_services, update_service,
    // update_service_status, delete_service, reorder_services
}
```

- [ ] **Step 5: Update `db/mod.rs`**

Remove all moved methods. Add module declarations:

```rust
mod workspace_repo;
mod app_repo;
mod service_repo;
```

`mod.rs` should now contain only: `Database` struct, `open()`, `migrate()`, and the `mod` declarations.

- [ ] **Step 6: Verify compilation**

Run: `cd src-tauri && cargo build 2>&1 | tail -5`
Expected: `Finished` with no errors. Fix any missing imports (e.g., `rusqlite::params` may need to be imported in each repo file).

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/db/
git commit -m "refactor(db): split into workspace, app, service repos"
```

---

## Task 3: Split `commands.rs` into domain modules

This is the largest task. Split the 2,021-line `commands.rs` into 13 domain files under `commands/`.

**Files:**
- Create: `src-tauri/src/commands/` directory with `mod.rs` + 12 domain files
- Delete: `src-tauri/src/commands.rs` (replaced by `commands/` directory)

**Important Rust note:** When you have a file `commands.rs` and want to turn it into a directory `commands/mod.rs`, you rename the file to `commands/mod.rs`. The module path `commands::` stays the same.

- [ ] **Step 1: Create commands directory and move file**

```bash
mkdir -p src-tauri/src/commands
mv src-tauri/src/commands.rs src-tauri/src/commands/mod.rs
```

Verify compilation still works: `cd src-tauri && cargo build 2>&1 | tail -5`

- [ ] **Step 2: Commit the directory move**

```bash
git add src-tauri/src/commands.rs src-tauri/src/commands/mod.rs
git commit -m "refactor(commands): convert commands.rs to commands/mod.rs"
```

- [ ] **Step 3: Extract `commands/terminal.rs`**

Read `commands/mod.rs` and find the terminal-related code:
- `TerminalHandle` struct and the `terminals()` static function
- `terminal_open`, `terminal_write`, `terminal_resize`, `terminal_close` command handlers

Cut these into `commands/terminal.rs`. Add necessary imports (`use` statements for `AppState`, Tauri types, nix, libc, etc.). In `mod.rs`, add:

```rust
mod terminal;
pub use terminal::*;
```

Verify: `cd src-tauri && cargo build 2>&1 | tail -5`

- [ ] **Step 4: Extract `commands/gdrive.rs`**

Find and move: `set_gdrive_credentials`, `get_gdrive_credentials`, `gdrive_connect`, `gdrive_status`, `gdrive_disconnect`, `gdrive_sync`, and any OAuth helper functions/types.

In `mod.rs`, add:
```rust
mod gdrive;
pub use gdrive::*;
```

Verify: `cd src-tauri && cargo build 2>&1 | tail -5`

- [ ] **Step 5: Extract `commands/deploy.rs`**

Find and move: `check_kamal`, `kamal_run`, `install_kamal`, `parse_kamal_accessories`, `add_deploy_custom_cmd`, `update_deploy_custom_cmd`, `delete_deploy_custom_cmd`, and the `spawn_pty_command` helper if it exists.

In `mod.rs`, add:
```rust
mod deploy;
pub use deploy::*;
```

Verify: `cd src-tauri && cargo build 2>&1 | tail -5`

- [ ] **Step 6: Extract `commands/tunnel.rs`**

Find and move: `check_cloudflared`, `start_tunnel`, `stop_tunnel`.

In `mod.rs`, add:
```rust
mod tunnel;
pub use tunnel::*;
```

Verify: `cd src-tauri && cargo build 2>&1 | tail -5`

- [ ] **Step 7: Extract `commands/service.rs`**

Find and move: `list_services`, `add_service`, `update_service`, `delete_service`, `reorder_services`, `start_service`, `stop_service`.

In `mod.rs`, add:
```rust
mod service;
pub use service::*;
```

Verify: `cd src-tauri && cargo build 2>&1 | tail -5`

- [ ] **Step 8: Extract `commands/settings.rs`**

Find and move: `get_notifications_enabled`, `set_notifications_enabled`, `get_launch_at_login`, `set_launch_at_login`, `detect_gdrive_path`, plus the `notify()` and `notify_crash()` helper functions and `read_config`/`write_config` helpers.

Make `notify` and `notify_crash` `pub(crate)` so other command modules can use them.

In `mod.rs`, add:
```rust
mod settings;
pub use settings::*;
```

Verify: `cd src-tauri && cargo build 2>&1 | tail -5`

- [ ] **Step 9: Extract `commands/backup.rs`**

Find and move: `export_data`, `import_data`, `list_backups`, `restore_backup`.

In `mod.rs`, add:
```rust
mod backup;
pub use backup::*;
```

Verify: `cd src-tauri && cargo build 2>&1 | tail -5`

- [ ] **Step 10: Extract `commands/setup.rs`**

Find and move: `check_setup`, `run_setup`, `start_caddy`, `reload_caddy`, `caddy_status`, `regenerate_certs`.

In `mod.rs`, add:
```rust
mod setup;
pub use setup::*;
```

Verify: `cd src-tauri && cargo build 2>&1 | tail -5`

- [ ] **Step 11: Extract `commands/workspace.rs`**

Find and move: `list_workspaces`, `add_workspace`, `update_workspace`, `delete_workspace`, `reorder_workspaces`.

In `mod.rs`, add:
```rust
mod workspace;
pub use workspace::*;
```

Verify: `cd src-tauri && cargo build 2>&1 | tail -5`

- [ ] **Step 12: Extract `commands/app_files.rs`**

Find and move: `get_app_logs`, `save_file`, `reveal_in_finder`, `open_in_editor`.

In `mod.rs`, add:
```rust
mod app_files;
pub use app_files::*;
```

Verify: `cd src-tauri && cargo build 2>&1 | tail -5`

- [ ] **Step 13: Extract `commands/app_lifecycle.rs`**

Find and move: `start_app`, `stop_app`, `restart_app`, `kill_app`, `kill_pid`, `kill_port_holder`, `mark_app_ready`, `mark_app_stopped`, plus helpers `start_single`, `wait_for_port`, `spawn_port_watcher`. Keep these `pub(crate)` — `auto_start.rs` (Task 4) will use `start_single` and `wait_for_port`.

In `mod.rs`, add:
```rust
mod app_lifecycle;
pub use app_lifecycle::*;
```

Verify: `cd src-tauri && cargo build 2>&1 | tail -5`

- [ ] **Step 14: Extract `commands/app.rs`**

Find and move: `list_apps`, `add_app`, `update_app`, `delete_app`, `detect_start_command`, `list_available_commands`, `next_available_port`.

In `mod.rs`, add:
```rust
mod app;
pub use app::*;
```

Verify: `cd src-tauri && cargo build 2>&1 | tail -5`

- [ ] **Step 15: Clean up `commands/mod.rs`**

At this point, `mod.rs` should contain only:
- The `pub use crate::app_state::AppState;` re-export
- All `mod` + `pub use` declarations
- The `rebuild_tray_menu` function (to be moved in Task 4)

Verify: `cd src-tauri && cargo build 2>&1 | tail -5`

- [ ] **Step 16: Commit**

```bash
git add src-tauri/src/commands/
git commit -m "refactor(commands): split into 12 domain modules"
```

---

## Task 4: Extract tray and auto-start from `lib.rs`

**Files:**
- Create: `src-tauri/src/tray.rs`
- Create: `src-tauri/src/auto_start.rs`
- Modify: `src-tauri/src/lib.rs` — slim down to ~50 lines
- Modify: `src-tauri/src/commands/mod.rs` — remove `rebuild_tray_menu`

- [ ] **Step 1: Create `tray.rs`**

Move `rebuild_tray_menu` from `commands/mod.rs` into `tray.rs`. Also extract the tray setup closure from `lib.rs` lines 117-178 (the `.setup(|app| { ... })` tray-building code) into a function:

```rust
// src-tauri/src/tray.rs
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{TrayIconBuilder, TrayIconEvent, MouseButton},
    Emitter, Manager, AppHandle,
};
use std::path::PathBuf;
use crate::app_state::AppState;

/// Build the system tray icon with initial menu (Open Dashboard + Quit).
pub fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    // Move the tray builder code from lib.rs .setup() closure here
    // (lines 118-178 of current lib.rs)
}

/// Rebuild tray menu with per-app toggle items.
/// Called after app state changes (start/stop/auto-start).
pub fn rebuild_tray_menu(handle: &AppHandle, db_path: &PathBuf) {
    // Move from commands/mod.rs
}
```

- [ ] **Step 2: Create `auto_start.rs`**

Move `topo_sort_auto_start` (lib.rs lines 27-75) and the auto-start thread spawn (lib.rs lines 180-204):

```rust
// src-tauri/src/auto_start.rs
use crate::app_state::AppState;
use crate::db::models::App;
use tauri::Manager;

/// Topological sort: returns auto_start apps in dependency order.
pub fn topo_sort_auto_start(all_apps: Vec<App>) -> Vec<App> {
    // Move from lib.rs lines 30-75
}

/// Spawn background thread that starts auto_start apps in dependency order.
pub fn spawn_auto_start(app: &tauri::App) {
    // Move from lib.rs lines 182-204
    // Uses commands::app_lifecycle::start_single and commands::app_lifecycle::wait_for_port
    // Uses tray::rebuild_tray_menu
}
```

- [ ] **Step 3: Slim down `lib.rs`**

After extraction, `lib.rs` should contain only:
- Module declarations (`pub mod` for all modules)
- The `run()` function with: DB open, stale PID cleanup, AppState construction, Tauri Builder with plugins, `.manage(state)`, `.setup()` calling `tray::setup_tray(app)` and `auto_start::spawn_auto_start(app)`, `.invoke_handler()`, `.on_window_event()`, `.run()`.

- [ ] **Step 4: Remove `rebuild_tray_menu` from `commands/mod.rs`**

It now lives in `tray.rs`. Update any callers in command modules to use `crate::tray::rebuild_tray_menu`.

- [ ] **Step 5: Verify compilation**

Run: `cd src-tauri && cargo build 2>&1 | tail -5`
Expected: `Finished` with no errors.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/tray.rs src-tauri/src/auto_start.rs src-tauri/src/lib.rs src-tauri/src/commands/
git commit -m "refactor(backend): extract tray and auto-start from lib.rs"
```

---

## Task 5: Extract shared frontend utilities (`log-utils.ts`)

**Files:**
- Create: `src/lib/log-utils.ts`
- Modify: `src/components/AppCard.tsx` — remove duplicated ANSI utils, import from log-utils
- Modify: `src/components/DeployModal.tsx` — remove duplicated ANSI utils, import from log-utils
- Modify: `src/components/LogViewer.tsx` — remove duplicated ANSI utils, import from log-utils

- [ ] **Step 1: Read all three files to identify the exact duplicated code**

Read the ANSI/log utility code from AppCard.tsx, DeployModal.tsx, and LogViewer.tsx. Note exact function names, regex patterns, and any differences between the copies.

- [ ] **Step 2: Create `src/lib/log-utils.ts`**

Extract the canonical version (use LogViewer's as the source of truth since it's the most complete):

```typescript
// src/lib/log-utils.ts

/** Strip ANSI escape sequences from a string */
export const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/** Detect log level from a line */
export function detectLevel(line: string): string {
  // ... exact implementation from LogViewer
}

/** CSS class map for log levels */
export const LEVEL_CLS: Record<string, string> = {
  // ... from LogViewer
};

/** Badge labels for log levels */
export const LEVEL_BADGE: Record<string, string> = {
  // ... from LogViewer
};

/** Filter pill definitions */
export const FILTER_PILLS = [
  // ... from LogViewer/DeployModal
];

/** Highlight a log line with level-aware styling */
export function highlightLine(line: string): string {
  // ... from LogViewer/DeployModal (if this function exists)
}
```

- [ ] **Step 3: Update AppCard.tsx**

Remove `ANSI_RE`, `stripAnsi`, `filterLog` definitions. Add import:

```typescript
import { ANSI_RE, stripAnsi } from "../lib/log-utils";
```

If `filterLog` is AppCard-specific (not shared), keep it but have it use imported `stripAnsi`.

- [ ] **Step 4: Update DeployModal.tsx**

Remove all ANSI/log utility definitions (lines 7-76 approximately). Add import:

```typescript
import { stripAnsi, detectLevel, LEVEL_CLS, LEVEL_BADGE, FILTER_PILLS, highlightLine } from "../lib/log-utils";
```

- [ ] **Step 5: Update LogViewer.tsx**

Remove all ANSI/log utility definitions. Add the same import as DeployModal.

- [ ] **Step 6: Verify TypeScript compilation**

Run: `npx tsc --noEmit 2>&1 | tail -10`
Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/log-utils.ts src/components/AppCard.tsx src/components/DeployModal.tsx src/components/LogViewer.tsx
git commit -m "refactor(frontend): extract shared log utilities to lib/log-utils.ts"
```

---

## Task 6: Slice the Zustand store

**Files:**
- Create: `src/store/slices/workspace.ts`
- Create: `src/store/slices/app.ts`
- Create: `src/store/slices/service.ts`
- Create: `src/store/slices/deploy.ts`
- Create: `src/store/slices/ui.ts`
- Create: `src/store/subscriptions.ts`
- Modify: `src/store/index.ts` — combine slices

- [ ] **Step 1: Read the full store to understand all state and actions**

Read `src/store/index.ts` completely. Map each state field and action to its slice:
- **workspace**: workspaces, selectedWorkspaceId, load, addWorkspace, updateWorkspace, deleteWorkspace, reorderWorkspaces, selectWorkspace
- **app**: apps, appLogs, appExitCode, appRetryCount, portConflicts, appRestarting, appTunnelErrors, appMetrics, addApp, updateApp, cloneApp, deleteApp, startApp, stopApp, restartApp, killApp, clearAppLogs, dismissPortConflict, startTunnel, stopTunnel, visibleApps
- **service**: services, serviceLogs, loadServices, addService, updateService, deleteService, startService, stopService, clearServiceLogs, reorderServices
- **deploy**: deploySessions, setDeploySelectedCmd, updateDeployCmdState, appendDeployLog
- **ui**: openToasts, notificationsEnabled, setupStatus, loading, error, registerToast, unregisterToast, getToastIndex, checkSetup, loadSettings, setNotificationsEnabled

- [ ] **Step 2: Create the slice type foundation**

Create `src/store/slices/` directory. Each slice file follows this pattern:

```typescript
// src/store/slices/workspace.ts
import type { StateCreator } from "zustand";
import type { Workspace } from "../../types";
import type { AllSlices } from "../index";
import * as cmd from "../../lib/commands";

export interface WorkspaceSlice {
  workspaces: Workspace[];
  selectedWorkspaceId: string | null;
  load: () => Promise<void>;
  selectWorkspace: (id: string | null) => void;
  addWorkspace: (name: string, domain: string) => Promise<void>;
  updateWorkspace: (id: string, name: string, domain: string) => Promise<void>;
  deleteWorkspace: (id: string) => Promise<void>;
  reorderWorkspaces: (fromIndex: number, toIndex: number) => void;
}

export const createWorkspaceSlice: StateCreator<AllSlices, [], [], WorkspaceSlice> = (set, get) => ({
  // Move state + actions from current store
});
```

Create all 5 slice files following this pattern. Each slice moves the relevant state fields and actions from the current monolithic store.

- [ ] **Step 3: Extract `subscriptions.ts`**

Move `_subscribeToAppEvents` to its own file:

```typescript
// src/store/subscriptions.ts
import type { AllSlices } from "./index";

export function subscribeToAppEvents(get: () => AllSlices, set: (partial: Partial<AllSlices>) => void): () => void {
  // Move the entire _subscribeToAppEvents implementation
  // Change from method to standalone function that receives get/set
}
```

- [ ] **Step 4: Rewrite `store/index.ts` to combine slices**

```typescript
// src/store/index.ts
import { create } from "zustand";
import { createWorkspaceSlice, type WorkspaceSlice } from "./slices/workspace";
import { createAppSlice, type AppSlice } from "./slices/app";
import { createServiceSlice, type ServiceSlice } from "./slices/service";
import { createDeploySlice, type DeploySlice } from "./slices/deploy";
import { createUiSlice, type UiSlice } from "./slices/ui";
import { subscribeToAppEvents } from "./subscriptions";

export type AllSlices = WorkspaceSlice & AppSlice & ServiceSlice & DeploySlice & UiSlice & {
  _subscribeToAppEvents: () => () => void;
};

// Re-export types that other files import from store
export type { KamalCmdState, AppDeploySession } from "./slices/deploy";
export { MAX_LOG_LINES } from "./slices/app";

export const usePortaStore = create<AllSlices>((...a) => ({
  ...createWorkspaceSlice(...a),
  ...createAppSlice(...a),
  ...createServiceSlice(...a),
  ...createDeploySlice(...a),
  ...createUiSlice(...a),
  _subscribeToAppEvents: () => {
    const [set, get] = [a[0], a[1]];
    return subscribeToAppEvents(get, set);
  },
}));
```

- [ ] **Step 5: Verify TypeScript compilation**

Run: `npx tsc --noEmit 2>&1 | tail -20`
Expected: No errors. Common issues: cross-slice access needs `get()` from the combined `AllSlices` type.

- [ ] **Step 6: Verify `main.tsx` still works**

The `usePortaStore.getState()._subscribeToAppEvents()` call in `main.tsx` should still work since the combined store exposes it.

- [ ] **Step 7: Commit**

```bash
git add src/store/
git commit -m "refactor(store): slice Zustand store into 5 domain slices + subscriptions"
```

---

## Task 7: Create shared UI components

**Files:**
- Create: `src/components/shared/Field.tsx`
- Create: `src/components/shared/EnvVarEditor.tsx`
- Create: `src/components/shared/TunnelStatusBadge.tsx`
- Modify: `src/components/AppSettingsModal.tsx` — extract Field + EnvVarEditor, use shared TunnelStatusBadge
- Modify: `src/components/AppCard.tsx` — use shared TunnelStatusBadge

- [ ] **Step 1: Extract `Field` component**

Read `AppSettingsModal.tsx` to find the `Field` component definition (near the bottom of the file). Create:

```typescript
// src/components/shared/Field.tsx
interface FieldProps {
  label: string;
  children: React.ReactNode;
  help?: string;
}

export function Field({ label, children, help }: FieldProps) {
  // Exact implementation from AppSettingsModal
}
```

Remove from `AppSettingsModal.tsx`, add import `from "../shared/Field"`.

- [ ] **Step 2: Extract `EnvVarEditor` from AppSettingsModal.tsx**

Read the environment section of AppSettingsModal.tsx. Find the key/value list editor (~80 lines) with add/remove row functionality. Extract into:

```typescript
// src/components/shared/EnvVarEditor.tsx
interface EnvVar {
  key: string;
  value: string;
}

interface EnvVarEditorProps {
  vars: EnvVar[];
  onChange: (vars: EnvVar[]) => void;
}

export function EnvVarEditor({ vars, onChange }: EnvVarEditorProps) {
  // Move the env var key/value list UI from AppSettingsModal
  // Includes: add row, remove row, key/value inputs
}
```

Update AppSettingsModal to import and use `<EnvVarEditor>`.

- [ ] **Step 3: Extract `TunnelStatusBadge`**

Read both AppCard.tsx (tunnel quick menu section) and AppSettingsModal.tsx (tunneling section) to identify the shared tunnel status rendering pattern. Create a shared component:

```typescript
// src/components/shared/TunnelStatusBadge.tsx
interface TunnelStatusBadgeProps {
  status: "connected" | "connecting" | "disconnected" | "error";
  url?: string | null;
  onCopyUrl?: () => void;
}

export function TunnelStatusBadge({ status, url, onCopyUrl }: TunnelStatusBadgeProps) {
  // Common badge rendering shared between AppCard and AppSettingsModal
}
```

Update both AppCard.tsx and AppSettingsModal.tsx to use the shared component.

- [ ] **Step 4: Verify TypeScript compilation**

Run: `npx tsc --noEmit 2>&1 | tail -10`

- [ ] **Step 5: Commit**

```bash
git add src/components/shared/ src/components/AppSettingsModal.tsx src/components/AppCard.tsx
git commit -m "refactor(frontend): extract Field, EnvVarEditor, TunnelStatusBadge shared components"
```

---

## Task 8: Reorganize frontend components into domain folders

This task moves all existing components into their domain folders. No code changes — only file moves and import path updates.

**Files:**
- Move 27 component files into 9 domain folders
- Update all import paths across the app

- [ ] **Step 1: Create domain directories**

```bash
mkdir -p src/components/{layout,workspace,app,service,deploy,settings,terminal,setup}
```

(shared/ already exists from Task 7)

- [ ] **Step 2: Move layout components**

```bash
mv src/components/Layout.tsx src/components/layout/
mv src/components/Sidebar.tsx src/components/layout/
mv src/components/CommandPalette.tsx src/components/layout/
```

- [ ] **Step 3: Move workspace components**

```bash
mv src/components/WorkspaceView.tsx src/components/workspace/
mv src/components/WorkspaceSettingsModal.tsx src/components/workspace/
mv src/components/AddWorkspaceModal.tsx src/components/workspace/
mv src/components/EditWorkspaceModal.tsx src/components/workspace/
mv src/components/WorkspaceContextMenu.tsx src/components/workspace/
mv src/components/CanvasView.tsx src/components/workspace/
```

- [ ] **Step 4: Move app components**

```bash
mv src/components/AppCard.tsx src/components/app/
mv src/components/AppDetailSheet.tsx src/components/app/
mv src/components/AppSettingsModal.tsx src/components/app/
mv src/components/AddAppModal.tsx src/components/app/
mv src/components/AppContextMenu.tsx src/components/app/
mv src/components/LogViewer.tsx src/components/app/
```

- [ ] **Step 5: Move service components**

```bash
mv src/components/ServiceCard.tsx src/components/service/
mv src/components/ServiceSettingsModal.tsx src/components/service/
mv src/components/AddServiceModal.tsx src/components/service/
```

- [ ] **Step 6: Move deploy components**

```bash
mv src/components/DeployModal.tsx src/components/deploy/
mv src/components/DeploymentView.tsx src/components/deploy/
```

- [ ] **Step 7: Move settings components**

```bash
mv src/components/SettingsPage.tsx src/components/settings/
mv src/components/SettingsModal.tsx src/components/settings/
```

- [ ] **Step 8: Move terminal components**

```bash
mv src/components/TerminalModal.tsx src/components/terminal/
mv src/components/TerminalTab.tsx src/components/terminal/
```

- [ ] **Step 9: Move setup components**

```bash
mv src/components/SetupWizard.tsx src/components/setup/
```

- [ ] **Step 10: Move Tooltip to shared**

```bash
mv src/components/Tooltip.tsx src/components/shared/
```

- [ ] **Step 11: Fix all import paths**

This is the critical step. Use TypeScript compiler to find all broken imports:

```bash
npx tsc --noEmit 2>&1 | grep "Cannot find module"
```

For each broken import, update the path. Key files to update:
- `src/App.tsx` — imports Layout, WorkspaceView, SetupWizard, SettingsPage, CommandPalette
- `src/components/layout/Sidebar.tsx` — imports workspace modals, settings
- `src/components/workspace/WorkspaceView.tsx` — imports AppCard, ServiceCard, DeployModal, etc.
- Each component that imports from sibling components

Pattern: `./ComponentName` becomes `./domain/ComponentName` or `../otherdomain/ComponentName`.

- [ ] **Step 12: Verify TypeScript compilation is clean**

Run: `npx tsc --noEmit 2>&1 | tail -20`
Expected: No errors.

- [ ] **Step 13: Commit**

```bash
git add src/
git commit -m "refactor(frontend): reorganize components into domain folders"
```

---

## Task 9: Extract sub-components from large files

**Files:**
- Create: `src/components/app/LogToast.tsx` (from AppCard.tsx)
- Create: `src/components/app/TunnelQuickMenu.tsx` (from AppCard.tsx)
- Create: `src/components/deploy/KamalConsolePane.tsx` (from DeployModal.tsx)
- Create: `src/components/deploy/DeployCommandSidebar.tsx` (from DeployModal.tsx)
- Create: `src/components/deploy/DeployCustomCmdForm.tsx` (from DeployModal.tsx)
- Create: `src/components/settings/SetupSection.tsx` (from SettingsPage.tsx)
- Create: `src/components/settings/NotificationsSection.tsx` (from SettingsPage.tsx)
- Create: `src/components/settings/BackupSection.tsx` (from SettingsPage.tsx)
- Create: `src/components/settings/SyncSection.tsx` (from SettingsPage.tsx)
- Modify: corresponding parent files to import the extracted components

- [ ] **Step 1: Extract LogToast from AppCard.tsx**

Read `AppCard.tsx`, find the `LogToast` component (defined at file level, ~85 lines). Cut into `src/components/app/LogToast.tsx`. Update AppCard to import it.

- [ ] **Step 2: Extract TunnelQuickMenu from AppCard.tsx**

Find the tunnel dropdown JSX section in AppCard (~110 lines). Extract into `src/components/app/TunnelQuickMenu.tsx` with props for app state and action callbacks. Update AppCard.

- [ ] **Step 3: Extract KamalConsolePane from DeployModal.tsx**

Find `KamalConsolePane` component (~100 lines with xterm.js setup). Already a self-contained component — just move to its own file. Update DeployModal.

- [ ] **Step 4: Extract DeployCommandSidebar from DeployModal.tsx**

Find the sidebar command list section (~180 lines). Extract with props for command list, selected command, and action callbacks. Update DeployModal.

- [ ] **Step 5: Extract DeployCustomCmdForm from DeployModal.tsx**

Find the inline custom command add/edit form (~80 lines). Extract with props. Update DeployModal.

- [ ] **Step 6: Extract SettingsPage sections**

Read `SettingsPage.tsx`. Find the four section functions (`SetupSection`, `NotificationsSection`, `BackupSection`, `SyncSection`). Each is already a file-level function — move each to its own file:

- `src/components/settings/SetupSection.tsx`
- `src/components/settings/NotificationsSection.tsx`
- `src/components/settings/BackupSection.tsx`
- `src/components/settings/SyncSection.tsx`

Update SettingsPage.tsx to import and render them. SettingsPage becomes a ~70-line shell.

- [ ] **Step 7: Verify TypeScript compilation**

Run: `npx tsc --noEmit 2>&1 | tail -20`
Expected: No errors.

- [ ] **Step 8: Commit**

```bash
git add src/components/
git commit -m "refactor(frontend): extract sub-components from large files"
```

---

## Task 10: Create custom hooks

**Files:**
- Create: `src/hooks/useLogScroll.ts`
- Create: `src/hooks/useLogFilter.ts`
- Modify: `src/components/app/LogViewer.tsx` — use hooks
- Modify: `src/components/deploy/DeployModal.tsx` — use hooks

- [ ] **Step 1: Read LogViewer.tsx and DeployModal.tsx to identify shared scroll/filter logic**

Find the auto-scroll detection pattern (checking if user has scrolled up, auto-scrolling on new logs) and the search/filter logic (text search + level filtering).

- [ ] **Step 2: Create `src/hooks/useLogScroll.ts`**

```typescript
// src/hooks/useLogScroll.ts
import { useRef, useEffect, useCallback } from "react";

interface UseLogScrollOptions {
  logs: string[];
  followTail: boolean;
}

export function useLogScroll({ logs, followTail }: UseLogScrollOptions) {
  // Extract scroll ref management, auto-scroll on new logs,
  // manual scroll detection from LogViewer/DeployModal
  // Return: { containerRef, isAtBottom, scrollToBottom }
}
```

- [ ] **Step 3: Create `src/hooks/useLogFilter.ts`**

```typescript
// src/hooks/useLogFilter.ts
import { useMemo, useState } from "react";
import { stripAnsi, detectLevel } from "../lib/log-utils";

export function useLogFilter(logs: string[]) {
  // Extract search text state, active level filters, filtered logs memo
  // Return: { search, setSearch, activeFilters, toggleFilter, filteredLogs }
}
```

- [ ] **Step 4: Update LogViewer.tsx and DeployModal.tsx to use the hooks**

Replace inline logic with hook calls. This should reduce each file by 30-50 lines.

- [ ] **Step 5: Verify TypeScript compilation**

Run: `npx tsc --noEmit 2>&1 | tail -10`

- [ ] **Step 6: Commit**

```bash
git add src/hooks/ src/components/app/LogViewer.tsx src/components/deploy/DeployModal.tsx
git commit -m "refactor(frontend): extract useLogScroll and useLogFilter hooks"
```

---

## Task 11: Full build verification and cleanup

**Files:**
- No new files
- Potential small fixes across the codebase

- [ ] **Step 1: Full Rust build**

Run: `cd src-tauri && cargo build 2>&1 | tail -10`
Expected: `Finished` with no errors.

- [ ] **Step 2: Full TypeScript check**

Run: `npx tsc --noEmit 2>&1 | tail -10`
Expected: No errors.

- [ ] **Step 3: Full Vite build**

Run: `npm run build 2>&1 | tail -10`
Expected: Build succeeds.

- [ ] **Step 4: Check for leftover empty files or stale imports**

```bash
# Check if any component files are left in the flat components/ root
ls src/components/*.tsx 2>/dev/null
```

Expected: No files (all moved to sub-folders). If any remain, move them to the appropriate domain folder.

- [ ] **Step 5: Check for duplicate `isTauri` declarations**

The spec noted that `isTauri` is re-declared locally in some files. Fix any remaining local declarations to import from `lib/commands.ts`:

```bash
grep -r "const isTauri" src/components/ --include="*.tsx"
```

Replace local declarations with `import { isTauri } from "../lib/commands";` (adjusting the relative path).

- [ ] **Step 6: Smoke test**

Run the app: `npm run tauri dev`
Verify:
- App opens, sidebar shows workspaces
- Can start/stop an app
- Settings page opens and all sections render
- Deploy modal opens
- Terminal opens

- [ ] **Step 7: Final commit**

```bash
git add -A
git commit -m "refactor: cleanup and verify full codebase restructure"
```
