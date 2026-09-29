# Browser Automation

YAAR drives Chrome itself. An agent can open a page, click through it, read it, and save what it
downloads. An app can put a live server-side tab in a window and let a human drive the same tab.
The server also uses that Chrome for its own work: a companion desktop that keeps answering while
the user's phone is asleep, and WebGPU inference that WebKit is too slow for.

This doc explains how that is built. It covers where Chrome comes from, the two doors into it and
who may use each, and why a browser session behaves like a process rather than a request handler.
It ends with the other subsystems that share the same machinery. Env var semantics are in the
[Browser section of `server_env.md`](../reference/server_env.md#browser). URI tables are in the
[URI & Verb Reference](../reference/uri_reference.md).

All paths are relative to `packages/server/src/` unless noted.

---

## Layering

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ URI + HTTP surface                                                           │
│   POST /api/browser, /api/browser/{id}/{events,screenshot,screencast}        │
│       → yaar-web bundle, always the sandbox        (http/routes/browser.ts)  │
│   yaar://session/browser  → session principal, the user's Chrome             │
│                                        (handlers/session.ts → features/session/browser.ts)
│   yaar://system/browsers[/{id}] → roster, revive, kill   (handlers/system.ts)│
├──────────────────────────────────────────────────────────────────────────────┤
│ Domain actions                                    features/browser/          │
│   BROWSER_ACTION_TABLE (every action + its `mutates` flag)   actions.ts      │
│   self-target + tab-control consent guards                   guards.ts       │
│   download → storage commons, window creation, domain allowlist              │
├──────────────────────────────────────────────────────────────────────────────┤
│ CDP subsystem                                     lib/browser/               │
│   BrowserProvider ── CdpBrowserProvider ─┬─ HeadlessServerBrowser (pool.ts)  │
│                                          └─ LocalUserBrowser                 │
│   BrowserSession (one tab) ── DownloadCapture, NetworkLog, page-scripts      │
│   BrowserSessionStore (records on disk)   chrome.ts / pid-file.ts (process)  │
│   CDPClient (JSON-RPC over `ws`)                                             │
└──────────────────────────────────────────────────────────────────────────────┘
```

Each layer has one job. `lib/browser/` knows CDP, Chrome, tabs and processes. It knows nothing
about agents, windows or storage. It stays in the server rather than moving to `@yaar/lib` because
it reads `config.js` for the debug port, the profile directory and the idle sweep. That makes it a
YAAR subsystem that speaks CDP, not a CDP library.

`features/browser/` turns tab operations into YAAR actions. It opens a Browser-app window for a new
tab, asks the domain allowlist before navigating, applies the consent guards, and moves a download
into storage. The handlers and routes then decide which provider a caller gets. That choice is the
security boundary, so it is made at the edge and nowhere else.

---

## Why raw CDP

`lib/browser/` has no automation library. `cdp.ts` is about 200 lines of JSON-RPC over the `ws`
package. `chrome.ts` finds and launches the system's Chrome or Edge. The code gives its reasons in
its own headers:

- **No new dependencies.** "No external dependencies beyond the `ws` package already in the
  project" (`cdp.ts`).
- **No bundled browser.** It uses the Chrome or Edge already installed, so "works anywhere Chrome
  is installed (including Windows .exe builds)" (`chrome.ts`, `pool.ts`).

The code states no further reasons. (Playwright and Puppeteer do appear in
[`headless_driving.md`](../guides/headless_driving.md), but only as clients driving YAAR from
outside, which is the opposite direction.)

In practice, much of the subsystem relies on CDP behavior that a wrapper library would hide:

- a crash is a socket that closes without being asked to
- download behavior is scoped to one connection
- the clipboard grant lives only as long as the connection that made it
- emulation overrides are dropped when their client disconnects

The modules below are written around those facts.

---

## Finding and launching Chrome

**Discovery** (`findChrome`) checks, in order:

1. `CHROME_PATH`
2. a platform list of known install paths, including Edge, and on Linux the WSL paths into
   `/mnt/c/Program Files`
3. `which` for `google-chrome`, `chromium-browser` and `chromium`

`probeBrowserAvailability()` runs once at MCP init and caches the answer for `isBrowserAvailable()`.
Nothing is launched at startup.

**Launch** (`launchChrome`) is lazy. The sandbox provider starts Chrome on the first
`createSession`, and callers that arrive during the launch join the same launch
(`HeadlessServerBrowser.getChrome`). Chrome runs `--headless=new` with a remote-debugging port.
A few flags are worth knowing about:

| Flag(s) | Why |
|---|---|
| `--user-data-dir=storage/.browser/profile` | The persisted sandbox profile (see [Sessions](#sessions-are-processes)); a `mkdtemp` dir under `YAAR_BROWSER_EPHEMERAL=1` |
| `--proxy-server=… --disable-quic` | Only when the `YAAR_FREEDPI` proxy is up. QUIC is UDP and would bypass it |
| `LINUX_WEBGPU_FLAGS_HEADLESS` | Linux only: WebGPU is off by default there, and `yaar-ml` needs it (`webgpu-flags.ts`) |
| `--browser-subprocess-path=…` | Android/Termux only. Without it, Chromium's children cannot re-exec `/proc/self/exe` (`androidSubprocessArgs`) |
| `--disable-print-preview`, `--window-position=-2400,-2400` | Keep a forwarded ⌘P, or an elevated Windows relaunch, from freezing the screencast or showing a blank frame |

On most platforms the DevTools URL is read from Chrome's stderr. On Windows, Chrome can fork and
exit its parent without printing that URL. The launcher therefore picks a fixed free port there and
falls back to polling `/json/version`.

**Cleanup.** `pid-file.ts` records `{pid, userDataDir}` at a fixed path, `tmpdir()/yaar-browser.pid`.
Before each launch, `cleanupStaleChrome` does three things:

- It kills an orphan from a crashed run, but only if that PID's command line still names the
  recorded `--user-data-dir`. PIDs get recycled, so the check keeps it from killing an unrelated
  process.
- It removes leftover `yaar-browser-*` temp dirs.
- It deletes the PID file.

That ordering matters now that the profile persists: an orphan still holds the profile's singleton
lock, and a new Chrome would not start until the lock is released. On shutdown, `cleanupChrome`
sends `Browser.close` over CDP, then kills the process. It deletes the profile only if it was a
scratch one.

The Chrome process is not permanent. When the last live sandbox session goes, whether closed or
idle-swept, the provider releases the whole process (`closeEndpoint` → `releaseProcess`). The next
`createSession` launches it again.

---

## Two doors

There are two `BrowserProvider` instances, and each is reachable from exactly one entry point
(`pool.ts`):

| | Sandbox door | User's-Chrome door |
|---|---|---|
| Provider | `HeadlessServerBrowser` via `getHeadlessBrowser()` | `LocalUserBrowser` via `getLocalBrowser()` |
| Chrome | Private headless Chrome the server launches and owns | The user's running Chrome on `CHROME_DEBUG_PORT` (default 9222), attached to and never launched or killed |
| Identity | A sandbox profile with no link to the user. Logins made in it persist in it | The user's cookies, logins and tabs |
| Reached by | Apps through `POST /api/browser` and its SSE, screenshot and screencast routes, gated on the `yaar-web` bundle. Also `yaar://system/browsers`, the companion tab and the ML host | **Only** `yaar://session/browser`, which is session-principal: the session agent and bundled system apps |
| `controlsUserBrowser` | `false` | `true` |

**The boundary is identity, not environment.** An app or a lower-tier agent does not get a
restricted view of the user's browser. It gets a *different instance*, so there is no path from the
sandbox door to the real Chrome.

Two consequences:

- **The sandbox door never falls back to the user's Chrome.** `POST /api/browser` always uses the
  sandbox.
- **The session door never falls back silently to the sandbox.** If no debuggable Chrome is
  reachable, `yaar://session/browser` returns an error. Quietly using the sandbox would mean acting
  under the wrong identity (`features/session/browser.ts`).

The only opt-out is `YAAR_BROWSER_PROVIDER=headless`, which points the session door at the sandbox
as well. Nothing ever works the other way round.

Both doors run the **same action layer**. `BROWSER_ACTION_TABLE` in `features/browser/actions.ts`
lists every action (`open`, `click`, `evaluate`, `download`, `get_network_log`, …) with a `mutates`
flag, and three things read that one table:

- the dispatcher
- the guards
- `yaar://session/browser`'s advertised enum

An action therefore cannot run without being classified. Around a mutating action, the guards
(`guards.ts`) add three things:

- **Self-target refusal.** Raw-DOM mutation of YAAR's own tab is refused. YAAR's UI is changed
  through OS Actions, not CDP. Reading it is allowed. The session door passes `allowSelfTarget`
  because the session agent is the user's deputy.
- **Tab-control consent.** This applies only when `controlsUserBrowser` is set. Mutating a real,
  logged-in tab requires a per-origin grant. It reuses the `curl_allowed_domains.yaml` allowlist and
  the same permission dialog.
- **A "driving" flag** on the session while the action runs. The Browser app shows it as the "agent
  is driving" indicator.

Separately, `open` asks the domain allowlist before navigating on *either* door.

### The third path: the YAAR Bridge (not CDP)

The Real Browser app (`apps/browser-user`) reaches the user's everyday browser through a different
mechanism: the YAAR Bridge extension. The extension dials `/bridge`, `BridgeHub` keeps its tab list
in memory, and `POST /api/bridge` dispatches actions (`features/browser/bridge.ts`,
`bridge-actions.ts`). It is **not** a `BrowserProvider` and uses none of `lib/browser/`. It deals in
tab metadata and a correlated command socket, with its own two consent grants: tab control and
`browser_content_read`.

It connects to the event system in one place. Bridge frames come in on the `bridge-event` channel.
That is the only process-global channel `session/session-event-router.ts` allows, because there is
one real browser and its socket belongs to no session. `AppWindowCoordinator` delivers those frames
to Real Browser windows. On purpose, there is no `yaar://browser` verb namespace. Control of the
real browser through the bridge always goes through a visible app window.

---

## Sessions are processes

A `BrowserSession` (`session.ts`) is one Chrome tab behind one CDP socket. A CDP socket is the most
fragile thing in the subsystem: renderers crash, `--watch` restarts the server, the desktop reloads.
The design keeps a session's *identity* separate from whichever socket is serving it at the moment.
In the code's words, sessions "behave like processes rather than request handlers."

### What a session is made of

- **A name.** `browserId` is caller-chosen (`'inbox'`, `'companion-desktop'`) or auto-numbered. It
  must match `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`, because it travels in URLs (`?browserId=`),
  filenames and `yaar://system/browsers/{id}`.
- **A socket, set up the same way every time.** `initTarget` runs for a new tab and again for every
  reattach. It:
  - enables `Page`, `Runtime` and `Network`, and never disables Network, because the blocklist and
    the network log depend on it
  - auto-dismisses JS dialogs, which would otherwise block every CDP command
  - intercepts the native file chooser, which would stall the browser UI thread
  - re-applies the shield (the provider-wide init script and URL blocklist)
  - arms download capture
  - watches for `Inspector.targetCrashed` and for an unexpected socket close
  - applies desktop (1280×800) or mobile (390×844 @3x, touch, mobile UA) emulation, unless the tab
    was *adopted*, in which case it is left exactly as it was
- **A record in memory.** `CdpBrowserProvider.records` holds, per browserId, the live session (if
  any), its current Chrome target, a crash-restart count, and any revive in progress. The record can
  exist with no socket, and only `drop()` takes it apart.
- **A record on disk.** `BrowserSessionStore` (`session-store.ts`) writes `{id, url, title, mobile,
  windowId}` to `storage/.browser/sessions.json`. Writes are debounced (500 ms), and records expire
  after 14 days without an update. Every failure is swallowed: losing the file costs a revive, never
  a running session.
- **A profile that outlives the process.** `storage/.browser/profile` survives shutdown, so a
  revived page is still logged in. Without it, a revive would be a new tab with extra steps.

### States and transitions

`listSessionInfo()` reports each session as `live`, `suspended`, or `crashed`:

| State | Meaning | How it gets there |
|---|---|---|
| `live` | A socket is attached | `createSession`, adoption, a successful revive or crash-restart |
| `suspended` | A disk record exists, but no socket | Idle sweep, desktop reload, server restart |
| `crashed` | The tab died and nothing has revived it yet | Renderer crash or unexpected socket close, with the restart pending or failed |

**Two ways to end a session:**

- **`closeSession(id)`** is a decision: the user shut the window, or the agent closed the tab.
  `drop({forgetRecord: true})` removes the in-memory record *and* the disk record, so the id no
  longer revives.
- **The idle sweep and `shutdown()`** only drop the socket (`forgetRecord: false`). The record
  stays, and the id comes back the next time something asks for it.

**The idle sweep** (`cleanupIdle`) runs every minute. It collects sessions untouched for longer than
`YAAR_BROWSER_IDLE_MINUTES` (default 5, `0` disables it) and skips two kinds:

- **Watched sessions** (`screencasting`). Someone reading a long page is not idle.
- **`pinned` sessions.** These are tabs whose job is to sit unused until needed: the companion
  desktop and ML host tabs.

**Revive** (`reviveSession`) opens a fresh tab under the same id, restores `mobile` and `windowId`,
and re-navigates to the recorded http(s) URL. Concurrent callers join one attempt. Four places
treat a browserId as a promise to keep and revive rather than returning 404:

- the Browser app's SSE stream (`/api/browser/{id}/events`)
- the screencast socket
- `invoke('yaar://system/browsers/{id}', {action: 'revive'})`
- the companion watchdog

**Crash-restart** (`restartCrashed`) handles the case where the tab dies without being asked to.
The provider opens a new target and calls `session.reattach(url, currentUrl)`. The *same*
`BrowserSession` object gets the new socket. That matters because the SSE stream, the screencast
viewers and the window binding all hold a reference to this object, not to a socket. Reattach
restores the viewport and restarts the screencast for viewers that never detached. Restarts are
bounded: after three attempts without a success, the session is closed and the window is left
showing the failure. A page that crashes Chrome on load would otherwise be revived forever. This handles a renderer death while the Chrome endpoint is still reachable. It does not
watch the Chrome *process*: after launch, nothing listens for its exit.

### What only the owning provider does

Persistence, crash-restart and the idle sweep are all conditioned on `ownsChrome`, which only
`HeadlessServerBrowser` sets. `LocalUserBrowser` tabs are never recorded, swept or restarted. They
belong to the user.

The same applies to **adopted** tabs, meaning tabs YAAR did not open. Two kinds get adopted:

- a popup a page opened (`Target.targetCreated` with an opener)
- a tab that was already open when `syncExistingTabs` ran, which the session door does before
  `list_tabs` so the list shows the user's real tabs

Adopted records are `ephemeral` and attached passively: no navigation, no emulation. They are never
written to disk, since recreating someone else's tabs after a restart would be wrong. They are
dropped when their target closes.

---

## The pool

`CdpBrowserProvider` (`cdp-provider.ts`) contains everything the two providers share. Subclasses
supply only five things:

- where the endpoint comes from (`ensureChromePort`)
- a port that is reachable without launching Chrome (`reachableChromePort`)
- whether the process is theirs (`ownsChrome`)
- how to release it (`releaseProcess`)
- liveness and availability

- **One Chrome, many tabs.** Tabs are opened through Chrome's HTTP debugging API (`PUT /json/new`,
  with a `GET` fallback for older Chrome). Each tab has its own CDP socket. One extra browser-level
  socket runs `Target.setDiscoverTargets`, which catches popups and closed tabs.
- **One profile.** All sandbox tabs share `storage/.browser/profile`. The code creates no separate
  browser contexts, so sandbox sessions share one cookie jar. They are separate tabs, not separate
  identities.
- **A hard cap.** `MAX_SESSIONS = 5` live sessions per provider, counting sessions still being
  created. Pinned internal tabs use slots too: the companion desktop and each ML host channel. The
  cap also bounds how many revives and adoptions can happen at once.
- **Tab events.** `onTabEvent` pushes `opened` and `closed` events, and the opener is named by
  Chrome's `openerId` rather than guessed. `consumeAdoptedTabs` is the pull half. It tells an
  agent's next `click` that a new tab appeared (`PageState.newTab`). A listener never consumes, so
  both halves see every popup.
- **Shield.** `setShield` holds one init script and one `Network.setBlockedURLs` list for every tab
  in the provider, including popups the provider adopts later. Otherwise the tab an ad opened would
  be unprotected.

---

## Downloads

Downloads are the **tab's**, captured on the server. `DownloadCapture` (`downloads.ts`) points
`Browser.setDownloadBehavior` at a per-session temp dir (`yaar-browser-dl-*`). It falls back to
`Page.setDownloadBehavior`, and if Chrome refuses both, it sets `downloadsAvailable = false` and
does not throw. This has two consequences a re-fetch through `yaar://http` could not match:

- the transfer carries the tab's cookies, headers and TLS session
- the bytes never pass through CDP or an app, so size is limited by disk space rather than a proxy
  cap

**The capture directory is the source of truth, not the CDP event.** With `behavior: 'allow'`,
Chrome chooses the filename from `Content-Disposition`, not the download GUID. Also, whether
browser-domain events arrive on a page socket is an implementation detail, not something the
protocol guarantees. So completion is detected from the filesystem: a file that is no longer named
`*.crdownload` has finished. The code uses `fs.watch` plus a sweep. `downloadWillBegin` events only
add the source URL when they arrive. Unclaimed captures are kept (up to 20) until claimed, and are
deleted with the directory when the session closes, including when the idle sweep closes it.

Two ways to start a download (the `download` action in `features/browser/actions.ts`):

- **`{ id }`** claims something Chrome downloaded on its own, such as the page's own button or an
  attachment navigation. The session's SSE stream announces these as they complete.
- **`{ url }`** (default: the current page) makes the *page* fetch the URL (blob plus
  `<a download>`, falling back to a plain link click when CORS refuses the fetch). It then waits for
  the capture.

Either way, `storeCapture` streams the file into `storage/shared/browser/downloads/`. That is the
one commons directory every app can read. The name goes through `safeDownloadName`, which
neutralizes path separators and renames `.html`/`.svg` to inert `.txt`. `download` is classed as
mutating: it is `evaluate` plus a filesystem write, and on the user's Chrome it spends the user's
own credentials.

---

## Network log

`NetworkLog` (`network-log.ts`) keeps the last 500 requests per tab. Each entry joins
`Network.requestWillBeSent`, `responseReceived`, and `loadingFinished`/`loadingFailed` on
`requestId`. The events were already arriving for the shield's blocked-request counter, so the log
costs no extra CDP. It records **metadata only**: URL, method, resource type, status, MIME type,
size, duration, redirect target, and blocked/failed status. It records no headers and no bodies. A
header is more often a secret than a diagnostic, and a body can be re-fetched through
`yaar://http`.

The log belongs to the tab, not the socket, so it survives navigation and reattach. Queries
(`get_network_log`) filter by URL pattern, resource type, or failures only. They page with
`afterSeq`, return at most 200 entries, and truncate URLs to 300 characters by default, because the
reader is usually a model.

---

## Page scripts

`page-scripts.ts` holds every JavaScript snippet the session runs inside the page through
`Runtime.evaluate`, as plain strings. Keeping them separate lets `session.ts` stay about CDP
orchestration. The snippets fall into five groups:

- **State:** `PAGE_STATE`, `VIEWPORT_TEXT`, `VIEWPORT_LINKS`
- **Targeting:** `FIND_BY_SELECTOR`, `FIND_BY_TEXT`, `ELEMENT_AT_POINT`
- **Input:** `FOCUS_AND_CLEAR`, `SET_VALUE`, `FIRE_CHANGE_EVENTS`
- **Extraction:** `EXTRACT_CONTENT`, `EXTRACT_IMAGES`, `FIND_MAIN_CONTENT`, `ANNOTATE_ELEMENTS`
- **Live-mode support:** `CARET_RECT`

`SETTLE` is the one to know about. Each interaction used to sleep for a fixed time. Now each waits
until the DOM has been quiet for 100 ms, and the old sleep is kept as the upper bound (`SETTLE_CAP`
in `session.ts`). An interaction on a page that settles quickly returns early, and the worst case is
the same as before.

---

## Live mode: the Browser app's window

The Browser app (`apps/browser`) renders a sandbox session in a window. Opening a visible tab goes
through the window verb (`features/window/create.ts`), because that verb is the one place an iframe
token is minted. The window's content is `yaar://apps/browser?browserId=…`. From there the app uses
three channels, all gated on `yaar-web`:

- **`GET /api/browser/{id}/events`**: an SSE stream of URL, title, `version` and `driving`, plus
  `download` and `popup` frames. A popup is announced on its *opener's* stream, because that is the
  window the user is looking at.
- **`GET /api/browser/{id}/screenshot`**: the cached WebP.
- **`/api/browser/{id}/screencast`**: a WebSocket (`websocket/screencast-handlers.ts`). CDP
  `Page.screencastFrame` JPEGs go down and raw pointer and key events come up. Both go into the
  *same* CDP session the agent drives, because co-driving one tab is the point. Frames are dropped
  above 256 KB of unsent data, so a slow link loses frame rate instead of falling behind in time.

---

## Listing and killing: `yaar://system/browsers`

`handlers/system.ts` presents sandbox sessions as processes:

| URI | Verb | Access | Effect |
|---|---|---|---|
| `yaar://system/browsers` | `list` / `read` | Open (an app declares the permission) | `{chromeRunning, maxSessions, liveSessions, sessions[]}`. Each entry has id, url, title, `state`, `driving`, `viewers`, `idleMs`, and `jsHeapBytes` (a weight proxy, not an accounting) |
| `yaar://system/browsers/{id}` | `read` | session-principal | One session's info |
| | `invoke {action:'revive'}` | session-principal | `reviveSession(id)` |
| | `delete` | session-principal | Closes the bound window first, then `closeSession(id)`, which also forgets the record |

Only the sandbox door is listed. Killing a session in the user's Chrome would mean closing a tab
they opened themselves. Suspended records are included, so a swept tab appears as *revivable*
rather than absent. Process Explorer is the reference consumer. Its manifest declares
`yaar://system/browsers/`.

---

## Other consumers of the same machinery

**Companion tab** (`features/companion/companion-tab.ts`, `YAAR_COMPANION_TAB`). This parks a
second, always-visible YAAR desktop in the *sandbox* Chrome under the fixed id `companion-desktop`,
at `?ui=desktop&companion=1`. When the user's own client is backgrounded (a phone switching apps),
round trips into the page such as `__screenshot` still have a live page to answer from. The tab is
`pinned` so the idle sweep leaves it alone. Every 60 s, a watchdog revives or re-creates it and
steers it back if it has navigated away from YAAR's origin. It is on by default only on Android,
where `androidSubprocessArgs` is also what lets Chromium start at all.

**Remote ML compute** (`features/ml-host/relay.ts`, `YAAR_ML_COMPUTE`). For each `yaar-ml` app
socket that should offload (by default, a macOS server with a WebKit page), this opens one pinned
sandbox tab, `ml-host-<id>`, on `/api/ml-host/page` and relays binary frames between the app and
that tab without reading them. One tab per socket ties GPU memory to the app's lifetime. If the tab
reloads, for example after a crash-restart replay, that is treated as the end of the channel, since
the model sessions died with the old page. On Linux, the WebGPU launch flags are what give this tab
a GPU adapter. The runtime side is covered in [`ml_runtime.md`](./ml_runtime.md).

**The dev Chrome** (`LAUNCH_CHROME=1`, `scripts/dev/start.sh`). `make claude` and `make claude-dev`
start a *visible* debuggable Chrome with its own profile (`~/.yaar-chrome`, or
`~/.yaar-chrome-mobile` under `MOBILE=1`). Chrome refuses remote debugging on the default profile.
This Chrome is what `LocalUserBrowser` finds on port 9222 in development, so in dev the "user's
Chrome" behind the session door is this dedicated profile. Two other things attach to it over their
own CDP connections, and neither disturbs the other:

- `lib/browser/clipboard-grant.ts` keeps a browser-level socket open for the life of the server,
  because a `Browser.grantPermissions` clipboard grant lasts only as long as that connection.
- `scripts/dev/emulate-mobile.ts` turns mouse drags into touch events.

The launcher reaps its own orphans the same way `pid-file.ts` does for the sandbox. It also keeps a
bash copy of `LINUX_WEBGPU_FLAGS`, since it cannot import `webgpu-flags.ts`. The bundled exe's
`--app` launcher (`exe-entry.ts`) imports the flags directly.

---

## Key files

| Concern | File |
|---|---|
| CDP JSON-RPC client, `/json/version` probe | `lib/browser/cdp.ts` |
| Chrome discovery, launch flags, cleanup | `lib/browser/chrome.ts` |
| Orphan reaping, PID file | `lib/browser/pid-file.ts` |
| Linux WebGPU flag sets | `lib/browser/webgpu-flags.ts` |
| Provider contract, `BrowserSessionInfo` | `lib/browser/types.ts` |
| Shared provider plumbing: records, revive, crash-restart, idle sweep, adoption, cap | `lib/browser/cdp-provider.ts` |
| Sandbox provider + the two-door getters, force-headless | `lib/browser/pool.ts` |
| User's-Chrome provider | `lib/browser/local-user-browser.ts` |
| One tab: init, actions, reattach, screencast, input | `lib/browser/session.ts` |
| Persisted session records | `lib/browser/session-store.ts` |
| Download capture | `lib/browser/downloads.ts` |
| Per-tab network log | `lib/browser/network-log.ts` |
| In-page scripts | `lib/browser/page-scripts.ts` |
| Clipboard pre-grant in the dev Chrome | `lib/browser/clipboard-grant.ts` |
| Profile dir, idle minutes, debug port | `config/browser.ts` |
| Action table, window creation, downloads → storage | `features/browser/actions.ts` |
| Self-target + consent guards | `features/browser/guards.ts` |
| Session resolution, page-state formatting | `features/browser/shared.ts` |
| Startup availability probe | `features/browser/availability.ts` |
| YAAR Bridge (not CDP) | `features/browser/bridge.ts`, `features/browser/bridge-actions.ts`, `http/routes/bridge.ts`, `websocket/bridge-handlers.ts` |
| Sandbox HTTP door, SSE, screenshot | `http/routes/browser.ts` |
| Screencast socket | `websocket/screencast-handlers.ts` (upgrade in `http/server.ts`) |
| User's-Chrome door | `handlers/session.ts`, `features/session/browser.ts` |
| Roster / revive / kill | `handlers/system.ts` (`registerBrowserHandlers`) |
| Companion desktop | `features/companion/companion-tab.ts` |
| Remote ML compute | `features/ml-host/relay.ts` |
| Shutdown of both providers | `lifecycle.ts` |
| App SDK over the sandbox door | `packages/compiler/src/shims/yaar-web.ts` |
| Dev Chrome launch | `scripts/dev/start.sh` (repo root) |
