# Proposal: Migrating Remote Access from a Public Tunnel to Tailscale Serve

YAAR's remote mode today reaches the outside world through a **free public tunnel** — an SSH
reverse tunnel to `localhost.run` that hands back an ephemeral `https://*.lhr.life` URL. The only
thing standing between that URL and a stranger is a shared bearer token. This proposal migrates the
default remote story to **Tailscale Serve**: the machine is reachable only by devices already on
your tailnet, over a real HTTPS certificate, with the token demoted from *sole gate* to *second
factor*.

The migration is deliberately phased. **Phase 1 has landed** (a managed `TailscaleTunnel` provider,
opt-in via config); Phases 2 and 3 are the follow-ups that turn a transport swap into a genuine
security upgrade.

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

The last row is the scariest and the least visible. It's stated plainly in
[`remote_mode.md`](../guides/remote_mode.md): *in remote mode, don't install apps you don't trust.*

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
lifecycle.ts  →  createTunnel(config, port)  →  TunnelProvider
                                                 ├── SshTunnel        (service: "localhost.run", default)
                                                 └── TailscaleTunnel  (service: "tailscale")
```

`TailscaleTunnel` is dramatically simpler than `SshTunnel`, because **`tailscaled` already owns the
tunnel and its resilience**. There is no ssh2 client, no reverse TCP piping, no keepalive, and no
exponential-backoff reconnect. `tailscale serve` just registers a proxy rule with the local daemon:

```
https://<host>.<tailnet>.ts.net:443   →   http://127.0.0.1:<PORT>
```

so the "tunnel" is pure CLI orchestration:

```
connect():
  1. `tailscale status --json`  → daemon up? (BackendState == "Running")  read Self.DNSName
  2. `tailscale serve --https=443 off`             (clear any stale rule we left)
  3. `tailscale serve --bg --https=443 http://127.0.0.1:<PORT>`
getPublicUrl(t): https://<magicDns>/#remote=<t>
shutdown():      `tailscale serve --https=443 off`
```

Config is data-driven via the existing `config/tunnel.json`:

```json
{ "service": "tailscale" }
```

### 3.1 Failure posture

Each precondition surfaces a targeted fix rather than a generic "LAN-only":

| Condition | Message |
|-----------|---------|
| `tailscale` binary absent | "Install Tailscale or set `tailscalePath` in `config/tunnel.json`" |
| `BackendState != Running` | "Run `tailscale up` to log into your tailnet" |
| `serve --https=443` cert error | "Enable MagicDNS + HTTPS Certificates in the admin console" |

Any failure falls back to LAN-only, exactly like the SSH tunnel — remote is best-effort, never a
hard boot dependency.

## 4. The phased roadmap

### Phase 1 — Managed Serve provider ✅ (landed)

`TunnelProvider` interface extracted; `SshTunnel implements` it unchanged; `TailscaleTunnel` added;
`createTunnel()` factory + `service: "tailscale"` config parsing; banner/QR show the MagicDNS URL.
Unit-tested via an injectable `CommandRunner` (no real daemon needed). `localhost.run` remains the
default, so nothing regresses. Files: `lib/tunnel/{types,config,index,tailscale-tunnel}.ts`,
`lifecycle.ts`, `src/tests/tailscale-tunnel.test.ts`, `docs/guides/remote_mode.md`.

### Phase 2 — Loopback-only bind under Serve (pending)

Today `REMOTE=1` binds `0.0.0.0` because the SSH tunnel connects in from outside. Under Serve,
`tailscaled` reaches YAAR at `127.0.0.1` — so when `service === "tailscale"` we can keep the
**loopback bind and drop LAN exposure entirely**. Only the tailnet (via the daemon) and localhost
get in. This is a behavior change (no more plain-LAN access from a device that isn't on the
tailnet), gated strictly on the Tailscale service, which is why it's separated from Phase 1.

### Phase 3 — Preserve app-origin isolation over remote (pending, the payoff)

This is why Serve, and not Funnel or localhost.run. The reason remote mode drops origin isolation
is that it loses the two-hostname split that keeps `source:'user'` app iframes cross-origin to the
desktop. Tailscale gives that split back as **stable MagicDNS names**: serve the desktop and the app
iframes on distinct hostnames (or distinct Serve paths/ports), and the browser's same-origin policy
re-erects the boundary over the network — a hostile installed app is once again confined to what its
`app.json` declares. localhost.run's rotating subdomains can't anchor this; only a stable-hostname
transport can. Landing Phase 3 would let us **delete the "remote drops origin isolation" caveat**
from `remote_mode.md` — the single biggest security win of the whole migration.

## 5. Security model, before and after

| | localhost.run (today) | Tailscale Serve (P1) | + loopback bind (P2) | + origin isolation (P3) |
|--|--|--|--|--|
| Who can reach the port | whole internet | tailnet only | tailnet only | tailnet only |
| LAN exposure | yes (`0.0.0.0`) | yes (`0.0.0.0`) | **no (loopback)** | no |
| Transport encryption | best-effort | **real HTTPS** | HTTPS | HTTPS |
| Token role | sole gate | second factor | second factor | second factor |
| Hostile-app containment | **none** | none | none | **restored** |

The token never goes away — defense in depth — but under Serve a leaked token is no longer
catastrophic, because the attacker also has to be a device you personally admitted to your tailnet.

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
- **CLI-syntax risk.** The provider's `serve` invocation and `Self.DNSName` parsing are validated
  against fakes, not a live `tailscaled`. One real run on a tailnet-joined machine should gate any
  reliance on Phase 1 in production.

## 7. Rollout

1. **Phase 1 is committed** and inert by default — no existing deployment changes behavior until a
   user writes `{ "service": "tailscale" }`.
2. Dogfood on a tailnet-joined dev machine; confirm the banner URL, the serve rule, and clean
   teardown on `Ctrl+C`.
3. Land Phase 2 (loopback bind) once Serve is confirmed working end to end.
4. Land Phase 3 (origin isolation over MagicDNS) as its own reviewed change, and rewrite the
   `remote_mode.md` security section to match.
