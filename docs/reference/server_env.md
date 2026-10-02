# Server Environment Variables

Every knob the server reads. The short table lives in
[`packages/server/CLAUDE.md`](../../packages/server/CLAUDE.md); this is where a variable gets its
full story.

A test run reads none of these from the developer's machine: `scripts/test/env.ts` scrubs the
whole `YAAR_*` prefix plus the knobs listed below, and points config/storage/session-logs at temp
dirs.

**Source:** `packages/server/src/config/env.ts`, `packages/server/src/config/paths.ts`, `scripts/test/env.ts`

---

## Provider & process

| Variable | Default | Meaning |
|---|---|---|
| `PROVIDER` | auto-detect | Force `claude` or `codex` |
| `FABLE` | off | `=1`: monitor agent on Fable, every other agent on Opus |
| `PORT` | `8000` | Server port |
| `MAX_AGENTS` | `10` | Global agent limit (process-wide) |
| `CODEX_WS_PORT` | `4510` | Codex app-server WebSocket listener |
| `MARKET_URL` | `https://yaarmarket.vercel.app` | App marketplace endpoint |
| `YAAR_MOCK_AGENT` | off | `=1`: every provider is a scripted mock — no model, no tokens (`make mobile-bench`) |
| `YAAR_REACT_PROD` | on for Android, off elsewhere | Dev bundler ships React's production build (`1` forces on, `0` off) |
| `YAAR_LAUNCHER_PID` | unset | Shut down once this process is gone (set by `make termux`) |
| `YAAR_WEBVIEW` | on | Bundled exe only: open the desktop in YAAR's own WebView window where the build carries one (`0` goes straight to Chrome/Edge `--app`) |
| `YAAR_WEBVIEW_DEVTOOLS` | off | `=1`: the WebView window gets right-click → Inspect (and Safari's Develop menu on macOS) |
| `YAAR_WEBVIEW_LIB` | unset | Load the WebView library from this path instead of the exe's embedded copy |
| `YAAR_WEBVIEW_CDP_PORT` | unset | Windows exe: serve CDP for the WebView2 window on this loopback port |

### `YAAR_MOCK_AGENT`

`YAAR_MOCK_AGENT=1` makes `instantiateProvider` return a `MockTransport` for every agent,
reporting the provider type it stands in for. Only the model is replaced: the turn still runs
inside its agent context, through `StreamToEventMapper`, and its windows go through the same
`yaar://windows` invoke — a load generator, not a UI fixture (`make mobile-bench`). It models
Termux, so it runs with the companion desktop on.

A turn is steered from its prompt: `perf windows=6 text=600 apps=memo` streams 600 characters,
then opens six windows rotating markdown → table → component → iframe app. A prompt with no
`perf` directive gets a one-line reply and no windows.

**Source:** `packages/server/src/providers/mock/index.ts`, `scripts/bench/mobile.ts`

### `YAAR_REACT_PROD`

Whether the dev bundler (every launch that is not `REMOTE=1` and not the bundled exe —
`make termux` included) builds the frontend against React's **production** build. The dev build
doubled the phone shell's render cost (`make mobile-bench`: 6-window turn 273ms vs 118ms of
renderer script). Default is development on a desktop, production on Android.
`make mobile-bench` pins it on; `YAAR_REACT_PROD=0 make mobile-bench` measures the dev build. The
release build (`packages/frontend/build.ts`) always defines `NODE_ENV=production`.

**Source:** `packages/server/src/http/dev-bundler.ts` (`reactProduction`), `packages/frontend/build.ts`

### `YAAR_LAUNCHER_PID`

The PID of whatever launched the server. The server checks on it every two seconds and shuts
down the normal way once it is gone; unset, nothing is watched. `start-termux.sh` sets it to
itself.

`start.sh` runs the server in a process group of its own, so a terminal hangup never reaches it
and only `start.sh`'s cleanup trap stops it — which does not run on SIGKILL, how Termux and the
phantom-process killer end a launcher. Without the watchdog the server lived on as an orphan on
port 8000.

Where there is a `/proc`, "gone" also covers PID recycling (start time is compared). The variable
is removed from the environment once read, so spawned agents do not inherit it.

**Source:** `packages/server/src/launcher-watchdog.ts`, `scripts/dev/start-termux.sh`

### `YAAR_WEBVIEW`

Where the bundled exe shows the desktop. On macOS the binary carries a native WebView library
(`libwebview.dylib`, built from `packages/lib/src/webview/native/` by `scripts/build/webview-native.ts`) and
re-spawns itself as `yaar --window <url> --parent <pid>` to own a WKWebView window; closing that
window shuts the server down, and the window closes itself if the server dies first. Any
failure before the window appears (no library for the platform, a library that will not load,
no WebView to be had) falls back to Chrome/Edge `--app`, then the default browser — so
`YAAR_WEBVIEW=0` is only needed to *choose* Chrome. Windows builds carry `webview.dll` (WebView2,
[windows.md](../installations/windows.md)); Linux builds carry no library yet.
Development never goes through here — `make dev` and friends open Chrome, over CDP.

The window loads the local h2 socket, `https://localhost:<tlsPort>`. WebKit has no equivalent of
Chromium's SPKI flag, so the server passes the pin as `--trust-spki <pin>` and the window's
delegate accepts that one self-signed key on a loopback host (desktop, isolated app frames on
`127.0.0.1`, and `wss:`); anything else gets the system trust store. With no TLS socket (no
`openssl`) the window loads plain `http://localhost:<port>` (HTTP/1.1, six connections per host).

The top frame of the desktop origin — and nothing else — gets `window.yaarHost` (contract:
`packages/shared/src/host-contract.ts`): bridge downloads into `~/Downloads`, clipboard read and
write, and opening http(s)/mailto URLs in the default browser. The window itself also saves
`<a download>` and attachment downloads into `~/Downloads` (never over an existing file), opens
off-machine `window.open`/`target=_blank` links in the default browser and script popups in a
window of their own, and grants the microphone and camera to `localhost`/`127.0.0.1` only once
macOS has granted them to YAAR.

`YAAR_WEBVIEW_LIB` points the window at a different library build. The embedded copy is otherwise
written to `~/Library/Caches/YAAR/libwebview-<hash>.dylib` (`%LOCALAPPDATA%\YAAR\Cache\webview-<hash>.dll`
on Windows; dlopen cannot read the exe's virtual filesystem), once per build.

On Windows the window is WebView2: the pin is checked in its certificate-error event instead of
a delegate, the profile lives in `%LOCALAPPDATA%\YAAR\WebView2`, and
`YAAR_WEBVIEW_CDP_PORT=<port>` serves CDP for the window on that loopback port.

A `YAAR.app` (built on a Mac by `bun run build:exe:bundle:macos`) keeps its data in
`~/Library/Application Support/YAAR` (`.env`, `config/`, `storage/`, `session_logs/`, `apps/`,
`user-apps/`) rather than beside the binary, because writing into a signed bundle breaks the
signature macOS records permission grants against.

**Source:** `packages/server/src/desktop-window/`, `packages/lib/src/webview/`,
`packages/lib/src/webview/native/webview_extras.mm`, `packages/lib/src/webview/native/webview_extras_win.cc`,
`packages/server/src/macos-bundle.ts`, `docs/installations/mac.md`, `docs/installations/windows.md`

### `FABLE`

`FABLE=1 make claude` puts the monitor agent — the one the user talks to — on Fable
(`FABLE_MODEL`), and pins every agent below it to Opus: the session agent, every app agent
whatever its `agentType`, and every sub-agent, including one spawned with an explicit `model`.
Off, the usual tiers apply (monitor and session agent Opus, apps Sonnet unless declared).
The flag is read per turn (`isFableMode()`). Under `PROVIDER=codex` Fable maps to `gpt-6-astra`
and Opus to `gpt-6.1-sol`, so the monitor agent runs on Astra and app and sub-agents move from
Luna to Sol.

**Source:** `packages/server/src/agents/profiles/model-tiers.ts`, `packages/server/src/agents/profiles/turn-options.ts`

### `CODEX_HOME`

Codex's own variable, inherited by the spawn — and read by YAAR *before* it, because
`getCodexAppServerArgs()` derives one `-c mcp_servers.<name>.enabled=false` per server that
`$CODEX_HOME/config.toml` declares (`detectUserMcpServers()`).

The list is **detected, not written down**: naming a server the config does not declare makes
codex refuse to boot with `invalid transport in mcp_servers.<name>`. Pinned to an empty temp dir
by the test env.

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

All four path vars are pinned to temp dirs by `scripts/test/env.ts`.

### `YAAR_WORKSPACE`

A workspace *is* the bundle of the four path overrides and nothing more:
`YAAR_WORKSPACE=game-dev` points storage, config, session logs and user-apps at
`workspaces/game-dev/`. Fill-in-if-unset — an individually set path var still wins.

- **New deploys land in the workspace's user-apps root**, not the tracked `apps/` tree
  (`DEPLOY_ROOT` in `features/apps/roots.ts`). Existing apps still update in place wherever
  `resolveAppDir()` finds them, and bundled apps remain visible.
- **An invalid name refuses boot** rather than falling back to the default roots. A name is one
  path segment — a letter or digit, then letters, digits, dots, hyphens or underscores
  (`workspaceNameRefusal`).

Applied in `config/env.ts` after `loadRootEnv()` and before `loadPersistedRemote()`, so
`YAAR_WORKSPACE` can come from the root `.env`, and the persisted `remote` preference is read
from the workspace's own settings.json.

**Source:** `packages/server/src/config/env.ts` (`applyWorkspace`), `packages/server/src/features/apps/roots.ts`

### `YAAR_KEEP_EMPTY_SESSIONS`

`1` keeps session logs that recorded nothing. Off by default: `createSession()` runs at boot, so
every launch closed without typing would otherwise leave a directory behind (in
`yaar://history/` and `GET /api/sessions` too). The next launch sweeps them first. What counts as
empty and what protects a concurrently-running instance's log (creating `pid` in `metadata.json`,
5-minute grace) is `logging/prune.ts`.

**Source:** `packages/server/src/logging/prune.ts`

### `YAAR_SKIP_DOTENV`

`1` skips loading the root `.env`. Set by `scripts/test/env.ts`.

---

## Logging

| Variable | Default | Meaning |
|---|---|---|
| `YAAR_LOG_LEVEL` | `info` | Floor for `observability/log.ts` — `debug` \| `info` \| `warn` \| `error` |
| `YAAR_LOG_FORMAT` | `pretty` | `pretty` or `json` |

Chatty lines (codex item/started, the Claude SDK message trace, `entered agent context`) need
`YAAR_LOG_LEVEL=debug`. `pretty` is the `[Component] message` terminal format plus `key=value`
fields and the monitor/agent ids; `json` is one object per line carrying every context id
(session, monitor, agent, window, app) and an ISO timestamp.

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

Applied to `save` as well as `read`, since `save` writes to storage and returns a URI. Redaction
rather than refusal, because a refused read makes an LLM ask the user to paste the content
instead.

Detection is prefix-anchored only: no entropy tier, no labeled-assignment tier, no checksum
verification. Images are not scanned. The opt-out is for agents whose job is the credential itself.

**Source:** `packages/server/src/features/user/secret-scan.ts`, `packages/server/src/features/user/clipboard.ts`

### `YAAR_CLIPBOARD_GRANT` — **on by default** (`=0` disables)

Pre-grants clipboard read/write to the desktop origin in the debuggable Chrome over CDP, so
`yaar://user/clipboard` never shows the user a permission prompt.
`lib/browser/clipboard-grant.ts` holds a browser-level CDP connection open for the process's life
(the override is scoped to the DevTools *connection*, so no launch flag or config file can replace
it). Grants only `DESKTOP_ORIGIN_HOST`, never `APP_ORIGIN_HOST`: a grant on the app origin would
hand every installed app the clipboard past its `app.json` permissions. The opt-out exists
because with this on, any agent turn reads the clipboard with no prompt.

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

Some networks block HTTPS by reading the hostname out of the plaintext ClientHello and injecting
a TCP reset. The server starts a loopback `CONNECT` proxy and points its two outbound paths at
it: Chrome gets `--proxy-server` (plus `--disable-quic` — HTTP/3 is UDP and would go around the
proxy), and `safeFetch` gets `fetch`'s `proxy` option.

**The ladder.** Every host starts on `direct` (an unblocked network pays one loopback hop). Only a
reset that *looks injected* — the connection opened, carried our first flight, and died without a
byte back — moves a host up a rung (`Route` in `packages/lib/src/freedpi/types.ts`):

1. **`tlsrec`** — rewrite the ClientHello as two TLS *records*, cut inside the hostname.
2. **`bypass`** — cut the hello into two TCP *segments* inside the hostname and hold the second
   back for `stallMs` (default 3000) until the middlebox's reassembly buffer expires.

The rung that served a host is remembered; a further reset on it climbs again. The retry is
invisible because a client whose handshake was reset has seen nothing, so the proxy replays the
identical ClientHello (`canReplay` refuses after any server bytes). Verdicts expire after 30
minutes, and the table is bounded and never written to disk.

`stallMs` was measured on one network (SK Broadband, AS9318, 2026-08: 0–1000ms reset every time,
2500ms intermittent, 3000ms six of six). Treat a bypass that stops working as a number to
re-measure, not a bug.

**DoH first, not DoH only.** Resolution goes to DoH (Cloudflare) because a censor that resets on
SNI usually poisons DNS on the same path. Every outbound connection is resolved in
`packages/lib/src/freedpi/resolve.ts`, so a DoH failure (captive portal, blocked `1.1.1.1`,
offline, AAAA-only name) falls back to the system resolver instead of failing the dial. Because
that fallback can return v6, `refusalForAddress` carries the v6 rules `packages/lib/src/ssrf.ts`
does not: `fc00::/7`, `::`, and `::ffff:` v4-mapped addresses (unwrapped to the v4 rule).

**SSRF is re-checked.** `validateUrl` sees only the hostname a caller passed; the address actually
dialed is the DoH answer. The proxy re-applies the same rules to it and also refuses loopback,
which `safeFetch` allows — an open `CONNECT` listener lives for the whole run.

`YAAR_FREEDPI=0` is for needing the system resolver's answers (split DNS, internal zones) or
Chrome's HTTP/3.

**Source:** `packages/lib/src/freedpi/`, `packages/lib/src/ssrf.ts`,
`packages/server/src/lib/browser/chrome.ts`, `packages/server/src/lifecycle.ts`

### The download ceiling vs the inline one

`yaar://http` has two ceilings. The inline cap (`MAX_RESPONSE_SIZE`, a fixed 10MB) bounds what
ends up *in a context*. `saveTo` puts the body on disk and hands back a path, so only the disk
needs bounding (`YAAR_MAX_DOWNLOAD_MB`). Bytes are piped to a `.part-*` file and renamed into
place at the end, so nothing is held in memory and a dead transfer leaves nothing at the
destination. The 30-second request budget becomes a *stall* timeout there, restarted on each chunk.

**Source:** `packages/server/src/features/http/fetch.ts`, `packages/server/src/handlers/http.ts`

---

## Companion desktop

| Variable | Default | Meaning |
|---|---|---|
| `YAAR_COMPANION_TAB` | on for Android, off elsewhere | Park a second, always-visible desktop in a server-side browser (`1` forces on, `0` off) |

### Why it exists

A phone freezes a backgrounded tab, and every read that is a **round trip into the page** stops
answering — notably `__screenshot`, rasterized inside the app's iframe. The socket does not say so:
a real Chrome frozen with `Page.setWebLifecycleState` kept it open for **264s** in front of a page
that could not execute a line (`packages/server/src/session/client-presence.ts`).

A second, always-visible desktop answers what the phone cannot, with no new mechanism:

- An action goes to **every** connection in the session (`BroadcastCenter.publishToSession`) and
  the first feedback wins (`ActionEmitter.emitActionWithFeedback`).
- `clientAwayNote` owes no explanation while **any** connection is visible.
- A socket that asks for no particular session gets the default one, the user's (`SessionHub.attach`).

With the YAAR app the phone's own page keeps answering in the background
([android.md](../installations/android.md#what-happens-when-you-leave)): it stays `visible` and
reports itself `unattended`, so it keeps its windows and the companion takes over only if the
app is killed. In Chrome on the phone the companion answers as described here.

### Why the default is Android-only

On a phone client and server are the same device, so "the user switched apps" is the ordinary
case; Termux keeps running (with a wake lock) and Chromium there is a child of it, on the
**server** side of the freeze (it needs `--browser-subprocess-path`, handled in
`lib/browser/chrome.ts`). Elsewhere a companion costs a Chromium process plus a second live iframe
for every open app window, so an app with side effects on mount runs them twice.

### Load-bearing details

- **`?ui=desktop`.** The phone shell renders one window at a time; the desktop layout keeps every
  window mounted, so a capture of any window finds it.
- **Pinned against the idle sweep** (`BrowserSession.pinned`), or `cleanupIdle` would collect it
  just when it is needed.
- **`companion=1`, and a socket that says `role=companion`.** App protocol commands go to one copy
  of each window; the companion is the **fallback** responder — a user's tab in front answers, the
  companion covers while that tab cannot run script, and the window moves back once the tab has
  been in front for `userTabSettleMs` (`AppWindowCoordinator.rankResponders` / `settledUserTab`).
  State an app must show on both copies goes in `createSharedSignal` (see `apps/CLAUDE.md`).

A box with no Chromium goes without, and says so once.

**Source:** `packages/server/src/features/companion/companion-tab.ts`

---

## Remote ML compute

| Variable | Default | Meaning |
|---|---|---|
| `YAAR_ML_COMPUTE` | `auto` | Where `@bundled/yaar-ml` sessions run: `auto`, `chrome` or `local` |

**Source:** `packages/server/src/features/ml-host/relay.ts`, `packages/compiler/src/shims/yaar-ml.ts` ("Remote compute")

### Why it exists

On macOS the desktop is YAAR's own WKWebView window, and WebKit's WebGPU runs the same model
markedly slower than Chrome on the same GPU (anima's DiT step: 3.9 s vs 2.2 s;
[mac_ml.md](../installations/mac_ml.md)). A yaar-ml app in the window asks for its sessions to run
in the server's headless Chrome instead: same onnxruntime-web, same app code. Design:
[ml_runtime.md](../architecture/ml_runtime.md).

### What `auto` means

`auto` offloads when the server is on macOS **and** the page reports itself as WebKit. `chrome`
offloads every page (a benchmark, or a Linux box with a better server GPU). `local` turns the
feature off. A decline is silent and total (old server, no Chrome, a tab that does not come up —
the server waits 60 s, the page 90 s): the page computes itself.

### How it holds together

- **One tab per app page.** The shim's socket (`/api/ml-host/connect`, iframe token, `yaar-ml`
  bundle required) gets its own headless tab, which dies with it.
- **The tab is the app, not the host.** Served on the app origin with the app's own iframe token
  (forced onto every same-server URL it fetches), under a CSP no wider than an app's.
- **Weights are read by the tab, not sent to it.** An `externalData` URL or
  `weightRange(url, start, end)` is fetched by the tab. Bytes the app already holds are uploaded
  in 4 MB chunks, at most three in flight (Bun drops frames past 16 MB of unsent data).
- **Tensors cross as bytes, unless kept.** Outputs named in `run(…, { keep })` stay in the tab as
  handles and cross as an id when fed to the next run. Numbers in
  [mac_ml.md](../installations/mac_ml.md).

## Termux:API (Android)

| Variable | Default | Meaning |
|---|---|---|
| `YAAR_TERMUX_API` | on for Android when Termux:API answers | Use the phone's own notifications, clipboard and share sheet (`0` off) |

### Why it exists

The companion desktop keeps the *server's* reads answering while Android freezes the tab; this
keeps the *user* informed. While no person is looking at the session (`isUserWatching` — the
companion does not count), agent notifications, permission dialogs, questions and finished monitor
turns are mirrored into the Android notification shade. Tapping one opens the desktop, and coming
back takes them all down. A permission dialog has a deadline, and one nobody sees is a denial.

The same client serves the clipboard (the phone's real one, text only, so an empty text read still
asks the browser in case it holds an image; gated by `YAAR_CLIPBOARD_GRANT`) and
`invoke { action: "share" }` on a storage file, which opens Android's share sheet.

### Why "on" means "if it answers"

Termux:API is a separate app **and** a separate package; with the package installed and the app
missing, every `termux-*` command waits forever. So the server makes one call at startup
(`termux-battery-status`) and uses Termux:API only if it answers in time; every later call has its
own deadline. Without it, nothing changes.

The launcher (`scripts/dev/start-termux.sh`) separately takes a `termux-wake-lock` for as long as the server runs and is single-instance (`$TMPDIR/yaar-termux.pid`). Where it opens the desktop (installed app, Chrome, `YAAR_TERMUX_BROWSER=<package>`; empty means the default browser) is in [android.md](../installations/android.md#where-the-desktop-opens).

Setup and day-to-day use: [`docs/guides/termux.md`](../guides/termux.md).

**Source:** `packages/server/src/features/android/`, `packages/lib/src/termux/`

---

## Agent budgets

| Variable | Default | Meaning |
|---|---|---|
| `MONITOR_MAX_CONCURRENT` | `4` | Concurrent background monitor tasks |
| `MONITOR_MAX_ACTIONS_PER_MIN` | `60` | Monitor action rate limit |
| `MONITOR_MAX_OUTPUT_PER_MIN` | `100000` | Monitor output rate limit |
| `APP_AGENT_IDLE_MINUTES` | `60` | Idle minutes before an app agent is reclaimed (`0` disables) |

### `APP_AGENT_IDLE_MINUTES`

The backstop for an app left open and unused: closing an app's **last** window on a monitor already
retires its agent, but nothing else reclaimed slots against the process-global `MAX_AGENTS`.
Reaping ends the agent's provider session (memory goes with it) but leaves its sub-agents alone;
their owner is the (monitor, app) pair, so only a last-window close, monitor removal, or teardown
takes those.

The default is an hour because "idle" means the *user* is away, and on a phone that is every app
switch; a shorter window left a successor agent re-doing work that had already landed.

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

The headless sandbox Chrome launches against `storage/.browser/profile`, which **survives
shutdown**, so a site signed into in the sandbox stays signed in. `storage/.browser/sessions.json`
holds the records (id, page, bound window) that make revive possible. It is still a sandbox, not
your Chrome profile; only `getLocalBrowser()` touches that.

`YAAR_BROWSER_EPHEMERAL=1` uses a `mkdtemp` dir wiped on cleanup instead — for a sandbox that
should forget between runs, and for two YAAR instances sharing a checkout (Chrome holds a
singleton lock on a profile directory).

### `YAAR_BROWSER_IDLE_MINUTES`

The sweep closes a session's *socket*, not its record: the id keeps naming its page, and the next
window (or `invoke(…, { action: 'revive' })`) brings it back. A session with a live screencast
viewer is exempt.

### `YAAR_BROWSER_PROVIDER` is not a selector

`POST /api/browser` is always the headless sandbox (`getHeadlessBrowser()`). The user's real Chrome
is reached only through `yaar://session/browser` (`getLocalBrowser()`), which auto-attaches
whenever a debuggable Chrome is reachable. The variable is a **force-headless opt-out**:
`=headless` keeps the agent away from your real browser, and the session door uses the sandbox too.

`CHROME_DEBUG_PORT` is the port the user launched Chrome with via `--remote-debugging-port`.

---

## Test-runner only

### `YAAR_TEST_REMOTE`

`1` makes `scripts/test/env.ts` pin `REMOTE=1` for the whole process, which is how
`src/tests/remote/` gets a genuine remote-mode `IS_REMOTE` (it is a module-load constant, so
remote-gate assertions are vacuous in a local-mode process). The env script sets this itself when
the collected files live under `src/tests/remote/`, so a by-path run stays a remote-mode run.

**Source:** `scripts/test/env.ts`, `scripts/test/partitions.ts`
