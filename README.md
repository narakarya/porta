# Porta

A macOS dev environment manager. Run your local apps, give them real `.test` domains, expose them to the internet, and deploy them — all from one native app.

Built with Tauri + React + TypeScript.

## Features

### Apps & workspaces
- **Workspaces** — group related apps together (e.g. frontend + backend + worker)
- **Process management** — start, stop, restart and monitor processes with live, streaming logs
- **Debug log viewer** — searchable app/container logs with level badges,
  stable line numbers, copy actions, and alternating row colors for scanning
- **Built-in terminal** — an xterm.js terminal per app for ad-hoc commands
- **Auto-detect** — recognizes Next.js, Vite, Rails, Phoenix, Elixir, Django, Go and Rust projects and suggests the right run command
- **Per-app env & settings** — environment variables, working dir, port bindings (including multi-port)
- **Health monitoring** — live status and port checks across all running apps

### Local networking
- **Reverse proxy** — automatic [Caddy](https://caddyserver.com) config generated per app
- **`.test` domains** — local DNS via [dnsmasq](https://thekelleys.org.uk/dnsmasq) so every app gets a memorable `myapp.test` hostname
- **Local HTTPS** — wildcard `*.test` certificate so apps are served over TLS locally
- **Basic auth** — optional per-app HTTP basic auth
- **Access logs & traffic inspector** — inspect requests hitting your local apps

### Public expose
- **Cloudflare Tunnel** — share local apps over the internet (quick and named tunnels)
- **Cloudflare DNS** — manage zone DNS records from inside the app
- **Cloudflare Access** — protect exposed apps with Zero Trust access policies
- **Cloudflare Email Routing** — manage email routing rules
- **Cloudflare Zones & Certificates** — zone settings and origin/edge certificate management
- **Tailscale** — expose apps privately over your tailnet

### Containers & services
- **docker-compose** — parse and manage compose-based services
- **Container observability** — stream container logs and status
- **Disk usage** — visualize Docker disk consumption and reclaim space
- **Image updates** — detect available image updates with a risk assessment before pulling
- **Volume snapshots** — snapshot and restore Docker volumes
- **Service templates** — quick-add common services (databases, caches, etc.)

### Deploy
- **Kamal** — run [Kamal](https://kamal-deploy.org) deployments with a live PTY-backed command runner and command sidebar

### Backup & sync
- **Export / import** — back up and restore workspace and app configs
- **Google Drive** — store backups in your Drive

### Extensibility
- **Extensions** — extend Porta with custom manifest-based extensions

### Quality of life
- **Auto-update** — installs the latest updater-signed release and relaunches; install once and you're set
- **Launch on login** — start Porta automatically at login
- **Menu bar tray** — quick controls from the macOS menu bar

## Requirements

- macOS (Apple Silicon or Intel) — the only supported platform
- [Caddy](https://caddyserver.com) — reverse proxy
- [dnsmasq](https://thekelleys.org.uk/dnsmasq) — local DNS
- [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) — optional, for Cloudflare Tunnel
- [Tailscale](https://tailscale.com) — optional, for tailnet expose
- [Docker](https://www.docker.com) — optional, for container/compose features

Porta's setup wizard checks for the core dependencies and helps you install what's missing.

## Install

Download the latest `.dmg` from the [Releases](../../releases/latest) page and drag Porta into `/Applications`.

The app **auto-updates**: when a new version is published it prompts you to update and relaunch.

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

Releases are built and published automatically by GitHub Actions when a `v*` tag is pushed. Bump the version in all three files first — they must match the tag:

- `package.json`
- `package-lock.json`
- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock`

```bash
git tag v0.6.30
git push origin main
git push origin v0.6.30
```

Push the release tag explicitly. Do not use `git push --tags` for releases:
GitHub does not create tag push events when more than three tags are pushed at
once, so the Release workflow will not start.

The workflow builds Apple Silicon and Intel macOS bundles, signs the updater
artifacts, merges a single `latest.json`, and publishes the `.dmg` assets to
GitHub Releases. The CI verifies the app versions match the tag before
building.

You can also run the Release workflow manually from GitHub Actions with a
version input. In that mode the workflow bumps the version files, commits to
`main`, creates the tag, and then runs the same release build.

### Apple code signing & notarization

Release builds are currently **unsigned** at the macOS app level. First launch
therefore hits a Gatekeeper warning; right-click the app and choose **Open** to
allow it once.

The Tauri updater artifacts are still signed with the updater signing key so
in-app updates can verify downloaded bundles. Apple Developer ID signing and
notarization are intentionally not wired into the release workflow yet.

## License

MIT
