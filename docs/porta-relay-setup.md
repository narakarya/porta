# Porta Relay — VPS setup guide

Porta Relay exposes a local app to the internet through **your own VPS**, using a
WireGuard tunnel and the VPS's Caddy. Porta manages the public entrypoint on the
VPS via Caddy's admin API (reached over the tunnel), while your app keeps running
on your Mac.

```
[Your Mac]                                   [Your VPS]
 local Caddy :443   <==== WireGuard ====>   Caddy admin API @ 10.0.0.1:2019
 (mkcert *.test)      10.0.0.2 <-> 10.0.0.1  Caddy public server "porta" :443 (Let's Encrypt)
      ^                                                |
      |  dial 10.0.0.2:443 (Host: myapp.local.test)   |
      +----------------- myapp.yourdomain.com ---------+
```

Porta assumes the VPS is **already set up** (v1 does not provision or bootstrap it
for you). This guide lists the one-time prerequisites.

## Prerequisites on the VPS

1. **WireGuard peer**, so the Mac and VPS share a private network:
   - VPS tunnel IP: `10.0.0.1` (example) — this is the host's **VPS tunnel IP** in Porta.
   - Mac tunnel IP: `10.0.0.2` (example) — this is **Mac tunnel IP** in Porta.
   - Confirm with `wg show` on both ends that the handshake succeeds.

2. **Caddy** installed and running, with its **admin API bound to the tunnel IP only**:
   ```jsonc
   // /etc/caddy/… — admin must NOT be public.
   {
     "admin": { "listen": "10.0.0.1:2019" }
   }
   ```
   > ⚠️ **Security:** never bind the admin API to `0.0.0.0:2019` or a public IP.
   > Anyone who can reach it controls your Caddy. Porta's **Test** button checks
   > reachability over the tunnel; a future release will also warn if the admin
   > API is reachable from the public interface.

3. **Ports 80 and 443 open** to the internet on the VPS. Porta owns these — it
   creates a `porta` server (`:443`, automatic Let's Encrypt TLS) and a
   `porta_redirect` server (`:80`→`:443`). Any other public sites on this VPS
   should be served **inside** Porta's Caddy via the admin API (Porta only ever
   replaces its own `porta`/`porta_redirect` servers, never yours).

4. **DNS** for your base domain pointing at the VPS's public IP:
   - Easiest: a wildcard `*.yourdomain.com  A  <vps-public-ip>` so any subdomain
     you expose resolves without extra DNS steps.
   - Or add an `A`/`AAAA` record per subdomain before exposing it.

## Register the host in Porta

Settings → **Remote Servers** → *Add remote server*:

| Field | Example | Meaning |
|---|---|---|
| Name | `my-vps` | Label only |
| VPS tunnel IP | `10.0.0.1` | WG IP where Caddy's admin API + public server live |
| Caddy admin port | `2019` | Admin API port |
| Base domain | `yourdomain.com` | Public hostnames are `<sub>.yourdomain.com` |
| Mac tunnel IP | `10.0.0.2` | This Mac's WG IP — the VPS dials it back over the tunnel |
| WireGuard interface | *(blank)* | Auto-detected via `wg show interfaces`; override if needed |

Click **Test** — a green result means Porta reached the Caddy admin API over the
tunnel.

## Expose an app

On any running app's tunnel menu → **Porta Relay** → pick the server, set a
subdomain (defaults to the app's slug) → **Expose via Porta Relay**. Within a few
seconds `https://<sub>.yourdomain.com` serves your app. **Disconnect** removes the
route from the VPS.

## Manual end-to-end checklist

1. Register the host → **Test** shows green.
2. Start an app locally, open its tunnel menu → Porta Relay → Expose.
3. Within ≤10s, `https://<sub>.yourdomain.com` loads the app over HTTPS.
4. Disconnect → the route is gone from the VPS (`curl https://<sub>.yourdomain.com`
   no longer resolves to your app), and the app's Porta Relay state clears.

## Tunnel status

Settings → Remote Servers shows each host's live WireGuard status: a colored dot
for the last handshake (green <2 min, amber <5 min, red ≥5 min), plus RX/TX and
the peer endpoint. It polls every 15 seconds while the tab is visible. Exposed
apps whose tunnel handshake goes stale (≥5 min) show an amber “degraded” state in
their tunnel menu.

If the status shows **“interface down / unavailable”** while the tunnel is
actually up, check that `wg show <interface> dump` works in a terminal — on some
setups `wg` needs the interface to be up and may require elevated privileges. Set
the interface name manually in the host settings if auto-detection picks the
wrong one.

If a route shows **“Pending — the VPS didn't confirm this route”**, the push to
the VPS Caddy failed (usually the tunnel was down). Fix connectivity, then click
**Retry expose**.

## Sync & drift (R5)

The **Sync** button on a host compares Porta's routes against the live VPS Caddy config:
- **Missing on VPS** — a route Porta expects but the VPS lost (e.g. Caddy restarted without
  Porta's config). Click **Push** to re-apply.
- **Foreign** — routes on the VPS that Porta doesn't manage (CI preview envs, manual sites).
  Shown read-only. **Remove** re-asserts Porta's routes and drops unmanaged ones — use with
  care if CI writes routes into the same `porta` server.

## Auto DNS via Cloudflare (R6)

If your base domain is on Cloudflare, fill the host's **VPS public IP** and tick **Auto-create
DNS via Cloudflare**. On expose, Porta creates a **DNS-only** (grey-cloud) A record
`<sub>.<base_domain> → <public IP>` so traffic reaches the VPS directly. Requirements:
- A Cloudflare API token in Settings → Cloudflare (same token used elsewhere).
- The zone must exist in that Cloudflare account.

Notes: creation is idempotent (an existing A record is left alone). Unexpose does **not** delete
the record (so you can reuse the subdomain); remove it manually in Cloudflare if you want it gone.
If the domain isn't on Cloudflare or the token/IP is missing, auto-DNS is skipped silently and
you set DNS yourself (the wildcard approach above still works).

## Remote access logs (R8)

To view VPS request logs inside Porta (Settings → Remote Servers → **Remote access logs**):
- Set the host's **SSH user** and (optionally) **Remote log path** (default
  `/var/log/caddy/porta-access.log`). Porta configures the VPS Caddy to write JSON access logs
  there when it pushes routes.
- Porta tails the log using your **system `ssh`** — it uses your existing `~/.ssh` keys, agent,
  and `known_hosts`. **Passwordless SSH to the VPS must work** (`ssh user@vps` should connect
  without a prompt); Porta stores no SSH credentials. `BatchMode` is on, so if SSH isn't set up
  the viewer shows a clear error instead of hanging.
- The `ssh_user` must be able to **read** the log file. Caddy usually runs as root, so either add
  the user to the `caddy` group, point the log at a path the user can read, or adjust the file
  mode.

## Caveats (v1)

- **ACME rate limits:** repeatedly exposing/unexposing *new* subdomains can hit
  [Let's Encrypt rate limits](https://letsencrypt.org/docs/rate-limits/). Reuse
  subdomains where possible; a DNS-challenge wildcard certificate option is
  planned for a later release.
- **Localhost-only apps are fine:** the VPS proxies to your **local Caddy**, not
  directly to the app's port, so apps bound to `localhost` still work.
- **VPS unreachable:** if the tunnel is down when you expose, Porta surfaces the
  error and keeps the route marked pending — click Expose again to retry once the
  tunnel is back.
