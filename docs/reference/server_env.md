# Server Environment Variables

Every knob the server reads, with the reasoning behind the ones whose default is load-bearing.
The short table — name, default, one line — lives in
[`packages/server/CLAUDE.md`](../../packages/server/CLAUDE.md); this is where a variable gets its
full story.

A test run reads none of these from the developer's machine: `scripts/test/env.ts` scrubs the
whole `YAAR_*` prefix plus the knobs listed below, and points config/storage/session-logs at temp
dirs. A suite that only passes on a clean checkout is a suite that fails on someone's laptop and
passes in review.

**Source:** `packages/server/src/config/env.ts`, `packages/server/src/config/paths.ts`, `scripts/test/env.ts`

---

## Provider & process

| Variable | Default | Meaning |
|---|---|---|
| `PROVIDER` | auto-detect | Force `claude` or `codex` |
| `PORT` | `8000` | Server port |
| `MAX_AGENTS` | `10` | Global agent limit (process-wide) |
| `CODEX_WS_PORT` | `4510` | Codex app-server WebSocket listener |
| `MARKET_URL` | `https://yaarmarket.vercel.app` | App marketplace endpoint |

### `CODEX_HOME`

Codex's own variable, inherited by the spawn — and read by YAAR *before* it, because
`getCodexAppServerArgs()` derives one `-c mcp_servers.<name>.enabled=false` per server that
`$CODEX_HOME/config.toml` declares (`detectUserMcpServers()`).

That list has to be **detected, not written down**: naming a server the config does not declare
leaves codex with a table holding only `enabled`, and it refuses to boot with
`invalid transport in mcp_servers.<name>`.

Pinned to an empty temp dir by the test env so the spawn args do not depend on whether the
developer has the ChatGPT desktop app installed.

**Source:** `packages/server/src/config/providers/codex.ts`

---

## Paths

| Variable | Default | Meaning |
|---|---|---|
| `YAAR_STORAGE` | `storage/` | Storage root |
| `YAAR_CONFIG` | `config/` | Config directory |
| `YAAR_SESSION_LOGS` | `session_logs/` | Session log root |
| `YAAR_USER_APPS` | `user-apps/` | Marketplace-install root |
| `YAAR_WORKSPACE` | — | Pre-fill all four from `workspaces/<name>/` |

All four path vars are pinned to temp dirs by `scripts/test/env.ts`. A suite that builds a
`SessionLogger` mints a log directory — which is how `session_logs/` used to collect
`app-persona-…` logs from a plain `bun run test` — and app discovery scanning the developer's
real `user-apps/` is how a test passes locally and means something different in CI.

### `YAAR_WORKSPACE`

A workspace *is* the bundle of the four path overrides and nothing more:
`YAAR_WORKSPACE=game-dev` is shorthand for pointing storage, config, session logs and user-apps
at `workspaces/game-dev/`, so a whole experiment lives in one disposable, git-ignored directory
and the default roots stay untouched. Fill-in-if-unset — an individually set path var still wins,
which is also what keeps the test env's explicit pins authoritative.

Two behaviors follow from an active workspace rather than from the path vars themselves:

- **New deploys land in the workspace's user-apps root**, not the tracked `apps/` tree
  (`DEPLOY_ROOT` in `features/apps/roots.ts`). An experiment that writes into `apps/` dirties
  the repo, which is the exact thing the workspace exists to prevent. Existing apps still
  update in place wherever `resolveAppDir()` finds them, and bundled apps remain visible —
  the workspace layers over the base install, it does not replace it.
- **An invalid name refuses boot** rather than falling back to the default roots: silently
  writing an experiment's state into the directories the workspace was protecting is the one
  failure mode the feature cannot have. A name is one path segment — a letter or digit, then
  letters, digits, dots, hyphens or underscores (`workspaceNameRefusal`).

Applied in `config/env.ts` after `loadRootEnv()` and before `loadPersistedRemote()`, so
`YAAR_WORKSPACE` can come from the root `.env`, and the persisted `remote` preference is read
from the workspace's own settings.json.

**Source:** `packages/server/src/config/env.ts` (`applyWorkspace`), `packages/server/src/features/apps/roots.ts`

### `YAAR_KEEP_EMPTY_SESSIONS`

`1` keeps session logs that recorded nothing. Off by default because `createSession()` runs at
boot, so a click before the first message is still logged — meaning every launch the user closed
without typing left a directory behind, in `yaar://history/` and `GET /api/sessions` as much as
on disk. The launch that would add the next one sweeps them first.

What counts as empty (exactly the created shape, every log zero-length) and what protects a
concurrently-running instance's log (the creating `pid` in `metadata.json`, plus a 5-minute grace
window) is `logging/prune.ts`.

**Source:** `packages/server/src/logging/prune.ts`

### `YAAR_SKIP_DOTENV`

`1` skips loading the root `.env`. Set by `scripts/test/env.ts`: a test run pins every knob
explicitly, and "fill in what is unset" is the one door a developer's `.env` could otherwise walk
back through.

---

## Logging

| Variable | Default | Meaning |
|---|---|---|
| `YAAR_LOG_LEVEL` | `info` | Floor for `observability/log.ts` — `debug` \| `info` \| `warn` \| `error` |
| `YAAR_LOG_FORMAT` | `pretty` | `pretty` or `json` |

`debug` being off by default is the one visibility change the console→logger conversion made:
everything that used to be `console.log` is `info` and still prints, but genuinely chatty lines
(codex item/started, the Claude SDK message trace, `entered agent context`) were demoted and now
need `YAAR_LOG_LEVEL=debug`.

`pretty` is the terminal format the `[Component] message` lines always had, plus `key=value`
fields and the monitor/agent ids. `json` is one object per line carrying **every** context id
(session, monitor, agent, window, app) and an ISO timestamp. Both are scrubbed by the test env's
`YAAR_` prefix sweep, so a suite never inherits a developer's setting.

**Source:** `packages/server/src/observability/log.ts`

---

## Security boundaries

### `YAAR_APP_ORIGIN_ISOLATION` — **on by default** (`=0` disables)

Serves `source:'user'` app iframes from a distinct browser origin so they are cross-origin to the
desktop; `resolvePrincipal` then refuses a token-less request carrying the app origin.

**Which two origins** (`loopback-alias` locally, `proxy-port` over Tailscale Serve, `off`) is
`http/origin-boundary.ts`'s business and the one place to ask — its header explains both modes and
why the proxy-port attribution is unforgeable. Never compare hostnames yourself.

**Source:** `packages/server/src/http/origin-boundary.ts`. See also
[`docs/guides/remote_mode.md`](../guides/remote_mode.md).

### `YAAR_CLIPBOARD_SECRETS` — **on by default** (`=0` disables)

Redacts vendor-prefixed credentials (API keys, tokens, PEM private keys, passwords in connection
URLs) out of clipboard **text** before it reaches an agent. Applied in `features/user/clipboard.ts`
so it covers `read` *and* `save`.

Guarding only `read` would not be a guard: `save` writes to storage and returns a URI, so a raw
write leaves the secret one `read('yaar://storage/...')` away.

Redaction rather than refusal, because a refused read makes an LLM ask the user to paste the
content into the chat instead — same context window, no scan.

Detection is prefix-anchored only: no entropy tier, no labeled-assignment tier, no checksum
verification (a checksum can only ever *reject* a match, so a bug in it leaks). Images are not
scanned at all. The opt-out is for agents whose job is the credential itself.

**Source:** `packages/server/src/features/user/secret-scan.ts`, `packages/server/src/features/user/clipboard.ts`

### `YAAR_CLIPBOARD_GRANT` — **on by default** (`=0` disables)

Pre-grants clipboard read/write to the desktop origin in the debuggable Chrome over CDP, so
`yaar://user/clipboard` never shows the user a permission prompt.
`lib/browser/clipboard-grant.ts` holds a browser-level CDP connection open for the process's life
to do it — the override is scoped to the DevTools *connection*, not the profile, so there is no
launch flag or config file that can replace it (the header records the measurements).

Deliberately grants only `DESKTOP_ORIGIN_HOST`, never `APP_ORIGIN_HOST`: the app origin is where
isolated app iframes live, and a grant there would hand every installed app the user's clipboard
past its `app.json` permissions.

The opt-out exists because with this on, any agent turn reads the clipboard with no prompt and no
visible indication.

**Source:** `packages/server/src/lib/browser/clipboard-grant.ts`

### `YAAR_REMOTE_TOKEN`

Adopt this remote token instead of minting one, so a launcher can build the `#remote=<token>` URL
before the server starts (`scripts/dev/start.sh` does this for `make claude`). **Under 32
characters it is ignored with a warning** — remote mode hands the token to every device that can
reach the server.

**Source:** `packages/server/src/http/auth.ts`

### `MCP_SKIP_AUTH` / `REMOTE`

`MCP_SKIP_AUTH=1` skips MCP auth for local dev. `REMOTE=1` enables remote mode (token auth, QR
code, tunnel). See [`docs/guides/remote_mode.md`](../guides/remote_mode.md).

---

## Network

| Variable | Default | Meaning |
|---|---|---|
| `YAAR_MAX_DOWNLOAD_MB` | `512` | Ceiling for a `yaar://http` body streamed to disk via `saveTo` |
| `YAAR_FREEDPI` | on | Route outbound TLS through a local fragmenting proxy to get past SNI-matching DPI (`0` disables) |

### `YAAR_FREEDPI` — on by default (`=0` disables)

Some networks block HTTPS by reading the hostname out of the ClientHello — which is
plaintext — and injecting a TCP reset. Nothing is wrong with DNS and nothing is wrong with
the route; the handshake is simply shot in the head every time. The server starts a
loopback `CONNECT` proxy and points its two outbound paths at it: Chrome gets
`--proxy-server`, and `safeFetch` gets `fetch`'s `proxy` option.

The countermeasures are a ladder, tried cheapest first, and every host climbs only as far
as it has to (`Route` in `lib/freedpi/types.ts`):

1. **`tlsrec`** — rewrite the ClientHello as two TLS *records*, cut inside the hostname.
   A middlebox that reassembles TCP still gets the whole stream, but a parser that reads
   the SNI out of the first record finds a truncated name. Costs nothing — measured on
   SK Broadband (AS9318), 2026-08, a blocked host went from a 40ms reset to a ~120ms
   handshake, indistinguishable from an unblocked one.
2. **`bypass`** — cut the hello into two TCP *segments* inside the hostname, and hold the
   second one back until the middlebox's reassembly buffer has expired. This is the rung
   for a box that both reassembles and parses across records; it is the one that costs
   `stallMs`.

### Why it is on by default

It was opt-in, on the reasoning that a censorship-circumvention tool should not arrive
unrequested. That reasoning had the failure mode backwards. A host killed by SNI reset
does not present as censorship — it presents as YAAR being broken on that site — so the
people the bypass was written for were exactly the ones who would never think to turn it
on. You cannot recognise a blocked host without something to compare it against.

It is affordable as a default because the ladder makes it cost nothing until it is used.
Every host starts on `direct`, so an unblocked network pays one extra loopback hop and
keeps its latency; only a host that gets an injected-looking reset climbs, and only that
host pays. What *is* unconditional is name resolution — see below — and, in Chrome,
HTTP/3.

Turn it off with `YAAR_FREEDPI=0` if you need the system resolver's own answers (split
DNS, an internal zone reached by a public-looking name) or Chrome's HTTP/3.

### DoH first, not DoH only

Resolution goes to DoH (Cloudflare) rather than the system resolver, because a censor
that resets on SNI usually poisons DNS on the same path; a system answer would be the
block page's address and no amount of fragmentation would help.

Being the default changes what a DoH *failure* has to mean. Every outbound connection the
server makes is now resolved in `lib/freedpi/resolve.ts`, so a DoH endpoint that is
unreachable — captive portal, a network that blocks `1.1.1.1`, plain offline — would take
all of them down, and a name with only an `AAAA` record would never resolve at all
(`type=A` is what is asked for). So a DoH failure falls back to the system resolver
instead of failing the dial.

The fallback cannot leave you worse off than not having the proxy: a poisoned system
answer resets the connection and the caller sees the failure it would have seen anyway,
whereas refusing to answer turns a working direct path into a 502. Because the fallback
can return a v6 address where DoH never could, `refusalForAddress` carries the v6 rules
`lib/ssrf.ts` does not — `fc00::/7`, `::`, and `::ffff:` v4-mapped addresses, which it
unwraps so they are refused by the same rule as the bare v4 form.

### The stall is a measurement, not a constant

`stallMs` only applies on the `bypass` rung, and defaults to 3000. That number came from
measuring one network — SK Broadband (AS9318), 2026-08 — where TCP fragmentation with no
delay, and with delays up to 1000ms, was reset every time; 2500ms succeeded intermittently;
3000ms succeeded six times out of six. (The same network is defeated by the record split,
which is why `tlsrec` is tried first; the stall is there for a box that is not.)
It describes that middlebox's buffer lifetime and nothing more. Another ISP will have a
different one, and the same ISP can change it. Treat a bypass that stops working as a
number to re-measure rather than a bug.

### Why hosts are learned instead of configured

Three seconds on every handshake would make the browser feel broken, and a hand-maintained
domain list goes stale the moment a censor's list does. So every host starts on the direct
path, and only a reset that *looks injected* — the connection opened, carried our first
flight, and died without one byte coming back — moves it to the bypass. Ordinary traffic
keeps its latency; a blocked host climbs the ladder once and the rung that served it is
remembered — a further reset on that rung climbs again.

That is affordable only because the retry is invisible. A client whose TLS handshake was
reset is still waiting for a ServerHello and has seen nothing, so the proxy opens a fresh
connection and replays the identical ClientHello on the next rung. One byte delivered and
that stops being safe, which is why `canReplay` refuses after any server bytes.

Verdicts expire (30 minutes) so an ISP that changes its policy is noticed, and the table is
bounded and never written to disk — a stale verdict read at boot would apply the stall to a
host that may no longer need it, with nothing prompting a re-test.

### Chrome must also be told to stop using QUIC

`--disable-quic` is passed alongside `--proxy-server`. HTTP/3 is UDP/443 and never enters an
HTTP proxy, so without it Chrome negotiates QUIC and goes around the bypass entirely — which
presents as the bypass mysteriously not working.

### It re-checks SSRF, because `validateUrl` can no longer see the target

`validateUrl` inspects the hostname a caller passed. Once traffic is tunnelled, the address
actually dialed is the one the proxy resolved over DoH, which no earlier check has seen — so
a public hostname whose A record points into private space would sail through. The proxy
therefore re-applies the same rules to the resolved address, and refuses loopback as well,
which `safeFetch` deliberately allows: an open `CONNECT` listener lives for the whole server
run, and anything local that finds the port inherits its reach.

**Source:** `packages/server/src/lib/freedpi/`, `packages/server/src/lib/ssrf.ts`,
`packages/server/src/lib/browser/chrome.ts`, `packages/server/src/lifecycle.ts`

### Why the download ceiling is separate from the inline one

`yaar://http` has two ceilings because it answers two different questions. The inline cap
(`MAX_RESPONSE_SIZE`, a fixed 10MB) is not about the network at all — it bounds what ends up
*in a context*: base64 an app has to decode, or bytes a model would have to read. `saveTo`
puts the body on disk and hands back a path, so none of that applies and the only thing left
to bound is the disk. Sharing one number meant the parameter that exists to fetch something
large was refused for being large (issue #90).

Bytes under `saveTo` are piped to a `.part-*` file as they arrive and renamed into place at
the end, so nothing the size of the download is ever held in memory and a transfer that dies
halfway leaves nothing at the destination. The 30-second request budget also becomes a
*stall* timeout there — restarted on each chunk — since a legitimate 500MB transfer outlives
any fixed one while a dead connection still has to be noticed.

**Source:** `packages/server/src/features/http/fetch.ts`, `packages/server/src/handlers/http.ts`

---

## Agent budgets

| Variable | Default | Meaning |
|---|---|---|
| `MONITOR_MAX_CONCURRENT` | `2` | Concurrent background monitor tasks |
| `MONITOR_MAX_ACTIONS_PER_MIN` | `30` | Monitor action rate limit |
| `MONITOR_MAX_OUTPUT_PER_MIN` | `50000` | Monitor output rate limit |
| `APP_AGENT_IDLE_MINUTES` | `15` | Idle minutes before an app agent is reclaimed (`0` disables) |

### Why `APP_AGENT_IDLE_MINUTES` exists

Closing an app's **last** window on a monitor already retires its agent, so this is the backstop
for the app left open and unused. App agents had no other reclaim path — not window close, only
`fresh: true`, monitor removal, explicit delete, or session teardown — so against a process-global
`MAX_AGENTS` of 10, apps opened once and left alone held their slots until restart.

Reaping ends the agent's provider session, so its memory goes with it (the same thing `fresh: true`
and a last-window close both do deliberately). Reaping leaves its sub-agents alone, because their
owner is the (monitor, app) pair — only a last-window close, monitor removal, or teardown takes
those.

**Source:** `packages/server/src/agents/agent-pool.ts`

---

## Browser

| Variable | Default | Meaning |
|---|---|---|
| `CHROME_PATH` | auto-detected | Chrome binary |
| `CHROME_DEBUG_PORT` | `9222` | DevTools port the session-door browser provider attaches to |
| `YAAR_BROWSER_PROVIDER` | — | Force-headless opt-out only (see below) |
| `YAAR_BROWSER_STATE_DIR` | `storage/.browser` | Where the sandbox profile and session records live |
| `YAAR_BROWSER_EPHEMERAL` | off (`=1` enables) | Throw the sandbox profile away on shutdown |
| `YAAR_BROWSER_IDLE_MINUTES` | `5` | Idle minutes before a browser session is swept (`0` disables) |

### The sandbox browser keeps its profile

The headless sandbox Chrome launches against `storage/.browser/profile`, and that directory
**survives shutdown**. A site you signed into in the sandbox is still signed in tomorrow, which is
what makes reviving a session worth anything — a revived tab that came back to a login screen
would be a new tab with extra steps. `storage/.browser/sessions.json` holds the records that make
the revive possible: id, page, bound window.

It is still a sandbox, not your Chrome profile. Only `getLocalBrowser()` touches that.

`YAAR_BROWSER_EPHEMERAL=1` restores the pre-P1 behaviour — a `mkdtemp` dir wiped on cleanup. Set
it when the sandbox should forget between runs, and when two YAAR instances share a checkout:
Chrome holds a singleton lock on a profile directory, so the second launch would otherwise wait on
the first.

### `YAAR_BROWSER_IDLE_MINUTES` and what "idle" means

The sweep closes a session's *socket*, not its record — the id keeps naming its page, and the next
window (or `invoke(…, { action: 'revive' })`) brings it back. A session with a live screencast
viewer is exempt however long it sits: someone reading a long page is not idle, and taking the
canvas out from under them was the pre-P1 behaviour.

### `YAAR_BROWSER_PROVIDER` is no longer a selector

`POST /api/browser` is always the headless sandbox (`getHeadlessBrowser()`). The user's real
Chrome is reached only through the session-agent door `yaar://session/browser`
(`getLocalBrowser()`), which auto-attaches whenever a debuggable Chrome is reachable.

The variable survives only as a **force-headless opt-out**: set `=headless` to keep the agent away
from your real browser, and the session door uses the sandbox too.

`CHROME_DEBUG_PORT` is the port the user launched Chrome with via `--remote-debugging-port`.

---

## Test-runner only

### `YAAR_TEST_REMOTE`

`1` makes `scripts/test/env.ts` pin `REMOTE=1` for the whole process, which is how
`src/tests/remote/` gets a genuine remote-mode `IS_REMOTE` (it is a module-load constant, so
remote-gate assertions are vacuous in a local-mode process). The env script sets this itself when
the collected files live under `src/tests/remote/`, so a by-path run stays a remote-mode run.

**Source:** `scripts/test/env.ts`, `scripts/test/partitions.ts`
