# Remote Mode

> [한국어 버전](../ko/remote_mode.md)

Remote mode lets you access YAAR from other devices on your network (phone, tablet, another PC) with token-based authentication.

> **Setting this up for the first time?** Just ask YAAR — "help me open this on my phone". It reads
> `yaar://skills/remote` and walks you through installing Tailscale on both devices step by step.
> This page is the reference; that skill is the walkthrough.

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
║  Server:  http://127.0.0.1:8000  (loopback only)
║  Tunnel:  https://my-box.tailnet-abc.ts.net/#remote=<token>
║  Token:   <random-token>
╠══════════════════════════════════════════════════╣
║  Connect: https://my-box.tailnet-abc.ts.net/#remote=<token>
╚══════════════════════════════════════════════════╝
```

Remote mode tunnels over [Tailscale Serve](#built-in-tunnel-tailscale-serve), so the connect URL
is reachable from any device on your tailnet and from nowhere else. Without the `tailscale`
daemon there's no tunnel, and the server stays reachable from this machine only.

If `qrcode-terminal` is installed, a QR code is also printed for easy mobile scanning.

## Turning Remote Mode On

The tunnel is part of remote mode, so it only comes up when remote mode is on. Two ways:

| How | Scope | Takes effect |
|-----|-------|--------------|
| `REMOTE=1` env var (`make claude` / `make codex`) | That one run | Immediately |
| **Remote Access** toggle in the configurations app (`remote: true` in `config/settings.json`) | Every run | Next restart |

The env var wins when both are set. `make dev`, `make claude-dev`, `make codex-dev` and the
bundled exe are local. `IS_REMOTE` is read once at module load, hence the restart.

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

These bind to `127.0.0.1` with no token authentication.

## How Auth Works

- `REMOTE=1` env var enables remote mode, as does a persisted `remote: true` ([both](#turning-remote-mode-on))
- Server generates a random 32-byte base64url token at startup — a **fresh one per start**, so a saved connection from a previous run needs the new token (rescan the QR)
- Server binds to `127.0.0.1` in every mode; `tailscaled` reaches it over loopback
- All HTTP endpoints require `Authorization: Bearer <token>` header or `?token=` query param
- WebSocket upgrades require `?token=` query param
- `/health` is always exempt (for connection testing), and answers `{ status, remote }` — `remote: true` tells a client with no token that reachability does *not* imply access, so it shows the connection dialog instead of connecting unauthenticated
- CORS allows any origin in remote mode (vs localhost-only in local mode)

### `YAAR_REMOTE_TOKEN` (launcher-supplied token)

Set `YAAR_REMOTE_TOKEN` and the server adopts it instead of minting one. This exists so a
*launcher* can know the connect URL before the server exists: `#remote=<token>` is required to
open a working tab, and nothing can ask the server for the token (every endpoint that would
answer is behind that same token). `scripts/dev/start.sh` mints one in remote mode and exports it,
which is how `make claude` can open a browser straight onto an authenticated desktop.

Values shorter than 32 characters are ignored with a warning and a random token is used instead.

## Built-in Tunnel (Tailscale Serve)

In remote mode, YAAR exposes itself over your [Tailscale](https://tailscale.com) tailnet. Only devices already on your tailnet can reach it — network-layer auth, strictly stronger than a public URL gated by a token. It also gives you a real HTTPS certificate (`https://<host>.<tailnet>.ts.net`) with no extra setup, and it's what carries [app-origin isolation](#app-origin-isolation-over-the-network) over the network.

This is the default and needs no `config/tunnel.json`. The file exists to tune the tunnel:

```json
{ "service": "tailscale" }
```

**Requirements:**
- The `tailscale` CLI installed and logged into a tailnet (`tailscale up`). YAAR checks `tailscale status` and continues without a tunnel if the daemon isn't running.
- **HTTPS certificates enabled** for the tailnet — turn on MagicDNS and HTTPS Certificates in the [admin console](https://login.tailscale.com/admin/dns). Without this, `serve --https=443` fails and YAAR prints the fix.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `service` | `"tailscale"` | `"tailscale"` | The transport |
| `tailscalePath` | string | discovered on `PATH` (and macOS app bundle) | Absolute path to the `tailscale` binary |
| `appOriginPort` | number | `8443` | Public HTTPS port the isolated **app origin** is served on (see below). Must not be 443 |

**How it works:** there's no tunnel to manage — `tailscaled` already holds the connection. YAAR registers a serve rule (`https://…ts.net:443 → http://127.0.0.1:{PORT}`) once the HTTP socket is listening and turns it off on shutdown. Reconnect and keepalive are the daemon's job, so there's no backoff loop in YAAR.

**Reach:** the server stays on loopback, so what can connect is your tailnet (through the daemon) plus this machine — not the whole internet, and not your LAN. If you want YAAR reachable some other way, put an [external tunnel](#external-tunneling-alternatives) in front of the loopback port.

> **Upgrading from an older config:** earlier versions used an SSH reverse tunnel via `localhost.run` (or a custom SSH server), and accepted `{ "disabled": true }` to run with no tunnel. Both are gone, along with the `ssh2` dependency. A `tunnel.json` still asking for either is refused with a warning and Tailscale is used instead; replace it with `{ "service": "tailscale" }`.

#### App-origin isolation over the network

YAAR registers a **second** serve rule on the same MagicDNS name but a different port:

```
https://my-box.tailnet-abc.ts.net        → http://127.0.0.1:8000   the desktop
https://my-box.tailnet-abc.ts.net:8443   → http://127.0.0.1:8001   installed apps
```

Different port means a different browser origin (the same-origin policy separates on port), so installed (`source:'user'`) app iframes are cross-origin to the desktop, exactly as `localhost`/`127.0.0.1` achieves locally. A stable hostname is what makes this possible — a MagicDNS name is the same on every start, so both origins survive a restart and the desktop can hand the browser a URL for the second one.

The two public ports point at **two different local sockets** on purpose. Behind a proxy the server cannot read which origin the browser addressed — `Host` and `X-Forwarded-*` are the proxy's word — so it reads *which socket the request arrived on* instead, which nothing can forge. The app-origin socket is loopback-only and its port never appears in a URL.

If the second rule fails to register (e.g. the port is refused), YAAR logs it, leaves the desktop tunnel up, and runs with isolation off — a boundary the browser can't reach would be worse than none. Set `appOriginPort` to pick a different port. `YAAR_APP_ORIGIN_ISOLATION=0` switches the whole thing off, here as locally.

### Tunnel Behavior

- Only activates in remote mode ([how to turn it on](#turning-remote-mode-on))
- The serve rules are registered *after* the HTTP sockets are listening, so they always point at the port actually bound (remote mode walks upward from `PORT` if it's taken)
- On success, the banner and QR code use the MagicDNS URL instead of the loopback URL
- If registration fails on startup (daemon down, no HTTPS certs), a warning is logged and the server continues localhost-only
- Reconnects and keepalive belong to `tailscaled`, not YAAR: a dropped link comes back on its own and the serve rules stay registered
- On shutdown (`Ctrl+C`), both serve rules are torn down

## External Tunneling (Alternatives)

If you need a genuinely public URL — sharing with someone who isn't on your tailnet — run an
external tool on this machine and point it at the loopback port. The built-in tunnel stays up
and simply coexists: both reach the same server.

Two caveats specific to going public this way:

- **Isolated apps won't load for the external viewer.** The desktop tells the browser to load
  app iframes from the tailnet app origin (`…ts.net:8443`), which a device outside your tailnet
  can't resolve. The desktop itself works; installed apps won't render.
- A public URL held shut by the bearer token is a weaker posture than tailnet membership. The
  token is all that stands in front of it.

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

**Tailscale Funnel:** if you want the tailnet setup you already have to be reachable publicly, `tailscale funnel` is the Tailscale-native answer — but YAAR doesn't manage it, and a Funnel'd desktop is a public URL held shut by the token again. It does keep the app origin working, since the app rule's `:8443` is a port Funnel also permits (which is why that's the default).

When using an external tunnel, the frontend's connection dialog accepts the tunnel URL as the server URL.

## Security Model

- Token is generated fresh each server start (not persisted)
- Token is transmitted in the URL hash fragment (`#remote=token`), which is **not sent to the server** by the browser — it stays client-side
- The frontend stores the connection in localStorage for reconnection
- All API and WebSocket requests include the token
- HTTPS comes from the tunnel: Tailscale serves a real certificate for the MagicDNS name, and WireGuard encrypts the hop regardless. Nothing leaves the machine unencrypted

### App-origin isolation

**App-origin isolation** serves installed (`source:'user'`) apps from a distinct browser origin from the desktop. Being cross-origin, the browser blocks a hostile app from reaching the desktop's DOM or JS memory through `window.parent`, and isolated app frames are additionally sandboxed so they can't navigate the top window (`window.top.location`) to a phishing page either. A hostile app is confined to what its `app.json` declares. It is on by default; `YAAR_APP_ORIGIN_ISOLATION=0` turns it off.

The boundary is just "two browser origins over one server", and every transport YAAR ships publishes two:

| Transport | Origin split | Hostile-app containment |
|-----------|--------------|-------------------------|
| Local | `localhost` / `127.0.0.1` | ✅ |
| **Tailscale Serve** (remote) | `…ts.net` / `…ts.net:8443` ([above](#app-origin-isolation-over-the-network)) | ✅ |
| Remote, tunnel failed to come up | `localhost` / `127.0.0.1` — loopback-only, so the local split applies | ✅ |

Two states still leave apps same-origin with the desktop, and both are things you switch on yourself:

- `YAAR_APP_ORIGIN_ISOLATION=0`, which turns the whole mechanism off.
- The tailnet desktop rule registering but the **app** rule failing (a refused `:8443`). YAAR logs this and runs with isolation off rather than pointing your browser at an origin it can't reach. Set `appOriginPort` to a port that works.

In either state a same-origin frame can't be meaningfully sandboxed either (`allow-scripts allow-same-origin` lets a frame reach into its own parent and strip its own sandbox attribute), so the sandbox doesn't help, and **a malicious installed app can reach the desktop's DOM and JS memory directly.** The token gating *who can connect at all* says nothing about apps you yourself installed. So in those two states: **don't install apps you don't trust.**

One consequence worth knowing: an isolated app's calls authenticate with its own **iframe token**, not the remote token. An iframe token is the narrower credential anyway: server-minted, bound to one window and app, expiring, and still subject to the app's declared permissions.

## Troubleshooting

**"Server not reachable" in connection dialog:**
- Check that the server is running and the URL is correct
- On the `…ts.net` URL: is Tailscale actually **on** for the client device? The VPN toggle being off is the usual cause — the name won't even resolve. The host machine also has to be awake with `tailscaled` running
- If the banner shows `Tunnel: none`, no other device can reach this server — fix the tunnel (below)

**No remote banner at all, and no tunnel:**
- Remote mode is off. Use `make claude`, or turn on **Remote Access** in the configurations app and restart ([both](#turning-remote-mode-on))
- Toggle on but still local? It's read once at boot (restart), and an explicit `REMOTE` env var overrides it

**Banner shows `Tunnel: none`:**
- `tailscale status` — if the daemon isn't running or isn't logged in, YAAR starts localhost-only and says so
- If the daemon is fine, the failure is usually missing HTTPS certificates: enable MagicDNS + HTTPS Certificates in the [admin console](https://login.tailscale.com/admin/dns). YAAR prints the exact `serve` error
- Not using Tailscale at all? Use local mode (`make dev` / `make claude-dev`), or put an [external tunnel](#external-tunneling-alternatives) in front of the loopback port

**"Invalid token":**
- Tokens are regenerated on each server restart — get the new token from the terminal
- Check for trailing whitespace when pasting the token

**Connection drops on page refresh:**
- The frontend saves the connection to localStorage, so it should reconnect automatically
- If the server restarted, you'll need a new token

**WebSocket fails to connect:**
- Some proxies/firewalls block WebSocket upgrades
- Try using a tunnel that supports WebSocket (Cloudflare Tunnel, bore, etc.)
