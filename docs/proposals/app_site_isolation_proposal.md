# Proposal: One Site per Installed App

**Status:** in progress, behind `YAAR_PER_APP_ORIGIN=1` (off by default). Server and frontend are
built and the acceptance test passes in Chrome (§8, phase 1). The native host checks are written
but unverified on their platforms, and the default is not flipped. What is left is §3. Claims not
yet run are marked **(verify)**.

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

Built: the `loopback-subdomain` mode (`http/origin-boundary.ts`, token↔host binding, CORS, CSP,
the DNS-label app-id rule); the `perAppOrigin` window mark (`features/window/origin-marks.ts`) and
`originBoundary` on `/health`; the frontend's once-per-load `probe.localhost` probe and
`appOriginFor(appId)` (`frontend/src/lib/appOrigin.ts`), with the frame held back until the probe
answers, since its `src` is its origin; posts to an isolated frame at its exact origin
(`data-yaar-origin`, `iframe-bridge/target.ts`); the `*.localhost` loopback checks in all three
native hosts. Their tests say what they hold. A `*.localhost` cert SAN turned out unnecessary:
every host trusts the TLS socket by SPKI pin, not by name. `ml-host` and `live-encoder` keep the
shared alias on purpose (server pages, not apps; said in the code). Devtools previews are not
isolated at all today (`resolveAppSource` is not `'user'` for `preview--*`), so they need no label.

### Still open

| What | Done when |
|---|---|
| Windows WebView2 | `webview_extras_win.cc` builds; two installed apps open with the flag; frames are separate processes (the §1 busy-loop test) |
| macOS WKWebView | `webview_extras.mm` builds; whether WebKit resolves `*.localhost` (the page probe falls back if not — `data-app-origins` on `<html>` says which) |
| Android WebView | Java compiles (checked). On a device: the probe answers, apps load; no process isolation expected |
| Marketplace (`MARKET_URL`, separate service) | Same DNS-label id rule, so an app that publishes there can be served here |
| Ship | Flip the default; release note (one-time re-download of cached models, §5); `origin-boundary.ts` header names `loopback-subdomain` as the local default |
| Optional hardening | With the flag **off**, a token-less request landing on some `foo.localhost` still reads as host. Moot once the default flips, unless `=0` stays supported |
| Fallback telemetry (§4) | The client's choice is visible (`data-app-origins`, a console warning) but not counted anywhere |

The trust model over remote (one shared app origin, so installed apps trust each other) is stated
in `docs/guides/remote_mode.md`.

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

| Phase | Work | Status |
|---|---|---|
| 1. Frontend (doubles as the spike) | `appOriginFor(appId)`, exact `targetOrigin`, probe + fallback, mode on `/health` | **Done.** Measured below |
| 2. Hosts | WebView2 / WKWebView / Android loopback checks | Code written; Android compiles; WebView2 and WKWebView not built or run (§3) |
| 3. Ship | Flip the default; marketplace id rule; release note; docs | Remote trust model documented; the rest open (§3) |

**Acceptance for the whole change:** the §1 table re-run, where the busy loop in Anima stalls Music
Maker by under 50 ms, and the §1 `frames[1].location.href` read throws `SecurityError`.

Measured 2026-10-11, headless Chrome 151 on Linux, `make claude-dev`-equivalent server, Music Maker
and Anima (and The Singularity Reader) opened from their desktop icons, the same 10 ms drift
monitor and 800 ms busy loop as §1 run over CDP:

| | Flag off (`loopback-alias`) | `YAAR_PER_APP_ORIGIN=1` |
|---|---|---|
| Frames served from | `https://127.0.0.1:8443` (all three) | `https://<appId>.localhost:8443`, one each |
| Music Maker stall during the Anima busy loop | **791 ms** | **0 ms** |
| Sibling `frames[i].location.href` from Music Maker | readable (Anima's URL) | `SecurityError` |
| App registers, `POST /api/verb` from the app origin | yes, 200 | yes, 200 |

Every app frame was an out-of-process iframe target in both runs (apps are cross-site to the
desktop either way); only with the flag did they stop sharing one process with each other. This is
Chromium-desktop only: the Windows release needs the same run in WebView2 (§3).
