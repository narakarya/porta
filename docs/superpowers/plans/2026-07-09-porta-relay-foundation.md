# Porta Relay — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline, chosen for the autonomous /loop) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose a local app to the internet through the user's own VPS (WireGuard + remote Caddy) as a third expose backend ("Porta Relay"), covering host inventory, a multi-target Caddy client, and expose/unexpose.

**Architecture:** Public request → VPS Caddy (dedicated `porta` server, `:443`, ACME) → reverse-proxy over WireGuard to the Mac's local Caddy (`10.0.0.2:443`, `Host` = app local domain, `insecure_skip_verify`) → app. Porta owns the whole `porta` server object on the VPS and writes it wholesale via `PUT /config/apps/http/servers/porta` (idempotent; never touches other servers → no per-route-PATCH spike needed). Host + route inventory persists in rusqlite; expose emits on the existing `app:tunnel:{id}` channel.

**Tech Stack:** Rust (Tauri 2, rusqlite, reqwest blocking, serde_json), React 19 + TypeScript + Zustand.

## Global Constraints

- Local Caddy config output MUST remain byte-identical after the R2 refactor (snapshot-gated).
- IPC convention: handler in `commands/<area>.rs` → register in `lib.rs` `generate_handler!` → typed wrapper in `src/lib/commands.ts` → consume in component.
- Every `src/lib/commands.ts` wrapper guards on `isTauri` and no-ops (resolves) in browser mode.
- Validation before "done": `node_modules/.bin/tsc --noEmit` + `cargo check --manifest-path src-tauri/Cargo.toml`; `cargo test` for new Rust tests.
- Emit tunnel status on the shared channel `app:tunnel:{id}` with payload `{ active: bool, url: string|null, error?: string }` (no new subscription).
- New DB columns/tables added non-destructively in `db/mod.rs::migrate` (`CREATE TABLE IF NOT EXISTS` / ignored `ALTER TABLE`).
- Spec: `docs/superpowers/specs/2026-07-09-porta-relay-foundation-design.md`.

---

### Task 1: Remote host + route persistence (DB layer)

**Files:**
- Modify: `src-tauri/src/db/mod.rs` (add tables in `migrate`, `mod remote_repo;`)
- Create: `src-tauri/src/db/remote_repo.rs`
- Modify: `src-tauri/src/db/models.rs` (add `RemoteHost`, `RemoteRoute` structs)

**Interfaces:**
- Produces:
  - `struct RemoteHost { id, name, tunnel_ip, admin_port: u16, base_domain, wg_interface: Option<String>, mac_tunnel_ip, created_at: i64 }` (all `String` unless noted; derive `Clone, Serialize, Deserialize`)
  - `struct RemoteRoute { id, app_id, host_id, subdomain, port: u16, status: String, created_at: i64 }` (derive `Clone, Serialize, Deserialize`)
  - `impl Database`: `insert_remote_host`, `update_remote_host`, `delete_remote_host(id: &str)`, `list_remote_hosts() -> Result<Vec<RemoteHost>>`, `get_remote_host(id) -> Result<Option<RemoteHost>>`, `insert_remote_route`, `update_remote_route_status(id, status)`, `delete_remote_route_by_app(app_id)`, `list_remote_routes() -> Result<Vec<RemoteRoute>>`, `list_remote_routes_for_host(host_id)`, `get_remote_route_for_app(app_id) -> Result<Option<RemoteRoute>>`.

- [ ] **Step 1: Add migration tables.** In `db/mod.rs::migrate`, after the extensions block, add an `execute_batch` creating `remote_hosts` and `remote_routes` exactly as specified in the design doc's "R1" SQL (both `CREATE TABLE IF NOT EXISTS`). Add `mod remote_repo;` near the other `mod *_repo;` lines.

- [ ] **Step 2: Add model structs.** In `models.rs`, add `RemoteHost` and `RemoteRoute` per the Interfaces block, each `#[derive(Debug, Clone, Serialize, Deserialize)]`.

- [ ] **Step 3: Write failing repo test.** In `remote_repo.rs`, add `#[cfg(test)]` module with an in-memory-DB test (mirror `db/mod.rs` tests) round-tripping a host and a route:
```rust
#[test]
fn test_remote_host_and_route_round_trip() {
    let db = Database::open(":memory:".into()).unwrap();
    let h = RemoteHost { id: "h1".into(), name: "vps".into(), tunnel_ip: "10.0.0.1".into(),
        admin_port: 2019, base_domain: "example.com".into(), wg_interface: None,
        mac_tunnel_ip: "10.0.0.2".into(), created_at: 0 };
    db.insert_remote_host(&h).unwrap();
    assert_eq!(db.list_remote_hosts().unwrap().len(), 1);
    let r = RemoteRoute { id: "r1".into(), app_id: "a1".into(), host_id: "h1".into(),
        subdomain: "myapp".into(), port: 3000, status: "pending".into(), created_at: 0 };
    db.insert_remote_route(&r).unwrap();
    db.update_remote_route_status("r1", "active").unwrap();
    assert_eq!(db.get_remote_route_for_app("a1").unwrap().unwrap().status, "active");
    db.delete_remote_route_by_app("a1").unwrap();
    assert!(db.get_remote_route_for_app("a1").unwrap().is_none());
}
```

- [ ] **Step 4: Run test, verify fail.** `cargo test --manifest-path src-tauri/Cargo.toml remote_host_and_route -- --nocapture` → FAIL (methods undefined).

- [ ] **Step 5: Implement the repo.** In `remote_repo.rs`, `impl Database` with each method using `self.conn` (mirror `service_repo.rs` mapping rows → structs; `admin_port`/`port` stored as INTEGER, read as `u16`).

- [ ] **Step 6: Run test, verify pass.** Same command → PASS.

- [ ] **Step 7: Commit.** `git add -A && git commit -m "feat(relay): remote_hosts/remote_routes persistence"`

---

### Task 2: Multi-target Caddy client (R2 refactor)

**Files:**
- Modify: `src-tauri/src/caddy.rs`
- Test: inline `#[cfg(test)]` in `caddy.rs`

**Interfaces:**
- Consumes: existing `Route`, `route_to_json`, `build_config`.
- Produces:
  - `fn route_to_json_with_dial(route, default_max, dial: Option<&str>) -> Value` — when `dial` is `Some(target)`, reverse_proxy upstreams dial `target` and set `Host` header to the route's `host`, with `"transport": { "protocol": "http", "tls": { "insecure_skip_verify": true } }`; when `None`, behaves exactly like today (`localhost:{port}`).
  - `struct RemoteCaddy { admin_url: String, client: Client }` with `fn new(admin_url: String)`, `fn build_porta_server(routes: &[Route], upstream_dial: &str) -> Value`, `fn put_porta_server(&self, server: &Value) -> Result<()>` (`PUT {admin_url}/config/apps/http/servers/porta`), `fn put_redirect_and_automation(&self) -> Result<()>` (ensures `:80`→`:443` redirect server + `apps.tls.automation` ACME on first use), `fn reachable(&self) -> bool`.
  - `build_porta_server` output: `{ "listen": [":443"], "routes": [...], "automatic_https": {} }` with each route dialing `upstream_dial` and ACME-managed TLS (no `load_files`, no mkcert).

- [ ] **Step 1: Refactor local path to keep byte-identity.** Extract the reverse_proxy upstream construction in `route_to_json` into `route_to_json_with_dial(route, max, None)`; keep `route_to_json` as a thin caller. Local `build_config` unchanged in output.

- [ ] **Step 2: Add local snapshot regression test.** In `caddy.rs` tests, serialize `build_config` for a representative route set (one ReverseProxy w/ auth+app_id, one FileServer, one AliasReverseProxy w/ rewrite) and assert deep-equality against an inline expected `serde_json::json!` snapshot capturing today's shape. Run existing tests too.

- [ ] **Step 3: Run tests, verify pass (no regression).** `cargo test --manifest-path src-tauri/Cargo.toml caddy` → all PASS (proves refactor preserved local output).

- [ ] **Step 4: Write failing remote-server test.**
```rust
#[test]
fn test_remote_porta_server_dials_local_caddy_over_tunnel() {
    let server = RemoteCaddy::build_porta_server(
        &[Route::ReverseProxy { host: "myapp.example.com".into(), port: 3000,
            auth: None, app_id: Some("a1".into()), max_body: None }],
        "10.0.0.2:443");
    assert_eq!(server["listen"][0], ":443");
    let route = &server["routes"][0];
    let proxy = route["handle"].as_array().unwrap().iter()
        .find(|h| h["handler"] == "reverse_proxy").unwrap();
    assert_eq!(proxy["upstreams"][0]["dial"], "10.0.0.2:443");
    assert_eq!(proxy["headers"]["request"]["set"]["Host"][0], "myapp.example.com");
    assert_eq!(proxy["transport"]["tls"]["insecure_skip_verify"], true);
    assert!(server.get("automatic_https").is_some());
}
```

- [ ] **Step 5: Run test, verify fail.** → FAIL (`RemoteCaddy` undefined).

- [ ] **Step 6: Implement `RemoteCaddy` + `build_porta_server`.** Build routes via `route_to_json_with_dial(r, default_max, Some(upstream_dial))`; wrap in the `:443` server with `automatic_https`. Implement `put_porta_server`/`put_redirect_and_automation`/`reachable` with the blocking `Client` (5s timeout, like `CaddyManager::new`).

- [ ] **Step 7: Run test, verify pass.** → PASS.

- [ ] **Step 8: Commit.** `git add -A && git commit -m "feat(relay): multi-target Caddy — remote porta server builder"`

---

### Task 3: Remote host commands + registration (R1 backend)

**Files:**
- Create: `src-tauri/src/commands/remote.rs`
- Modify: `src-tauri/src/commands/mod.rs` (`mod remote; pub use remote::*;`)
- Modify: `src-tauri/src/lib.rs` (register handlers in `generate_handler!` after Tailscale ~`:317`)

**Interfaces:**
- Produces `#[tauri::command]`s:
  - `list_remote_hosts(state) -> Result<Vec<RemoteHost>, String>`
  - `add_remote_host(state, host: RemoteHost) -> Result<(), String>` (generate id/created_at if empty via `uuid`/`SystemTime` as elsewhere in codebase; auto-fill `wg_interface` via `detect_wg_interface()` when blank)
  - `update_remote_host(state, host) -> Result<(), String>`
  - `delete_remote_host(state, id: String) -> Result<(), String>`
  - `test_remote_host(state, id: String) -> Result<RemoteHostTest, String>` where `struct RemoteHostTest { reachable: bool, message: String }`; performs `GET http://{tunnel_ip}:{admin_port}/config/` (2s timeout). `// TODO(spec2): warn if admin API reachable from a public IP.`
  - `detect_wg_interface() -> Option<String>` (helper, not a command) shelling `wg show interfaces`, first token.

- [ ] **Step 1: Write failing test for `detect_wg_interface` parse.** Add a pure parser `fn parse_wg_interfaces(out: &str) -> Option<String>` returning the first whitespace-token; test `parse_wg_interfaces("utun6 utun7\n") == Some("utun6")` and `parse_wg_interfaces("") == None`.

- [ ] **Step 2: Run, verify fail.** `cargo test --manifest-path src-tauri/Cargo.toml parse_wg_interfaces` → FAIL.

- [ ] **Step 3: Implement module skeleton + parser + host CRUD commands.** Lock the DB via `state.db` mutex like other command modules; map errors to `String`.

- [ ] **Step 4: Register + verify compile.** Add `mod remote; pub use remote::*;` to `commands/mod.rs`; add the five commands to `lib.rs` `generate_handler!`. Run `cargo test ... parse_wg_interfaces` → PASS and `cargo check --manifest-path src-tauri/Cargo.toml` → clean.

- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(relay): remote host CRUD + test-connection commands"`

---

### Task 4: Expose / unexpose flow + mutual exclusion (R3 backend)

**Files:**
- Modify: `src-tauri/src/commands/remote.rs`
- Modify: `src-tauri/src/lib.rs` (register 3 commands)
- Modify: `src-tauri/src/commands/tailscale.rs` + `src-tauri/src/commands/tunnel.rs` (call `stop_remote_for_switch` in their start paths)

**Interfaces:**
- Consumes: Task 1 repo, Task 2 `RemoteCaddy`, `App::route_auth`, existing `set_tunnel_config` DB pattern.
- Produces `#[tauri::command]`s:
  - `list_remote_routes(state) -> Result<Vec<RemoteRoute>, String>`
  - `expose_remote(state, app_handle, app_id: String, host_id: String, subdomain: String) -> Result<String, String>` (returns `https://{subdomain}.{base_domain}`)
  - `unexpose_remote(state, app_handle, app_id: String) -> Result<(), String>`
  - `pub fn stop_remote_for_switch(app_id: &str, app_handle: &AppHandle)` (silent; deletes route + PUTs updated porta server; no event emit)
- Behavior: expose = insert `pending` route → build `porta` server from all `list_remote_routes_for_host` (as `Route::ReverseProxy` with `route_auth()` and `host = {sub}.{base_domain}`, dial = host's `mac_tunnel_ip:443`) → `put_redirect_and_automation` + `put_porta_server` → on ok set `active`, persist `tunnel_provider='remote'`, emit `{active:true,url}`; on err keep `pending`, emit `{active:false,error}`. unexpose = delete route row → rebuild+PUT server (now without it) → clear provider → emit `{active:false,url:null}`; if PUT fails, surface error and keep row.

- [ ] **Step 1: Write failing test for server rebuild from routes.** Add pure helper `fn routes_for_host(host: &RemoteHost, routes: &[RemoteRoute], apps: &[App]) -> Vec<Route>` and test that two `remote_routes` for one host produce two `Route::ReverseProxy` with hosts `a.example.com`/`b.example.com` and each dialing implied `mac_tunnel_ip:443` (dial applied later in build). Assert host strings + ports.

- [ ] **Step 2: Run, verify fail.** `cargo test ... routes_for_host` → FAIL.

- [ ] **Step 3: Implement `routes_for_host` + the three commands + `stop_remote_for_switch`.** Emit via `app_handle.emit("app:tunnel:{id}", payload)` (match tailscale.rs payload shape). Use `RemoteCaddy::new(format!("http://{}:{}", host.tunnel_ip, host.admin_port))`.

- [ ] **Step 4: Wire mutual exclusion.** In `tailscale.rs::start_tailscale_serve` and `tunnel.rs::start_tunnel`, add a call to `crate::commands::remote::stop_remote_for_switch(&id, &app_handle)` alongside the existing cross-provider stops. In `expose_remote`, first call `stop_cloudflare_for_switch(&app_id)` and `stop_tailscale_for_switch(&app_id, &app_handle)`.

- [ ] **Step 5: Run test + compile.** `cargo test ... routes_for_host` → PASS; `cargo check --manifest-path src-tauri/Cargo.toml` → clean.

- [ ] **Step 6: Commit.** `git add -A && git commit -m "feat(relay): expose/unexpose flow + provider mutual-exclusion"`

---

### Task 5: Frontend IPC wrappers + cache

**Files:**
- Modify: `src/lib/commands.ts`
- Create: `src/lib/remoteCache.ts`

**Interfaces:**
- Produces (TS): `interface RemoteHost` / `RemoteRoute` / `RemoteHostTest` (mirror Rust serde shape, snake_case fields); wrappers `listRemoteHosts()`, `addRemoteHost(h)`, `updateRemoteHost(h)`, `deleteRemoteHost(id)`, `testRemoteHost(id): Promise<RemoteHostTest>`, `listRemoteRoutes()`, `exposeRemote(appId, hostId, subdomain): Promise<string>`, `unexposeRemote(appId)`. `remoteCache.ts`: `getCachedRemoteHosts/setCachedRemoteHosts/hasRemoteCache` (mirror `tailscaleCache.ts`).

- [ ] **Step 1: Add interfaces + wrappers** in `commands.ts` near the Tailscale block (`~:1046`), each guarded on `isTauri`.
- [ ] **Step 2: Create `remoteCache.ts`** mirroring `tailscaleCache.ts` triplet.
- [ ] **Step 3: Typecheck.** `node_modules/.bin/tsc --noEmit` → clean.
- [ ] **Step 4: Commit.** `git add -A && git commit -m "feat(relay): frontend IPC wrappers + cache"`

---

### Task 6: Zustand store — remote slice + dispatch branches

**Files:**
- Create: `src/store/slices/remote.ts`
- Modify: `src/store/index.ts` (add `RemoteSlice` to `AllSlices` + spread)
- Modify: `src/store/slices/app.ts` (`startTunnel`/`stopTunnel` add `else if (provider === "remote")`)
- Modify: `src/store/slices/ui.ts` (add `"remote"` to `SettingsSection` union)

**Interfaces:**
- Produces `RemoteSlice`: `remoteHosts: RemoteHost[]`, `loadRemoteHosts()`, `addRemoteHost(h)`, `updateRemoteHost(h)`, `deleteRemoteHost(id)`, `testRemoteHost(id)`, `remoteRoutes: RemoteRoute[]`, `loadRemoteRoutes()`. Consumes Task 5 wrappers + cache.
- `app.ts` branch: `startTunnel(id,"remote")` reads the app's chosen host/subdomain (passed via a new optional param or a pending-selection field) and calls `exposeRemote`; `stopTunnel` for a remote-exposed app calls `unexposeRemote`.

- [ ] **Step 1: Create `remote.ts` slice** (hydrate from `remoteCache`, background-refresh, like tailscale usage in app.ts).
- [ ] **Step 2: Register in `index.ts`.**
- [ ] **Step 3: Add `"remote"` to `SettingsSection`** in `ui.ts`.
- [ ] **Step 4: Add dispatch branches** in `app.ts` `startTunnel`/`stopTunnel` (signature: `startTunnel(id, providerOverride?, opts?: { hostId?: string; subdomain?: string })`).
- [ ] **Step 5: Typecheck.** `node_modules/.bin/tsc --noEmit` → clean.
- [ ] **Step 6: Commit.** `git add -A && git commit -m "feat(relay): remote store slice + expose dispatch"`

---

### Task 7: Settings — "Remote Servers" section

**Files:**
- Create: `src/components/settings/RemoteSection.tsx`
- Modify: `src/components/settings/SettingsPage.tsx` (lazy import + NAV entry + render block)

**Interfaces:** Consumes `RemoteSlice`. A form to add/edit a host (name, tunnel_ip, admin_port, base_domain, mac_tunnel_ip, optional wg_interface), a list with edit/delete, and a **Test** button showing `RemoteHostTest.message` (green/red).

- [ ] **Step 1: Build `RemoteSection.tsx`** modeled on `TailscaleSection.tsx` (form + list + Test).
- [ ] **Step 2: Wire into `SettingsPage.tsx`**: `const RemoteSection = lazy(...)`, NAV entry `{ id: "remote", label: "Remote Servers", icon: … }`, and a `<div hidden={activeSection !== "remote"}>` render block.
- [ ] **Step 3: Typecheck.** `node_modules/.bin/tsc --noEmit` → clean.
- [ ] **Step 4: Commit.** `git add -A && git commit -m "feat(relay): Remote Servers settings section"`

---

### Task 8: TunnelQuickMenu — "Porta Relay" expose branch

**Files:**
- Modify: `src/components/app/TunnelQuickMenu.tsx`

**Interfaces:** Consumes `RemoteSlice.remoteHosts` + `startTunnel(id,"remote",{hostId,subdomain})`.

- [ ] **Step 1: Add `isRemote = provider === "remote"` + a "Porta Relay" branch** parallel to the Tailscale branch (`~:235`): host `<select>` (from `remoteHosts`), subdomain input (default = app slug), "Expose via Porta Relay" → `startTunnel(id,"remote",{hostId,subdomain})`. When `remoteHosts.length === 0`, render the option **disabled** with a hint linking to Settings → Remote Servers (`openSettingsSection("remote")`).
- [ ] **Step 2: Add `"remote"` case** to the connected-tooltip switch (`~:89`) and connected view.
- [ ] **Step 3: Typecheck.** `node_modules/.bin/tsc --noEmit` → clean.
- [ ] **Step 4: Commit.** `git add -A && git commit -m "feat(relay): Porta Relay option in TunnelQuickMenu"`

---

### Task 9: Full validation + setup guide

**Files:**
- Create: `docs/porta-relay-setup.md`

- [ ] **Step 1: Full validation.** `node_modules/.bin/tsc --noEmit` && `cargo check --manifest-path src-tauri/Cargo.toml` && `cargo test --manifest-path src-tauri/Cargo.toml` → all green.
- [ ] **Step 2: Write setup guide** documenting VPS prerequisites: WireGuard peer config (Mac `10.0.0.2` / VPS `10.0.0.1`), Caddy installed with admin API **bound to `10.0.0.1:2019` only** (never public), DNS A/AAAA (or wildcard) for `*.base_domain` → VPS, that Porta manages the public `:443` entrypoint, and the ACME rate-limit caveat. Include the documented manual E2E checklist (register → Test green → expose → URL live ≤10s → unexpose → route gone).
- [ ] **Step 3: Commit.** `git add -A && git commit -m "docs(relay): VPS setup guide + E2E checklist"`

---

## Self-Review

**Spec coverage:** R1 → Tasks 1,3,7. R2 → Task 2. R3 → Tasks 4,6,8. WG detection → Task 3. Mutual-exclusion → Task 4. Basic-auth reuse → free via `route_auth()` in Task 4's `routes_for_host` (full UI is Spec 2). Setup guide + security bind note → Task 9. Data-flow A (dial local Caddy) → Task 2 test. Dedicated server block / Porta owns `:443` → Task 2 `build_porta_server`. Pending/error contract → Task 4. Local regression → Task 2 snapshot.

**Deferred to Spec 2 (intentional, not gaps):** WG live status panel, stale-badge UI + retry button (Spec 1 retry = re-invoke `expose_remote`), per-route basic-auth UI, public-IP-exposure warning (TODO marker in Task 3).

**Placeholder scan:** none — each code step has concrete content; `// TODO(spec2)` markers are deliberate scope boundaries, not plan gaps.

**Type consistency:** `RemoteHost`/`RemoteRoute`/`RemoteHostTest` names identical across Rust (Tasks 1,3,4) and TS (Task 5); `expose_remote(app_id, host_id, subdomain)` signature consistent Rust↔TS↔store↔UI; `stop_remote_for_switch` referenced in Task 4 only.
