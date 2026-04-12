# Deploy Modal — State Persistence & Custom Commands

**Date:** 2026-04-13
**Branch:** feat/v0.2-reliable

---

## Problem

Two issues with the current deploy feature:

1. **State loss on close** — `cmdStates` (logs, running status, exit codes) lives in local `useState` inside `DeployModal`. Closing the modal unmounts the component and destroys all state. The PTY process on the Rust side keeps running, but the frontend loses all output and cannot reconnect.

2. **Hardcoded Rails commands** — The `COMMANDS` array hardcodes `bin/rails console` as the only exec option. Kamal deploys any Docker app; the console command must not assume Rails. There is also no way to add project-specific commands.

---

## Goals

- Closing and reopening `DeployModal` preserves all logs, running state, and selected command.
- Active deploys (PTY still running) reconnect their output stream when the modal reopens.
- Common Kamal commands are always present (hardcoded).
- Accessories defined in `deploy.yml` surface as auto-generated commands.
- Users can add, edit, and delete custom exec commands per app, inline in the modal.
- No Rails assumptions remain in the fixed command set.

---

## Architecture

### 1. Deploy Session State — Lifted to Zustand

Move all ephemeral deploy state from component-local `useState` into the global Zustand store, keyed by `appId`.

**New store slice** (`src/store/index.ts`):

```typescript
interface KamalCmdState {
  logs: string[];
  running: boolean;
  exitCode: number | null;
  startedAt: number | null;
  runId: string | null; // stored so modal can re-attach on reopen
}

interface AppDeploySession {
  cmdStates: Record<string, KamalCmdState>;
  selectedCmdId: string;
}

// Added to PortaState:
deploySessions: Record<string, AppDeploySession>;

// Actions:
setDeploySession: (appId: string, session: Partial<AppDeploySession>) => void;
updateDeployCmdState: (appId: string, cmdId: string, patch: Partial<KamalCmdState>) => void;
appendDeployLog: (appId: string, cmdId: string, line: string) => void;
```

**Re-attachment on modal reopen:**
On mount, `DeployModal` inspects `deploySessions[app.id]`. For any `cmdId` where `running === true` and `runId !== null`, it calls `listen("kamal:log:{runId}", ...)` and `listen("kamal:exit:{runId}", ...)` to reconnect the output stream. If the PTY already finished, the exit event fires immediately (Tauri buffers last-event-per-channel for a short window) or the command stays marked running until the user next opens — acceptable, the logs are still visible.

### 2. Command Tiers

Three tiers of commands shown in the sidebar, rendered in order:

#### Tier 1 — Fixed (hardcoded)

Always present, no user action needed. Rails-specific entries removed.

| ID | Label | Args | Group | Flags |
|----|-------|------|-------|-------|
| `deploy` | Deploy | `["deploy"]` | Deploy | confirm |
| `rollback` | Rollback | `["rollback"]` | Deploy | confirm |
| `lock-release` | Release Lock | `["lock", "release"]` | Deploy | confirm |
| `app-logs` | App Logs | `["app", "logs", "-f"]` | App | safe |
| `app-details` | Details | `["app", "details"]` | App | safe |
| `app-start` | Start | `["app", "start"]` | App | — |
| `app-stop` | Stop | `["app", "stop"]` | App | — |
| `app-restart` | Restart | `["app", "restart"]` | App | confirm |
| `exec-bash` | Bash Shell | `["app", "exec", "--reuse", "-i", "bash"]` | Console | interactive |
| `server-reboot` | Server Reboot | `["server", "reboot"]` | Server | confirm |
| `server-exec` | Server Info | `["server", "exec", "hostname && uname -a"]` | Server | safe |
| `audit` | Audit | `["audit"]` | Debug | safe |
| `version` | Version | `["version"]` | Debug | safe |

#### Tier 2 — Accessories (parsed from deploy.yml)

A new Rust command `parse_kamal_accessories(config_path: String) -> Vec<String>` reads the YAML and returns accessory names. Frontend generates two commands per accessory:

- `kamal accessory exec <name> bash` → interactive bash in the accessory container
- `kamal accessory logs <name> -f` → streaming logs

These are displayed under an "Accessories" group and refresh when the modal opens (no polling).

**Rust implementation:** Uses the `serde_yaml` crate (already available) to deserialize only the `accessories` key from `deploy.yml`. Returns a `Vec<String>` of names. If parsing fails or the key is absent, returns an empty list — no error shown to user.

#### Tier 3 — Custom (user-defined, stored in DB)

User-defined commands, stored as `deploy_custom_commands` JSON column on the `apps` table.

**Schema** (Rust):
```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomDeployCmd {
    pub id: String,        // nanoid, client-generated
    pub label: String,
    pub args: Vec<String>, // raw kamal args, e.g. ["app", "exec", "-i", "bin/console"]
    pub interactive: bool, // open xterm pane vs log viewer
}
```

**DB migration:** `ALTER TABLE apps ADD COLUMN deploy_custom_commands TEXT NOT NULL DEFAULT '[]'`.

**Tauri commands:**
- `add_deploy_custom_cmd(app_id, cmd: CustomDeployCmd) -> Result<(), String>`
- `update_deploy_custom_cmd(app_id, cmd: CustomDeployCmd) -> Result<(), String>`
- `delete_deploy_custom_cmd(app_id, cmd_id: String) -> Result<(), String>`

These are thin wrappers that load the app, update the JSON field, and save.

### 3. Custom Command UI — Inline in DeployModal

**Sidebar footer** — A small "+ Add command" button below the command list. Clicking opens an inline form (not a separate modal) that slides in at the bottom of the sidebar.

**Inline form fields:**
- Label (text input, required)
- Args (text input, space-separated, e.g. `app exec -i bin/console`, required)
- Interactive toggle (checkbox — opens xterm vs log viewer)
- Save / Cancel buttons

**Edit/delete** — Each custom command row in the sidebar shows a `⋯` menu on hover with Edit and Delete options. Edit re-opens the same inline form populated with current values.

**Validation:** Label must be non-empty. Args must have at least one token. No duplicate labels within the same app.

---

## Data Flow

```
User clicks "Deploy"
  → execCommand(cmd)
  → generate runId = `run-deploy-${Date.now()}`
  → store.updateDeployCmdState(appId, "deploy", { running: true, runId, logs: [], ... })
  → attach listen("kamal:log:{runId}") → store.appendDeployLog(appId, "deploy", line)
  → attach listen("kamal:exit:{runId}") → store.updateDeployCmdState(appId, "deploy", { running: false, exitCode })
  → call kamalRun(appId, configPath, ["deploy"], runId)

User closes modal
  → component unmounts
  → Tauri listeners are removed (listen returns unlisten fn, called in useEffect cleanup)
  → store.deploySessions[appId] preserved ✓
  → PTY process continues on Rust side ✓

User reopens modal
  → component mounts
  → reads store.deploySessions[appId]
  → for each cmd where running === true && runId !== null:
      → re-attach listen("kamal:log:{runId}") and listen("kamal:exit:{runId}")
  → logs are visible immediately from store ✓
  → new output continues streaming ✓
```

---

## Files Changed

| File | Change |
|------|--------|
| `src/store/index.ts` | Add `deploySessions` slice and actions |
| `src/components/DeployModal.tsx` | Read/write from store; add accessories tier; add custom command UI |
| `src/lib/commands.ts` | Add `parseKamalAccessories`, `addDeployCustomCmd`, `updateDeployCustomCmd`, `deleteDeployCustomCmd` |
| `src/types/index.ts` | Add `CustomDeployCmd` type |
| `src-tauri/src/commands.rs` | Add `parse_kamal_accessories`, `add_deploy_custom_cmd`, `update_deploy_custom_cmd`, `delete_deploy_custom_cmd` |
| `src-tauri/src/db/mod.rs` | Add `get/set_deploy_custom_cmds` helpers |
| `src-tauri/src/db/models.rs` | Add `deploy_custom_commands: Vec<CustomDeployCmd>` to `App` |
| `src-tauri/src/lib.rs` | Register new Tauri commands |
| Migration (inline in `db/mod.rs`) | `ALTER TABLE apps ADD COLUMN deploy_custom_commands TEXT NOT NULL DEFAULT '[]'` |

---

## Out of Scope

- Showing live deploy status / progress parsing (separate feature)
- Multi-environment support (separate feature)
- Kamal 2.x proxy commands (can be added as custom commands by user)
- Accessory-specific custom commands (accessories from deploy.yml get bash + logs only)
