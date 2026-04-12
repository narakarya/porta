# Tunneling Redesign

**Date:** 2026-04-13
**Scope:** Global Settings, AppSettingsModal Tunneling tab, data model, Rust backend

---

## Problem

Tunneling config is currently scattered and incomplete:
- `tunnel_provider` is stored per-app but there's only one provider (Cloudflare)
- Only quick tunnel is supported (no named tunnel / custom domain)
- No global place to configure cloudflared install, Cloudflare account token, or default domain
- `tunnel_url` is a single string — can't express multiple active tunnel URLs
- App-level tunneling tab shows provider selection and mode that belong in global settings

---

## Solution

Split tunneling configuration into two layers:

1. **Global Settings → new "Tunneling" tab** — infra-level: cloudflared status, mode (quick/named), Cloudflare token, default domain
2. **App Settings → Tunneling tab (simplified)** — routing-level: toggle on/off, subdomain list (named tunnel only)

Mode and provider are inherited from global. App only defines subdomains.

---

## Global Settings — Tunneling Tab

Add a "Tunneling" entry to `SettingsPage` nav.

### Sections

**cloudflared Status**
- Detect cloudflared binary (check known paths + `which cloudflared`)
- If installed: show path, version (`cloudflared --version`)
- If not installed: show install instructions (`brew install cloudflare/cloudflare/cloudflared`) with a copy button

**Default Mode** (segmented control)
- `Quick Tunnel` — random `*.trycloudflare.com` URL, no account needed
- `Named Tunnel` — custom domain, requires Cloudflare account

**Named Tunnel Config** (only enabled when mode = Named)
- API Token — stored in global config, masked input
- Default Domain — e.g. `example.com`; workspace can override this field (future, see below)

### Persistence

Global tunnel config stored as a new table `tunnel_config` in SQLite (single-row config):

```
tunnel_config {
  mode: "quick" | "named",
  api_token: Option<String>,   -- stored as plaintext in local SQLite (acceptable for a local-only dev tool)
  default_domain: Option<String>,
}
```

Exposed via two Tauri commands:
- `get_tunnel_config() -> TunnelConfig`
- `save_tunnel_config(config: TunnelConfig) -> Result<(), String>`

---

## App Settings — Tunneling Tab

### Quick Tunnel Mode (global mode = quick)

- Toggle: Enable / Disable tunnel
- When disabled: "Disconnected — toggle to start a quick tunnel"
- When enabled: show connecting state → active URL (single `*.trycloudflare.com`) with copy button
- No subdomain config (URL is random per connection)

### Named Tunnel Mode (global mode = named)

- Toggle: Enable / Disable tunnel
- **Subdomains tag input** — same pattern as `extra_subdomains`
  - Add subdomain (Enter or comma), remove with ×
  - Each subdomain routes to the app's port
  - Preview: `subdomain.default_domain` (or `subdomain.workspace_domain` if set)
- When tunnel active: list of live URLs, each with copy button
- When disabled: subdomain list still editable

### Behavior

- All subdomains in the list point to the same port (the app's assigned port)
- Connecting starts one `cloudflared` process per app (not per subdomain)
- Named tunnel: cloudflared routes multiple hostnames via the same tunnel process using `--hostname` flags

---

## Data Model Changes

### App model

```
// Remove
tunnel_provider: Option<String>   // was always "cloudflare", now global concern
tunnel_url: Option<String>        // single URL → list

// Add
tunnel_subdomains: Vec<String>    // configured subdomains (named tunnel only, persisted)
tunnel_urls: Vec<String>          // active tunnel URLs (runtime only, not persisted)
```

`tunnel_active: bool` stays unchanged.

### Workspace model

```
// Add (future per-workspace override)
tunnel_domain: Option<String>     // overrides global default_domain; null = use global
```

This field can be null in v0.2 — the UI wiring for per-workspace domain override is deferred to a later iteration.

### DB migration

- Add `tunnel_subdomains TEXT DEFAULT '[]'` to `apps` table
- Add `tunnel_config` table (single-row)
- Add `tunnel_domain TEXT` to `workspaces` table (nullable)
- Drop `tunnel_provider` column from `apps` table via migration (no longer needed — provider is always Cloudflare, configured globally)

---

## Backend (Rust) Changes

### `start_tunnel`

Current signature: `start_tunnel(id: String, port: u16)`

Updated signature: `start_tunnel(id: String, port: u16, subdomains: Vec<String>)`

Behavior:
- Load global `tunnel_config` to determine mode
- **Quick mode**: `cloudflared tunnel --url http://localhost:{port}` (unchanged)
- **Named mode**: `cloudflared tunnel --hostname {sub}.{domain} --url http://localhost:{port}` for each subdomain, or a single process with multiple `--hostname` args if cloudflared supports it

Emits `app:tunnel:{id}` event — change payload from `{ active, url }` to `{ active, urls: Vec<String> }`.

### `check_cloudflared`

Add `cloudflared_version() -> Option<String>` command that returns version string.

### New commands

- `get_tunnel_config() -> TunnelConfig`
- `save_tunnel_config(config: TunnelConfig) -> Result<(), String>`

---

## Frontend Store Changes

- `startTunnel(id)` passes `tunnel_subdomains` from app state
- Event listener for `app:tunnel:{id}` updates `tunnel_urls: string[]` instead of `tunnel_url: string | null`
- Add `tunnelConfig: TunnelConfig | null` to store state
- Add `loadTunnelConfig()`, `saveTunnelConfig(config)` actions

---

## Out of Scope (deferred)

- Per-workspace tunnel domain UI (model supports it via `tunnel_domain`, wiring deferred)
- Named tunnel authentication flow (tunnel token vs API token — defer to when named tunnel is implemented)
- Multiple cloudflared processes per subdomain vs single process multi-hostname — verify cloudflared behavior before implementing
- ngrok or other providers

---

## Implementation Order

1. DB migration (`tunnel_subdomains`, `tunnel_config` table, `tunnel_domain` on workspaces)
2. Rust: new data models + commands (`get_tunnel_config`, `save_tunnel_config`, updated `start_tunnel`)
3. Global Settings: add Tunneling tab
4. App Settings: simplify Tunneling tab — remove provider select, add subdomain tag input, handle quick vs named display based on global mode
5. Store: update `startTunnel`, event listener, add tunnel config actions
