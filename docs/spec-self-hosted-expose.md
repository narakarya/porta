# PRD: Self-hosted Expose

**Status:** Draft · **Versi:** 1.0 · **Tanggal:** 2026-07-09
**Fitur:** Expose app lokal ke internet via VPS milik user (WireGuard + Caddy remote)

---

## Problem Statement

Developer yang ingin memamerkan app lokal ke internet lewat Porta saat ini hanya punya dua opsi: Cloudflare Tunnel (terikat ekosistem & ToS Cloudflare, HTTP-only pada praktiknya) dan Tailscale Funnel (domain `*.ts.net`, ada limit bandwidth, lebih cocok demo). Developer yang sudah punya VPS murah + home server — segmen yang berkembang di komunitas self-hosting — harus keluar dari Porta dan mengelola WireGuard + Caddyfile manual via SSH, padahal Porta sudah punya seluruh primitif yang dibutuhkan (route model, Caddy admin API client, pola integrasi eksternal).

Tanpa fitur ini, Porta berhenti di batas `localhost` — sementara nilai terbesarnya justru menjadi satu-satunya control panel dari dev lokal sampai publik.

## Goals

1. User bisa expose app lokal ke domain publik miliknya sendiri dalam **≤ 3 klik** dari app card (setelah setup awal sekali).
2. Setup wizard host remote selesai dalam **≤ 15 menit** untuk user yang sudah punya VPS + domain (tanpa menulis config manual).
3. Route publik konsisten dengan route lokal: satu sumber kebenaran (DB Porta), tidak ada drift antara Caddy lokal dan Caddy VPS.
4. Status tunnel WireGuard terlihat real-time di UI (handshake, transfer, reachable/tidak) — user tidak perlu lagi `wg show` manual.
5. Menjadi backend expose ketiga yang setara: pilihan "Cloudflare / Tailscale / **My Server**" di TunnelQuickMenu.

## Non-Goals

- **Provisioning VPS** (beli/create VM dari dalam Porta) — kompleksitas API per-provider tinggi, nilai rendah; user diasumsikan sudah punya VPS. *(Future: guided script)*
- **Instalasi WireGuard/Caddy otomatis di VPS via SSH** untuk v1 — v1 mengasumsikan VPS sudah ter-setup (ada panduan); otomasi bootstrap masuk P2.
- **Manajemen DNS domain non-Cloudflare** — Porta sudah punya modul `cf_dns`; registrar lain di luar scope.
- **TCP/UDP passthrough (non-HTTP)** — v1 HTTP/HTTPS reverse proxy saja; DNAT/stream masuk P2.
- **Multi-user/team sharing** — Porta single-user; kolaborasi adalah inisiatif terpisah.

## User Stories

**Persona utama: "Home-server developer"** — developer solo dengan Mac (Porta) + VPS murah + domain sendiri.

- Sebagai developer, saya ingin mendaftarkan VPS saya sebagai "remote host" di Porta supaya Porta tahu ke mana harus push config publik.
- Sebagai developer, saya ingin klik "Expose via My Server" di app card dan mendapat `myapp.domainku.com` HTTPS supaya saya tidak perlu SSH + edit Caddyfile manual.
- Sebagai developer, saya ingin melihat status WireGuard (handshake terakhir, transfer, endpoint) di Porta supaya saya tahu tunnel sehat tanpa buka terminal.
- Sebagai developer, saya ingin unexpose app dengan satu klik supaya route publik hilang bersih dari VPS.
- Sebagai developer, saya ingin melihat daftar semua route publik yang aktif di host remote supaya tidak ada route zombie yang lupa dimatikan.
- Sebagai developer, saat VPS tidak reachable saya ingin Porta menampilkan error yang jelas (bukan silent fail) dan menandai route sebagai "stale" supaya saya tahu state di VPS mungkin beda dengan state di Porta.
- Sebagai developer, saya ingin basic auth per-route publik (reuse fitur yang sudah ada) supaya app staging tidak bisa diakses sembarang orang.

## Requirements

### Must-Have (P0)

**R1. Remote host inventory**
Modul baru `commands/remote.rs` mengikuti pola `cf_*`/`tailscale`. CRUD host: nama, IP tunnel (mis. `10.0.0.1`), port admin Caddy (default 2019), base domain (mis. `domainku.com`). Persist di rusqlite (tabel `remote_hosts`).

- [ ] User bisa tambah/edit/hapus remote host di Settings → section baru "Remote Servers"
- [ ] Tes koneksi: tombol "Test" → GET `http://<tunnel-ip>:2019/config/` → sukses/gagal dengan pesan jelas
- [ ] Given tidak ada host terdaftar, When user buka menu expose, Then opsi "My Server" tampil disabled dengan hint setup

**R2. Parameterisasi Caddy client**
Refactor `caddy.rs`: `CADDY_API` (saat ini hardcoded `localhost:2019`) menjadi parameter per-target. Satu `CaddyManager` bisa melayani target lokal dan N target remote.

- [ ] `build_config()` untuk target remote menghasilkan route dengan upstream `dial: 10.0.0.2:<port>` (IP Mac di tunnel), bukan `localhost`
- [ ] TLS di target remote memakai ACME/Let's Encrypt otomatis (bukan cert mkcert lokal)
- [ ] Config lokal tidak berubah perilaku (regression-safe; snapshot test JSON config lokal sebelum/sesudah refactor)

**R3. Expose/unexpose flow**
Aksi di app card & TunnelQuickMenu: "Expose via My Server" → pilih subdomain (default: slug nama app) → push route ke Caddy VPS → tampilkan URL.

- [ ] Given app jalan di port 3000 dan tunnel sehat, When user expose dengan subdomain `myapp`, Then dalam ≤10 detik `https://myapp.domainku.com` melayani app
- [ ] Unexpose menghapus route dari config VPS dan state Porta secara atomik
- [ ] Route publik tersimpan di DB (tabel `remote_routes`: app_id, host_id, subdomain, basic_auth) — restart Porta tidak kehilangan state
- [ ] Kalau push gagal (VPS unreachable), state route ditandai `pending/stale`, ada tombol retry, tidak ada partial state yang diam-diam

**R4. Panel status WireGuard**
Parse output `wg show <iface> dump` (via shell, interface configurable, default `wg0`/utun).

- [ ] Menampilkan: status interface, handshake terakhir (dengan warna: hijau <2 menit, kuning <5, merah lebih), RX/TX, endpoint
- [ ] Polling ringan (interval 10-15 detik) hanya saat panel terlihat
- [ ] Given handshake >5 menit, When user melihat app card yang ter-expose, Then ada indikator degraded di badge expose

### Nice-to-Have (P1)

- **R5. Sync & drift detection** — tombol "Sync" yang membandingkan `remote_routes` di DB vs config aktual di Caddy VPS, tampilkan diff, opsi reconcile ke salah satu arah.
- **R6. Reuse Cloudflare DNS** — kalau domain user di Cloudflare (modul `cf_dns` sudah ada), auto-create A record subdomain saat expose (untuk user tanpa wildcard record).
- **R7. Basic auth per route publik** — reuse bcrypt basic-auth yang sudah ada di route model.
- **R8. Access log remote di Traffic Inspector** — tail log JSON Caddy VPS melalui endpoint admin/SSH, satukan ke Traffic Inspector yang ada.

### Future Considerations (P2)

- **Bootstrap VPS otomatis**: wizard yang SSH ke VPS baru dan menginstall WireGuard + Caddy + config awal (menghapus prasyarat manual).
- **TCP/UDP passthrough** via Caddy layer4 / iptables DNAT.
- **Multi-host**: satu app di-expose ke lebih dari satu VPS (geo/failover).
- **Preview environments panel**: kelola compose project `pr-*` + URL preview (spec terpisah, lihat "Ide Lanjutan").

## Desain Teknis (ringkas)

```
[Porta/Mac] --WireGuard--> [VPS]
    |                        |
    | HTTP PUT /load         | Caddy (admin API bind 10.0.0.1:2019)
    +--> 10.0.0.1:2019 ------+--> route: myapp.domainku.com → dial 10.0.0.2:3000
```

- **Keamanan**: admin API Caddy di VPS **wajib bind ke IP tunnel saja** (`10.0.0.1:2019`), tidak pernah ke publik. Dokumentasikan di panduan setup + validasi di "Test connection" (warning kalau admin API ternyata reachable dari IP publik).
- **IPC**: `commands/remote.rs` (host CRUD, test, wg status, expose/unexpose) → register `lib.rs` → wrapper `src/lib/commands.ts` → slice Zustand baru `remote.ts` + subscriptions untuk event status.
- **Config VPS**: Porta memiliki *sebagian* config Caddy VPS. Strategi v1: Porta mengelola satu blok route dengan ID ber-prefix `porta_` via admin API `PATCH` per-route (bukan `POST /load` full replace) supaya config manual user (mis. blok `:80`, preview env dari CI) tidak tertimpa. Ini keputusan arsitektur terpenting — full-replace lebih sederhana tapi menghancurkan koeksistensi dengan workflow CI preview.

## Success Metrics

- **Leading**: waktu setup host pertama (target ≤15 menit, ukur via telemetry wizard jika ada / self-report); expose sukses rate ≥95% saat tunnel sehat; waktu expose-klik-sampai-URL-hidup ≤10 detik.
- **Lagging (30-60 hari)**: ≥30% user aktif yang punya remote host melakukan ≥5 expose/bulan; penurunan penggunaan Cloudflare quick tunnel pada user yang setup My Server (indikasi preferensi); issue/bug report kategori "expose" < 5 per rilis.

## Open Questions

1. **(Engineering, blocking)** PATCH per-route vs full `POST /load`: konfirmasi granularitas admin API Caddy cukup stabil untuk manipulasi per-route (`/config/apps/http/servers/.../routes/...`) — perlu spike 1-2 hari.
2. **(Engineering, non-blocking)** Deteksi interface WireGuard di macOS (`utunX` dinamis) — pakai `wg show interfaces` atau biarkan user pilih manual di settings?
3. **(Product, non-blocking)** Nama fitur di UI: "My Server", "Self-hosted", atau nama brand ("Porta Relay")?
4. **(Engineering, non-blocking)** Rate limit ACME Let's Encrypt kalau user expose-unexpose berulang dengan subdomain berbeda — perlukah wildcard cert via DNS challenge sebagai opsi?

## Phasing

- **Fase 1 (P0, ~1-2 minggu):** R1 + R2 + R3 happy path — host inventory, refactor caddy.rs, expose/unexpose, tanpa drift handling canggih.
- **Fase 2 (P0 sisa + P1 inti, ~1 minggu):** R4 panel WireGuard, error/stale state, R7 basic auth.
- **Fase 3 (P1, opportunistic):** R5 sync/drift, R6 CF DNS, R8 remote logs.

---

## Lampiran: Ide Fitur Lanjutan (bukan bagian scope ini)

1. **Preview Environments Panel** — tampilkan compose project ber-prefix `pr-*` sebagai grup: URL, umur, tombol cleanup; integrasi `gh` untuk link ke PR. Sinergis dengan Self-hosted Expose (route preview dikelola CI, Porta menampilkannya read-only via R5 sync).
2. **GitHub Actions Visibility** — status self-hosted runner + `gh run list` per app di app card. Kandidat kuat **extension** (pola porta-kamal, cukup shell bridge), bukan core.
3. **Notifikasi ntfy** — event Porta (app crash, expose gagal, disk Docker penuh) → push ntfy; setting URL topic di Settings. Kecil, cepat, nilai harian tinggi.
4. **Remote host health di menu bar tray** — dot hijau/merah tunnel di tray macOS; melengkapi R4.
5. **"Promote to production"** — dari preview/expose staging ke route produksi permanen dengan satu aksi (rename subdomain + pin).
