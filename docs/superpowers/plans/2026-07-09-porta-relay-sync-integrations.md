# Porta Relay — Sync & Integrations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline). Steps use `- [ ]` checkboxes.

**Goal:** Add drift sync (R5), Cloudflare DNS auto-record (R6), and remote access logs over SSH (R8) to Porta Relay (PRD Fase 3).

**Architecture:** R5 diffs DB `remote_routes` vs the live VPS `porta` server (admin GET) and reconciles via Push / Remove-foreign. R6, on expose, idempotently creates a DNS-only A record via the existing `cf_dns` commands using a new per-host `public_ip` + `auto_dns`. R8 auto-configures JSON access logging on the VPS porta server and tails it via the system `ssh` client into a per-host viewer, reusing the local Caddy-JSON parser.

**Tech Stack:** Rust (Tauri, reqwest, serde, tokio), React 19 + TS + Zustand.

## Global Constraints

- Same as Spec 1/2. Validation: `tsc --noEmit` + `cargo check` + `cargo test`.
- Reuse existing modules: `cf_dns` (`cf_dns_list_zones`, `cf_dns_list_records`, `cf_dns_create_record`, `DnsRecordInput`, `DnsZone`), `settings::get_cf_api_token`, `access_log`.
- SSH via system `ssh` with `-o BatchMode=yes -o ConnectTimeout=8` (no credential storage).
- Spec: `docs/superpowers/specs/2026-07-09-porta-relay-sync-integrations-design.md`.

---

### Task 1: Host schema extension (public_ip, auto_dns, ssh_user, remote_log_path)

**Files:** `src-tauri/src/db/mod.rs`, `src-tauri/src/db/models.rs`, `src-tauri/src/db/remote_repo.rs`, `src/lib/commands.ts`, `src/components/settings/RemoteSection.tsx`.

**Interfaces:** `RemoteHost` gains `public_ip: Option<String>`, `auto_dns: bool`, `ssh_user: Option<String>`, `remote_log_path: Option<String>` (Rust + TS).

- [ ] **Step 1: Migrate.** In `db/mod.rs::migrate`, after the `remote_routes` block, add four ignored `ALTER TABLE remote_hosts ADD COLUMN …` per the spec.
- [ ] **Step 2: Extend struct + repo.** Add the fields to `RemoteHost`; update `insert_remote_host`, `update_remote_host` (new columns), and `row_to_host` (read cols 8–11). Update the Spec-1 round-trip test literal + the `test_host()` helper in `commands/remote.rs` to include the new fields (`..` not usable — explicit).
- [ ] **Step 3: Run DB test.** `cargo test --lib remote_host_and_route` → PASS (after fixing struct literals).
- [ ] **Step 4: TS interface + form.** Add the fields to `RemoteHost` in `commands.ts` and `EMPTY_HOST`; add inputs to `RemoteSection` (Public IP, SSH user, Remote log path) + an "Auto-create DNS via Cloudflare" checkbox bound to `auto_dns`.
- [ ] **Step 5: Typecheck + commit.** `tsc --noEmit` clean. `feat(relay): host fields for DNS + SSH log tailing`

---

### Task 2: R5 drift detection backend

**Files:** `src-tauri/src/commands/remote.rs`, `src-tauri/src/lib.rs`.

**Interfaces:** `struct DiffReport { matched: Vec<String>, missing_on_vps: Vec<String>, foreign_on_vps: Vec<String> }`; pure `fn diff_hosts(db: &[String], vps: &[String]) -> DiffReport`; pure `fn extract_route_hosts(server: &serde_json::Value) -> Vec<String>`; commands `remote_diff(host_id)`, `remote_push_host(host_id)`, `remote_remove_foreign(host_id, public_host)`.

- [ ] **Step 1: Failing pure-fn tests.**
```rust
#[test]
fn test_diff_hosts_partitions() {
    let d = diff_hosts(&["a.x".into(), "b.x".into()], &["b.x".into(), "c.x".into()]);
    assert_eq!(d.matched, vec!["b.x"]);
    assert_eq!(d.missing_on_vps, vec!["a.x"]);
    assert_eq!(d.foreign_on_vps, vec!["c.x"]);
}
#[test]
fn test_extract_route_hosts() {
    let server = serde_json::json!({"routes":[
        {"match":[{"host":["a.x"]}]},{"match":[{"host":["b.x","c.x"]}]}]});
    let mut hosts = extract_route_hosts(&server);
    hosts.sort();
    assert_eq!(hosts, vec!["a.x","b.x","c.x"]);
}
```
- [ ] **Step 2: Run, verify fail.** `cargo test --lib diff_hosts` → FAIL.
- [ ] **Step 3: Implement** the pure fns + the three commands. `remote_diff`: GET `{admin}/config/apps/http/servers/porta` (404/err → treat VPS hosts as empty), `extract_route_hosts`, DB desired = `{sub}.{base_domain}` from `list_remote_routes_for_host`. `remote_push_host`: fetch host+routes+apps+workspaces, call `push_host`. `remote_remove_foreign`: `push_host` (DB-only rebuild already drops foreign) — implemented as a push after confirming; return Ok.
- [ ] **Step 4: Register** `remote_diff`, `remote_push_host`, `remote_remove_foreign` in `lib.rs`; run `cargo test --lib diff_hosts extract_route_hosts` → PASS; `cargo check` clean.
- [ ] **Step 5: Commit.** `feat(relay): drift detection (diff/push/remove-foreign)`

---

### Task 3: R5 frontend Sync UI

**Files:** `src/lib/commands.ts`, `src/store/slices/remote.ts`, `src/components/settings/RemoteSection.tsx`.

**Interfaces:** TS `DiffReport`; wrappers `remoteDiff(hostId)`, `remotePushHost(hostId)`, `remoteRemoveForeign(hostId, publicHost)`. Slice: `remoteDiffs: Record<string, DiffReport>`, `loadRemoteDiff(hostId)`, `pushRemoteHost(hostId)`, `removeForeign(hostId, host)`.

- [ ] **Step 1: Wrappers + slice methods.**
- [ ] **Step 2: RemoteSection UI:** a **Sync** button per host → shows matched count, missing list with **Push**, foreign list with **Remove** (window.confirm).
- [ ] **Step 3: Typecheck + commit.** `feat(relay): Sync/drift panel in Remote Servers`

---

### Task 4: R6 Cloudflare DNS auto-record

**Files:** `src-tauri/src/commands/remote.rs`.

**Interfaces:** pure `fn zone_for_domain(zones: &[DnsZone], base_domain: &str) -> Option<String>` (returns zone_id, longest-suffix match); called inside `expose_remote` after a successful push when `host.auto_dns`.

- [ ] **Step 1: Failing test.**
```rust
#[test]
fn test_zone_for_domain_longest_suffix() {
    let zones = vec![
        DnsZone { id:"z1".into(), name:"example.com".into() },
        DnsZone { id:"z2".into(), name:"sub.example.com".into() }];
    assert_eq!(zone_for_domain(&zones, "app.sub.example.com").as_deref(), Some("z2"));
    assert_eq!(zone_for_domain(&zones, "app.example.com").as_deref(), Some("z1"));
    assert_eq!(zone_for_domain(&zones, "other.org"), None);
}
```
(Adjust to the real `DnsZone` field names — check `cf_dns.rs`.)
- [ ] **Step 2: Run, verify fail.** `cargo test --lib zone_for_domain` → FAIL.
- [ ] **Step 3: Implement** `zone_for_domain` + an async `maybe_create_dns(host, subdomain) -> Option<String>` (note string): token via `get_cf_api_token()`, skip if empty / no `public_ip` / no zone; `cf_dns_list_records` search fqdn, skip if exists; else `cf_dns_create_record({type:"A", name:fqdn, content:public_ip, proxied:false})`. Call from `expose_remote` after push; append any note to the returned URL result (non-fatal). `expose_remote` becomes `async` — update the handler + `lib.rs` (it's `generate_handler!`-compatible either way).
- [ ] **Step 4: Run test + check.** `cargo test --lib zone_for_domain` → PASS; `cargo check` clean.
- [ ] **Step 5: Commit.** `feat(relay): auto-create Cloudflare DNS A record on expose`

---

### Task 5: R8 VPS access logging + shared parser

**Files:** `src-tauri/src/access_log.rs`, `src-tauri/src/caddy.rs`.

**Interfaces:** `access_log::parse_caddy_line(&str) -> Option<AccessLogEntry>` (extract from the current per-line parse; local `tail` calls it). `RemoteCaddy::build_porta_server` emits a server `logs` block (`{ "logger_names": {...} }` or `default_logger_name: "porta_relay"`); `RemoteCaddy` gains `put_logging(&self, log_path: &str)` PUTting `/config/logging/logs/porta_relay`.

- [ ] **Step 1: Refactor parser.** Extract the JSON-line→`AccessLogEntry` logic in `access_log.rs` into `pub fn parse_caddy_line(line: &str) -> Option<AccessLogEntry>`; have `tail` use it. Add a test: a real Caddy access JSON line parses; `""`/`"{}"`/garbage → `None`.
- [ ] **Step 2: Run.** `cargo test --lib parse_caddy_line` → PASS (behavior preserved).
- [ ] **Step 3: VPS logging config.** In `build_porta_server`, add `"logs": { "default_logger_name": "porta_relay" }` to the server. Add `RemoteCaddy::put_logging(log_path)` and call it from `put_porta_server` when a log path is provided. Update `push_host`/callers to pass `host.remote_log_path` (default `/var/log/caddy/porta-access.log`). Add a test asserting the server has a `logs` block.
- [ ] **Step 4: Run + check.** `cargo test --lib caddy` → PASS; `cargo check` clean.
- [ ] **Step 5: Commit.** `feat(relay): VPS access logging + shared Caddy-line parser`

---

### Task 6: R8 SSH log tailing backend

**Files:** `src-tauri/src/commands/remote.rs`, `src-tauri/src/lib.rs`.

**Interfaces:** `remote_log_tail(host_id, lines) -> Result<Vec<AccessLogEntry>, String>`; `remote_log_live_start(app, state, host_id) -> Result<String,String>`; `remote_log_live_stop(state, stream_id)`. Reuses `access_log::parse_caddy_line`. A `RemoteLogStreams` state (like `AccessLogStreams`) tracks live children.

- [ ] **Step 1: Implement `ssh_target(host) -> (user_at_host, path)`** — `format!("{}@{}", ssh_user, public_ip.or(base_domain))`, path from `remote_log_path` (default). Guard: missing `ssh_user` → clear error.
- [ ] **Step 2: `remote_log_tail`** — `std::process::Command::new("ssh").args(["-o","BatchMode=yes","-o","ConnectTimeout=8", &user_at_host, &format!("tail -n {lines} {path}")])`; on non-zero exit return stderr as a friendly error; else map `parse_caddy_line` over stdout lines.
- [ ] **Step 3: `remote_log_live_start/stop`** — mirror `commands/access_log.rs` `live_access_log_start`: spawn a tokio task running `ssh … "tail -n 50 -F {path}"` as a child (`tokio::process::Command`), read stdout lines, parse, emit `access-log:remote:<host_id>`; stop kills the child + removes the handle. Register `RemoteLogStreams` in `lib.rs` `.manage(...)` and the three commands in `generate_handler!`.
- [ ] **Step 4: Compile.** `cargo check` clean (no unit test for the network path; helpers already covered).
- [ ] **Step 5: Commit.** `feat(relay): tail VPS access logs over SSH`

---

### Task 7: R8 frontend remote-log viewer

**Files:** `src/lib/commands.ts`, `src/store/slices/remote.ts`, `src/components/settings/RemoteSection.tsx`.

**Interfaces:** TS `AccessLogEntry` (mirror or import if already defined for Traffic Inspector); wrappers `remoteLogTail(hostId, lines)`, `remoteLogLiveStart(hostId)`, `remoteLogLiveStop(streamId)`.

- [ ] **Step 1: Wrappers.** Reuse the existing `AccessLogEntry` TS type if present (grep `access-log`), else define a minimal one.
- [ ] **Step 2: Viewer.** Per-host **Remote logs** area in `RemoteSection`: "Load recent" (`remoteLogTail(id,100)`) renders a compact table (time · method · host · status · uri); a **Live** toggle calls `remoteLogLiveStart`, subscribes to `listen("access-log:remote:"+hostId)` appending entries, and `remoteLogLiveStop` on toggle-off/unmount.
- [ ] **Step 3: Typecheck + commit.** `feat(relay): remote access-log viewer in Remote Servers`

---

### Task 8: Validation + setup guide

**Files:** `docs/porta-relay-setup.md`.

- [ ] **Step 1: Full validation.** `tsc --noEmit` && `cargo check` && `cargo test` → green.
- [ ] **Step 2: Document** in the setup guide: R5 Sync (drift/zombie routes), R6 (fill Public IP + enable Auto-DNS; needs the CF token in Settings → Cloudflare; A record is DNS-only and not deleted on unexpose), R8 (set SSH user + remote log path; requires passwordless SSH and the log file readable by that user; `BatchMode` fails fast if not configured).
- [ ] **Step 3: Commit.** `docs(relay): document sync, CF DNS, and remote logs`

## Self-Review

**Spec coverage:** R5 → Tasks 2,3. R6 → Tasks 1,4. R8 → Tasks 1,5,6,7. Schema (public_ip/auto_dns/ssh_user/remote_log_path) → Task 1. Shared parser DRY → Task 5. Docs → Task 8.

**Placeholder scan:** pure-fn tests have concrete data; the `DnsZone`/`AccessLogEntry` field names are flagged to verify against source before use (Tasks 4,7) — not placeholders but explicit "check the real type" notes.

**Type consistency:** `DiffReport` (matched/missing_on_vps/foreign_on_vps) identical Rust↔TS; `remote_diff/push_host/remove_foreign` names consistent; `AccessLogEntry` reused from `access_log`; event channel `access-log:remote:<host_id>` consistent between Task 6 emit and Task 7 subscribe.
