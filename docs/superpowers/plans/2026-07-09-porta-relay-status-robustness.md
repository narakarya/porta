# Porta Relay — Status & Robustness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline). Steps use `- [ ]` checkboxes.

**Goal:** Add live WireGuard status, error/stale route surfacing with retry, and confirm per-route basic auth for the Porta Relay backend (PRD Fase 2).

**Architecture:** Backend `wg_status(host_id)` parses `wg show <iface> dump` into a `WgStatus`; the frontend polls it (15s, visible-only) for a per-host panel in Settings and a degraded amber indicator on exposed apps. Pending routes from Spec 1 get a Retry affordance. R7 basic auth already flows through `routes_for_host`; add tests + a lock glyph.

**Tech Stack:** Rust (Tauri, serde), React 19 + TypeScript + Zustand.

## Global Constraints

- Same as Spec 1 (see `2026-07-09-porta-relay-foundation.md`): IPC convention, `isTauri` guards, validation chain (`tsc --noEmit` + `cargo check` + `cargo test`), events on `app:tunnel:{id}`.
- Spec: `docs/superpowers/specs/2026-07-09-porta-relay-status-robustness-design.md`.
- Builds on Spec 1 types (`RemoteHost`, `RemoteRoute`, `RemoteCaddy`, `routes_for_host`).

---

### Task 1: WireGuard status backend (R4)

**Files:** Modify `src-tauri/src/commands/remote.rs`, `src-tauri/src/lib.rs`.

**Interfaces:**
- Produces: `struct WgStatus { interface: String, up: bool, peer_found: bool, endpoint: Option<String>, handshake_age_secs: Option<i64>, rx_bytes: u64, tx_bytes: u64 }` (Serialize/Deserialize); pure `fn parse_wg_dump(out: &str, tunnel_ip: &str) -> Option<ParsedPeer>` where `struct ParsedPeer { endpoint: Option<String>, latest_handshake: i64, rx: u64, tx: u64 }`; command `wg_status(host_id: String, state) -> Result<WgStatus, String>`.

- [ ] **Step 1: Failing parser test.**
```rust
#[test]
fn test_parse_wg_dump_picks_peer_by_allowed_ip() {
    // line 1 = interface; line 2/3 = peers (tab-separated).
    let out = "PRIV\tPUB\t51820\toff\n\
PEERA\t(none)\t1.2.3.4:51820\t10.0.0.9/32\t1700000000\t100\t200\t0\n\
PEERB\t(none)\t5.6.7.8:51820\t10.0.0.1/32\t1700000500\t300\t400\t25\n";
    let p = parse_wg_dump(out, "10.0.0.1").unwrap();
    assert_eq!(p.endpoint.as_deref(), Some("5.6.7.8:51820"));
    assert_eq!(p.latest_handshake, 1700000500);
    assert_eq!(p.rx, 300);
    assert_eq!(p.tx, 400);
    assert!(parse_wg_dump("", "10.0.0.1").is_none());
    // never-handshaked peer keeps latest_handshake 0
    let never = "P\tK\t1\toff\nX\t(none)\t(none)\t10.0.0.1/32\t0\t0\t0\t0\n";
    assert_eq!(parse_wg_dump(never, "10.0.0.1").unwrap().latest_handshake, 0);
}
```

- [ ] **Step 2: Run, verify fail.** `cargo test --lib parse_wg_dump` → FAIL.

- [ ] **Step 3: Implement `parse_wg_dump`, `WgStatus`, and `wg_status`.** Parser: split lines, skip the first (interface), for each peer split on `\t`, cols `[2]=endpoint (treat "(none)" as None)`, `[3]=allowed_ips`, `[4]=latest_handshake`, `[5]=rx`, `[6]=tx`; choose the peer whose `allowed_ips` contains `tunnel_ip`, else the first peer. `wg_status`: resolve iface (`host.wg_interface` or `detect_wg_interface()`), run `wg show <iface> dump`; if the command fails or iface missing return `WgStatus { up:false, peer_found:false, .. }`; else map `ParsedPeer` → `handshake_age_secs = (latest_handshake>0).then(|| now - latest_handshake)`.

- [ ] **Step 4: Register + run.** Add `commands::wg_status` to `lib.rs` `generate_handler!`. `cargo test --lib parse_wg_dump` → PASS; `cargo check` → clean.

- [ ] **Step 5: Commit.** `feat(relay): wg_status command + wg dump parser`

---

### Task 2: R7 basic-auth confirmation tests

**Files:** Modify `src-tauri/src/commands/remote.rs` (tests).

- [ ] **Step 1: Add test** asserting a basic-auth app produces a spec with auth, and it reaches Caddy JSON:
```rust
#[test]
fn test_routes_for_host_carries_basic_auth() {
    let host = /* h1 as in test_routes_for_host_maps... */;
    let ws = Workspace { id:"w1".into(), name:"W".into(), domain:"work.test".into(), deployment:None };
    let app = App { id:"a1".into(), name:"myapp".into(), port:3000, workspace_id:Some("w1".into()),
        subdomain:Some("myapp".into()), basic_auth_enabled:true, basic_auth_username:Some("u".into()),
        basic_auth_password_hash:Some("$2b$12$x".into()), ..Default::default() };
    let routes = vec![RemoteRoute { id:"r1".into(), app_id:"a1".into(), host_id:"h1".into(),
        subdomain:"public".into(), port:3000, status:"active".into(), created_at:0 }];
    let specs = routes_for_host(&host, &routes, &[app], &[ws]);
    assert!(specs[0].auth.is_some());
    let server = crate::caddy::RemoteCaddy::build_porta_server(&specs, "10.0.0.2:443");
    let handlers = server["routes"][0]["handle"].as_array().unwrap();
    assert_eq!(handlers[0]["handler"], "authentication");
}
```
- [ ] **Step 2: Run, verify pass** (logic already exists from Spec 1). `cargo test --lib routes_for_host_carries_basic_auth` → PASS.
- [ ] **Step 3: Commit.** `test(relay): confirm per-route basic auth reaches VPS Caddy`

---

### Task 3: Frontend IPC + store for WG status

**Files:** Modify `src/lib/commands.ts`, `src/store/slices/remote.ts`.

**Interfaces:** `interface WgStatus {...}` mirroring Rust; `wgStatus(hostId): Promise<WgStatus>` (browser no-op → `{interface:"",up:false,peer_found:false,endpoint:null,handshake_age_secs:null,rx_bytes:0,tx_bytes:0}`). Slice: `wgStatuses: Record<string, WgStatus>`, `loadWgStatus(hostId)`, `loadAllWgStatuses()`.

- [ ] **Step 1: Add `WgStatus` + `wgStatus` wrapper** in `commands.ts`.
- [ ] **Step 2: Add `wgStatuses` state + loaders** to `remote.ts` (set merges by hostId). Add to `RemoteSlice` interface.
- [ ] **Step 3: Typecheck.** `tsc --noEmit` → clean.
- [ ] **Step 4: Commit.** `feat(relay): wg status IPC wrapper + store state`

---

### Task 4: RemoteSection WG status panel

**Files:** Modify `src/components/settings/RemoteSection.tsx`.

**Interfaces:** Consumes `wgStatuses`, `loadAllWgStatuses`.

- [ ] **Step 1: Add a status row per host** — colored dot (green `<120`, amber `<300`, red `>=300` or `!up`), text "handshake 34s ago" / "never" / "interface down", endpoint, and `RX/TX` via a `formatBytes` helper.
- [ ] **Step 2: Poll every 15s while visible.** `useEffect` with `setInterval(loadAllWgStatuses, 15000)` that clears on unmount and pauses on `document.hidden` (mirror `TailscaleSection`'s interval). Initial `loadAllWgStatuses()` on mount.
- [ ] **Step 3: Typecheck.** `tsc --noEmit` → clean.
- [ ] **Step 4: Commit.** `feat(relay): live WireGuard status panel in Remote Servers`

---

### Task 5: TunnelQuickMenu — degraded state, pending retry, lock glyph

**Files:** Modify `src/components/app/TunnelQuickMenu.tsx`.

**Interfaces:** Consumes `remoteRoutes`, `wgStatuses`, `loadRemoteRoutes`, `loadWgStatus`, `startTunnel`.

- [ ] **Step 1: Resolve this app's relay route + host status.** On menu open, `loadRemoteRoutes()`; compute `myRoute = remoteRoutes.find(r => r.app_id === app.id)`; if `myRoute`, `loadWgStatus(myRoute.host_id)`; `hostWg = wgStatuses[myRoute?.host_id]`; `degraded = provider==="remote" && app.tunnel_active && (!hostWg?.up || (hostWg?.handshake_age_secs ?? 0) >= 300)`.
- [ ] **Step 2: Amber degraded styling.** When `degraded`, color the trigger button amber and set the connected tooltip to `"Porta Relay connected · tunnel degraded"`.
- [ ] **Step 3: Pending banner + Retry.** When `myRoute?.status === "pending"` and not active, render a banner "Pending — the VPS didn't confirm this route" with a **Retry** button calling `startTunnel(app.id,"remote",undefined,{hostId: myRoute.host_id, subdomain: myRoute.subdomain})`.
- [ ] **Step 4: Lock glyph.** When `app.basic_auth_enabled`, show a small lock icon next to the Porta Relay section header / connected URL, indicating the public URL is protected.
- [ ] **Step 5: Typecheck.** `tsc --noEmit` → clean.
- [ ] **Step 6: Commit.** `feat(relay): degraded indicator, pending retry, auth lock in tunnel menu`

---

### Task 6: Validation + setup-guide note

**Files:** Modify `docs/porta-relay-setup.md`.

- [ ] **Step 1: Full validation.** `tsc --noEmit` && `cargo check` && `cargo test` → green.
- [ ] **Step 2: Add a "Tunnel status" note** to the setup guide: the panel shows handshake age/RX/TX; `wg show` may require the interface to be up and (on some systems) elevated privileges — if status shows "unavailable", check `wg show` works in a terminal.
- [ ] **Step 3: Commit.** `docs(relay): document WireGuard status panel`

## Self-Review

**Spec coverage:** R4 → Tasks 1,3,4,5. Error/stale + retry → Task 5 (+ RemoteSection pending list folded into Task 4/5). R7 → Task 2 (+ lock glyph Task 5). Degraded badge → Task 5. Placement (RemoteSection + app badge) honored.

**Placeholder scan:** parser test has concrete sample data; all steps have commands. The Task 2 snippet reuses the Spec-1 host literal (`/* ... */`) — the implementer copies the `RemoteHost { id:"h1", ... }` from `test_routes_for_host_maps_public_and_local_hosts` in the same file.

**Type consistency:** `WgStatus` field names identical Rust↔TS; `wgStatuses` keyed by `host_id`; `handshake_age_secs` nullable both sides; thresholds 120/300 consistent across panel + degraded.
