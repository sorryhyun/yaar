# Remote Mode

> [한국어 버전](../ko/remote_mode.md)

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
- Server generates a random 32-byte base64url token at startup — a **fresh one per start**, so a saved connection from a previous run needs the new token (rescan the QR)
- Server binds to `0.0.0.0` (all interfaces) instead of `127.0.0.1`
- All HTTP endpoints require `Authorization: Bearer <token>` header or `?token=` query param
- WebSocket upgrades require `?token=` query param
- `/health` endpoint is always exempt (for connection testing), and answers `{ status, remote }` — `remote: true` tells a client with no token that reachability does *not* imply access, so it shows the connection dialog instead of connecting unauthenticated
- CORS allows any origin in remote mode (vs localhost-only in local mode)

### `YAAR_REMOTE_TOKEN` (launcher-supplied token)

Set `YAAR_REMOTE_TOKEN` and the server adopts it instead of minting one. This exists so a
*launcher* can know the connect URL before the server exists: `#remote=<token>` is required to
open a working tab, and nothing can ask the server for the token (every endpoint that would
answer is behind that same token). `scripts/dev.sh` mints one in remote mode and exports it,
which is how `make claude` can open a browser straight onto an authenticated desktop.

Values shorter than 32 characters are ignored with a warning and a random token is used
instead — the default tunnel exposes a public URL, so a weak token here is not a local-only
mistake.

## Built-in Tunnel (Auto)

In remote mode, YAAR automatically establishes an SSH reverse tunnel via [localhost.run](https://localhost.run) — no configuration, no signup, no extra binaries. Just start the server and scan the QR code from anywhere.

**Requirements:** An SSH key on the machine (`~/.ssh/id_ed25519`, `id_rsa`, or `id_ecdsa`). Most dev machines already have one. If not, run `ssh-keygen`.

### How It Works

1. Server starts in remote mode → detects SSH key on disk (or SSH agent)
2. Connects to `localhost.run` via SSH and requests a reverse tunnel
3. `localhost.run` assigns a public HTTPS URL (e.g., `https://abc123.lhr.life`)
4. Banner and QR code show the tunnel URL — external clients connect through it
5. If the tunnel fails (no SSH key, no internet), server continues in LAN-only mode

### Banner with Tunnel

```
╔══════════════════════════════════════════════════╗
║              YAAR Remote Mode                   ║
╠══════════════════════════════════════════════════╣
║  Server:  http://192.168.1.100:8000
║  Tunnel:  https://abc123.lhr.life/#remote=<token>
║  Token:   <random-token>
╠══════════════════════════════════════════════════╣
║  Connect: https://abc123.lhr.life/#remote=<token>   ← QR encodes this
╚══════════════════════════════════════════════════╝
```

### Disabling Auto-Tunnel

Create `config/tunnel.json`:
```json
{ "disabled": true }
```

### Custom SSH Server

Instead of localhost.run, you can tunnel through your own server:

```json
{
  "host": "myserver.com",
  "username": "deploy",
  "privateKeyPath": "~/.ssh/id_ed25519",
  "remotePort": 8000,
  "publicHost": "myserver.com"
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `host` | string | **(required)** | SSH server hostname |
| `port` | number | `22` | SSH port |
| `username` | string | **(required)** | SSH username |
| `privateKeyPath` | string | — | Path to private key (`~` resolved to home dir) |
| `password` | string | — | Password auth fallback |
| `remotePort` | number | same as local `PORT` | Port to forward on the remote server |
| `remoteHost` | string | `"0.0.0.0"` | Bind address on the remote server |
| `publicHost` | string | same as `host` | Hostname used in the public URL |
| `publicHttps` | boolean | `false` | Use `https://` in the public URL |

Auth priority: `privateKeyPath` → `password` → `SSH_AUTH_SOCK` agent.

### Tailscale Serve (managed, tailnet-only)

Instead of a public tunnel, YAAR can expose itself over your [Tailscale](https://tailscale.com) tailnet. Only devices already on your tailnet can reach it — this is network-layer auth, strictly stronger than a public URL gated by a token. It also gives you a real HTTPS certificate (`https://<host>.<tailnet>.ts.net`) with no extra setup.

Create `config/tunnel.json`:
```json
{ "service": "tailscale" }
```

The banner and QR then show the MagicDNS URL:
```
║  Tunnel:  https://my-box.tailnet-abc.ts.net/#remote=<token>   (tailnet-only)
```

**Requirements:**
- The `tailscale` CLI installed and logged into a tailnet (`tailscale up`). YAAR checks `tailscale status` and falls back to LAN-only if the daemon isn't running.
- **HTTPS certificates enabled** for the tailnet — turn on MagicDNS and HTTPS Certificates in the [admin console](https://login.tailscale.com/admin/dns). Without this, `serve --https=443` fails and YAAR prints the fix.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `service` | `"tailscale"` | — | Selects the Tailscale Serve provider |
| `tailscalePath` | string | discovered on `PATH` (and macOS app bundle) | Absolute path to the `tailscale` binary |

**How it differs from the SSH tunnel:** there's no reverse tunnel to manage — `tailscaled` already holds the connection. YAAR just registers a serve rule (`https://…ts.net:443 → http://127.0.0.1:{PORT}`) at startup and turns it off on shutdown. Reconnect/keepalive are the daemon's job, so there's no backoff loop. Because only `tailscaled` (on loopback) and the tailnet reach the server, the public surface is your tailnet, not the whole internet.

### Tunnel Behavior

- Only activates in remote mode (`REMOTE=1` or bundled exe)
- On success, the banner and QR code use the tunnel URL instead of the LAN URL
- If connection fails on startup, a warning is logged and the server continues in LAN-only mode
- If connection drops after success, auto-reconnects with exponential backoff (1s → 30s max)
- On shutdown (`Ctrl+C`), the tunnel is closed gracefully with a 3s timeout
- Keepalive: 15s interval, 3 max missed heartbeats

## External Tunneling (Alternatives)

For access beyond your LAN without the built-in tunnel, use an external tool:

**Cloudflare Tunnel (recommended):**
```bash
cloudflared tunnel --url http://localhost:8000
```

**SSH tunnel (manual):**
```bash
ssh -R 8000:localhost:8000 your-server.com
```

**bore:**
```bash
bore local 8000 --to bore.pub
```

**Tailscale:**
Devices on your tailnet can connect directly to the LAN URL. For a managed setup with an HTTPS MagicDNS URL in the banner/QR, use the built-in [Tailscale Serve](#tailscale-serve-managed-tailnet-only) provider (`config/tunnel.json` → `{ "service": "tailscale" }`) instead.

When using an external tunnel, the frontend's connection dialog accepts the tunnel URL as the server URL.

## Security Model

- Token is generated fresh each server start (not persisted)
- Token is transmitted in the URL hash fragment (`#remote=token`), which is **not sent to the server** by the browser — it stays client-side
- The frontend stores the connection in localStorage for reconnection
- All API and WebSocket requests include the token
- No HTTPS by default — use a tunnel (Cloudflare, etc.) for encrypted connections over the internet

### Remote mode drops the app-origin boundary

This is the one security property remote mode trades away, so it's worth stating plainly.

In the default local setup, **app-origin isolation** is on: installed apps are served from a distinct browser origin (`127.0.0.1`) while the desktop stays on `localhost`. Being cross-origin, the browser blocks a hostile app from reaching the desktop's DOM or JS memory through `window.parent`, and isolated app frames are additionally sandboxed so they can't navigate the top window (`window.top.location`) to a phishing page either. A hostile app is confined to what its `app.json` declares.

**Remote mode serves apps same-origin with the desktop** — the `localhost`/`127.0.0.1` loopback-alias split has no meaning once you're reaching the machine over the network, so the origin boundary can't exist. A same-origin frame can't be meaningfully sandboxed against this (`allow-scripts allow-same-origin` lets a frame reach into its own parent and strip its own sandbox attribute), so the sandbox doesn't help here. The consequence: **a malicious installed app can reach the desktop's DOM and JS memory directly.** The same is true in local mode if you explicitly set `YAAR_APP_ORIGIN_ISOLATION=0`.

The backstop in remote mode is the token gating *who can connect at all* — but that says nothing about apps you yourself installed. So: **in remote mode, don't install apps you don't trust.** If you need untrusted apps and the desktop's integrity both, stay in the default local mode where origin isolation is on.

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
