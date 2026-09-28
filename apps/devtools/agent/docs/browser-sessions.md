---
name: browser-sessions
description: Read before an app logs in to a site, borrows cookies, solves captchas, or falls back to a real browser tab via @bundled/yaar-web.
audience: agent
---

## Browser-Backed Sessions (thesingularity-reader, dc-comics, github)

### The ladder: cheapest transport that works

1. **`httpFetch`, anonymous** — reading anything the site renders server-side.
2. **`httpFetch` carrying the browser's cookies** as a `Cookie:` header — authenticated
   calls without a tab (thesingularity-reader's comment post: ~250ms against 8–15s in a tab).
3. **A headless `@bundled/yaar-web` tab** — only when the site's own JS must build the
   request, and only as a fallback when step 2 failed *before sending anything*.
4. **A visible, live tab handed to the person** — `web.open(url, { visible: true, live:
   true })` — for login, OTP and captcha. Never automated.

If the site has token auth (github's OAuth device flow over `httpFetch`), skip the ladder:
no tab, no cookies, no captcha surface.

### The session is the browser's cookie jar

`yaar-web` tabs are not isolated from each other: they share one persisted Chrome profile,
so a login survives reloads and restarts, and a new `browserId` is not a clean session. thesingularity-reader stores **no** session file: `loadSession()`
reads the jar, HTTP calls borrow it, logout deletes the site's cookies. Only one function
may clear them, since clearing is logout for every tab at once. On mount, re-read the jar
and re-ask the site — nothing to resume. Store only a display name, never a password
(and scrub any legacy one). *Seen in:* `src/browser.ts`, `src/dc/session.ts`.

### Login state has an `unknown`

`signed-out`, `signing-in`, `signed-in`, `expired` — and **`unknown`**: a failed request,
a redirect stub, or a page with neither marker. Only a **positive** logged-out marker may
downgrade the session; absence never does, or a transient failure logs the user out.
Many sites render the same field empty-when-anonymous and filled-when-signed-in, so keep
present-but-empty distinct from absent. *Seen in:* `src/dc/status.ts`, `src/dc/markers.ts`.

```ts
if (isLoggedInPage(html)) return { status: 'logged_in' };
if (!isLoggedOutPage(html)) return { status: 'unknown' };   // not logged_out
return { status: 'logged_out' };
```

### The agent never holds credentials

The protocol has `login`, `cancelLogin`, `logout`, `checkSession` — and **no credential
parameter anywhere**, so an agent structurally cannot try. `login` opens the visible tab;
its description tells the caller to ask the user to finish there and then read the status
key. The UI panel keeps the failing step and URL so it can offer "open in browser".

### Write paths against a live site

- **Form tokens belong to the render that produced them.** Cache CSRF and honeypot tokens
  only from a page rendered *with* the session; an anonymous read's tokens poisoned every
  later submit. Honeypot field names can change per load — parse them fresh.
- **Know whether the write was sent.** A failure before the POST may retry on the fallback
  transport; at or after it (a timeout above all) the write may be live — refuse to retry
  and verify with a read-only re-fetch.
- **Trust the server's verdict, not DOM furniture.** A captcha element shipped in the
  anonymous form fired "solve the captcha" on every logged-out visit; check the site's own
  guest-form message first and believe `captcha` only when the response says so.
- **No test posts on a real site.** Build a `diagnose*` command that runs every step up to
  (never including) the write and returns the same evidence the real submit uses.
- **Headless tabs look like bots.** A site checking `navigator.webdriver` *and* a null
  WebGL context (true of every GPU-less headless tab) needs both answered, not one.

### `yaar-web` specifics

- Gated by `"bundles": ["yaar-web"]` alone; there is no `yaar://browser` permission
  namespace, so a `yaar://browser/` entry in `app.json` grants nothing.
- At most 5 tabs open at once — close what you are done with.
- **Never infer a browser fact from whether a call threw**: `web.evaluate` throws on a
  gone or mid-navigation tab, while `web.html`/`web.screenshot` resolve empty. Ask the page.
- The server revives idle-swept tabs and replays the URL after a crash, and never sweeps a
  tab someone is watching live.
- For acting inside the tab the user is *already* looking at (their own Chrome), the tool
  is the `browser-user` app with its per-origin consent, not a `yaar-web` tab.

### Testing

Only pure modules (parsers, markers) are testable offline — expose them for
`previewScript`, as thesingularity-reader's `globalThis.__readerTest` does. The login flow
needs the deployed app, a real desktop and a person.
