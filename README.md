# Porta

A macOS dev environment manager. Run your local apps, give them real `.test` domains, expose them to the internet, and deploy them — all from one native app.

Built with Tauri + React + TypeScript.

## Features

### Apps & workspaces
- **Workspaces** — group related apps together (e.g. frontend + backend + worker)
- **Process management** — start, stop, restart and monitor processes with live, streaming logs
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
- **Auto-update** — installs the latest signed release and relaunches; install once and you're set
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
- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml`

```bash
git tag v0.5.62
git push origin v0.5.62
```

The workflow builds a universal binary, signs the updater artifacts, and publishes the `.dmg` plus `latest.json` to GitHub Releases. The CI verifies the three versions match the tag before building.

### Apple code signing & notarization (optional)

By default builds are **unsigned**, so first launch hits a Gatekeeper warning. To ship notarized builds that open cleanly, add these repo secrets (requires an Apple Developer account) — the workflow picks them up automatically:

| Secret | What |
| --- | --- |
| `APPLE_CERTIFICATE` | base64 of the exported Developer ID `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | password for that `.p12` |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Name (TEAMID)` |
| `APPLE_ID` | Apple ID email |
| `APPLE_PASSWORD` | app-specific password for that Apple ID |
| `APPLE_TEAM_ID` | 10-character team ID |

Until they're set, signing is skipped and the build still succeeds.

## License

MIT
