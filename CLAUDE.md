# Porta

macOS dev environment manager — Tauri app yang manage multiple local apps + Caddy + dnsmasq + Cloudflare Tunnel.

## Stack
- **Shell**: Tauri 2 (Rust) — native window, all IPC commands di `src-tauri/src/commands/`
- **UI**: React 19 + TypeScript + Vite + Tailwind 3
- **State**: Zustand (`src/store/`)
- **Editor**: CodeMirror (untuk YAML config editing)
- **Terminal**: xterm.js
- **Dev introspection**: Tidewave Web (vite-plugin) → MCP at `http://localhost:1420/tidewave/mcp`

## Boundary tools (PENTING)

Project ini hybrid — **Rust di `src-tauri/`, React di `src/`**. Tools yang bisa pakai berbeda:

| Concern                                  | Tool                                                  |
|------------------------------------------|-------------------------------------------------------|
| React state (Zustand store, props, DOM)  | Tidewave Web `browser_eval`                           |
| Rust command behavior, syscall, FFI      | Baca file + `cargo check` + log (Tidewave invisible)  |
| IPC bridge (`invoke('cmd_name')`)        | Frontend = `browser_eval`, Backend = baca file        |
| Caddy/dnsmasq/Cloudflare integration     | Baca `src-tauri/src/commands/*.rs` + run command      |

**Tidewave Web hanya lihat WebView**. Apa pun yang dieksekusi Rust (file system, process spawning, network, sidecar) **invisible** — jangan habiskan token coba `browser_eval` untuk Rust bug.

## Pre-flight
Tidewave MCP butuh Vite dev server hidup di port `1420`. Cek:
```
lsof -ti:1420
```
Kalau kosong → `npm run tauri dev` (jangan `npm run dev` saja, karena kita butuh Tauri shell juga untuk command IPC).

## Validation chain (sebelum claim "done")
```
node_modules/.bin/tsc --noEmit
cargo check --manifest-path src-tauri/Cargo.toml
```

Untuk perubahan signifikan, full build sekali:
```
npm run tauri build
```

## Konvensi
- IPC command pattern: tambah handler di `src-tauri/src/commands/<area>.rs` → register di `src-tauri/src/lib.rs` → typed wrapper di `src/lib/commands.ts` → konsumsi di komponen.
- Struktur store: per-domain slice di `src/store/slices/` + subscriptions di `src/store/subscriptions.ts`.
- UI: section-based settings (`src/components/settings/*Section.tsx`), card-based app/service.
- File path konvensi: gunakan `path/to/file.ts:42` saat refer ke kode.

## Anti-patterns (sering bikin keliru)
- "App command tidak jalan" — jangan langsung baca React. Cek dulu Rust handler-nya di `src-tauri/src/commands/` dan registrasinya di `lib.rs`.
- "State tidak update" — Zustand subscriptions di `src/store/subscriptions.ts` sering jadi sumber sync issue antara Rust event dan React state.
- Tidewave MCP timeout silent kalau Vite mati — sebelum debug deep, verifikasi MCP-nya jalan dulu.

## Git hygiene
- Branch utama: `main`
- Worktrees agent (`.claude/worktrees/agent-*`) jangan di-commit — sudah di global gitignore.
- Versi dilacak di `package.json` + `src-tauri/tauri.conf.json` + `src-tauri/Cargo.toml` — bump bertiga.

## Local build perf (sccache)

Cold `cargo build` ~5 menit untuk Tauri stack (387 crates). Pasang sccache
sekali untuk potong ~50–70% setelah build pertama:

```bash
brew install sccache
echo 'export RUSTC_WRAPPER=sccache' >> ~/.zshrc
source ~/.zshrc

# Verifikasi:
sccache --show-stats        # cache hit/miss counters
```

`RUSTC_WRAPPER` env-based dibanding `.cargo/config.toml` supaya CI yang
gak punya sccache binary tidak break — kalau env-nya nggak diset, cargo
pakai rustc langsung.

Setelah `cargo clean` + rebuild, sccache mestinya hit > 95% untuk
dependencies; cuma porta crate sendiri yang fresh-compile.
