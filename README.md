# Porta

A macOS dev environment manager. Run multiple local apps, manage reverse proxy and DNS, expose to the public — all from one place.

Built with Tauri + React + TypeScript.

## What it does

- **Workspaces** — group related apps together (e.g. frontend + backend + worker)
- **Process management** — start, stop, and monitor app processes with live log streaming
- **Reverse proxy** — automatic Caddy config per app with local `.test` domains via dnsmasq
- **Auto-detect** — detects common project types (Next.js, Rails, etc.) and suggests commands
- **Export** — backup and restore workspace configs

## Roadmap highlights

- Auto-restart on crash, env vars per app, desktop notifications — **v0.2**
- Docker services (Postgres, Redis), app dependency ordering, resource monitoring — **v0.3**
- Public expose via Cloudflare Tunnel with custom domain support — **v0.3**
- Kamal deployment section, visual orchestration & deploy canvas — **v0.4**
- Config sync across machines, app templates, launch on login — **v0.4**

See [`docs/superpowers/specs/2026-04-12-porta-roadmap-design.md`](docs/superpowers/specs/2026-04-12-porta-roadmap-design.md) for the full spec.

## Requirements

- macOS (only supported platform)
- [Caddy](https://caddyserver.com) — reverse proxy
- [dnsmasq](https://thekelleys.org.uk/dnsmasq/doc.html) — local DNS

## Development

```bash
npm install
npm run tauri dev
```

## Build

```bash
npm run tauri build
```
