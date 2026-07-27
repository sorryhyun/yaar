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

Remote mode tunnels over [Tailscale Serve](#built-in-tunnel-tailscale-serve), so the connect URL
is reachable from any device on your tailnet and from nowhere else. That is the only transport:
remote mode is Tailscale or nothing. Without the `tailscale` daemon there is no tunnel and the
server is reachable from this machine only — there is no LAN fallback, by design ([why](#why-there-is-no-lan-mode)).

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
- Server is bound to `127.0.0.1`, always — `tailscaled` reaches it over loopback, so a LAN bind buys nothing and YAAR never opens one ([why](#why-there-is-no-lan-mode))
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
tailnet), so a weak token here is not a local-only mistake.

## Built-in Tunnel (Tailscale Serve)

In remote mode, YAAR exposes itself over your [Tailscale](https://tailscale.com) tailnet. Only devices already on your tailnet can reach it — this is network-layer auth, strictly stronger than a public URL gated by a token. It also gives you a real HTTPS certificate (`https://<host>.<tailnet>.ts.net`) with no extra setup, and it is the only way remote mode keeps [app-origin isolation](#app-origin-isolation-over-the-network).

This is the default and needs no `config/tunnel.json`. The file exists only to tune the tunnel — it can no longer turn it off.

```json
{ "service": "tailscale" }
```

> **Removed:** earlier versions defaulted to an SSH reverse tunnel via `localhost.run` (and could tunnel through a custom SSH server), and offered `{ "disabled": true }` to run remote mode on the LAN with no tunnel at all. All three are gone, along with the `ssh2` dependency. An ephemeral public URL held shut by a bearer token was the weakest posture YAAR offered, and neither a rotating subdomain nor a bare LAN address could anchor the second stable origin app isolation needs — `{ "disabled": true }` was the last configuration in which a hostile installed app could reach the desktop's DOM ([below](#app-origin-isolation)). A `tunnel.json` still asking for any of them is refused with a warning and Tailscale is used instead; for a public URL, put an [external tool](#external-tunneling-alternatives) in front.

**Requirements:**
- The `tailscale` CLI installed and logged into a tailnet (`tailscale up`). YAAR checks `tailscale status` and continues without a tunnel if the daemon isn't running.
- **HTTPS certificates enabled** for the tailnet — turn on MagicDNS and HTTPS Certificates in the [admin console](https://login.tailscale.com/admin/dns). Without this, `serve --https=443` fails and YAAR prints the fix.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `service` | `"tailscale"` | `"tailscale"` | The transport. Only value accepted |
| `tailscalePath` | string | discovered on `PATH` (and macOS app bundle) | Absolute path to the `tailscale` binary |
| `appOriginPort` | number | `8443` | Public HTTPS port the isolated **app origin** is served on (see below). Must not be 443 |

**How it works:** there's no tunnel to manage — `tailscaled` already holds the connection. YAAR registers a serve rule (`https://…ts.net:443 → http://127.0.0.1:{PORT}`) once the HTTP socket is listening and turns it off on shutdown. Reconnect and keepalive are the daemon's job, so there's no backoff loop in YAAR. Because only `tailscaled` (on loopback) and the tailnet reach the server, the public surface is your tailnet, not the whole internet.

#### Why there is no LAN mode

`tailscaled` reaches YAAR at `127.0.0.1`, so a LAN bind buys nothing and YAAR **stays on loopback** in every mode: only the tailnet (through the daemon) and this machine can connect.

YAAR used to offer a LAN bind via `{ "disabled": true }` and no longer does. Two reasons, and the second is the decisive one:

- A LAN URL on plain `http://` held shut by a bearer token is a much weaker posture than tailnet membership, for no capability the tailnet doesn't already give you (including from off-network — you don't need to be on the same wifi).
- **It could not carry the app-origin boundary.** That boundary is two browser origins over one server; one host on one port publishes exactly one. So installed apps were served same-origin with the desktop, and a hostile one could read the desktop's DOM and JS memory. Removing the mode is what makes app-origin isolation unconditional.

If `tailscaled` is down you therefore get **this machine only** — not a LAN fallback. Someone running tailnet-only should not silently have their whole LAN exposed on a bearer token because a daemon wasn't running. Isolated apps keep their boundary in that state too: the server is loopback-only, which is exactly where the local `localhost`/`127.0.0.1` split works, so YAAR falls back to that rather than to no boundary.

#### App-origin isolation over the network

Tailscale is what lets remote mode have an origin boundary at all — it [used to be dropped](#app-origin-isolation) over the network. YAAR registers a **second** serve rule on the same MagicDNS name but a different port:

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
- If registration fails on startup (daemon down, no HTTPS certs), a warning is logged and the server continues [localhost-only](#why-there-is-no-lan-mode) — never silently LAN-wide
- Reconnects and keepalive belong to `tailscaled`, not YAAR: a dropped link comes back on its own and the serve rules stay registered
- On shutdown (`Ctrl+C`), both serve rules are torn down

## External Tunneling (Alternatives)

If you need a genuinely public URL — sharing with someone who isn't on your tailnet — run an
external tool on this machine and point it at the loopback port. The built-in tunnel stays on
(it can't be turned off) and simply coexists: both reach the same server.

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
- HTTPS comes from the tunnel: Tailscale serves a real certificate for the MagicDNS name, and WireGuard encrypts the hop regardless. Nothing leaves the machine unencrypted — there is no plain-`http://` LAN mode any more

### App-origin isolation

**App-origin isolation** serves installed (`source:'user'`) apps from a distinct browser origin from the desktop. Being cross-origin, the browser blocks a hostile app from reaching the desktop's DOM or JS memory through `window.parent`, and isolated app frames are additionally sandboxed so they can't navigate the top window (`window.top.location`) to a phishing page either. A hostile app is confined to what its `app.json` declares. It is on by default; `YAAR_APP_ORIGIN_ISOLATION=0` turns it off.

The boundary is just "two browser origins over one server", and **every transport YAAR ships can publish two** — which is why tunnel-off remote mode was removed rather than documented:

| Transport | Origin split | Hostile-app containment |
|-----------|--------------|-------------------------|
| Local | `localhost` / `127.0.0.1` | ✅ |
| **Tailscale Serve** (remote) | `…ts.net` / `…ts.net:8443` ([above](#app-origin-isolation-over-the-network)) | ✅ |
| Remote, tunnel failed to come up | `localhost` / `127.0.0.1` — loopback-only, so the local split applies | ✅ |

Two states still leave apps same-origin with the desktop, and both are things you switch on yourself:

- `YAAR_APP_ORIGIN_ISOLATION=0`, which turns the whole mechanism off.
- The tailnet desktop rule registering but the **app** rule failing (a refused `:8443`). YAAR logs this and runs with isolation off rather than pointing your browser at an origin it can't reach — a boundary the browser can't reach is worse than none. Set `appOriginPort` to a port that works.

In either state a same-origin frame can't be meaningfully sandboxed either (`allow-scripts allow-same-origin` lets a frame reach into its own parent and strip its own sandbox attribute), so the sandbox doesn't help, and **a malicious installed app can reach the desktop's DOM and JS memory directly.** The token gating *who can connect at all* says nothing about apps you yourself installed. So in those two states: **don't install apps you don't trust.**

One consequence worth knowing: an isolated app's calls authenticate with its own **iframe token**, not the remote token. They never carried the remote token in a header — it was read out of `Referer`, which only worked while apps were same-origin, since the default referrer policy trims a cross-origin `Referer` down to a bare origin. An iframe token is the narrower credential anyway: server-minted, bound to one window and app, expiring, and still subject to the app's declared permissions.

## Troubleshooting

**"Server not reachable" in connection dialog:**
- Check that the server is running and the URL is correct
- On the `…ts.net` URL: is Tailscale actually **on** for the client device? The VPN toggle being off is the usual cause — the name won't even resolve. The host machine also has to be awake with `tailscaled` running
- If the banner shows `Tunnel: none`, no other device can reach this server at all — fix the tunnel (below); there is no LAN URL to fall back to

**Banner shows `Tunnel: none`:**
- `tailscale status` — if the daemon isn't running or isn't logged in, YAAR starts localhost-only and says so
- If the daemon is fine, the failure is usually missing HTTPS certificates: enable MagicDNS + HTTPS Certificates in the [admin console](https://login.tailscale.com/admin/dns). YAAR prints the exact `serve` error
- Deliberately not using Tailscale? Then you want local mode (`make dev` / `make claude-dev`), not remote mode — remote mode has no other transport ([why](#why-there-is-no-lan-mode))

**"Invalid token":**
- Tokens are regenerated on each server restart — get the new token from the terminal
- Check for trailing whitespace when pasting the token

**Connection drops on page refresh:**
- The frontend saves the connection to localStorage, so it should reconnect automatically
- If the server restarted, you'll need a new token

**WebSocket fails to connect:**
- Some proxies/firewalls block WebSocket upgrades
- Try using a tunnel that supports WebSocket (Cloudflare Tunnel, bore, etc.)
