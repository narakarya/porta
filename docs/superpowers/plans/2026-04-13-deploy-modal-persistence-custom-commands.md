# Deploy Modal — State Persistence & Custom Commands

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix deploy session state being lost on modal close, remove Rails assumptions from command list, add accessories auto-detection from deploy.yml, and let users define custom exec commands per app.

**Architecture:** Lift `cmdStates` from local `useState` into Zustand store (keyed by `appId`) so logs survive modal unmount. New Rust command parses `deploy.yml` accessories. Custom commands stored as JSON in a new `deploy_custom_commands` DB column. All three command tiers (fixed, accessories, custom) rendered in one sidebar.

**Tech Stack:** Rust (rusqlite, serde_json, serde_yaml), TypeScript, React, Zustand, Tauri invoke/events.

---

## File Map

| File | Change |
|------|--------|
| `src-tauri/Cargo.toml` | Add `serde_yaml = "0.9"` |
| `src-tauri/src/db/models.rs` | Add `deploy_custom_commands: Vec<CustomDeployCmd>` + new struct |
| `src-tauri/src/db/mod.rs` | Migration + `get/set_deploy_custom_cmds` helpers |
| `src-tauri/src/commands.rs` | Add `parse_kamal_accessories`, `add/update/delete_deploy_custom_cmd` |
| `src-tauri/src/lib.rs` | Register 4 new commands |
| `src/types/index.ts` | Add `CustomDeployCmd` type |
| `src/lib/commands.ts` | Add `parseKamalAccessories`, `addDeployCustomCmd`, `updateDeployCustomCmd`, `deleteDeployCustomCmd` |
| `src/store/index.ts` | Add `deploySessions` slice + 3 actions |
| `src/components/DeployModal.tsx` | Lift state to store; update fixed commands; accessories tier; custom command UI |

---

### Task 1: DB migration + Rust model

**Files:**
- Modify: `src-tauri/src/db/models.rs`
- Modify: `src-tauri/src/db/mod.rs`

- [ ] **Step 1: Add `CustomDeployCmd` struct and field to `App` in models.rs**

In `src-tauri/src/db/models.rs`, add at the top (after existing imports):

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomDeployCmd {
    pub id: String,
    pub label: String,
    pub args: Vec<String>,
    pub interactive: bool,
}
```

Then add the field to `App` struct, right after `deploy_config_path`:

```rust
    /// User-defined custom deploy commands, stored as JSON in DB.
    #[serde(default)]
    pub deploy_custom_commands: Vec<CustomDeployCmd>,
```

- [ ] **Step 2: Add DB migration in `db/mod.rs`**

At the end of the `migrate()` method in `src-tauri/src/db/mod.rs`, before `Ok(())`:

```rust
        let _ = self.conn.execute(
            "ALTER TABLE apps ADD COLUMN deploy_custom_commands TEXT NOT NULL DEFAULT '[]'",
            [],
        );
```

- [ ] **Step 3: Add helpers `get_deploy_custom_cmds` and `set_deploy_custom_cmds` in `db/mod.rs`**

Add these two methods to `impl Database`, after the existing `update_app` method:

```rust
    pub fn get_deploy_custom_cmds(&self, app_id: &str) -> Result<Vec<models::CustomDeployCmd>> {
        let raw: String = self.conn.query_row(
            "SELECT COALESCE(deploy_custom_commands, '[]') FROM apps WHERE id = ?1",
            params![app_id],
            |r| r.get(0),
        )?;
        Ok(serde_json::from_str(&raw).unwrap_or_default())
    }

    pub fn set_deploy_custom_cmds(
        &self,
        app_id: &str,
        cmds: &[models::CustomDeployCmd],
    ) -> Result<()> {
        let json = serde_json::to_string(cmds).unwrap_or_else(|_| "[]".into());
        self.conn.execute(
            "UPDATE apps SET deploy_custom_commands = ?1 WHERE id = ?2",
            params![json, app_id],
        )?;
        Ok(())
    }
```

- [ ] **Step 4: Update `list_apps` to read `deploy_custom_commands` from DB**

In `db/mod.rs`, update the `list_apps` SELECT statement to include the new column:

```rust
    pub fn list_apps(&self) -> Result<Vec<App>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, workspace_id, name, root_dir, port, subdomain,
                    start_command, start_command_source, status, pid,
                    env_file, auto_start, env_vars, restart_policy, max_retries,
                    health_check_path, depends_on, extra_subdomains,
                    COALESCE(deploy_custom_commands, '[]')
             FROM apps ORDER BY rowid"
        )?;
        let rows = stmt.query_map([], |row| {
            let env_vars_str: String = row.get::<_, Option<String>>(12)?.unwrap_or_else(|| "{}".into());
            let env_vars: HashMap<String, String> = serde_json::from_str(&env_vars_str).unwrap_or_default();
            let restart_policy: String = row.get::<_, Option<String>>(13)?.unwrap_or_else(|| "on-failure".into());
            let max_retries: u8 = row.get::<_, Option<i32>>(14)?.unwrap_or(3) as u8;
            let health_check_path: Option<String> = row.get(15)?;
            let depends_on_str: String = row.get::<_, Option<String>>(16)?.unwrap_or_else(|| "[]".into());
            let depends_on: Vec<String> = serde_json::from_str(&depends_on_str).unwrap_or_default();
            let extra_subdomains_str: String = row.get::<_, Option<String>>(17)?.unwrap_or_else(|| "[]".into());
            let extra_subdomains: Vec<String> = serde_json::from_str(&extra_subdomains_str).unwrap_or_default();
            let custom_cmds_str: String = row.get::<_, Option<String>>(18)?.unwrap_or_else(|| "[]".into());
            let deploy_custom_commands: Vec<models::CustomDeployCmd> = serde_json::from_str(&custom_cmds_str).unwrap_or_default();
            Ok(App {
                id: row.get(0)?,
                workspace_id: row.get(1)?,
                name: row.get(2)?,
                root_dir: row.get(3)?,
                port: row.get(4)?,
                subdomain: row.get(5)?,
                start_command: row.get(6)?,
                start_command_source: row.get(7)?,
                status: row.get(8)?,
                pid: row.get(9)?,
                env_file: row.get(10)?,
                auto_start: row.get::<_, i32>(11).map(|v| v != 0)?,
                env_vars,
                restart_policy,
                max_retries,
                health_check_path,
                depends_on,
                extra_subdomains,
                tunnel_provider: None,
                tunnel_url: None,
                tunnel_active: false,
                deploy_config_path: None,
                deploy_custom_commands,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(anyhow::Error::from)
    }
```

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/db/models.rs src-tauri/src/db/mod.rs
git commit -m "feat(db): add deploy_custom_commands column + helpers"
```

---

### Task 2: Add serde_yaml + Rust commands

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/commands.rs`

- [ ] **Step 1: Add serde_yaml dependency**

In `src-tauri/Cargo.toml`, add under `[dependencies]`:

```toml
serde_yaml = "0.9"
```

- [ ] **Step 2: Add `parse_kamal_accessories` command in `commands.rs`**

Add this function anywhere after the existing kamal commands (around line 1418):

```rust
#[tauri::command]
pub fn parse_kamal_accessories(config_path: String) -> Vec<String> {
    let Ok(content) = std::fs::read_to_string(&config_path) else {
        return vec![];
    };
    let Ok(value) = serde_yaml::from_str::<serde_yaml::Value>(&content) else {
        return vec![];
    };
    value
        .get("accessories")
        .and_then(|v| v.as_mapping())
        .map(|m| {
            m.keys()
                .filter_map(|k| k.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}
```

- [ ] **Step 3: Add `add_deploy_custom_cmd` command**

```rust
#[tauri::command]
pub fn add_deploy_custom_cmd(
    state: State<AppState>,
    app_id: String,
    cmd: serde_json::Value,
) -> Result<(), String> {
    let new_cmd: crate::db::models::CustomDeployCmd =
        serde_json::from_value(cmd).map_err(|e| e.to_string())?;
    let db = state.db.lock().unwrap();
    let mut cmds = db.get_deploy_custom_cmds(&app_id).map_err(|e| e.to_string())?;
    if cmds.iter().any(|c| c.id == new_cmd.id) {
        return Err("Command with this id already exists".into());
    }
    cmds.push(new_cmd);
    db.set_deploy_custom_cmds(&app_id, &cmds).map_err(|e| e.to_string())
}
```

- [ ] **Step 4: Add `update_deploy_custom_cmd` command**

```rust
#[tauri::command]
pub fn update_deploy_custom_cmd(
    state: State<AppState>,
    app_id: String,
    cmd: serde_json::Value,
) -> Result<(), String> {
    let updated: crate::db::models::CustomDeployCmd =
        serde_json::from_value(cmd).map_err(|e| e.to_string())?;
    let db = state.db.lock().unwrap();
    let mut cmds = db.get_deploy_custom_cmds(&app_id).map_err(|e| e.to_string())?;
    let pos = cmds.iter().position(|c| c.id == updated.id)
        .ok_or_else(|| "Command not found".to_string())?;
    cmds[pos] = updated;
    db.set_deploy_custom_cmds(&app_id, &cmds).map_err(|e| e.to_string())
}
```

- [ ] **Step 5: Add `delete_deploy_custom_cmd` command**

```rust
#[tauri::command]
pub fn delete_deploy_custom_cmd(
    state: State<AppState>,
    app_id: String,
    cmd_id: String,
) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    let mut cmds = db.get_deploy_custom_cmds(&app_id).map_err(|e| e.to_string())?;
    cmds.retain(|c| c.id != cmd_id);
    db.set_deploy_custom_cmds(&app_id, &cmds).map_err(|e| e.to_string())
}
```

- [ ] **Step 6: Register all 4 new commands in `lib.rs`**

In `src-tauri/src/lib.rs`, add to the `invoke_handler` list (after `commands::install_kamal`):

```rust
            commands::parse_kamal_accessories,
            commands::add_deploy_custom_cmd,
            commands::update_deploy_custom_cmd,
            commands::delete_deploy_custom_cmd,
```

- [ ] **Step 7: Verify Rust compiles**

```bash
cd src-tauri && cargo check 2>&1 | tail -20
```

Expected: no errors (warnings are fine).

- [ ] **Step 8: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(rust): parse_kamal_accessories + custom cmd CRUD commands"
```

---

### Task 3: TypeScript types + commands.ts

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/lib/commands.ts`

- [ ] **Step 1: Add `CustomDeployCmd` type in `src/types/index.ts`**

Append at the end of the file:

```typescript
// ── Deploy custom commands ─────────────────────────────────────────────────────

export interface CustomDeployCmd {
  id: string;
  label: string;
  args: string[];
  interactive: boolean;
}
```

Also add `deploy_custom_commands` field to the `App` interface (after `deploy_config_path`):

```typescript
  deploy_custom_commands: CustomDeployCmd[];
```

- [ ] **Step 2: Add new invoke wrappers in `src/lib/commands.ts`**

Append at the end of the file:

```typescript
export const parseKamalAccessories = (configPath: string): Promise<string[]> =>
  isTauri
    ? invoke("parse_kamal_accessories", { configPath })
    : Promise.resolve([]);

export const addDeployCustomCmd = (appId: string, cmd: import("../types").CustomDeployCmd): Promise<void> =>
  isTauri
    ? invoke("add_deploy_custom_cmd", { appId, cmd })
    : Promise.reject(new Error("not available in browser mode"));

export const updateDeployCustomCmd = (appId: string, cmd: import("../types").CustomDeployCmd): Promise<void> =>
  isTauri
    ? invoke("update_deploy_custom_cmd", { appId, cmd })
    : Promise.reject(new Error("not available in browser mode"));

export const deleteDeployCustomCmd = (appId: string, cmdId: string): Promise<void> =>
  isTauri
    ? invoke("delete_deploy_custom_cmd", { appId, cmdId })
    : Promise.reject(new Error("not available in browser mode"));
```

- [ ] **Step 3: Commit**

```bash
git add src/types/index.ts src/lib/commands.ts
git commit -m "feat(types): CustomDeployCmd type + invoke wrappers"
```

---

### Task 4: Zustand deploySessions slice

**Files:**
- Modify: `src/store/index.ts`

- [ ] **Step 1: Add types and initial state**

In `src/store/index.ts`, add the interface and field to `PortaState` (after `serviceLogs`):

```typescript
// ── Deploy session state ──────────────────────────────────────────────────────
export interface KamalCmdState {
  logs: string[];
  running: boolean;
  exitCode: number | null;
  startedAt: number | null;
  runId: string | null;
}

export interface AppDeploySession {
  cmdStates: Record<string, KamalCmdState>;
  selectedCmdId: string;
}
```

Add to `PortaState` interface (after `serviceLogs: Record<string, string[]>`):

```typescript
  deploySessions: Record<string, AppDeploySession>;
  setDeploySelectedCmd: (appId: string, cmdId: string) => void;
  updateDeployCmdState: (appId: string, cmdId: string, patch: Partial<KamalCmdState>) => void;
  appendDeployLog: (appId: string, cmdId: string, line: string) => void;
```

- [ ] **Step 2: Add initial value and action implementations**

In the `create<PortaState>((set, get) => ({` body, add (after `serviceLogs: {}`):

```typescript
  deploySessions: {},

  setDeploySelectedCmd: (appId, cmdId) =>
    set((s) => ({
      deploySessions: {
        ...s.deploySessions,
        [appId]: {
          ...(s.deploySessions[appId] ?? { cmdStates: {} }),
          selectedCmdId: cmdId,
        },
      },
    })),

  updateDeployCmdState: (appId, cmdId, patch) =>
    set((s) => {
      const session = s.deploySessions[appId] ?? { cmdStates: {}, selectedCmdId: "" };
      const prev = session.cmdStates[cmdId] ?? { logs: [], running: false, exitCode: null, startedAt: null, runId: null };
      return {
        deploySessions: {
          ...s.deploySessions,
          [appId]: {
            ...session,
            cmdStates: { ...session.cmdStates, [cmdId]: { ...prev, ...patch } },
          },
        },
      };
    }),

  appendDeployLog: (appId, cmdId, line) =>
    set((s) => {
      const session = s.deploySessions[appId] ?? { cmdStates: {}, selectedCmdId: "" };
      const prev = session.cmdStates[cmdId] ?? { logs: [], running: false, exitCode: null, startedAt: null, runId: null };
      return {
        deploySessions: {
          ...s.deploySessions,
          [appId]: {
            ...session,
            cmdStates: {
              ...session.cmdStates,
              [cmdId]: { ...prev, logs: [...prev.logs, line] },
            },
          },
        },
      };
    }),
```

- [ ] **Step 3: Commit**

```bash
git add src/store/index.ts
git commit -m "feat(store): add deploySessions slice for persistent deploy state"
```

---

### Task 5: DeployModal — lift state + fix persistence

**Files:**
- Modify: `src/components/DeployModal.tsx`

This task rewires `cmdStates` and `selectedCmdId` from `useState` to the Zustand store. The rest of the component (UI, log rendering, keyboard shortcuts) is unchanged.

- [ ] **Step 1: Import store actions at the top of DeployModal**

Add to the existing import from `"../store"`:

```typescript
import { usePortaStore } from "../store";
import type { KamalCmdState } from "../store";
```

Also add to the existing import from `"../lib/commands"`:

```typescript
import {
  checkKamal, kamalRun, installKamal, isTauri,
  terminalOpen, terminalWrite, terminalResize, terminalClose,
  parseKamalAccessories, addDeployCustomCmd, updateDeployCustomCmd, deleteDeployCustomCmd,
} from "../lib/commands";
```

- [ ] **Step 2: Replace local state with store reads**

Remove these three `useState` lines:

```typescript
  const [cmdStates, setCmdStates] = useState<Record<string, CmdState>>({});
  const [selectedCmdId, setSelectedCmdId] = useState<string>(COMMANDS[0].id);
  const [consoleKey, setConsoleKey] = useState<number>(0);
```

Replace with:

```typescript
  const { deploySessions, updateDeployCmdState, appendDeployLog, setDeploySelectedCmd } = usePortaStore();
  const session = deploySessions[app.id] ?? { cmdStates: {}, selectedCmdId: COMMANDS[0].id };
  const cmdStates = session.cmdStates;
  const selectedCmdId = session.selectedCmdId || COMMANDS[0].id;
  const setSelectedCmdId = (id: string) => setDeploySelectedCmd(app.id, id);
  const [consoleKey, setConsoleKey] = useState<number>(0);
```

- [ ] **Step 3: Replace `setCmdStates` calls with store actions in `execCommand`**

Find the block starting at `async function execCommand(cmd: CommandDef)` and replace all `setCmdStates` calls with store equivalents:

```typescript
  async function execCommand(cmd: CommandDef) {
    setPendingCmdId(null);
    setSelectedCmdId(cmd.id);

    if (cmd.interactive) {
      setConsoleKey(k => k + 1);
      return;
    }
    const runId = `run-${cmd.id}-${Date.now()}`;
    updateDeployCmdState(app.id, cmd.id, {
      logs: [], running: true, exitCode: null, startedAt: Date.now(), runId,
    });

    if (isTauri) {
      let unlistenLog: (() => void) | undefined;
      let unlistenExit: (() => void) | undefined;

      [unlistenLog, unlistenExit] = await Promise.all([
        listen<string>(`kamal:log:${runId}`, (e) => {
          const raw = e.payload.startsWith("[err]") ? e.payload.slice(5).trimStart() : e.payload;
          appendDeployLog(app.id, cmd.id, raw);
        }),
        listen<number>(`kamal:exit:${runId}`, (e) => {
          updateDeployCmdState(app.id, cmd.id, { running: false, exitCode: e.payload });
          unlistenLog?.();
          unlistenExit?.();
          if (e.payload === 0) doCheckKamal();
        }),
      ]);

      try {
        await kamalRun(app.id, configPath, cmd.args, runId);
      } catch (e) {
        unlistenLog?.(); unlistenExit?.();
        updateDeployCmdState(app.id, cmd.id, {
          running: false,
          exitCode: -1,
          logs: [...(cmdStates[cmd.id]?.logs ?? []), `Error: ${String(e)}`],
        });
      }
    }
  }
```

- [ ] **Step 4: Re-attach listeners on modal mount for in-flight commands**

Add this `useEffect` after the `useEffect` for `doCheckKamal()`:

```typescript
  // Re-attach Tauri event listeners for commands that were running when modal was closed
  useEffect(() => {
    if (!isTauri) return;
    const session = deploySessions[app.id];
    if (!session) return;

    const cleanups: Array<() => void> = [];

    for (const [cmdId, state] of Object.entries(session.cmdStates)) {
      if (!state.running || !state.runId) continue;
      const runId = state.runId;

      Promise.all([
        listen<string>(`kamal:log:${runId}`, (e) => {
          const raw = e.payload.startsWith("[err]") ? e.payload.slice(5).trimStart() : e.payload;
          appendDeployLog(app.id, cmdId, raw);
        }),
        listen<number>(`kamal:exit:${runId}`, (e) => {
          updateDeployCmdState(app.id, cmdId, { running: false, exitCode: e.payload });
          cleanups.forEach(fn => fn());
        }),
      ]).then(([ul, ux]) => {
        cleanups.push(ul, ux);
      });
    }

    return () => cleanups.forEach(fn => fn());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.id]);
```

- [ ] **Step 5: Verify the app renders without errors**

Run the dev server:
```bash
npm run tauri dev 2>&1 | grep -E "(error|Error|warn)" | head -20
```

Open the Deploy modal, run a command, close and reopen — logs should still be visible.

- [ ] **Step 6: Commit**

```bash
git add src/components/DeployModal.tsx
git commit -m "fix(deploy): persist session state across modal open/close"
```

---

### Task 6: Update fixed COMMANDS — remove Rails, add lock-release

**Files:**
- Modify: `src/components/DeployModal.tsx`

- [ ] **Step 1: Replace the COMMANDS array**

Find the existing `const COMMANDS: CommandDef[]` block and replace it entirely:

```typescript
const FIXED_COMMANDS: CommandDef[] = [
  { id: "deploy",        label: "Deploy",        args: ["deploy"],                              group: "Deploy",  confirm: true },
  { id: "rollback",      label: "Rollback",       args: ["rollback"],                            group: "Deploy",  confirm: true },
  { id: "lock-release",  label: "Release Lock",   args: ["lock", "release"],                     group: "Deploy",  confirm: true },
  { id: "app-logs",      label: "App Logs",       args: ["app", "logs", "-f"],                   group: "App",     safe: true },
  { id: "app-details",   label: "Details",        args: ["app", "details"],                      group: "App",     safe: true },
  { id: "app-start",     label: "Start",          args: ["app", "start"],                        group: "App" },
  { id: "app-stop",      label: "Stop",           args: ["app", "stop"],                         group: "App" },
  { id: "app-restart",   label: "Restart",        args: ["app", "restart"],                      group: "App",     confirm: true },
  { id: "exec-bash",     label: "Bash Shell",     args: ["app", "exec", "--reuse", "-i", "bash"], group: "Console", interactive: true },
  { id: "server-reboot", label: "Server Reboot",  args: ["server", "reboot"],                    group: "Server",  confirm: true },
  { id: "server-exec",   label: "Server Info",    args: ["server", "exec", "hostname && uname -a"], group: "Server", safe: true },
  { id: "audit",         label: "Audit",          args: ["audit"],                               group: "Debug",   safe: true },
  { id: "version",       label: "Version",        args: ["version"],                             group: "Debug",   safe: true },
];
```

Also update the `CommandDef` type to extend the group union:

```typescript
type CommandDef = {
  id: string;
  label: string;
  args: string[];
  group: "Deploy" | "App" | "Console" | "Server" | "Debug" | "Accessories" | "Custom";
  confirm?: boolean;
  safe?: boolean;
  interactive?: boolean;
};
```

- [ ] **Step 2: Update any references from `COMMANDS` to `FIXED_COMMANDS`**

Search the file for `COMMANDS` and replace each occurrence with `FIXED_COMMANDS` — except in the sidebar rendering section (which will be replaced in Task 7). For now, do a simple replace-all for sidebar default:

```typescript
  const selectedCmdId = session.selectedCmdId || FIXED_COMMANDS[0].id;
```

- [ ] **Step 3: Commit**

```bash
git add src/components/DeployModal.tsx
git commit -m "feat(deploy): remove Rails console, add lock-release to fixed commands"
```

---

### Task 7: Accessories tier

**Files:**
- Modify: `src/components/DeployModal.tsx`

- [ ] **Step 1: Add state for accessories**

In the component body, after `const [cmdSearch, setCmdSearch] = useState("")`:

```typescript
  const [accessories, setAccessories] = useState<string[]>([]);

  useEffect(() => {
    if (!configPath) return;
    parseKamalAccessories(configPath).then(setAccessories).catch(() => {});
  }, [configPath]);
```

- [ ] **Step 2: Build accessory commands dynamically**

Add a derived variable (after the `accessories` state):

```typescript
  const accessoryCommands: CommandDef[] = accessories.flatMap((name) => [
    {
      id: `acc-bash-${name}`,
      label: `${name}: bash`,
      args: ["accessory", "exec", name, "bash"],
      group: "Accessories" as const,
      interactive: true,
    },
    {
      id: `acc-logs-${name}`,
      label: `${name}: logs`,
      args: ["accessory", "logs", name, "-f"],
      group: "Accessories" as const,
      safe: true,
    },
  ]);
```

- [ ] **Step 3: Build `allCommands` — fixed + accessories + custom**

Right after `accessoryCommands`, add:

```typescript
  const customCommands: CommandDef[] = (app.deploy_custom_commands ?? []).map((c) => ({
    id: `custom-${c.id}`,
    label: c.label,
    args: c.args,
    group: "Custom" as const,
    interactive: c.interactive,
  }));

  const allCommands = [...FIXED_COMMANDS, ...accessoryCommands, ...customCommands];
```

- [ ] **Step 4: Replace `COMMANDS` with `allCommands` everywhere in render**

In the sidebar rendering section (command list, group headers, search filter), replace `COMMANDS` with `allCommands`. Typical pattern to search for:

```typescript
// Before:
COMMANDS.filter(...)
// After:
allCommands.filter(...)
```

Also update the default selected command fallback:

```typescript
  const selectedCmdId = session.selectedCmdId || allCommands[0]?.id ?? "deploy";
```

And the `execCommand` lookup in the sidebar click handler to use `allCommands`.

- [ ] **Step 5: Commit**

```bash
git add src/components/DeployModal.tsx
git commit -m "feat(deploy): accessories tier auto-detected from deploy.yml"
```

---

### Task 8: Custom command UI — inline add/edit/delete

**Files:**
- Modify: `src/components/DeployModal.tsx`

- [ ] **Step 1: Add form state**

In the component body, after `const [cmdSearch, setCmdSearch] = useState("")`:

```typescript
  type CustomForm = { id: string; label: string; rawArgs: string; interactive: boolean };
  const emptyForm = (): CustomForm => ({ id: "", label: "", rawArgs: "", interactive: false });
  const [customForm, setCustomForm] = useState<CustomForm | null>(null); // null = closed
  const [customFormError, setCustomFormError] = useState("");
```

- [ ] **Step 2: Add save + delete handlers**

```typescript
  async function handleSaveCustomCmd() {
    if (!customForm) return;
    const label = customForm.label.trim();
    const rawArgs = customForm.rawArgs.trim();
    if (!label) { setCustomFormError("Label is required"); return; }
    if (!rawArgs) { setCustomFormError("Args are required"); return; }

    const args = rawArgs.split(/\s+/);
    const isEdit = !!customForm.id;
    const id = isEdit ? customForm.id : crypto.randomUUID();
    const cmd = { id, label, args, interactive: customForm.interactive };

    try {
      if (isEdit) {
        await updateDeployCustomCmd(app.id, cmd);
      } else {
        await addDeployCustomCmd(app.id, cmd);
      }
      // Refresh app list so deploy_custom_commands updates in store
      usePortaStore.getState().load();
      setCustomForm(null);
      setCustomFormError("");
    } catch (e) {
      setCustomFormError(String(e));
    }
  }

  async function handleDeleteCustomCmd(cmdId: string) {
    try {
      await deleteDeployCustomCmd(app.id, cmdId);
      usePortaStore.getState().load();
    } catch {}
  }
```

- [ ] **Step 3: Render the inline form below the command list in the sidebar**

Find the closing tag of the sidebar command list (the `<div>` wrapping the command buttons), and add directly after it:

```tsx
        {/* ── Custom command form ──────────────────────────────── */}
        {customForm && (
          <div className="border-t border-white/5 p-3 space-y-2">
            <p className="text-xs font-medium text-zinc-400">
              {customForm.id ? "Edit command" : "New command"}
            </p>
            <input
              type="text"
              placeholder="Label"
              value={customForm.label}
              onChange={(e) => setCustomForm({ ...customForm, label: e.target.value })}
              className="w-full text-xs bg-white/5 border border-white/10 rounded px-2 py-1.5 text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-white/25"
            />
            <input
              type="text"
              placeholder="Args (e.g. app exec -i bin/console)"
              value={customForm.rawArgs}
              onChange={(e) => setCustomForm({ ...customForm, rawArgs: e.target.value })}
              className="w-full text-xs bg-white/5 border border-white/10 rounded px-2 py-1.5 text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-white/25"
            />
            <label className="flex items-center gap-2 text-xs text-zinc-400 cursor-pointer">
              <input
                type="checkbox"
                checked={customForm.interactive}
                onChange={(e) => setCustomForm({ ...customForm, interactive: e.target.checked })}
                className="rounded"
              />
              Interactive (opens terminal pane)
            </label>
            {customFormError && (
              <p className="text-xs text-red-400">{customFormError}</p>
            )}
            <div className="flex gap-2">
              <button
                onClick={handleSaveCustomCmd}
                className="flex-1 text-xs bg-indigo-600 hover:bg-indigo-500 text-white rounded px-2 py-1.5"
              >
                Save
              </button>
              <button
                onClick={() => { setCustomForm(null); setCustomFormError(""); }}
                className="flex-1 text-xs bg-white/5 hover:bg-white/10 text-zinc-400 rounded px-2 py-1.5"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* ── Add command button ───────────────────────────────── */}
        {!customForm && (
          <div className="border-t border-white/5 p-2">
            <button
              onClick={() => setCustomForm(emptyForm())}
              className="w-full text-xs text-zinc-500 hover:text-zinc-300 hover:bg-white/5 rounded px-2 py-1.5 text-left transition-colors"
            >
              + Add command
            </button>
          </div>
        )}
```

- [ ] **Step 4: Add edit/delete controls on Custom group command rows**

In the sidebar, when rendering commands in the `"Custom"` group, add a `⋯` menu on hover. Find where command buttons are rendered and add this inline for custom commands:

```tsx
{cmd.group === "Custom" && (
  <div className="ml-auto flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
    <button
      onClick={(e) => {
        e.stopPropagation();
        const raw = app.deploy_custom_commands?.find(c => `custom-${c.id}` === cmd.id);
        if (raw) setCustomForm({ id: raw.id, label: raw.label, rawArgs: raw.args.join(" "), interactive: raw.interactive });
      }}
      className="text-zinc-500 hover:text-zinc-300 px-1"
      title="Edit"
    >
      ✎
    </button>
    <button
      onClick={(e) => {
        e.stopPropagation();
        const rawId = cmd.id.replace("custom-", "");
        handleDeleteCustomCmd(rawId);
      }}
      className="text-zinc-500 hover:text-red-400 px-1"
      title="Delete"
    >
      ✕
    </button>
  </div>
)}
```

Wrap the command button `<button>` in a `<div className="group flex items-center">` so hover works.

- [ ] **Step 5: Verify end-to-end**

1. Open Deploy modal
2. Click "+ Add command", fill in label "Sidekiq console", args `app exec -i bin/sidekiq`, save
3. Verify it appears in sidebar under "Custom" group
4. Click it — should run `kamal app exec -i bin/sidekiq`
5. Edit the label, verify update persists after modal close/reopen
6. Delete the command, verify it disappears

- [ ] **Step 6: Commit**

```bash
git add src/components/DeployModal.tsx
git commit -m "feat(deploy): custom command add/edit/delete inline in sidebar"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task |
|-----------------|------|
| Closing modal preserves logs + running state | Task 4 (store) + Task 5 (lift state) |
| Active deploy reconnects on reopen | Task 5 step 4 (re-attach listeners) |
| Remove Rails hardcode | Task 6 |
| `lock release` added to fixed commands | Task 6 |
| Accessories from deploy.yml | Task 7 |
| Custom commands stored in DB | Task 1 |
| Custom command UI inline in sidebar | Task 8 |
| Edit/delete custom commands | Task 8 step 4 |

**Placeholder scan:** None — all steps include full code.

**Type consistency:**
- `KamalCmdState` defined in Task 4, used in Task 5
- `CustomDeployCmd` defined in Task 3 (TS) and Task 1 (Rust) — same fields
- `allCommands` built in Task 7, replaces `COMMANDS` references from Task 6
- `handleDeleteCustomCmd(rawId)` strips `custom-` prefix added by Task 7 — consistent
- `usePortaStore.getState().load()` after custom cmd mutations refreshes `app.deploy_custom_commands` — required for Task 8 step 3 which reads from `app.deploy_custom_commands`
