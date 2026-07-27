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
║  Server:  http://127.0.0.1:8000  (loopback only — no LAN)
║  Tunnel:  https://my-box.tailnet-abc.ts.net/#remote=<token>
║  Token:   <random-token>
╠══════════════════════════════════════════════════╣
║  Connect: https://my-box.tailnet-abc.ts.net/#remote=<token>
╚══════════════════════════════════════════════════╝
```

Remote mode tunnels over [Tailscale Serve](#built-in-tunnel-tailscale-serve) by default, so the
connect URL is reachable from any device on your tailnet and from nowhere else. Without the
`tailscale` daemon there is no tunnel, and the banner shows the loopback URL only — see
[running without Tailscale](#running-without-tailscale) for the LAN fallback.

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
- Server stays bound to `127.0.0.1` under the [default Tailscale tunnel](#no-lan-bind) — `tailscaled` reaches it over loopback, so the LAN bind buys nothing. Only with the tunnel [disabled](#running-without-tailscale) does it bind `0.0.0.0` (all interfaces)
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
instead — remote mode hands the token to every device that can reach the server (your whole
tailnet by default, your whole LAN with the tunnel disabled), so a weak token here is not a
local-only mistake.

## Built-in Tunnel (Tailscale Serve)

In remote mode, YAAR exposes itself over your [Tailscale](https://tailscale.com) tailnet. Only devices already on your tailnet can reach it — this is network-layer auth, strictly stronger than a public URL gated by a token. It also gives you a real HTTPS certificate (`https://<host>.<tailnet>.ts.net`) with no extra setup, and it is the only way remote mode keeps [app-origin isolation](#app-origin-isolation-over-the-network).

This is the default: no `config/tunnel.json` is needed. The file exists to disable the tunnel or tune it.

```json
{ "service": "tailscale" }
```

> **Removed:** earlier versions defaulted to an SSH reverse tunnel via `localhost.run` (and could tunnel through a custom SSH server). Both are gone, along with the `ssh2` dependency. An ephemeral public URL held shut by a bearer token was the weakest posture YAAR offered, and its rotating subdomain could never anchor the second stable origin app isolation needs. A `tunnel.json` still asking for either is refused with a warning and Tailscale is used instead; for a public URL, disable the tunnel and use an [external tool](#external-tunneling-alternatives).

**Requirements:**
- The `tailscale` CLI installed and logged into a tailnet (`tailscale up`). YAAR checks `tailscale status` and continues without a tunnel if the daemon isn't running.
- **HTTPS certificates enabled** for the tailnet — turn on MagicDNS and HTTPS Certificates in the [admin console](https://login.tailscale.com/admin/dns). Without this, `serve --https=443` fails and YAAR prints the fix.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `service` | `"tailscale"` | `"tailscale"` | The transport. Only value accepted |
| `disabled` | boolean | `false` | Run remote mode with no tunnel at all (see below) |
| `tailscalePath` | string | discovered on `PATH` (and macOS app bundle) | Absolute path to the `tailscale` binary |
| `appOriginPort` | number | `8443` | Public HTTPS port the isolated **app origin** is served on (see below). Must not be 443 |

**How it works:** there's no tunnel to manage — `tailscaled` already holds the connection. YAAR registers a serve rule (`https://…ts.net:443 → http://127.0.0.1:{PORT}`) once the HTTP socket is listening and turns it off on shutdown. Reconnect and keepalive are the daemon's job, so there's no backoff loop in YAAR. Because only `tailscaled` (on loopback) and the tailnet reach the server, the public surface is your tailnet, not the whole internet.

#### No LAN bind

`tailscaled` reaches YAAR at `127.0.0.1`, so a LAN bind buys nothing and YAAR **stays on loopback**: only the tailnet (through the daemon) and this machine can connect.

This is decided from the transport you asked for, not from whether the tunnel came up. If `tailscaled` is down you get **localhost-only**, not LAN-only — someone running tailnet-only should not silently have their whole LAN exposed on a bearer token because a daemon wasn't running.

#### Running without Tailscale

To get the LAN URL back — remote mode on `0.0.0.0` with token auth and no tunnel — turn the tunnel off in `config/tunnel.json`:

```json
{ "disabled": true }
```

The banner and QR then show `http://<lan-ip>:8000/#remote=<token>`, reachable by anything on your network that has the token. Pair it with an [external tunnel](#external-tunneling-alternatives) if you need to reach it from off-network. Note that app-origin isolation is off in this mode ([below](#app-origin-isolation)).

#### App-origin isolation over the network

Tailscale is what lets remote mode keep the origin boundary that [used to be dropped](#app-origin-isolation). YAAR registers a **second** serve rule on the same MagicDNS name but a different port:

```
https://my-box.tailnet-abc.ts.net        → http://127.0.0.1:8000   the desktop
https://my-box.tailnet-abc.ts.net:8443   → http://127.0.0.1:8001   installed apps
```

Different port means a different browser origin (the same-origin policy separates on port), so installed (`source:'user'`) app iframes are cross-origin to the desktop again, exactly as `localhost`/`127.0.0.1` achieves locally. A stable hostname is what makes this possible at all — a MagicDNS name is the same on every start, so both origins survive a restart and the desktop can hand the browser a URL for the second one.

The two public ports point at **two different local sockets** on purpose. Behind a proxy the server cannot read which origin the browser addressed — `Host` and `X-Forwarded-*` are the proxy's word — so it reads *which socket the request arrived on* instead, which nothing can forge. The app-origin socket is loopback-only and its port never appears in a URL.

If the second rule fails to register (e.g. the port is refused), YAAR logs it, leaves the desktop tunnel up, and runs with isolation off — a boundary the browser can't reach would be worse than none. Set `appOriginPort` to pick a different port. `YAAR_APP_ORIGIN_ISOLATION=0` switches the whole thing off, here as locally.

### Tunnel Behavior

- Only activates in remote mode (`REMOTE=1` or bundled exe)
- The serve rules are registered *after* the HTTP sockets are listening, so they always point at the port actually bound (remote mode walks upward from `PORT` if it's taken)
- On success, the banner and QR code use the MagicDNS URL instead of the loopback URL
- If registration fails on startup (daemon down, no HTTPS certs), a warning is logged and the server continues [localhost-only](#no-lan-bind) — never silently LAN-wide
- Reconnects and keepalive belong to `tailscaled`, not YAAR: a dropped link comes back on its own and the serve rules stay registered
- On shutdown (`Ctrl+C`), both serve rules are torn down

## External Tunneling (Alternatives)

If you need a genuinely public URL — sharing with someone who isn't on your tailnet — turn the
built-in tunnel off (`{ "disabled": true }`) and put an external tool in front of it. Remote mode
then binds the LAN and the tool reaches it there. Note that [app-origin isolation](#app-origin-isolation)
is off in this configuration.

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

**Tailscale Funnel:** if you want the tailnet setup you already have to be reachable publicly, `tailscale funnel` is the Tailscale-native answer — but YAAR doesn't manage it, and a Funnel'd desktop is a public URL held shut by the token again.

When using an external tunnel, the frontend's connection dialog accepts the tunnel URL as the server URL.

## Security Model

- Token is generated fresh each server start (not persisted)
- Token is transmitted in the URL hash fragment (`#remote=token`), which is **not sent to the server** by the browser — it stays client-side
- The frontend stores the connection in localStorage for reconnection
- All API and WebSocket requests include the token
- HTTPS comes from the tunnel: the default Tailscale setup serves a real certificate for the MagicDNS name, and WireGuard encrypts the hop regardless. With the tunnel disabled the LAN URL is plain `http://` — put an external tunnel in front of it before it leaves the network

### App-origin isolation

**App-origin isolation** serves installed (`source:'user'`) apps from a distinct browser origin from the desktop. Being cross-origin, the browser blocks a hostile app from reaching the desktop's DOM or JS memory through `window.parent`, and isolated app frames are additionally sandboxed so they can't navigate the top window (`window.top.location`) to a phishing page either. A hostile app is confined to what its `app.json` declares. It is on by default; `YAAR_APP_ORIGIN_ISOLATION=0` turns it off.

Whether remote mode has a boundary at all **depends on the transport**, because the boundary is just "two browser origins over one server" and not every transport can publish two:

| Transport | Origin split | Hostile-app containment |
|-----------|--------------|-------------------------|
| Local (default) | `localhost` / `127.0.0.1` | ✅ |
| **Tailscale Serve** (default remote) | `…ts.net` / `…ts.net:8443` ([above](#app-origin-isolation-over-the-network)) | ✅ |
| Tunnel disabled — LAN / external tunnel | none — one host, one port | ❌ |

Where the boundary can't exist, **apps are served same-origin with the desktop.** A same-origin frame can't be meaningfully sandboxed against this either (`allow-scripts allow-same-origin` lets a frame reach into its own parent and strip its own sandbox attribute), so the sandbox doesn't help. The consequence: **a malicious installed app can reach the desktop's DOM and JS memory directly.** The same is true locally with `YAAR_APP_ORIGIN_ISOLATION=0`.

The only backstop in that case is the token gating *who can connect at all* — which says nothing about apps you yourself installed. So with the tunnel disabled: **don't install apps you don't trust.** If you need untrusted apps and the desktop's integrity both, leave the Tailscale tunnel on or stay local.

One consequence worth knowing: an isolated app's calls authenticate with its own **iframe token**, not the remote token. They never carried the remote token in a header — it was read out of `Referer`, which only worked while apps were same-origin, since the default referrer policy trims a cross-origin `Referer` down to a bare origin. An iframe token is the narrower credential anyway: server-minted, bound to one window and app, expiring, and still subject to the app's declared permissions.

## Troubleshooting

**"Server not reachable" in connection dialog:**
- Check that the server is running and the URL is correct
- On the `…ts.net` URL: is Tailscale actually **on** for the client device? The VPN toggle being off is the usual cause — the name won't even resolve. The host machine also has to be awake with `tailscaled` running
- With the tunnel disabled: ensure your firewall allows connections on the server port (default 8000), and try pinging the server IP from the client device

**No `Tunnel:` line in the banner:**
- `tailscale status` — if the daemon isn't running or isn't logged in, YAAR starts localhost-only and says so
- If the daemon is fine, the failure is usually missing HTTPS certificates: enable MagicDNS + HTTPS Certificates in the [admin console](https://login.tailscale.com/admin/dns). YAAR prints the exact `serve` error
- Deliberately not using Tailscale? [Disable the tunnel](#running-without-tailscale) to get the LAN URL back

**"Invalid token":**
- Tokens are regenerated on each server restart — get the new token from the terminal
- Check for trailing whitespace when pasting the token

**Connection drops on page refresh:**
- The frontend saves the connection to localStorage, so it should reconnect automatically
- If the server restarted, you'll need a new token

**WebSocket fails to connect:**
- Some proxies/firewalls block WebSocket upgrades
- Try using a tunnel that supports WebSocket (Cloudflare Tunnel, bore, etc.)
