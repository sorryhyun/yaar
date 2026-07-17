# Known Gaps

Security gaps that are understood, accepted for now, and **not** fixed. Each entry says what
holds today, what does not, and what closing it would actually cost — so the next person to
touch the area doesn't rediscover it, and doesn't mistake the surrounding code's carefulness
for coverage it doesn't have.

This file exists because these descriptions previously lived only in a working plan document
that was overwritten and then deleted. A live gap needs a home that outlives the effort that
found it.

---

## App iframes share the desktop's origin, so a header-based principal is forgeable

**Status:** open. **Severity:** critical against hostile app code; nil against everything else.
**Sites:** `packages/server/src/http/access.ts` (`resolvePrincipal`),
`packages/frontend/src/components/renderers/IframeRenderer.tsx`.

Local apps are served same-origin and deliberately unsandboxed — *"For same-origin content
(local apps), don't sandbox - it's trusted."* The access chokepoint resolves a caller to a
`Principal` from its iframe token, but a malicious app has three ways around that, none of which
a token can fix:

- **Omit the token.** `resolvePrincipal` reads "no token" as `host`, because the desktop
  genuinely has no token. A same-origin `fetch()` from an iframe is byte-for-byte
  indistinguishable from the desktop's (`Sec-Fetch-Dest: empty`, `Sec-Fetch-Site: same-origin`
  for both).
- **Spoof `Referer`.** `fetch()`'s `referrer` option accepts any same-origin URL.
- **Reach `window.parent`.** Same-origin means full DOM and memory access to the desktop.

So the permission model binds network callers, cross-session reads, other-app reads *by an app
that plays by the rules*, and every accidental path — but not an app that sets out to escape.

**The fix is an origin boundary, not another header.** Serve app iframes from a distinct origin
(e.g. desktop on `localhost:PORT`, apps on `127.0.0.1:PORT` — same server, different origin by
the browser's rules), which makes `Origin` a browser-set, unspoofable principal. Then
`resolvePrincipal` can stop reading "no token" as "the desktop", because the desktop and an app
become distinguishable at the transport.

**Cost, and why it hasn't been done:** the frontend loses same-origin DOM reach into app
iframes. Script injection for non-compiled iframes and HTTP-error detection in `IframeRenderer`
must be reworked, CORS widened, and apps that build raw `/api/storage` URLs for `<img>` /
`<video>` need the token-appending helper. That is frontend work with its own blast radius,
which is why it was never folded into the access-chokepoint work that created the principal.

**Acceptance, when someone does close it:** an app iframe that omits its token, spoofs
`Referer`, or reaches for `window.parent` is still confined to what its `app.json` declares.
