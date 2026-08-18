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
