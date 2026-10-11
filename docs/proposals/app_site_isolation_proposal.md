# Proposal: One Site per Installed App

**Status:** in progress. The server half is built behind `YAAR_PER_APP_ORIGIN=1` (off by default);
nothing uses it until the frontend half lands. What is left is §3 and §8. Claims not yet run are
marked **(verify)**.

**In one line:** serve each installed (`source:'user'`) app from its own `<appId>.localhost`
origin instead of the shared `127.0.0.1`, so that Chromium gives every app its own renderer
process — its own main thread — and no installed app can reach into another.

---

## 1. Why

### Every installed app shares one main thread

App-origin isolation (`http/origin-boundary.ts`, `loopback-alias` mode) puts the desktop on
`localhost` and **every** installed app on `127.0.0.1`. Chromium assigns processes by *site*
(scheme + registrable domain, port ignored), so all installed apps open on a desktop land in one
renderer process, and frames of one site in one process share one main thread.

Measured 2026-10-11 under `make claude-dev` (launched Chrome 154, Windows 11), with a 10 ms
`setInterval` drift monitor injected into the Music Maker frame over CDP while a song played:

| Scenario | Music Maker main-thread stall (max) |
|---|---|
| Playing, nothing else | 26 ms |
| Anima (WebGPU, installed) opened next to it | 32 ms |
| **800 ms busy loop run inside the Anima frame** | **897 ms** |
| 800 ms busy loop run inside the desktop page | 44 ms |

`SystemInfo.getProcessInfo` agreed: the busy loop in Anima charged the same renderer PID that hosts
Music Maker. One installed app's long task is a full stop for every other installed app.

That is what a user hears. Music Maker schedules notes with Tone.js at its default
`lookAhead: 0.1` from the frame's main thread, so any stall over ~100 ms drops or delays notes.
The audio graph renders on the audio thread and does not stall — the *scheduling* does.

### Installed apps can read each other

Same origin means same-origin access between sibling frames. From the Music Maker frame, with
Anima open:

```js
window.parent.frames[1].location.href   // full URL, including Anima's __yaar_token
window.parent.frames[1].document.title  // "Anima (WebGPU)"
```

Both reads succeeded (measured, same session). The parent is cross-origin, but `frames[i]` is
reachable through it, and the sibling is same-origin with the caller. So any installed app can take
any other installed app's iframe token and act as that app: call its endpoints and read its
storage. It can also script its DOM, and share or clobber its IndexedDB, Cache Storage and OPFS.
The boundary today protects the desktop from apps, not apps from each other.

### What this is not about

- **Bundled apps** (`source:'bundled'`, including the Browser app and Memo) stay same-origin with
  the desktop by design (`features/window/origin-marks.ts`) and are out of scope here (§7).
- **Background throttling** of the whole window (EcoQoS, renderer backgrounding) is a separate,
  smaller fix: WebView2 browser arguments in `configureWebView2`. It is worth doing on its own and
  does not replace this.

---

## 2. Proposal

Add a third boundary mode, **`loopback-subdomain`**, next to `loopback-alias` and `proxy-port`:

| | Desktop | Installed app `X` |
|---|---|---|
| `loopback-alias` (today) | `https://localhost:<port>` | `https://127.0.0.1:<port>` |
| `loopback-subdomain` (new) | `https://localhost:<port>` | `https://X.localhost:<port>` |

Why `*.localhost`:
- **Distinct sites.** `localhost` is not on the Public Suffix List, so Chromium takes the last label
  as the TLD and `X.localhost` as the registrable domain. Different apps are different sites, so
  they get different processes under the default site-per-process policy.
- **Loopback with no DNS setup.** Chromium resolves `*.localhost` to loopback itself, without the
  OS resolver (RFC 6761 §6.3), and treats it as a potentially trustworthy (secure-context) origin.
- **Stable across restarts.** The origin does not depend on the port, so per-app storage and
  permission grants survive a relaunch the way they do on `127.0.0.1` today.

The rejected alternatives and why are in §6. The short version: per-app *ports* are distinct
origins but the **same site**, so they fix the security half and not the performance half.

`loopback-alias` stays as the fallback for hosts where the subdomain cannot work (§4).

---

## 3. What is left

The server half (the `loopback-subdomain` mode in `http/origin-boundary.ts`, token↔host binding,
CORS, CSP, the DNS-label app-id rule) is built; its tests say what it holds. A `*.localhost` cert SAN
turned out unnecessary: every host trusts the TLS socket by SPKI pin, not by name.

### Server

| Where | Change |
|---|---|
| Marketplace (`MARKET_URL`, separate service) | Same DNS-label id rule, so an app that publishes there can be served here |
| `/health` (or the window-create payload) | Say which mode is in force, so the frontend knows to try per-app origins at all |
| `features/ml-host/relay.ts`, `features/live-encoder/encoder.ts` | Mint `127.0.0.1` URLs via `APP_ORIGIN_HOST`. Fine to leave there — server-side pages, not apps — but say so in the code |
| Optional hardening | With the flag **off**, a token-less request landing on some `foo.localhost` still reads as host. Treating `*.localhost` as app side in `loopback-alias` too is stricter and costs nothing, but changes the default mode |

### Frontend

`IframeRenderer.tsx` derives the app origin (the sibling-alias function at line ~148). It becomes
per-app: `appOriginFor(appId)`, plus the server-supplied `appOrigin` path in
`iframe-bridge/open-url.ts`. Previews (`preview--<project>`) need a label too: decide whether they
get a per-app origin or stay on the alias.

Smaller than first thought: inbound messages are routed by `event.source === iframe.contentWindow`
(`lib/iframeMessageRouter.ts`), not by origin, so there is no per-check `event.origin` sweep.
Outbound posts use `getIframeTargetOrigin` (`iframe-bridge/target.ts`), which already falls back to
`'*'` for a cross-origin frame. With the origin known per window, that `'*'` can become the exact
origin, so a frame that navigated away stops receiving app messages.

### Hosts

| Host | Change | Process isolation gained? |
|---|---|---|
| Launched Chrome (dev, Linux `--app`) | None: `--ignore-certificate-errors-spki-list` already trusts the key under any name | Yes |
| Windows WebView2 | `is_loopback_host` in `webview_extras_win.cc` accepts `*.localhost`. It gates the TLS pin, auto-granted permissions and external-link routing | Yes **(verify in the shipped WebView2)** |
| macOS WKWebView | `is_loopback_host` in `webview_extras.mm` accepts `*.localhost` | Security yes; process **(verify: WebKit site isolation)** |
| Android WebView | Same check in `HostBridge.java` / `MainActivity.java` | Security yes; process no (WebView does not run out-of-process iframes) |

The security half (no cross-app frame access, token bound to host) holds on every host, because it
comes from origins, not processes. The performance half is Chromium-desktop only: Chrome and
WebView2 — which covers the Windows release this started from.

## 4. Fallback

The server cannot know whether the client resolves `*.localhost`. Most clients do, but a WKWebView
that hands the name to the system resolver might not **(verify)**. So the frontend decides once per
load. It probes `https://probe.localhost:<port>/health` (CORS-readable, no token). On success it
uses per-app origins; otherwise it falls back to `127.0.0.1` for every app, i.e. today's behaviour.
The server accepts both, since a frame on `127.0.0.1` is still an app-origin request (built).

The fallback is a silent security downgrade — on `127.0.0.1` apps share an origin again and no
token is held to its app. Make the chosen mode visible (devtools, `/health`), and measure how often
it happens: Firefox and Safari on plain HTTP decide that more than Chromium does **(verify)**.

Remote mode (`proxy-port`) **keeps one shared app origin**. Tailscale Serve publishes HTTPS on only
443, 8443 and 10000 and MagicDNS gives no per-app subdomains, so there is nothing to split on. That
is a stated limit, not a regression — but state it as a trust model in `remote_mode.md`: over remote,
installed apps trust each other, since same-origin siblings can script each other outright.

`YAAR_APP_ORIGIN_ISOLATION=0` still turns the whole boundary off.

---

## 5. Costs

- **One renderer process per open installed app.** Each is roughly 30–80 MB **(verify: measure
  with 5 apps open, before and after)**. Bundled apps and AI-made windows are unaffected. For the
  apps people open side by side, that is the price of their not stalling each other.
- **Per-origin data does not migrate.** IndexedDB, Cache Storage, OPFS and permission grants on
  `127.0.0.1` are not visible from `X.localhost`. The cost is largest for apps that cache models
  locally (Anima, yaar-ml users): one re-download on first launch after the change. YAAR app state
  lives in server storage (`check:apps` forbids `localStorage`), so nothing authoritative is lost.
  The release note says so.
- **Two windows of the same app** share an origin and therefore a process. That is intended: it is
  one app.

---

## 6. Alternatives considered

| Option | Security (apps apart) | Performance (own main thread) | Why not |
|---|---|---|---|
| Per-app port on `127.0.0.1` | ✅ distinct origins | ❌ same site, same process | Fixes half; ports are unstable across restarts, so storage origins move |
| `Origin-Agent-Cluster: ?1` | ❌ | ❌ | Keyed per *origin*, and all apps share one origin |
| Sandbox without `allow-same-origin` (opaque origin) | ✅ | ❌ sandboxed frames are grouped per site **(verify)** | Breaks storage, blob URLs and cookies — the DC-comics class of bug `ISOLATED_APP_SANDBOX` documents |
| `--isolate-origins` / `--site-per-process` flags | — | — | Need distinct origins to act on; site-per-process is already the default |
| AudioWorklet sequencer in Music Maker | — | Audio only | Worth doing in the app regardless; fixes one symptom, not the shared thread |
| WebView2 anti-throttling flags | — | Whole-window only | Worth doing separately (§1); does nothing about apps stalling each other |

---

## 7. Out of scope, possible follow-up

**Heavy bundled apps.** The Browser app and devtools run on the desktop's own main thread. Moving
a bundled app to its own site is a bigger change, because bundled apps are trusted and may assume
same-origin access to the desktop. If wanted later, make it an explicit `app.json` opt-in
(`"process": "dedicated"`) for apps known to need no same-origin privileges, built on the same
`loopback-subdomain` mechanics.

---

## 8. Plan

| Phase | Work | Done when |
|---|---|---|
| 1. Frontend (doubles as the spike) | `appOriginFor(appId)`, exact `targetOrigin`, probe + fallback, mode on `/health` | In launched Chrome with the flag: the §1 busy-loop test shows the stall gone, and the `frames[1].location.href` read throws `SecurityError`; `frontend` tests per message path |
| 2. Hosts | WebView2 / WKWebView / Android loopback checks | The `webview_host_proposal.md` §1 checklist passes with two installed apps open; WebView2 process isolation and WKWebView resolution answered |
| 3. Ship | Flip the default; marketplace id rule; release note (one-time re-download of cached models); docs: `remote_mode.md` trust model, `origin-boundary.ts` header | — |

**Acceptance for the whole change:** the §1 table re-run, where the busy loop in Anima stalls Music
Maker by under 50 ms, and the §1 `frames[1].location.href` read throws `SecurityError`.
