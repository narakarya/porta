# Porta

A macOS dev environment manager. Run multiple local apps, manage reverse proxy and DNS, and expose them to the public — all from one place.

Built with Tauri + React + TypeScript.

## What it does

- **Workspaces** — group related apps together (e.g. frontend + backend + worker)
- **Process management** — start, stop, and monitor app processes with live log streaming
- **Reverse proxy** — automatic Caddy config per app with local `.test` domains via dnsmasq
- **Public expose** — share local apps over the internet via Cloudflare Tunnel
- **Auto-detect** — detects common project types (Next.js, Rails, Phoenix, etc.) and suggests run commands
- **Export / import** — back up and restore workspace configs

## Requirements

- macOS (Apple Silicon or Intel) — the only supported platform
- [Caddy](https://caddyserver.com) — reverse proxy
- [dnsmasq](https://thekelleys.org.uk/dnsmasq/doc.html) — local DNS
- [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) — optional, for public expose

## Install

Download the latest `.dmg` from the [Releases](../../releases/latest) page and drag Porta into `/Applications`.

The app **auto-updates**: when a new version is published it will prompt you to update and relaunch — install once and you're set.

> First launch: macOS Gatekeeper may warn the app is from an unidentified developer. Right-click the app → **Open** to allow it once.

## Development

```bash
npm install
npm run tauri dev
```

## Build

```bash
npm run tauri build
```

## Releasing

Releases are built and published automatically by GitHub Actions when a `v*` tag is pushed:

```bash
# bump version in package.json, src-tauri/tauri.conf.json, and src-tauri/Cargo.toml first
git tag v0.5.62
git push origin v0.5.62
```

The workflow builds a universal binary, signs the updater artifacts, and publishes the `.dmg` plus `latest.json` to GitHub Releases.

## License

MIT
