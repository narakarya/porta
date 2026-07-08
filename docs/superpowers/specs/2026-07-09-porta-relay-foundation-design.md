# Design: Porta Relay — Foundation (Spec 1 of 3)

**Status:** Approved · **Date:** 2026-07-09 · **PRD:** [Self-hosted Expose](https://docs.google.com/document/d/1-Q8-nC25Q2IpwYlY3NKPGNRzIn0wdEtlzqLKqJ2ssWM/edit)

Expose a local app to the internet through the user's own VPS (WireGuard + remote Caddy),
as a third expose backend alongside Cloudflare Tunnel and Tailscale Funnel. Surfaces in the UI
as **"Porta Relay"**.

## Scope

This is the first of three specs decomposing the PRD:

| Spec | PRD phase | Contents |
|---|---|---|
| **1 — Relay foundation (this doc)** | Fase 1 (P0) | R1 host inventory, R2 caddy.rs multi-target refactor, R3 expose/unexpose happy path |
| 2 — Status & robustness | Fase 2 (P0+P1) | R4 WireGuard status panel, error/stale state, R7 per-route basic auth |
| 3 — Sync & integrations | Fase 3 (P1) | R5 sync/drift, R6 CF DNS auto-record, R8 remote logs |

**In scope for Spec 1:** register a remote host, test its connection, expose/unexpose an app to a
public HTTPS URL on the user's domain, persist that state across restarts.

**Out of scope for Spec 1 (deferred to Spec 2/3, or PRD non-goals):** WireGuard live status panel,
sophisticated drift/stale detection and reconcile, per-route basic auth UI, CF DNS auto-record,
remote access logs, VPS provisioning, automatic WireGuard/Caddy bootstrap over SSH, TCP/UDP
passthrough, multi-user sharing. Basic error surfacing (unreachable VPS → clear error, no silent
partial state) IS in scope; rich stale-state UI is Spec 2.

## Locked decisions (from brainstorming)

1. **Data flow:** VPS Caddy → **local Caddy** over the tunnel (not directly to the app port).
2. **Caddy config strategy:** **dedicated server block** — Porta owns `apps.http.servers.porta` on
   the VPS and thereby owns the public `:443`/`:80` entrypoint on that VPS.
3. **WireGuard interface detection:** auto-detect via `wg show interfaces`, with a manual override
   field in host settings. (Detection wiring lands here; the live *status panel* is Spec 2.)
4. **UI name:** "Porta Relay".

## Architecture

### Topology

```
[Porta / Mac]                                  [VPS]
  local Caddy :443  <==== WireGuard tunnel ====>  Caddy admin API bind 10.0.0.1:2019
  (mkcert *.test)         10.0.0.2 <-> 10.0.0.1    Caddy public server "porta" :443 (ACME)
       ^                                                     |
       | dial 10.0.0.2:443 (Host: myapp.local-domain.test)  |
       +------------------ route: myapp.userdomain.com ------+
```

- Public request hits VPS Caddy `porta` server on `:443`, terminates TLS via Let's Encrypt/ACME.
- VPS route for `myapp.userdomain.com` reverse-proxies to `10.0.0.2:443` (Mac's WG IP → local
  Caddy), setting `Host` to the app's **local** domain so local Caddy routes it to the right app.
- The internal VPS→Mac hop is HTTPS against local Caddy's mkcert cert, so the VPS proxy uses
  `tls { insecure_skip_verify }` for that upstream — identical to how `tunnel.rs` already points
  cloudflared at local Caddy (`caddy_origin_args`, `tunnel.rs:141`).
- **Why via local Caddy, not `10.0.0.2:{port}` directly:** most dev servers bind `localhost` only,
  so they are unreachable on the WG interface. Routing through local Caddy reuses all existing
  local routing (subdomains, host rewrites, and later per-route basic auth) and needs no change to
  how apps bind.

### Dedicated server block & its consequence

Caddy cannot bind two servers to the same listener address, so a "dedicated server block" on `:443`
means **Porta owns the public HTTPS entrypoint** on that VPS. Porta creates/manages
`apps.http.servers.porta` (listen `:443`, ACME automation) plus a `:80`→`:443` redirect server.
Coexistence with CI-preview or other routes is achieved by those routes living *inside* Porta's
server (added via the same admin API; surfaced read-only by R5 sync in Spec 3), not via a separate
`:443` server. The setup guide documents that Porta manages the VPS public entrypoint.

Open-question #1 (PRD) — confirm the admin API is stable enough to PATCH individual routes within
`servers/porta/routes` — is validated by a small spike at the start of implementation (see Risks).

### R2 — Multi-target Caddy client refactor

`caddy.rs` today hardcodes the admin endpoint (`CADDY_API = "http://localhost:2019"`, `caddy.rs:8`)
and always dials `localhost:{port}` (`caddy.rs:110`). Refactor to a target abstraction:

```rust
enum CaddyTarget {
    Local,                                  // admin http://localhost:2019, dial localhost:{port}, mkcert certs
    Remote { admin_url: String, upstream_dial: String, base_domain: String },
}
```

- `CaddyManager::new(target)` holds the admin base URL.
- `build_config(routes, &target)` branches: **Local** produces today's exact config (mkcert wildcard,
  `:443` `porta_https` + `:80` redirect, wake-errors block, per-app loggers). **Remote** produces the
  `porta` server with ACME automation (`automatic_https`/`tls` issuer = ACME), routes whose
  `reverse_proxy` upstream dials `upstream_dial` (`10.0.0.2:443`) with the `Host` header set to the
  app's local host and `tls { insecure_skip_verify }`.
- **Regression safety (R2 acceptance):** a snapshot test asserts `build_config(routes, &Local)`
  is byte-identical to the pre-refactor output for a representative route set. The existing
  `caddy.rs` unit tests must all continue to pass unchanged.
- Remote writes use the admin API on `admin_url` (the tunnel IP), scoped to the `porta` server.

### R1 — Remote host inventory

New rusqlite tables (added non-destructively in `db/mod.rs::migrate`, following the existing
`ALTER TABLE ... IF NOT EXISTS`/`CREATE TABLE IF NOT EXISTS` convention):

```sql
CREATE TABLE IF NOT EXISTS remote_hosts (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    tunnel_ip    TEXT NOT NULL,              -- VPS WG IP, e.g. 10.0.0.1 (admin API + public host reach)
    admin_port   INTEGER NOT NULL DEFAULT 2019,
    base_domain  TEXT NOT NULL,              -- e.g. userdomain.com
    wg_interface TEXT,                       -- manual override; NULL = auto-detect (wg show interfaces)
    mac_tunnel_ip TEXT NOT NULL,             -- Mac's WG IP, e.g. 10.0.0.2 (upstream dial target)
    created_at   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS remote_routes (
    id         TEXT PRIMARY KEY,
    app_id     TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    host_id    TEXT NOT NULL REFERENCES remote_hosts(id) ON DELETE CASCADE,
    subdomain  TEXT NOT NULL,                -- e.g. "myapp" → myapp.<base_domain>
    port       INTEGER NOT NULL,            -- local app port this route targets
    status     TEXT NOT NULL DEFAULT 'active', -- 'active' | 'pending' (push not yet confirmed)
    created_at INTEGER NOT NULL DEFAULT 0
);
```

Repo functions live in `db/` (new `remote_repo.rs`, mirroring `service_repo.rs`): CRUD for hosts and
routes, plus `list_remote_routes_for_host`, `list_remote_routes_for_app`.

Rust command module `commands/remote.rs` (mirrors `commands/tailscale.rs`), commands:

- `list_remote_hosts() -> Vec<RemoteHost>`
- `add_remote_host(host) / update_remote_host(host) / delete_remote_host(id)`
- `test_remote_host(id) -> RemoteHostTest` — `GET http://{tunnel_ip}:{admin_port}/config/`;
  returns reachable/unreachable + message. (Public-exposure warning check is Spec 2; a TODO marker
  is left here.)
- `list_remote_routes() -> Vec<RemoteRoute>`
- `expose_remote(app_id, host_id, subdomain) -> Result<String, String>` (returns public URL)
- `unexpose_remote(app_id) -> Result<(), String>`
- `stop_remote_for_switch(app_id, app_handle)` — silent teardown for provider mutual-exclusion.

Registered in `lib.rs` `generate_handler!` (after the Tailscale cluster ~`:317`) and
`commands/mod.rs` (`mod remote; pub use remote::*;`).

### R3 — Expose / unexpose flow

**Expose** (`expose_remote`):
1. Validate: host exists, tunnel reachable (reuse `test_remote_host`), subdomain non-empty
   (default = app slug), not already exposed.
2. Insert `remote_routes` row with `status='pending'`.
3. Build the app's Route and PATCH it into the VPS `porta` server via the remote `CaddyManager`.
4. On success: set row `status='active'`, persist `tunnel_provider='remote'` on the app (reuse
   `set_tunnel_config` DB pattern, `tunnel.rs:916`), emit `app:tunnel:{id}` `{active:true, url}`.
5. On failure (VPS unreachable / PATCH error): leave row `pending`, emit
   `app:tunnel:{id}` `{active:false, error}`. No partial VPS state is left silently — the row is the
   retry anchor. (Rich "stale" badge UI is Spec 2; Spec 1 surfaces the error + keeps the pending row.)

Acceptance: app on port 3000, tunnel healthy, expose subdomain `myapp` → within ≤10s
`https://myapp.userdomain.com` serves the app.

**Unexpose** (`unexpose_remote`): DELETE the route from the VPS `porta` server, then delete the
`remote_routes` row and clear the app's `tunnel_provider` — atomically (remove-then-persist; if the
VPS delete fails, surface the error and keep the row so the user can retry, do not orphan DB state).

**Mutual exclusion:** `startTunnel` for `provider==="remote"` first calls the other backends'
`stop_*_for_switch`; symmetrically `start_tailscale_serve` / `start_tunnel` call
`stop_remote_for_switch`. Mirrors `tailscale.rs:445/577`.

### WireGuard interface detection (detection only; panel is Spec 2)

Helper in `commands/remote.rs`: `detect_wg_interface() -> Option<String>` shelling
`wg show interfaces` and returning the first match; used to fill the host's `wg_interface` when the
manual field is blank. The live status parsing/polling panel (R4) is Spec 2 — Spec 1 only needs the
resolved interface name available for later.

### Frontend

Following the mapped patterns:

- `src/lib/commands.ts`: `RemoteHost` / `RemoteRoute` / `RemoteHostTest` interfaces + wrappers
  (`listRemoteHosts`, `addRemoteHost`, `updateRemoteHost`, `deleteRemoteHost`, `testRemoteHost`,
  `listRemoteRoutes`, `exposeRemote`, `unexposeRemote`), each guarded on `isTauri`.
- `src/lib/remoteCache.ts`: getter/setter/has triplet mirroring `tailscaleCache.ts`.
- `src/store/slices/remote.ts`: host CRUD state (list/add/edit/delete/test). The connect/disconnect
  dispatch stays in `app.ts` (`startTunnel`/`stopTunnel` gain an `else if (provider === "remote")`
  branch). Registered in `store/index.ts` `AllSlices`.
- `src/store/slices/ui.ts`: add `"remote"` to the `SettingsSection` union.
- `src/components/settings/RemoteSection.tsx`: "Remote Servers" section (add host, edit, delete,
  Test button with clear success/failure). Lazy-imported + NAV entry + render block in
  `SettingsPage.tsx`.
- `src/components/app/TunnelQuickMenu.tsx`: add an `else if (isRemote)` branch (parallel to the
  Tailscale branch ~`:235`) rendering the host picker + subdomain field + "Expose via Porta Relay",
  calling `startTunnel(id, "remote")`. When no host is registered, the option shows **disabled**
  with a hint linking to Settings → Remote Servers (R1 acceptance).
- Events: reuse the existing `app:tunnel:{id}` subscription (`subscriptions.ts:240`); no new listener.

## Testing

- **Rust unit:** `remote_repo` CRUD round-trips (in-memory DB, like `db/mod.rs` tests);
  `build_config` remote-target shape (route dials `mac_tunnel_ip:443`, Host header set, ACME issuer
  present, `insecure_skip_verify` set); **local-target snapshot regression** (byte-identical to
  pre-refactor).
- **Rust logic:** `expose_remote` failure path leaves a `pending` row and emits an error (mock/inject
  the Caddy client so no live VPS needed).
- **Frontend:** `tsc --noEmit` clean; store slice add/remove host reducer behavior.
- **Manual E2E (documented, needs a real VPS+tunnel):** register host → Test green → expose →
  URL live ≤10s → unexpose → route gone from VPS config.
- Validation chain (CLAUDE.md): `node_modules/.bin/tsc --noEmit` +
  `cargo check --manifest-path src-tauri/Cargo.toml`; `cargo test` for the new Rust tests.

## Risks & mitigations

- **Admin-API per-route granularity (open-question #1, blocking):** start implementation with a
  ~½-day spike PATCHing a single route into a `porta` server on a scratch Caddy and confirming
  idempotent add/replace/delete. If per-route paths prove fragile, fall back to
  `PATCH servers/porta` (replace the whole Porta-owned server, still isolating it from user config).
- **ACME rate limits (open-question #4):** repeated expose/unexpose with new subdomains can hit
  Let's Encrypt limits. Spec 1 accepts this; wildcard-cert-via-DNS-challenge is noted for a later
  spec. Document it in the setup guide.
- **Local config regression:** mitigated by the byte-identical snapshot test gating the R2 refactor.
- **VPS unreachable mid-expose:** handled by the `pending`-row + error-emit contract (no silent
  partial state); retry is a button in Spec 2, a re-invoke of `expose_remote` in Spec 1.

## Open questions carried forward

- #2 wg interface detection — resolved (auto + manual override).
- #3 naming — resolved ("Porta Relay").
- #1 admin API granularity — de-risked by the opening spike (above).
- #4 ACME wildcard — deferred, documented.
