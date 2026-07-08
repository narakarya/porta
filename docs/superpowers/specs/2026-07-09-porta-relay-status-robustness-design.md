# Design: Porta Relay — Status & Robustness (Spec 2 of 3)

**Status:** Approved · **Date:** 2026-07-09 · **PRD:** [Self-hosted Expose](https://docs.google.com/document/d/1-Q8-nC25Q2IpwYlY3NKPGNRzIn0wdEtlzqLKqJ2ssWM/edit)

Builds on Spec 1 (foundation). Adds live WireGuard tunnel visibility, surfaced
error/stale route state with retry, and confirms per-route basic auth. PRD Fase 2.

## Scope

**In scope:**
- **R4 WireGuard status panel:** parse `wg show <iface> dump`; show interface up/down,
  last-handshake age (green <2 min, amber <5 min, red ≥5 min), RX/TX, endpoint. Live
  panel in Settings → Remote Servers, polled every 15s only while visible. A degraded
  (amber) indicator on an exposed app when its host's handshake is ≥5 min stale.
- **Error/stale state:** surface Spec 1's `pending` routes (push failed / VPS unreachable)
  in the UI with a one-click **Retry**; never silent.
- **R7 per-route basic auth:** already flows via `routes_for_host` (`app.route_auth()`)
  from Spec 1. Confirm end-to-end with a test and surface a lock indicator on protected
  relay routes.

**Out of scope (Spec 3 / non-goals):** drift/reconcile between DB and live VPS config
(R5), CF DNS auto-record (R6), remote access logs (R8), public-IP admin-exposure warning
(carried TODO), auto WG/Caddy bootstrap.

## Locked decisions

- **WG panel placement:** full per-host status in Settings → Remote Servers **and** a
  compact degraded dot on exposed apps (brainstorming).
- Handshake color thresholds: green <2 min, amber <5 min, red ≥5 min (PRD R4).

## Architecture

### R4 — WireGuard status

**Backend** (`commands/remote.rs`): new command
`wg_status(host_id) -> Result<WgStatus, String>`.

```rust
#[derive(Serialize)]
pub struct WgStatus {
    pub interface: String,
    pub up: bool,                        // interface present in `wg show interfaces`
    pub peer_found: bool,                // a peer line matched this host
    pub endpoint: Option<String>,        // peer endpoint host:port
    pub handshake_age_secs: Option<i64>, // None = never handshaked
    pub rx_bytes: u64,
    pub tx_bytes: u64,
}
```

- Resolve the interface: host's `wg_interface` if set, else `detect_wg_interface()`.
- Run `wg show <iface> dump`. Format: first line is the interface
  (`privkey pubkey listen-port fwmark`); each subsequent tab-separated line is a peer
  (`pubkey psk endpoint allowed-ips latest-handshake rx tx keepalive`).
- Pick the peer whose `allowed-ips` contains the host's `tunnel_ip` (the VPS's WG IP);
  fall back to the first peer. `latest-handshake` is unix epoch (0 = never →
  `handshake_age_secs = None`); otherwise `now - handshake`.
- A pure parser `parse_wg_dump(out, tunnel_ip) -> Option<ParsedPeer>` is unit-tested with
  a canned `wg ... dump` sample (no live tunnel needed).

**Frontend:**
- `wgStatus(hostId)` IPC wrapper + `WgStatus` interface (browser no-op returns a
  down/never status).
- Remote slice: `wgStatuses: Record<string, WgStatus>`, `loadWgStatus(hostId)`,
  `loadAllWgStatuses()` (maps over `remoteHosts`).
- `RemoteSection`: per-host status row — colored dot + "handshake 34s ago / never",
  endpoint, RX/TX (human-readable). Polls every 15s via an interval that pauses when the
  document is hidden (mirrors `TailscaleSection`).
- `TunnelQuickMenu`: when `provider === "remote"` && the app is active && the app's host
  `handshake_age_secs >= 300` (or interface down), render the trigger + connected tooltip
  in an **amber "degraded"** state ("Porta Relay connected · tunnel degraded"). Host is
  resolved via the app's `remoteRoutes` entry → `wgStatuses[host_id]`. This touches only
  `TunnelQuickMenu` (no `AppCard` change).

### Error / stale state + Retry

- Spec 1 already persists a route with `status='pending'` and emits `{active:false,error}`
  when the VPS push fails. When that happens the app is not `tunnel_active`, so the menu
  shows the non-connected view.
- Add: the remote slice loads `remoteRoutes`; `TunnelQuickMenu` detects a `pending` route
  for this app and renders a distinct **"Pending — the VPS didn't confirm this route"**
  banner with a **Retry** button that re-invokes the relay expose with the route's stored
  `host_id`/`subdomain`. On success the row flips to `active` and the tunnel goes live.
- `RemoteSection` also lists any `pending` routes across hosts with the same Retry, so a
  stale route is visible even away from the app card.

### R7 — per-route basic auth

- No new backend logic: `routes_for_host` (Spec 1) already attaches `app.route_auth()` to
  each `RemoteRouteSpec`, and `RemoteCaddy::build_porta_server` emits the Caddy
  `authentication` handler ahead of the proxy. Add a unit test asserting a protected app's
  remote route carries the auth handler.
- UI: show a small lock glyph next to a relay route (in `RemoteSection`'s pending/active
  list and the app's connected view) when the app has basic auth enabled, so the user
  knows the public URL is protected.

## Testing

- **Rust unit:** `parse_wg_dump` — a real handshake sample (age computed, endpoint, rx/tx),
  a never-handshaked sample (`handshake_age_secs None`), multi-peer selection by
  `tunnel_ip`, and an empty/garbage sample (`None`). `wg_status` interface-resolution
  fallback. R7: `routes_for_host` on a basic-auth app yields a spec with `auth: Some`, and
  `build_porta_server` emits an `authentication` handler for it.
- **Frontend:** `tsc --noEmit` clean; slice reducer for `wgStatuses`.
- **Manual E2E (documented):** with a live tunnel — panel shows green handshake; stop the
  tunnel → panel goes red and the exposed app badges degraded; kill VPS Caddy mid-expose →
  pending banner + Retry recovers once back.
- Validation chain: `tsc --noEmit` + `cargo check` + `cargo test`.

## Risks

- **`wg` requires privileges / may be absent:** `wg show` can need root on some setups.
  `wg_status` degrades gracefully (returns `up:false` / error string) rather than throwing;
  the panel shows "unavailable" instead of breaking. Documented in the setup guide.
- **Interface name drift (utunN):** already mitigated by auto-detect + manual override
  (Spec 1); `wg_status` re-resolves each poll.
- **Polling cost:** capped at 15s and paused when the settings tab / window is hidden.
