# Known Gaps

Security gaps that are understood, accepted for now, and **not** fully closed. Each entry says
what holds today, what does not, and what closing it would actually cost — so the next person to
touch the area doesn't rediscover it, and doesn't mistake the surrounding code's carefulness for
coverage it doesn't have.

This file exists because these descriptions previously lived only in a working plan document that
was overwritten and then deleted. A live gap needs a home that outlives the effort that found it.

---

## Unsandboxed app iframes: top-level navigation hijack

**Status:** open. **Severity:** moderate while origin isolation is on — redirect/phishing, *not*
data theft; escalates to full desktop DOM/memory theft when isolation is off (see the last
paragraph). **Sites:**
`packages/frontend/src/components/window/renderers/IframeRenderer.tsx` (the `sandbox` decision),
`packages/server/src/http/csp.ts` (the app CSP), `packages/server/src/http/access.ts`
(`resolvePrincipal`).

Local apps are served as trusted content and deliberately left **unsandboxed**. App-origin
isolation (on by default in local mode; installed apps served cross-origin from `127.0.0.1` while
the desktop is on `localhost`) makes an app's principal unforgeable *and*, because the app is now a
distinct browser origin, the same-origin policy already blocks it from reaching `window.parent`'s
DOM or JS memory — a sandbox is **not** what closes that, cross-origin does. (`document.domain`
can't bridge the two loopback hosts either.) The boundary's mechanics live in `access.ts` and are
locked by `packages/server/src/tests/app-origin-isolation.test.ts`; they are not a gap.

**What remains open is sandbox-class, not memory theft.** An unsandboxed *cross-origin* frame can
still **navigate the top window** — `window.top.location = 'https://phish.example'` — and open
popups. That is a full-tab redirect / phishing vector, not a read of the desktop's DOM or memory.

Crucially, this is **not** covered by YAAR's domain allowlist. The app CSP is `connect-src 'self'
blob: data:`, which forces `fetch`/`XHR`/`WebSocket` egress through the fetch proxy where the
allowlist applies — but a *navigation* is not a connection. No `navigate-to` / `form-action`
directive is set (and `navigate-to` isn't implemented in browsers anyway), so top-level navigation
and form submissions escape the allowlist entirely.

**Closing it** means applying an `<iframe sandbox>` to isolated apps — keeping them cross-origin
but dropping `allow-top-navigation` — and reworking the same-origin affordances the frontend still
relies on for non-isolated apps: runtime SDK-script injection for non-compiled iframes, same-origin
HTTP-error detection in `IframeRenderer`, and the token-appending helper for raw asset URLs. That
is frontend work with its own blast radius, which is why isolation was landed first and sandboxing
left as the next stage. **Acceptance:** an isolated app iframe cannot navigate or otherwise reach
the top-level desktop, and is confined to what its `app.json` declares.

**When isolation is off, this is no longer sandbox-class — it's full DOM/memory access.** With
`YAAR_APP_ORIGIN_ISOLATION=0`, or in remote mode (where the loopback-alias trick is meaningless),
apps are served same-origin again and a hostile app regains real `window.parent` reach into the
desktop. Isolation is on by default in local mode, and the bundled exe now defaults to local
(`REMOTE` decoupled from `IS_BUNDLED_EXE`), so a default install has it — but a user who turns
remote on trades it away, and there the only backstop is the remote token gating who can connect
at all.

Until then: **don't install apps you don't trust.**
