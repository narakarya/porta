# Cloudflare Tunnel: Wildcard Subdomain Setup

Share local development apps that use wildcard subdomains (e.g. `*.grandado.test`) via Cloudflare Tunnel.

## Prerequisites

- A domain managed by Cloudflare (e.g. `grandado.com`)
- `cloudflared` CLI installed

```bash
brew install cloudflared
```

## Setup

### 1. Login to Cloudflare

```bash
cloudflared tunnel login
```

This opens a browser to authorize — select the domain you want to use.

### 2. Create a Named Tunnel

```bash
cloudflared tunnel create grandado-dev
```

Note the **tunnel ID** from the output (e.g. `a1b2c3d4-...`).

### 3. Add Wildcard DNS Record

In Cloudflare Dashboard → DNS for your domain:

| Type  | Name    | Target                            | Proxy |
|-------|---------|-----------------------------------|-------|
| CNAME | `*.dev` | `<tunnel-id>.cfargotunnel.com`    | ON    |

This routes `*.dev.grandado.com` to your tunnel.

### 4. Create Tunnel Config

```bash
cat > ~/.cloudflared/config.yml << 'EOF'
tunnel: <tunnel-id>
credentials-file: ~/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: "*.dev.grandado.com"
    service: https://localhost:443
    originRequest:
      noTLSVerify: true
  - service: http_status:404
EOF
```

Replace `<tunnel-id>` with your actual tunnel ID.

**Key points:**
- `service: https://localhost:443` — routes to local Caddy (managed by Porta)
- `noTLSVerify: true` — Caddy uses mkcert self-signed certs, so skip verification
- The catch-all `http_status:404` is required by cloudflared

### 5. Configure Porta

In Porta, set the app's **Custom Domain** to `dev.grandado.com` and **Subdomain** to `*`.

This ensures Caddy routes `*.dev.grandado.com` requests to the correct app port.

### 6. Run the Tunnel

```bash
cloudflared tunnel run grandado-dev
```

### 7. Share

Your app is now accessible at:

```
https://aus.dev.grandado.com/products/...
https://dnk.dev.grandado.com/products/...
https://id.dev.grandado.com/products/...
```

## Running as a Service (persistent)

To keep the tunnel running across reboots:

```bash
sudo cloudflared service install
```

This registers cloudflared as a launchd service on macOS.

## Troubleshooting

- **502 Bad Gateway**: Ensure Caddy is running (`brew services list | grep caddy`)
- **SSL errors in tunnel**: Check `noTLSVerify: true` is set in config
- **DNS not resolving**: Wait a few minutes for DNS propagation, or check the CNAME record in Cloudflare Dashboard
- **App not routing correctly**: Verify the Custom Domain in Porta matches the tunnel hostname pattern
