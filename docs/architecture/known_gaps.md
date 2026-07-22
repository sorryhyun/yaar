# Known Gaps

Security gaps that are understood, accepted for now, and **not** fully closed. Each entry says
what holds today, what does not, and what closing it would actually cost — so the next person to
touch the area doesn't rediscover it, and doesn't mistake the surrounding code's carefulness for
coverage it doesn't have.

This file exists because these descriptions previously lived only in a working plan document that
was overwritten and then deleted. A live gap needs a home that outlives the effort that found it.

---

## App iframes are unsandboxed, so a hostile app still reaches `window.parent`

**Status:** open. **Severity:** critical against hostile app code; nil against everything else.
**Sites:** `packages/frontend/src/components/window/renderers/IframeRenderer.tsx` (the `sandbox`
decision), `packages/server/src/http/access.ts` (`resolvePrincipal`).

Local apps are served as trusted content and deliberately unsandboxed — *"For same-origin content
(local apps), don't sandbox - it's trusted."* Historically this left a hostile app **three** ways
to act as the desktop, none of which a token could fix:

1. **Omit the token.** A same-origin `fetch()` from an app was byte-for-byte indistinguishable
   from the desktop's, so `resolvePrincipal` read "no token" as `host`.
2. **Spoof `Referer`.** `fetch()`'s `referrer` option accepts any same-origin URL.
3. **Reach `window.parent`.** Same-origin means full DOM and memory access to the desktop.

**Escapes #1 and #2 are closed by default** by the app-origin boundary (below). **#3 is what
remains:** the frame is still unsandboxed, so app code can still read and write the desktop's DOM
and JS memory directly through `window.parent`. The origin swap does not take that away — a
sandbox does. Closing it means applying an `<iframe sandbox>` to isolated apps (dropping
`allow-same-origin` so the frame gets an opaque origin with no parent reach) and reworking every
same-origin affordance the frontend currently relies on: runtime SDK-script injection for
non-compiled iframes, same-origin HTTP-error detection in `IframeRenderer`, and the token-appending
helper for raw asset URLs. That is frontend work with its own blast radius, which is why the boundary
was landed first and sandboxing left as the next stage.

**Acceptance, when someone does close it:** an app iframe that reaches for `window.parent` sees an
opaque cross-origin window it cannot touch, and is confined to what its `app.json` declares.

Until then: **don't install apps you don't trust.**

### The app-origin boundary — landed, enforcing, on by default (`YAAR_APP_ORIGIN_ISOLATION`)

The boundary that closed #1 and #2. Scoped to the population that carries the threat — installed
(`source:'user'`) apps — while bundled apps and AI-authored HTML stay same-origin (host-authored,
not hostile app code). **On by default in local mode**; set `YAAR_APP_ORIGIN_ISOLATION=0` to force
it off. It has no meaning behind a remote tunnel or in the bundled exe (both fold into `IS_REMOTE`),
so it is inert there.

- **The pin.** The desktop lives on `localhost`; installed apps are served from the `127.0.0.1`
  alias — the same socket, a distinct browser origin by the browser's rules. The assignment is
  fixed, not symmetric: `http/server.ts` redirects any top-level *document* that lands on
  `127.0.0.1` back to localhost (app iframe documents carry `Sec-Fetch-Dest: iframe` + a token and
  are left alone), and the frontend's `siblingLoopbackOrigin()` only serves an app onto `127.0.0.1`
  when the desktop is on `localhost`.
- **The plumbing.** An isolated app is handed the desktop origin as `__yaar_api`, so its injected
  SDK (`verb`/`storage`/`fetch-proxy`) calls the backend cross-origin with its token; CORS in
  `http/server.ts` allows the sibling origin. The `postMessage` app-protocol still relays — source
  is matched by `contentWindow` identity, never by `event.origin`.
- **The enforcement.** `resolvePrincipal` refuses a token-less request that carries the app origin,
  caught two unspoofable ways: a browser-set `Origin: http://127.0.0.1:PORT` on a cross-origin
  SDK-shaped `fetch` (escape #1), or the request *landing on* the `127.0.0.1` alias for a relative
  `fetch('/api/…')` that sends no `Origin` at all (escape #2). A well-behaved app is unaffected: its
  token — in the header cross-origin, or in the query on the app alias — resolves it as the app.
- **Safe for internal callers.** MCP bypasses `resolvePrincipal` entirely, and the only internal
  `127.0.0.1` fetches target Chrome's debug port, not YAAR's own routes.

The invariant is locked by `packages/server/src/tests/app-origin-isolation.test.ts`: both escapes
refused, the desktop still resolves as host, and a token still resolves as the app.
