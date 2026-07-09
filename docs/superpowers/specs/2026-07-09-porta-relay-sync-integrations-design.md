# Design: Porta Relay — Sync & Integrations (Spec 3 of 3)

**Status:** Approved · **Date:** 2026-07-09 · **PRD:** [Self-hosted Expose](https://docs.google.com/document/d/1-Q8-nC25Q2IpwYlY3NKPGNRzIn0wdEtlzqLKqJ2ssWM/edit)

Final spec of the Porta Relay series. Adds sync/drift detection (R5), Cloudflare
DNS auto-record (R6), and remote access logs in the Traffic Inspector (R8). PRD Fase 3.

## Scope

In: R5 diff + reconcile, R6 CF DNS auto-record on expose, R8 remote-log tailing over
SSH merged into a per-host log viewer. Out: VPS provisioning, TCP/UDP passthrough,
multi-host, auto WG/Caddy bootstrap (PRD non-goals / P2).

## Locked decisions (brainstorming)

- **R8 transport = system `ssh` binary.** Reuse the user's existing `~/.ssh`
  config/agent/known_hosts. Porta stores only `ssh_user` + `remote_log_path` per host;
  **no key vault, no host-key store**. Assumes passwordless SSH to the VPS is configured
  (documented). Rationale: a bespoke SSH credential subsystem is a large security-sensitive
  surface disproportionate to a P1 feature; leaning on the OS ssh client is safe and
  complete.
- **R6 needs the VPS public IP** → add a `public_ip` column + a per-host `auto_dns` opt-in.
- **R5 reconcile:** Porta-managed routes missing on the VPS get **Push** (DB→VPS). Routes
  present on the VPS but unknown to Porta (CI/manual) are shown **read-only** as "foreign",
  with an explicit **Remove from VPS** action (confirmation-gated) to kill zombies — Porta
  does not silently adopt them (they have no Porta app to bind to).

## Data model additions

Non-destructive `ALTER TABLE remote_hosts` (ignored-error pattern):

```sql
ALTER TABLE remote_hosts ADD COLUMN public_ip TEXT;              -- for R6 A records
ALTER TABLE remote_hosts ADD COLUMN auto_dns INTEGER NOT NULL DEFAULT 0; -- R6 opt-in
ALTER TABLE remote_hosts ADD COLUMN ssh_user TEXT;              -- R8 ssh target user
ALTER TABLE remote_hosts ADD COLUMN remote_log_path TEXT;       -- R8 VPS Caddy access log path
```

`RemoteHost` gains: `public_ip: Option<String>`, `auto_dns: bool`,
`ssh_user: Option<String>`, `remote_log_path: Option<String>`. `remote_repo` insert/update
and `row_to_host` extended; the TS `RemoteHost` interface + `RemoteSection` form gain the
fields (public IP, an "Auto-create DNS via Cloudflare" toggle, SSH user, remote log path).

## R5 — Sync & drift detection

**Backend** (`commands/remote.rs`):
- `struct DiffReport { matched: Vec<String>, missing_on_vps: Vec<String>, foreign_on_vps: Vec<String> }`
  (host strings).
- `remote_diff(host_id) -> Result<DiffReport, String>`: `GET {admin}/config/apps/http/servers/porta`;
  extract each route's `match[].host[]`; DB desired hosts = `{sub}.{base_domain}` for the host's
  `remote_routes`. `matched` = intersection; `missing_on_vps` = DB − VPS; `foreign_on_vps` =
  VPS − DB. A pure `fn diff_hosts(db: &[String], vps: &[String]) -> DiffReport` is unit-tested.
  Parsing VPS route hosts is a pure `fn extract_route_hosts(server: &Value) -> Vec<String>`
  (also unit-tested).
- `remote_push_host(host_id)`: reuse Spec 1 `push_host` to re-apply the DB state (fixes
  `missing_on_vps` and any pending routes) — returns Ok/err.
- `remote_remove_foreign(host_id, public_host)`: rebuild the porta server from DB routes
  **plus** explicitly excluding `public_host`, then PUT — i.e. a Push that also drops the
  named zombie. (Because Porta owns the whole `porta` server, a plain Push already removes
  foreign routes; this action is the confirmation-gated "yes, really drop it".)

**Frontend:** a **Sync** button per host in `RemoteSection` → calls `remote_diff`, shows a
compact panel: matched count, "missing on VPS → Push" (button per item or bulk), "foreign on
VPS (not managed by Porta)" list with a **Remove** button (confirm) each.

## R6 — Cloudflare DNS auto-record

**Backend** (`commands/remote.rs`), invoked inside `expose_remote` after a successful push,
only when `host.auto_dns` is true:
- Read token via `crate::commands::settings::get_cf_api_token()`; if empty, skip silently
  (log a note in the returned URL message — non-fatal).
- Resolve the zone: `cf_dns_list_zones(token)` → find the zone whose `name` is a suffix of
  `base_domain` (longest match). If none, skip (user's domain isn't on CF) — non-fatal.
- Idempotent create: `cf_dns_list_records(token, zone_id, search=<fqdn>)`; if an A record for
  `<sub>.<base_domain>` already exists, do nothing; else `cf_dns_create_record` with
  `{ type:"A", name:<fqdn>, content: host.public_ip, proxied:false }` (**DNS-only** so traffic
  reaches the VPS directly, not the CF proxy). Requires `public_ip` set; if missing, skip with
  a note.
- Helper `fn zone_for_domain(zones: &[DnsZone], base_domain: &str) -> Option<zone_id>` is
  unit-tested (longest-suffix match).
- Failures here never fail the expose (the tunnel is already live) — surfaced as a note.

## R8 — Remote access logs in Traffic Inspector

**VPS-side logging (auto-configured on push):** extend the remote push so the VPS `porta`
server writes JSON access logs to `host.remote_log_path` (default
`/var/log/caddy/porta-access.log` when the field is blank):
- `RemoteCaddy::build_porta_server` gains a server-level `logs` block referencing a logger
  name `porta_relay`; `put_porta_server` additionally PUTs
  `/config/logging/logs/porta_relay` = `{ writer: { output:"file", filename:<path> }, encoder:{format:"json"}, include:["http.log.access.porta_relay"] }`.
  Skipped when `remote_log_path` is blank AND logging isn't desired — but default-on with the
  default path keeps it simple.

**Tailing over SSH** (`commands/remote.rs`):
- `struct SshTarget` resolved from the host: user `ssh_user`, host `public_ip` (fallback
  `base_domain`), path `remote_log_path`.
- `remote_log_tail(host_id, lines) -> Result<Vec<AccessLogEntry>, String>`: run
  `ssh -o BatchMode=yes -o ConnectTimeout=8 <user>@<host> "tail -n <lines> <path>"`, parse each
  JSON line with the **existing** `access_log` Caddy-JSON parser (refactor its per-line parse
  into a reusable `access_log::parse_caddy_line(&str) -> Option<AccessLogEntry>` and call it
  here — DRY with the local tail). `BatchMode=yes` means it fails fast instead of prompting for
  a password, surfacing a clear "SSH not configured" error.
- `remote_log_live_start(host_id) -> stream_id` / `remote_log_live_stop(stream_id)`: mirror the
  local `live_access_log_start` pattern — spawn a tokio task running
  `ssh ... "tail -n 50 -F <path>"` as a child process, read stdout line-by-line, parse, and
  emit `access-log:remote:<host_id>` events. Cancel kills the child.

**Frontend:** a **Remote logs** viewer in `RemoteSection` per host (reusing the access-log
entry row rendering if a shared component exists, else a compact method/host/status/uri table):
"Load recent" (one-shot `remote_log_tail`) + a Live toggle (`remote_log_live_start/stop`,
subscribe to `access-log:remote:<host_id>`). Deep per-app merge into the existing Traffic
Inspector is out of scope; per-host viewing satisfies "remote logs visible in Porta".

## Testing

- **Rust unit:** `diff_hosts` (matched/missing/foreign), `extract_route_hosts` (from a sample
  porta-server JSON), `zone_for_domain` (longest-suffix, no-match), `access_log::parse_caddy_line`
  (a real Caddy JSON line → entry; garbage → None), `build_porta_server` now emits a `logs`
  block. SSH/CF network paths are not unit-tested (integration-only) but their pure helpers are.
- **Frontend:** `tsc --noEmit`; slice reducers for diff + remote-log entries.
- **Manual E2E (documented):** delete a route on the VPS out-of-band → Sync shows it missing →
  Push restores it; add a foreign route → Sync lists it → Remove drops it. Expose with `auto_dns`
  on a CF domain → A record appears (DNS-only). With SSH configured → Remote logs "Load recent"
  shows VPS requests; Live streams new ones.
- Validation: `tsc --noEmit` + `cargo check` + `cargo test`.

## Risks

- **SSH not configured / prompts:** `BatchMode=yes` + `ConnectTimeout` fail fast with a clear
  error rather than hanging; the viewer shows "SSH unavailable — configure passwordless SSH to
  the VPS". Documented.
- **VPS log path permissions:** Caddy (root) writes the log; `ssh_user` must be able to read it.
  Documented (e.g. add the user to the caddy group or point at a world-readable path).
- **CF DNS side effects:** create is idempotent (list-before-create) and DNS-only; never fails
  the expose. Unexpose does **not** delete the A record in v1 (avoids nuking a record the user
  may reuse) — noted as a deliberate choice.
- **Foreign-route removal is destructive:** confirmation-gated, and the panel labels them as
  possibly CI-managed.
