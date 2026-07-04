# Proposal: The Browser as Substrate — Inverting YAAR's Web Access

This proposal addresses a structural absurdity in YAAR's web access: **the user reaches the
internet through a second-hand, server-side browser that is rendered as a screenshot inside the
real browser they are already using.** It proposes inverting the relationship — treating the
user's own browser as the OS substrate and making YAAR an agentic window-manager *over real tabs*
— and shows that this same inversion dissolves the self-reference / use-mention problem that
otherwise forces awkward self-origin guards.

> This is a separate document from [`proposal.md`](./proposal.md) (session observability, caching,
> context dedup). The two are orthogonal.

---

## Current State: Three Browser-Roles, Muddled

YAAR today conflates three distinct roles of "the browser":

| Role | What plays it today | Addressed how |
|------|--------------------|----------------|
| **Substrate** — where YAAR renders | the user's real browser | (implicit) |
| **Tool** — what the agent drives | a server-side headless Chrome pool (`lib/browser/`) | `browserId` + CDP |
| **Content surface** — how the user sees the web | a screenshot/canvas inside the Browser app | `capture: canvas` |

**The plumbing today:**

- `@bundled/yaar-web` (compiler shim) → `POST /api/browser` (`http/routes/browser.ts`)
- → `BrowserPool` / `BrowserSession` (`lib/browser/pool.ts`, `session.ts`) drive a **separate
  server-side Chrome** over CDP (`lib/browser/cdp.ts`, `chrome.ts`).
- The **Browser app** (`apps/browser`, `capture: "canvas"`, `"description": "Second-hand browser
  tool for rendering server-side browser."`) renders the *result* of that server-side browser back
  into a YAAR window.

### Why it is built this way

The **agent runs server-side.** It cannot reach into the user's browser tab — cross-origin iframe
sandboxing and the same-origin policy forbid it from scripting third-party sites. So to give the
*agent* programmatic control (`click`, `extract`, `evaluate`), YAAR puts a browser where the agent
lives: on the server. **The server-side browser exists to serve the agent's need for control, not
the user's need to browse.** The screenshotted, logged-out Browser app the user sees is collateral.

### The symptom

> Why does a user look at a *nested* browser to reach the internet they are already on?

They shouldn't. The user is sitting in a real, fully-capable browser — with their cookies, logins,
extensions, and sessions — and YAAR ignores it to simulate a worse one. Concretely, this causes:

- **Re-auth everywhere.** The headless browser knows none of the user's logins; every site is a
  fresh, logged-out session.
- **Lossy rendering.** The user sees a screenshot/canvas, not a live page. Interactivity is
  mediated and degraded.
- **Wasted resources.** A whole second Chrome process and pool, purely to host the agent's grip.
- **The self-reference foot-gun.** Because the *substrate* (a browser) and a *tool* (a browser
  driver) are the same kind of object, the agent can drive YAAR by accident — e.g.
  `navigate({ url: "http://localhost:8000" })` + `evaluate(...)` — bypassing the entire `yaar://`
  protocol. There is currently **no guard** against pointing automation at YAAR's own origin
  (verified: `lib/browser/` only references `127.0.0.1:<cdp-port>` for its control plane, never the
  YAAR origin). The naive fix is to *block* self-origin; this proposal argues for a better one.

---

## The Reframe: Collapse Three Roles into One

**Stop treating the web as content to fetch-and-screenshot into YAAR. Treat the user's browser as
the OS substrate, and make YAAR a window-manager over real tabs.**

Collapse all three roles into a single object — the user's browser:

- **Substrate** = the user's browser (unchanged).
- **Tool** = the user's browser, driven via CDP/extension over real tabs.
- **Content surface** = the user's browser — a web "window" *is a real tab*, not a screenshot.

Web pages become real sibling tabs/targets the agent drives through the same channel it uses for
everything else. There is nothing left to nest, because there is one browser, used by both the user
and the agent.

### Proof the mechanism already exists

YAAR's own `CLAUDE.md` documents driving YAAR from outside via `claude-in-chrome` (CDP over a real
Chrome). The exact capability needed to drive *real* tabs is already in hand — it is currently
pointed *inward at YAAR from outside*. The inversion is to let YAAR point it *outward at siblings
from inside*.

---

## How the Reframe Dissolves Self-Reference

A prior instinct was to **block** the YAAR origin as an automation target. That treats the symptom.
The architectural cure is to **make the substrate itself the addressed meta-level.**

CDP already assigns every tab/target a stable **target ID**. If YAAR routes *all* browsing through
target IDs — including YAAR's own tab — then:

- Self-control is no longer an accident to forbid; it is simply *"the target whose ID is YAAR's
  tab."*
- **Use and mention become the same mechanism**, distinguished only by *which ID you name*. The
  overloaded word "browser" splits cleanly: there is one browser (the substrate) and many
  *addressed targets* within it.
- The `yaar://` protocol remains the **sanctioned reflective channel** for acting on YAAR's *state*;
  CDP target addressing becomes the sanctioned channel for acting on YAAR's *rendering surface and
  its siblings*. Neither one reaches YAAR through an unaddressed shared substrate by accident.

Principle: **every reflective capability goes through an addressed meta-level, never the shared
substrate.** Here we satisfy it not by walling off self, but by making self just another address.

---

## Architecture: a `BrowserProvider`, Mirroring `AITransport`

YAAR already has a pluggable-provider pattern for AI backends (`providers/factory.ts`,
`providers/types.ts`, `base-transport.ts`, warm pool, lifecycle manager) selecting Claude vs Codex.
Apply the identical shape to browsing.

### Invariant: `yaar-web` API does not change

`@bundled/yaar-web`'s surface (`open`, `navigate`, `click`, `type`, `press`, `extract`,
`screenshot`, `evaluate`, `getCookies`, `listTabs`, ... — all keyed by an optional `browserId`)
stays **byte-for-byte identical**. Apps and agents are unaffected.

> **⚠️ Superseded on one axis by [`session_agent_browser_design.md`](./session_agent_browser_design.md) (Phase 2, shipped).**
> The original plan — "*only the backend behind `POST /api/browser` swaps*" — no longer holds.
> `POST /api/browser` is now **hard-pinned to `HeadlessServerBrowser`** and never swaps; the user's
> real browser is reached through a *separate, principal-gated door*, `yaar://session/browser`,
> usable only by the session agent. The `yaar-web` surface and the `LocalUserBrowser` mechanism
> below remain authoritative — only "who selects which provider, through which door" has moved.

### Two providers behind one shared action layer (two doors)

```
features/browser/actions.ts   (open/click/extract/… — takes a provider instance)
        ├── POST /api/browser        (apps, yaar-web)     → HeadlessServerBrowser   (sandbox)
        └── yaar://session/browser   (session agent only) → LocalUserBrowser        (real Chrome)
```

- **`HeadlessServerBrowser`** — the current `BrowserPool`/`BrowserSession` over a server-spawned
  Chrome. **Kept, not deprecated.** It is the correct answer for headless / cloud / SSH / no-display
  / Claude-in-Claude / eval runs, and the *only* thing `POST /api/browser` ever reaches.
- **`LocalUserBrowser`** — CDP (or a companion extension) against the **user's own browser**. Real
  cookies, real logins, real tabs, no re-auth, no screenshots: the tab *is* the window. Reached
  **only** through `yaar://session/browser`.

### Provider selection — by door + detection, not environment (superseded)

The original env-keyed table below is **superseded** by principal-routing + Chrome detection (see
[`session_agent_browser_design.md`](./session_agent_browser_design.md) §5). Selection is no longer
"environment → provider"; it is "**which door** you came through":

| Door / principal | Provider | Note |
|------------------|----------|------|
| `POST /api/browser` (apps, monitor agents, `yaar-web`) | `HeadlessServerBrowser` | hard-pinned; ignores `YAAR_BROWSER_PROVIDER=local` |
| `yaar://session/browser` (session agent) | `LocalUserBrowser` when a debuggable Chrome is reachable | auto-detected; never launches Chrome; errors (no silent fallback) when none is reachable |

`YAAR_BROWSER_PROVIDER` is **retired as the selector** and demoted to a single **force-headless
opt-out** (`=headless`) for users who never want the agent near their real browser.

### Target addressing

`browserId` generalizes to a **CDP target ID**. The `LocalUserBrowser` enumerates the user's real
tabs as targets; YAAR's own tab is one target among them (flagged, never *blocked*). `open()`
creates a real tab; the Browser app becomes a *thin handle/embed over a live tab* rather than a
canvas of a screenshot.

---

## Honest Costs

An architect names the costs. None of these are blockers; all are known patterns.

### 1. Extension requirement (the compositing problem)

You **cannot** `<iframe src="bank.com">` arbitrary sites — `X-Frame-Options`/CSP is *precisely why*
YAAR screenshots today. To control real top-level tabs you need either:

- a **companion browser extension**, or
- Chrome launched with `--remote-debugging-port` (developer/power-user mode).

This makes the browser the compositor instead of YAAR, and is a genuine **product decision**
(YAAR-as-extension or YAAR-cooperating-with-one), not merely a refactor. The `HeadlessServerBrowser`
provider is the fallback whenever neither is available.

### 2. Security surface (consent model)

CDP over the user's *real* browser lets the agent touch logged-in banking, email, everything. The
headless box was a sandbox precisely to contain this. `LocalUserBrowser` therefore needs:

- **Per-origin grants** — extend the existing `config/curl_allowed_domains.yaml` allowlist (already
  the consent seed for outbound HTTP) to cover tab control.
- **Visible "agent is driving this tab" indicator** in the UI.
- **Self-target flag** — driving YAAR's own tab is allowed but explicit and surfaced, never silent.

### 3. Keep both providers forever

Headless is not legacy. It is the cloud/eval/Claude-in-Claude path and must remain a first-class
provider. The whole point of the abstraction is that the absurd-for-desktop case and the
necessary-for-cloud case coexist behind one interface.

---

## Product Identity Unlocked

This is the sharp, non-trivial wedge — not *"an AI desktop that has a browser app"* (ambiguous,
competes with everything) but:

> **An agentic window-manager layer over your real browser — your open tabs become processes the AI
> can read, drive, and compose.**

Adjacent to Arc / Dia / Comet, but with YAAR's actual differentiator: the AI builds *UI over the
tabs* (dashboards, extractors, cross-tab joins) via the existing app/compile/deploy loop, not just
chat-about-a-page. And it turns self-reference into a feature: YAAR can legitimately observe and
rearrange itself because it is one more addressed target in the substrate it admits it lives in.
("Reverse YAAR" — an app that watches the user — becomes buildable for free: the introspection
surface is the same CDP target channel.)

---

## Phasing

1. **Seam extraction (no behavior change).** ✅ **Done.** Introduced the `BrowserProvider` interface
   (`lib/browser/types.ts`); refactored the pool to `HeadlessServerBrowser` (with a `BrowserPool`
   back-compat alias). `POST /api/browser`, `resolveSession`, and all other call sites dispatch
   through `getBrowserProvider()`. Pure refactor; `yaar-web` unchanged; existing tests still green.
2. **`LocalUserBrowser` (dev mode).** ✅ **Done.** Extracted the shared CDP/session plumbing into an
   abstract `CdpBrowserProvider` base; both providers extend it. `LocalUserBrowser`
   (`lib/browser/local-user-browser.ts`) attaches to the user's own Chrome on
   `CHROME_DEBUG_PORT` (default 9222) via `--remote-debugging-port`, never launching or killing it
   (`ownsChrome = false`). Opt in with `YAAR_BROWSER_PROVIDER=local`. Power-user/dev only; no
   extension yet.
3. **Consent model.** ✅ **Done.** `features/browser/guards.ts` adds two protections in front of the
   dispatch: (a) a **self-target guard** that refuses raw-DOM *mutations* of YAAR's own tab
   (detected via `isYaarOriginUrl` against `getPort()`) while still allowing reads, pointing the
   agent at OS Actions / `yaar://` instead; (b) **tab-control consent** that, when
   `provider.controlsUserBrowser`, gates mutating a real logged-in tab behind the existing
   `curl_allowed_domains.yaml` allowlist + permission dialog. The "agent is driving this tab"
   indicator is plumbed via `BrowserSession.setDriving()` → the SSE `updated` stream (`driving` +
   `isSelf` fields); `list_tabs` annotates YAAR's own tab with `isSelf`.
4. **Companion extension.** ⬜ Specified in its own proposal:
   [`extension_bridge_proposal.md`](./extension_bridge_proposal.md) ("YAAR Bridge") — pulled forward
   and expanded beyond productizing `LocalUserBrowser`: the extension reaches the user's *default
   profile* (which CDP cannot, post-Chrome-136) and adds tiered observe/manage/act capabilities. A
   zero-setup read-only floor is specified separately in
   [`os_presence_bridge_proposal.md`](./os_presence_bridge_proposal.md).
5. **Provider auto-selection.** ✅ **Superseded & resolved** by
   [`session_agent_browser_design.md`](./session_agent_browser_design.md) Phase 2. The single
   env-keyed `getBrowserProvider()` singleton is gone, replaced by two doors:
   `getHeadlessBrowser()` (`/api/browser`, hard-pinned) and `getLocalBrowser()`
   (`yaar://session/browser`, session-agent only, auto-attaches to a reachable Chrome).
   `YAAR_BROWSER_PROVIDER` is no longer a selector — only a force-headless opt-out. The "environment
   → provider" idea is replaced by "principal/door + Chrome detection."

Each phase is independently shippable and reversible; phase 1 was pure refactor. Phases 1–3 are
implemented and covered by tests (`tests/browser-pool.test.ts`, `tests/local-user-browser.test.ts`,
`tests/browser-guards.test.ts`, `tests/browser-doors.test.ts`).

---

## Files / Seams

Implemented (Phases 1–3):

- `packages/compiler/src/shims/yaar-web.ts` — API unchanged (the invariant holds).
- `packages/server/src/lib/browser/types.ts` — `BrowserProvider` interface (+ `controlsUserBrowser`,
  `BrowserProviderStats`, `AdoptedTab`).
- `packages/server/src/lib/browser/cdp-provider.ts` — `CdpBrowserProvider`, the shared base holding
  all CDP/session plumbing (session map, target discovery, tab creation, idle loop).
- `packages/server/src/lib/browser/pool.ts` — `HeadlessServerBrowser extends CdpBrowserProvider`
  (+ `BrowserPool` alias); `getBrowserProvider()` selection via `YAAR_BROWSER_PROVIDER`.
- `packages/server/src/lib/browser/local-user-browser.ts` — `LocalUserBrowser extends
  CdpBrowserProvider` (attaches to the user's Chrome; `ownsChrome = false`, `controlsUserBrowser =
  true`).
- `packages/server/src/lib/browser/session.ts` — `driving` flag + `setDriving()` for the indicator.
- `packages/server/src/features/browser/guards.ts` — self-target guard + tab-control consent.
- `packages/server/src/http/routes/browser.ts` — runs `enforceBrowserGuards` before dispatch; toggles
  the driving indicator; emits `driving`/`isSelf` on the SSE stream.
- `config/curl_allowed_domains.yaml` — now also the consent surface for tab control (reused as-is).

Still ahead (Phases 4–5):

- `packages/server/src/providers/` — mirror the AI provider factory/selection shape for browser
  environment auto-detection.
- `apps/browser/app.json` — evolve from `capture: "canvas"` screenshot to a live-tab handle, and
  render the `driving`/`isSelf` SSE fields.

---

## Open Questions

1. **Extension distribution.** Build/maintain a first-party extension, or document the
   `--remote-debugging-port` path and treat the extension as later productization?
2. **Same-tab vs adopt-existing.** Should `LocalUserBrowser` only manage tabs YAAR opens, or also
   adopt the user's *pre-existing* tabs (more powerful, larger consent surface)?
3. **Cross-browser.** CDP covers Chromium. Is Firefox (via the WebDriver BiDi protocol) in scope, or
   Chromium-only initially?
4. **Self-target semantics.** ✅ **Resolved (Phase 3).** Raw-DOM *mutations* of the self-target are
   forbidden (`enforceBrowserGuards` returns 403 with a pointer to OS Actions / `yaar://`); read-only
   introspection of self (screenshot/extract/html/get_cookies) is allowed; CDP mutation is reserved
   for *sibling* targets. The self-target is detected dynamically from the tab's current URL, so a
   sibling tab that later navigates to YAAR's origin is covered automatically.
5. **Reload cache interaction.** Live tabs have real, drifting state. How do fingerprints
   (`reload/cache.ts`) treat a live-tab window vs. a screenshot — exclude from cache, or fingerprint
   on tab URL + DOM hash?
