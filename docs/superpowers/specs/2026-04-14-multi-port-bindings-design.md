# Multi-Port Bindings per App

**Date:** 2026-04-14
**Status:** Approved

## Problem

An app may listen on multiple ports (e.g. Next.js frontend on :3000, API server on :4000, WebSocket on :4001). Currently Porta models each app with a single port + subdomain. Users must create separate app entries for each port, losing the logical grouping.

## Solution

Add a `port_bindings` field to each app — a list of extra (label, port, subdomain/domain) tuples. The existing `port` + `subdomain` + `custom_domain` fields remain as the **primary** binding. Extra bindings are secondary and each gets its own Caddy route.

## Data Model

### PortBinding struct

```rust
// Rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortBinding {
    pub id: String,
    pub label: String,
    pub port: u16,
    pub subdomain: Option<String>,
    pub custom_domain: Option<String>,
}
```

```typescript
// TypeScript
interface PortBinding {
  id: string;
  label: string;
  port: number;
  subdomain: string | null;
  custom_domain: string | null;
}
```

### App changes

Add `port_bindings: Vec<PortBinding>` (Rust) / `port_bindings: PortBinding[]` (TS) to the App struct/interface.

Add `port_bindings: PortBinding[]` to `UpdateAppParams`.

Storage: JSON column `port_bindings` in the `apps` table (consistent with `extra_subdomains`, `env_vars`, `deploy_custom_commands`).

## Backend

### Database (app_repo.rs)

- **Schema migration:** `ALTER TABLE apps ADD COLUMN port_bindings TEXT DEFAULT '[]'`
- **insert_app:** Serialize `port_bindings` to JSON. Register ALL ports in `port_registry` (primary + each binding).
- **list_apps:** Deserialize `port_bindings` JSON column.
- **update_app:** Accept `port_bindings` parameter. Diff old vs new binding ports against `port_registry`:
  1. Delete all `port_registry` entries for this app_id
  2. Re-insert primary port + all binding ports
- **used_ports:** No changes needed — already reads all of `port_registry`.

### Route generation (models.rs)

Replace `all_hosts(&self, workspaces) -> Vec<String>` with `all_routes(&self, workspaces) -> Vec<(String, u16)>`:

```rust
pub fn all_routes(&self, workspaces: &[Workspace]) -> Vec<(String, u16)> {
    let domain = self.effective_domain(workspaces);
    let mut routes = Vec::new();

    // Primary binding
    routes.push((self.resolved_host(workspaces), self.port));

    // Extra subdomains (existing feature — all map to primary port)
    for sub in &self.extra_subdomains {
        let trimmed = sub.trim();
        if !trimmed.is_empty() {
            routes.push((format!("{}.{}", trimmed, domain), self.port));
        }
    }

    // Port bindings (new — each has its own port)
    for binding in &self.port_bindings {
        let binding_domain = binding.custom_domain.as_deref()
            .filter(|d| !d.is_empty())
            .unwrap_or(&domain);
        // If no subdomain specified, use the label (lowercased, spaces → hyphens)
        let fallback_sub = binding.label.to_lowercase().replace(' ', "-");
        let sub = binding.subdomain.as_deref()
            .filter(|s| !s.is_empty())
            .unwrap_or(&fallback_sub);
        routes.push((format!("{}.{}", sub, binding_domain), binding.port));
    }

    routes
}
```

### Caddy sync (commands/setup.rs)

Simplify — `sync_caddy` currently does `flat_map(|a| a.all_hosts().map(|h| (h, a.port)))`. With `all_routes()` returning `Vec<(String, u16)>`, it becomes just `flat_map(|a| a.all_routes(&workspaces))`.

Cert generation: also collect `custom_domain` from each binding for mkcert.

## Frontend

### Types (types/index.ts)

- Add `PortBinding` interface
- Add `port_bindings: PortBinding[]` to `App`
- Add `port_bindings: PortBinding[]` to `UpdateAppParams`

### AppSettingsModal — "Port Bindings" section

Location: new section in the **domain** tab, below extra subdomains.

UI: dynamic list with add/remove rows.

Each row:
- **Label** — text input (required, e.g. "API Server")
- **Port** — number input (required, validated 1-65535, checked against used ports)
- **Subdomain** — text input (optional, validated same as primary subdomain regex)
- **Custom domain** — text input (optional, validated same as primary custom_domain regex)
- **Remove button** — removes the binding

Add button at the bottom: "+ Add port binding"

Live URL preview for each binding, same as primary URL preview.

### AppDetailSheet — read-only display

In the OverviewTab, below the primary URL row, show extra bindings:

```
URL           myapp.local.test
Port bindings
  API Server  api.local.test → :4000
  WebSocket   ws.myproject.com → :4001
```

If no bindings, this section is hidden.

### Store (store/slices/app.ts)

No structural changes — `updateApp` already passes `UpdateAppParams` through to the backend. Just needs to include `port_bindings` in the payload.

## Backward Compatibility

- Existing apps have `port_bindings = []` (empty JSON array default)
- Primary port/subdomain/custom_domain fields unchanged
- `extra_subdomains` feature unchanged — it still maps aliases to the primary port
- No data migration needed beyond the ALTER TABLE

## Example

App "my-saas" with primary port 3000:

| Type | Label | Subdomain | Custom Domain | Port |
|------|-------|-----------|---------------|------|
| Primary | — | my-saas | — | 3000 |
| Binding | API | api | — | 4000 |
| Binding | WebSocket | — | ws.myproject.com | 4001 |

Caddy routes generated:
- `my-saas.local.test` → `:3000`
- `api.local.test` → `:4000`
- `ws.myproject.com` → `:4001`
