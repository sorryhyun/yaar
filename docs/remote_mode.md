# Remote Mode

Remote mode lets you access YAAR from other devices on your network (phone, tablet, another PC) with token-based authentication.

## Quick Start

```bash
make claude   # Start with Claude provider (remote mode)
make codex    # Start with Codex provider (remote mode)
```

The server will print a connection banner:

```
╔══════════════════════════════════════════════════╗
║              YAAR Remote Mode                   ║
╠══════════════════════════════════════════════════╣
║  Server:  http://192.168.1.100:8000
║  Token:   <random-token>
╠══════════════════════════════════════════════════╣
║  Connect: http://192.168.1.100:8000/#remote=<token>
╚══════════════════════════════════════════════════╝
```

If `qrcode-terminal` is installed, a QR code is also printed for easy mobile scanning.

## Connecting

Three ways to connect from another device:

1. **QR code** — Scan the QR code from the terminal with your phone's camera
2. **URL** — Open the `Connect:` URL directly in a browser
3. **Manual** — Open any hosted frontend, enter the server URL and token in the connection dialog

The frontend auto-detects the connection method:
- Hash fragment (`#remote=<token>`) → auto-connects and saves to localStorage
- Saved connection in localStorage → validates and reconnects
- Local server at `/health` → local mode (no auth)
- Nothing → shows the connection dialog

## Local Development (No Auth)

```bash
make claude-dev   # Claude, local only, no MCP auth
make codex-dev    # Codex, local only, no MCP auth
make dev          # Auto-detect provider, local only
```

These bind to `127.0.0.1` with no token authentication, same as before.

## How Auth Works

- `REMOTE=1` env var enables remote mode
- Server generates a random 32-byte base64url token at startup
- Server binds to `0.0.0.0` (all interfaces) instead of `127.0.0.1`
- All HTTP endpoints require `Authorization: Bearer <token>` header or `?token=` query param
- WebSocket upgrades require `?token=` query param
- `/health` endpoint is always exempt (for connection testing)
- CORS allows any origin in remote mode (vs localhost-only in local mode)

## Tunneling (Internet Access)

For access beyond your LAN, use a tunnel:

**Cloudflare Tunnel (recommended):**
```bash
cloudflared tunnel --url http://localhost:8000
```

**SSH tunnel:**
```bash
ssh -R 8000:localhost:8000 your-server.com
```

**bore:**
```bash
bore local 8000 --to bore.pub
```

**Tailscale:**
No tunnel needed — devices on your tailnet can connect directly.

When using a tunnel, the frontend's connection dialog accepts the tunnel URL as the server URL.

## Security Model

- Token is generated fresh each server start (not persisted)
- Token is transmitted in the URL hash fragment (`#remote=token`), which is **not sent to the server** by the browser — it stays client-side
- The frontend stores the connection in localStorage for reconnection
- All API and WebSocket requests include the token
- No HTTPS by default — use a tunnel (Cloudflare, etc.) for encrypted connections over the internet

## Troubleshooting

**"Server not reachable" in connection dialog:**
- Check that the server is running and the URL is correct
- Ensure your firewall allows connections on the server port (default 8000)
- Try pinging the server IP from the client device

**"Invalid token":**
- Tokens are regenerated on each server restart — get the new token from the terminal
- Check for trailing whitespace when pasting the token

**Connection drops on page refresh:**
- The frontend saves the connection to localStorage, so it should reconnect automatically
- If the server restarted, you'll need a new token

**WebSocket fails to connect:**
- Some proxies/firewalls block WebSocket upgrades
- Try using a tunnel that supports WebSocket (Cloudflare Tunnel, bore, etc.)
