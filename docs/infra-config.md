# Infra Config — Home Server (seed data untuk Self-hosted Expose)

Ringkasan konfigurasi aktual VPS + Mac Mini per 2026-07-09.
Dipakai sebagai referensi/seed saat implementasi `docs/spec-self-hosted-expose.md`.

## Topologi

```
Internet → VPS IDCloudHost (Caddy, :80/:443)
             ↕ WireGuard (UDP 51820)
           Mac Mini M1 16GB (apps)
```

## VPS (tunnel endpoint)

| Field | Value |
|---|---|
| Provider | IDCloudHost, Basic Standard (2 vCPU / 2GB / 20GB NVMe) |
| DC | Jakarta |
| OS | Ubuntu 24.04 LTS |
| Hostname | `tunnel` (prompt: `home@tunnel`) |
| IP publik | `<ISI_IP_PUBLIK_VPS>` ← belum tercatat, cek console IDCloudHost |
| SSH user | `home` (key-only; root & password login disabled) |
| UFW allow | 22/tcp, 80/tcp, 443/tcp, 51820/udp |
| IP forwarding | aktif (`net.ipv4.ip_forward=1`) |
| WireGuard iface | `wg0`, service `wg-quick@wg0` (enabled) |
| WG address | `10.0.0.1/24`, ListenPort `51820` |
| WG config | `/etc/wireguard/wg0.conf` |
| Caddy | installed via apt repo resmi, config `/etc/caddy/Caddyfile` |
| Caddy admin API | `localhost:2019` (default) — **TODO spec R1: rebind ke `10.0.0.1:2019`** |

## Mac Mini (app host)

| Field | Value |
|---|---|
| Hardware | Mac Mini M1, 16GB RAM, 512GB |
| Hostname | `mini-unknown` (belum di-rename) |
| macOS user | `nasrulgunawan` |
| LAN IP | `192.168.18.100` (DHCP reservation di router) |
| MAC address di reservation | `9e:17:f1:90:6a:d0` ⚠️ locally-administered (Private Wi-Fi Address) — kalau pindah ke Ethernet/matikan private address, update reservation |
| WG address | `10.0.0.2/24`, `PersistentKeepalive = 25` |
| WG config | `/opt/homebrew/etc/wireguard/wg0.conf` (chmod 600) |
| WG interface runtime | `utunX` (dinamis, terakhir `utun6`) — deteksi via `wg show interfaces` |
| WG autostart | launchd `/Library/LaunchDaemons/com.wireguard.wg0.plist` |
| Tooling | Homebrew (`/opt/homebrew`), mise (node@lts terpasang) |
| Test app | node hello di `~/apps/hello/server.js`, listen `0.0.0.0:3000` |

## Jaringan rumah

| Field | Value |
|---|---|
| ISP | Biznet (latensi ke Vultr SG ~15ms; ke DC Jakarta lebih rendah) |
| Router gateway | `192.168.18.1` (subnet `192.168.18.0/24`) |

## Domain

| Field | Value |
|---|---|
| Domain | `<BELUM_DIBELI>` — rencana .my.id, DNS via Cloudflare |
| DNS plan | A `@` → IP VPS, A `*` → IP VPS (DNS only dulu, bukan proxied) |

## Konvensi routing (dipakai Caddy VPS & spec)

- Upstream app dari VPS: `10.0.0.2:<port>` (bukan localhost)
- Port app: mulai 3000; preview env: `4000 + nomor PR`, compose project `pr-<N>`
- Preview route: `/etc/caddy/previews/*.caddy` via `import` (milik CI, JANGAN ditimpa Porta — lihat spec: PATCH per-route dengan prefix `porta_`)

## Kredensial & secrets (TIDAK dicatat di sini)

WG private keys (di config masing-masing mesin), SSH keys, password — jangan pernah commit. File ini aman di-commit karena hanya berisi topologi.
