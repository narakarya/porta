# Settings Grouping Design

**Date:** 2026-04-13  
**Scope:** `AppSettingsModal` + `SettingsPage`

## Problem

The `AppSettingsModal` General tab is too dense — it mixes 4 different concerns (identity, routing, process, dependencies) into a single tab with 9+ fields. The global `SettingsPage` has no workspace-level domain management.

## Solution

Two changes:

1. **Split `AppSettingsModal` General tab** — extract domain routing fields into a new "Domain" tab
2. **Add "Domains" tab to `SettingsPage`** — workspace-level domain management

---

## AppSettingsModal

### Tab Structure (before → after)

**Before:** `General | Environment | Tunneling | Danger Zone`  
**After:** `General | Domain | Environment | Tunneling | Danger Zone`

### General Tab (updated)

- Name
- Port ← moved from old General (process-level concern)
- Start Command
- Root Directory
- Health Check Path
- Start After (dependency graph)

### Domain Tab (new)

- Subdomain (primary)
- Extra Subdomains (tag input with add/remove)
- URL Preview (live preview card — https or http based on cert status)

No changes to `Environment`, `Tunneling`, or `Danger Zone` tabs.

---

## SettingsPage

### Tab Structure (before → after)

**Before:** `Setup & Certificates | Notifications | Data & Backup | Sync`  
**After:** `Setup & Certificates | Domains | Notifications | Data & Backup | Sync`

### Domains Tab (new)

- List all workspaces with their current domain
- Inline edit domain per workspace
- "Reload Caddy" button after domain changes (so Caddy picks up new config)

---

## Architecture Notes

Domain management has two levels:
- **Workspace domain** — Caddy-level wildcard config (e.g. `*.narakarya.test`)
- **App subdomain** — Caddy route to specific port (e.g. `api.narakarya.test → :3000`)

The UI separation mirrors this backend separation of concern.

---

## Out of Scope

- No changes to `Environment`, `Tunneling`, `Danger Zone` tabs
- No new backend commands required for the Domain tab in AppSettingsModal (uses existing `updateApp`)
- SettingsPage Domains tab will need a `updateWorkspace` command (or reuse existing store action)
