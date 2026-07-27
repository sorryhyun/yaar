# Proposal: Migrating Remote Access from a Public Tunnel to Tailscale Serve

YAAR's remote mode today reaches the outside world through a **free public tunnel** — an SSH
reverse tunnel to `localhost.run` that hands back an ephemeral `https://*.lhr.life` URL. The only
thing standing between that URL and a stranger is a shared bearer token. This proposal migrates the
default remote story to **Tailscale Serve**: the machine is reachable only by devices already on
your tailnet, over a real HTTPS certificate, with the token demoted from *sole gate* to *second
factor*.

The migration was deliberately phased, and **all three phases have landed**: a managed
`TailscaleTunnel` provider (Phase 1), a loopback-only bind under Serve (Phase 2), and app-origin
isolation preserved over the network (Phase 3) — the follow-ups that turn a transport swap into a
genuine security upgrade. Tailscale remains opt-in via `config/tunnel.json`; `localhost.run` is
still the zero-install default and behaves exactly as before.

---

## 1. Why the public tunnel is the weak link

`REMOTE=1` today does four things: mint a 32-byte token, bind `0.0.0.0`, open the SSH reverse
tunnel, and print a banner + QR. It works, it's zero-config, and anyone can scan the QR from any
phone. But every one of those properties cuts the other way:

| Property | The cost |
|----------|----------|
| Public `*.lhr.life` URL | The server is reachable from the entire internet. The token is the *only* gate; a leaked URL+token is full access. |
| Ephemeral subdomain | The hostname rotates every start — un-bookmarkable, and (crucially for §4) it can never anchor a stable origin. |
| No HTTPS guarantee | The docs say "no HTTPS by default"; encryption depends on whatever the tunnel service happens to terminate. |
| Same-origin apps | Remote mode **drops app-origin isolation** — over the network the `localhost`/`127.0.0.1` split is meaningless, so a hostile installed app can reach the desktop's DOM and JS memory. |

The last row is the scariest and the least visible, and it is what Phase 3 closes — but only under
Serve. On `localhost.run` it still holds, and [`remote_mode.md`](../guides/remote_mode.md) still says
so plainly: *on a boundary-less transport, don't install apps you don't trust.*

## 2. Tailscale is network-layer auth, not a public URL

localhost.run exposes you to everyone and trusts a token. Tailscale inverts this: a device must be
**in your tailnet** to reach the port at all. That's strictly stronger — the token becomes a second
factor. But Tailscale offers three modes, and the choice among them is the whole design decision:

| Mode | Reachability | Client needs | HTTPS | QR-from-any-phone |
|------|--------------|--------------|-------|-------------------|
| Plain tailnet (`http://host:8000`) | tailnet devices only | Tailscale installed | ❌ | ❌ |
| **Tailscale Serve** | tailnet devices only | Tailscale installed | ✅ real `*.ts.net` cert | ❌ |
| Tailscale Funnel | **public internet** | nothing | ✅ | ✅ |

**We chose Serve.** Funnel would be the closer drop-in for "anyone scans the QR," but it keeps the
public surface and the token-as-sole-gate model — it doesn't fix anything, it just re-hosts the
problem behind a nicer cert. Serve trades away scan-from-a-stranger's-phone (an acceptable loss for
a personal AI desktop) and in return unlocks two things localhost.run structurally cannot offer:
**real HTTPS for free**, and **stable MagicDNS hostnames** (`my-box.tailnet-abc.ts.net`), which §4
depends on.

## 3. The seam: a `TunnelProvider` strategy

The lifecycle only ever touches a tunnel through four methods — `connect()`, `isConnected()`,
`getPublicUrl(token)`, `shutdown()`. That was already an implicit interface; Phase 1 made it
explicit (`lib/tunnel/types.ts`) so implementations are interchangeable:

```
lifecycle.ts  →  createTunnel(config, port, appPort?)  →  TunnelProvider
                                                           ├── SshTunnel        (service: "localhost.run", default)
                                                           └── TailscaleTunnel  (service: "tailscale")
```

Phase 3 added one optional method, `originBoundary()` — the two public origins this transport
publishes, or null. `SshTunnel` simply omits it, which is how "no origin boundary over this
transport" is expressed without a capability flag.

`TailscaleTunnel` is dramatically simpler than `SshTunnel`, because **`tailscaled` already owns the
tunnel and its resilience**. There is no ssh2 client, no reverse TCP piping, no keepalive, and no
exponential-backoff reconnect. `tailscale serve` just registers a proxy rule with the local daemon:

```
https://<host>.<tailnet>.ts.net:443    →   http://127.0.0.1:<PORT>       the desktop
https://<host>.<tailnet>.ts.net:8443   →   http://127.0.0.1:<APP_PORT>   installed apps (Phase 3)
```

so the "tunnel" is pure CLI orchestration:

```
connect():
  1. `tailscale status --json`  → daemon up? (BackendState == "Running")  read Self.DNSName
  2. registerServeRule(443,  PORT)       — `serve --https=443 off`, then `serve --bg --https=443 …`
  3. registerServeRule(8443, APP_PORT)   — only when an app-origin socket was opened; non-fatal
getPublicUrl(t):  https://<magicDns>/#remote=<t>
originBoundary(): { desktop: https://<magicDns>, app: https://<magicDns>:8443 } | null
shutdown():       `serve --https=443 off`, `serve --https=8443 off`
```

Config is data-driven via the existing `config/tunnel.json`:

```json
{ "service": "tailscale", "appOriginPort": 8443 }
```

### 3.1 Failure posture

Each precondition surfaces a targeted fix rather than a generic "LAN-only":

| Condition | Message |
|-----------|---------|
| `tailscale` binary absent | "Install Tailscale or set `tailscalePath` in `config/tunnel.json`" |
| `BackendState != Running` | "Run `tailscale up` to log into your tailnet" |
| `serve --https=443` cert error | "Enable MagicDNS + HTTPS Certificates in the admin console" |
| `serve --https=8443` refused | "Set `appOriginPort` in `config/tunnel.json`" — desktop stays up, isolation off |

Any failure is non-fatal — remote is best-effort, never a hard boot dependency. It falls back to
**localhost-only** rather than LAN-only, though; see Phase 2 for why that differs from the SSH tunnel.

## 4. The phased roadmap

### Phase 1 — Managed Serve provider ✅ (landed)

`TunnelProvider` interface extracted; `SshTunnel implements` it unchanged; `TailscaleTunnel` added;
`createTunnel()` factory + `service: "tailscale"` config parsing; banner/QR show the MagicDNS URL.
Unit-tested via an injectable `CommandRunner` (no real daemon needed). `localhost.run` remains the
default, so nothing regresses. Files: `lib/tunnel/{types,config,index,tailscale-tunnel}.ts`,
`lifecycle.ts`, `src/tests/tailscale-tunnel.test.ts`, `docs/guides/remote_mode.md`.

### Phase 2 — Loopback-only bind under Serve ✅ (landed)

`REMOTE=1` binds `0.0.0.0` because the SSH tunnel is best-effort in front of it: lose the tunnel and
the LAN URL still works. Under Serve, `tailscaled` reaches YAAR at `127.0.0.1`, so the LAN bind is
pure extra surface — `getBindHostname()` keeps the **loopback bind and drops LAN exposure entirely**
when `service === "tailscale"`. Only the tailnet (via the daemon) and localhost get in.

One decision worth recording, because it contradicts §3.1 as originally written: the bind is chosen
from the *configured intent*, not from whether the tunnel came up. A user who asked for tailnet-only
should not silently get their whole LAN exposed on a bearer token because `tailscaled` was down. So
the Tailscale failure fallback is **localhost-only, not LAN-only**, and the banner says so. (This
also resolves an ordering problem: the tunnel now connects *after* the sockets bind — necessary for
Phase 3, and a latent fix, since the serve rule used to be registered against `getPort()` before the
port-in-use walk could move it.)

### Phase 3 — App-origin isolation over remote ✅ (landed, the payoff)

This is why Serve, and not Funnel or localhost.run. Remote mode dropped origin isolation because it
lost the two-hostname split that keeps `source:'user'` app iframes cross-origin to the desktop.
Tailscale gives that split back as a **stable MagicDNS name plus a second port** — a port difference
is an origin difference to the same-origin policy:

```
https://my-box.tailnet-abc.ts.net        → http://127.0.0.1:8000   the desktop
https://my-box.tailnet-abc.ts.net:8443   → http://127.0.0.1:8001   installed apps
```

**Why two local sockets, not one.** The enforcement in `resolvePrincipal` needs to know which origin
the browser addressed, and behind a proxy it cannot: `url.hostname`/`url.port` describe the loopback
hop `tailscaled` dialed, and `Host`/`X-Forwarded-*` are the proxy's word rather than the browser's.
The `Origin` header covers cross-origin calls but not same-origin GETs, which carry none — and those
reach the same routes. So each public port gets its own local socket and its own `fetch` handler; the
app-origin one runs inside `runOnAppOriginSocket()`, and "which socket did this arrive on" is
unforgeable by construction.

Three seams generalized to make this fit:

- **`http/origin-boundary.ts`** — the new single place that knows *where* the two origins are
  (`loopback-alias` | `proxy-port` | `off`) and answers the two questions consumers had been
  answering with hardcoded hostname comparisons: does this request carry the app origin, and where
  does a desktop document that landed on it get redirected. `access.ts`, `csp.ts`, `server.ts` and
  `features/window/create.ts` all route through it now.
- **The app origin is server-stated over `proxy-port`.** Locally the frontend must derive it (only
  the browser knows which port served the document — a dev proxy isn't the API port), so
  `window.create` carries an optional `appOrigin` used only when the client cannot compute it.
- **An iframe token is now a credential at the remote-auth gate.** An app's SDK calls never carried
  the remote token in a header; `extractToken` read it out of `Referer`, which worked *only* because
  apps were same-origin. Put an app on its own origin and the default referrer policy trims `Referer`
  to a bare origin. The alternative to accepting the iframe token was not "apps authenticate some
  other way", it was "every call an isolated app makes 401s".

A failed second rule is not fatal: the desktop tunnel stands and isolation stays off, because a
boundary the browser cannot reach is worse than none.

## 5. Security model, before and after

| | localhost.run (still the default) | Tailscale Serve (P1) | + loopback bind (P2) | + origin isolation (P3) |
|--|--|--|--|--|
| Who can reach the port | whole internet | tailnet only | tailnet only | tailnet only |
| LAN exposure | yes (`0.0.0.0`) | yes (`0.0.0.0`) | **no (loopback)** | no |
| Transport encryption | best-effort | **real HTTPS** | HTTPS | HTTPS |
| Token role | sole gate | second factor | second factor | second factor |
| Hostile-app containment | **none** | none | none | **restored** |

The token never goes away — defense in depth — but under Serve a leaked token is no longer
catastrophic, because the attacker also has to be a device you personally admitted to your tailnet.

The rightmost column is what shipped for `{ "service": "tailscale" }`; the leftmost is what every
existing deployment still gets until it opts in.

## 6. Non-goals and tradeoffs

- **Not removing localhost.run.** It stays the zero-install default for users who genuinely want
  scan-from-any-phone and accept the public-URL model. Tailscale is opt-in via config.
- **Not adding Funnel** in this proposal. If public access with Tailscale's HTTPS is ever wanted, a
  `mode: "funnel"` on the same provider is a small follow-up — but it re-inherits the public-surface
  and same-origin-app tradeoffs, so it's explicitly out of scope here.
- **Client friction is real.** Serve requires Tailscale installed and logged in on *every* client
  device. For a single-user AI desktop reached from your own phone/laptop this is a one-time cost;
  for sharing with others it's a genuine barrier, and Funnel (or staying on localhost.run) is the
  honest answer there.
- **CLI-syntax risk — still open.** The provider's `serve` invocations (now two rules) and
  `Self.DNSName` parsing are validated against fakes, not a live `tailscaled`. Nothing here has been
  exercised against a real tailnet, so one real run should gate any production reliance — see §7.
- **A second HTTPS port must be permitted on the tailnet.** Serve allows arbitrary ports, but 8443 is
  the default because Funnel also accepts it, so a later `mode: "funnel"` needs no different number.
  A refused port degrades to isolation-off, not to a broken desktop.

## 7. Rollout

1. **All three phases are committed** and inert by default — no existing deployment changes behavior
   until a user writes `{ "service": "tailscale" }`.
2. **Not yet dogfooded on a real tailnet.** On a tailnet-joined machine, confirm: the banner URL and
   the `(loopback only — no LAN)` marker; `tailscale serve status` showing *both* rules; an installed
   app rendering from `:8443` with working storage/verb calls (the iframe-token auth path); and clean
   teardown of both rules on `Ctrl+C`.
3. If the second rule is refused on 8443, confirm `appOriginPort` selects another and that the
   fallback (desktop up, isolation off) is what actually happens.
