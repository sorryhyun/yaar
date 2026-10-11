# Proposal: One Site per Installed App

**Status:** proposal. Nothing here is built. Claims not yet run are marked **(verify)**.

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

## 3. What changes

### Server

| Where | Change |
|---|---|
| `config/env.ts` | `appOriginHost(appId)` → `${appId}.localhost`. Keep `APP_ORIGIN_HOST` for the fallback mode. |
| `http/origin-boundary.ts` | New mode. `requestCarriesAppOrigin`: `Origin` hostname or `url.hostname` is `*.localhost` and not `localhost` itself. `desktopRedirectTarget`: any `*.localhost` document goes to `localhost`. New `appIdOfRequestOrigin(req, url)`. |
| `http/auth.ts` / `access.ts` | **Bind token to host.** A request on `X.localhost`, or carrying that `Origin`, must present a token minted for app `X`. Today a token is checked only for validity. With per-app hosts the server can also check *whose* it is, so a leaked token is useless from another app's origin. |
| `http/csp.ts` | `frame-src` / `connect-src`: `https://*.localhost:<port>` in place of the `127.0.0.1` entry. |
| `@yaar/lib/tls` `self-signed.ts` | SAN gains `DNS:*.localhost`. Reuse the existing key so the advertised SPKI pin does not change; regenerate the cert when the SAN set is stale. |
| `features/window/origin-marks.ts` | Unchanged rule (only `source:'user'` moves). In this mode it states the per-app origin. |
| `@yaar/lib/ssrf` `isLoopback` | **Do not** widen it to `*.localhost`. `isDesktopOrigin` treats every loopback hostname as the desktop, so a widened pattern would read an app origin as the desktop. Callers ask `requestCarriesAppOrigin` first already, but the pattern should stay narrow anyway. |

App IDs become DNS labels. Today's IDs fit (`[a-z0-9-]`, e.g. `thesingularity-reader`). The rule
must be enforced at install time: lowercase, ≤ 63 chars, no leading or trailing `-` **(verify the
current app-id validator)**.

### Frontend

`IframeRenderer.tsx` derives the app origin today (the sibling-alias function at line ~148). It
becomes per-app: `appOriginFor(appId)`. Every check that compares a frame's `event.origin` against
"the app origin" must compare against *that window's* origin, not one shared value:
`IframeRenderer`, `ContentRenderer`, `WindowFrame`, `iframe-bridge/open-url.ts`, `windowsSlice`.
This is the riskiest part of the change. A missed check either drops an app's messages (visible)
or accepts another app's (silent), so each one gets a test.

### Hosts

| Host | Change | Process isolation gained? |
|---|---|---|
| Launched Chrome (dev, Linux `--app`) | None: `--ignore-certificate-errors-spki-list` already trusts the key under any name | Yes |
| Windows WebView2 | `is_loopback_host` in `webview_extras_win.cc` accepts `*.localhost`. It gates the TLS pin, auto-granted permissions and external-link routing | Yes **(verify in the shipped WebView2)** |
| macOS WKWebView | The delegate's loopback check accepts `*.localhost` | Security yes; process **(verify: WebKit site isolation)** |
| Android WebView | Same check | Security yes; process no (WebView does not run out-of-process iframes) |

The security half (no cross-app frame access, token bound to host) holds on every host, because it
comes from origins, not processes. The performance half is Chromium-desktop only: Chrome and
WebView2 — which covers the Windows release this started from.

---

## 4. Fallback

The server cannot know whether the client resolves `*.localhost`. Most clients do, but a WKWebView
that hands the name to the system resolver might not **(verify)**. So the frontend decides once per
load. It probes `https://probe.localhost:<port>/health` (CORS-readable, no token). On success it
uses per-app origins; otherwise it falls back to `127.0.0.1` for every app, i.e. today's behaviour.
The server accepts both, since a frame on `127.0.0.1` is still an app-origin request.

Remote mode (`proxy-port`) **keeps one shared app origin**. Tailscale Serve publishes HTTPS on only
443, 8443 and 10000 and MagicDNS gives no per-app subdomains, so there is nothing to split on. That
is a stated limit, not a regression.

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
| 0. Spike | Hard-code one installed app onto `X.localhost` (server routing + frontend origin) behind a flag | The §1 busy-loop test shows the stall gone in launched Chrome **and** the shipped WebView2; cert and permission prompts behave; WKWebView resolution answered |
| 1. Server | New boundary mode, token↔host binding, CSP, cert SAN | `server` tests: an app origin without a token is refused; X's token used from Y's origin is refused; a desktop document on `*.localhost` is redirected |
| 2. Frontend | `appOriginFor(appId)`, per-window `event.origin` checks, probe + fallback | `frontend` tests per message path; the cross-frame read from §1 throws |
| 3. Hosts | WebView2 / WKWebView / Android loopback checks | The `webview_host_proposal.md` §1 checklist passes with two installed apps open |
| 4. Ship | Release note (one-time re-download of cached models), docs: `remote_mode.md`, `origin-boundary.ts` header | — |

**Acceptance for the whole change:** the §1 table re-run, where the busy loop in Anima stalls Music
Maker by under 50 ms, and the §1 `frames[1].location.href` read throws `SecurityError`.
