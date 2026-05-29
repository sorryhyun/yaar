# Design: The Session Agent as the User's Deputy — Principal-Routed Browser Access

This document designs **who** is allowed to drive the user's *real* browser, and answers it by
promoting the **session agent** into the single, observable principal that acts *as the user*.

It builds directly on [`browser_substrate_proposal.md`](./browser_substrate_proposal.md), which
already shipped the *mechanism* (the `BrowserProvider` seam, `LocalUserBrowser`, the
"driving" indicator, and the consent guards — phases 1–3). That proposal left provider selection as
a **global** env flip (`YAAR_BROWSER_PROVIDER`). This document replaces "global flip" with
**principal-routed**: the session agent reaches the local browser; everyone else stays sandboxed —
and it does so by hanging browser access off the `yaar://session` namespace rather than a new
top-level `yaar://browser`.

---

## 1. The boundary is *identity*, not *feature*

Driving a sandboxed/headless Chrome is benign at any tier — it is a throwaway browser with no
identity. Driving the user's **real** Chrome (their cookies, logins, authenticated sites) is a
different *kind* of act. What makes it safe is not that browsing is gated, but that the act is taken
**as the user's deputy** — by one named, auditable principal — rather than by an arbitrary worker.

So YAAR's agents split by *identity*, not by capability:

| Tier | Identity | Browser access |
|------|----------|----------------|
| **App agent** (`iframe:{appId}`) | the app's sandbox | headless Chrome, via the Browser app / `yaar-web` (as today) |
| **Monitor agent** | a desktop worker | headless Chrome (subscribe to / manipulate the Browser app) |
| **Session agent** | **the user's deputy** | the user's **real** browser — "the same as what the user does" |

This closes the exact gap that motivated the design: the difference between *what an agent reaches
in a fresh sandbox* and *what you reach because you are logged in everywhere*. The session agent is
the one principal allowed to step across it.

Singular + named + observable is not a preference — it is the standard mitigation for the
**confused-deputy** problem. One throat to watch.

---

## 2. Why route through `yaar://session`, not a new `yaar://browser`

The instinct to nest browser access under `yaar://session` (rather than minting a sibling
`yaar://browser` and gating it) is the better structural choice — because it makes the access rule
**namespace-shaped instead of resource-shaped**:

> `yaar://session/*` is the session principal's private namespace. Anything that requires
> user-level authority lives under it and inherits the gate for free.

Browser-as-user becomes **`yaar://session/browser`**, sitting alongside the things the session agent
already owns there (`yaar://session/monitors`, `yaar://session/context`, `memorize`). You don't
gate "the browser" as a special case; you gate one coherent namespace, and the browser is simply a
resident of it. The next capability you decide is "user-principal / cross-cutting" goes under
`yaar://session/` and is gated automatically — no new policy each time.

---

## 3. The premise, corrected — the gate is half-built

The working assumption was: *"`yaar://session` is already off-limits to everyone except the
session agent and the session-logs app."* That is **half true, in a way that defines the work**:

- **Apps are already gated.** Iframe verb calls go through `POST /api/verb`, which enforces the
  app's `app.json` `permissions` allowlist per-URI **and** per-verb (`verb.ts:isUriAllowed`,
  default-deny). An app physically cannot touch a URI it didn't declare.
  - *Correction worth noting:* the **session-logs app declares `yaar://history/` (read/list), not
    `yaar://session`** (`apps/session-logs/app.json`). So the "session-log SDK" carve-out you had in
    mind actually points at `yaar://history`, a different namespace. Good — it means the session-logs
    app needs **no** access to `yaar://session/*` at all, and the carve-out can be *narrower* than
    assumed (see §4).

- **Agents are NOT gated.** When an agent calls the 5 verb MCP tools, `registry.execute()` runs
  with **zero** access control (confirmed: no role/tier checks anywhere in `handlers/`,
  `uri-registry.ts`, `uri-resolve.ts`, or the MCP dispatch). **Every monitor agent can read/invoke
  `yaar://session/*` today.** And `AgentContext` (the AsyncLocalStorage identity) carries
  `agentId / sessionId / monitorId / windowId` — but **no `role`**.

So the gate doesn't exist to "inherit" yet. The **missing primitive is agent-side, role-based URI
access control.** That is the core of this design; the app side is already done.

---

## 4. The access rule

One rule, two enforcement points (matching the two ways a verb can be invoked):

**Rule:** `yaar://session/browser` (and its children) — and the *mutating* surface of
`yaar://session/*` generally — may be invoked **only by the session agent.**

| Caller | Path | Outcome |
|--------|------|---------|
| **Session agent** | MCP verb tools | ✅ full access to `yaar://session/*`, incl. `yaar://session/browser` |
| **Monitor agent** | MCP verb tools | ❌ `403` on `yaar://session/*` (today: silently allowed) |
| **App agent** | MCP (query/command/relay only) | n/a — apps don't have verb tools |
| **Any app** | `POST /api/verb` | ❌ — `yaar://session/*` is session-agent-only; apps are never granted *any* of it (see §4b) |

> **Decision (Q3): `yaar://session/*` is session-agent-only, full stop** — no per-verb read
> carve-out for apps. If another agent legitimately needs a *piece* of it (e.g. a read-only context
> summary), we **extract that piece to its own URI** (e.g. under `yaar://history` or a new
> read-only resource) rather than poking holes in the session namespace. Keep the boundary clean;
> widen it by extraction, never by exception.

### 4a. Agent path — add `role` to the context, check it centrally

1. Add `role: 'session' | 'monitor' | 'app'` to `AgentContext` (`agents/agent-context.ts`),
   populated from the `PooledAgent`'s role when the turn's context is established
   (`runInAgentContext` in `agent-session.ts`). The pool already knows each agent's role.
2. Let a handler declare an access requirement at registration time, e.g.
   `access: 'session-principal'` on the `yaar://session/browser` registration (and on the mutating
   verbs of `yaar://session/*`).
3. Enforce centrally in `ResourceRegistry.execute()` (`uri-registry.ts`): if the matched handler
   requires `session-principal` and `getAgentRole() !== 'session'` (and the caller isn't an
   allow-listed app, §4b), return a `403`-style `VerbResult` error. One choke point, reused for any
   future privileged namespace.

### 4b. App path — already default-deny, plus a non-self-grant for the session namespace

`POST /api/verb` already denies any URI an app didn't declare. The only hole is that an app could
*declare* `yaar://session/*` in its own `app.json` and self-grant. Close it the same way `yaar-web`
is treated as privileged: **`yaar://session/*` is not self-grantable — `/api/verb` refuses it for
any app, regardless of `app.json`.** Per the Q3 decision there is no exception, not even read.

This costs nothing today: the corrected fact is that the **session-logs app uses `yaar://history/`,
not `yaar://session`** — so no existing app needs the session namespace at all.

---

## 5. Two providers alive at once — routed by entry point

**Today (the leak), to be precise.** `getBrowserProvider()` (`pool.ts:117`) is a *single global lazy
singleton* selected purely by `YAAR_BROWSER_PROVIDER`. `/api/browser` calls it. So `LocalUserBrowser`
is **not blocked and not a separate domain — it is reached through the exact same `/api/browser`
endpoint.** When `YAAR_BROWSER_PROVIDER=local`, *every* `/api/browser` caller — apps via `yaar-web`
included — drives the user's real Chrome. There is no separation at all; the env var is a global flip
of one shared instance. That is the leak.

**The fix is not "block" or "new domain" — it is "stop sharing one singleton."** Keep one shared
*action layer* and give it two doors bound to two instances:

```
features/browser/actions.ts   (open/click/extract/… — already takes a provider instance)
        ├── POST /api/browser        (apps, yaar-web)     → HeadlessServerBrowser   (sandbox)
        └── yaar://session/browser   (session agent only) → LocalUserBrowser        (real Chrome)
```

- The `yaar://session/browser` handler calls the **same action functions directly** with the local
  instance — **no internal HTTP hop** back through `/api/browser`.
- `getBrowserProvider()` (one env-switched singleton) becomes `getHeadlessBrowser()` +
  `getLocalBrowser()`.
- **`/api/browser` is hard-pinned to headless** and *ignores* `YAAR_BROWSER_PROVIDER=local` (Q4
  decision). Local is reachable **only** through the gated session door — which is what makes
  "protect the Browser app's access to local" automatic: lower agents physically reach a *different
  instance*.
- **The session door defaults to local — by detection, not opt-in.** Once the session-agent gate
  replaces the env var as the safety control, `YAAR_BROWSER_PROVIDER=local` is no longer needed to
  *enable* local; `getLocalBrowser()` **auto-attaches whenever a debuggable Chrome is reachable**
  (`ownsChrome = false` — never launches/kills the user's Chrome). This is also *correct*, not just
  safe: the act-as-user path is meaningless against a logged-out sandbox, so the deputy must default
  to the user's real, logged-in browser. The env var is **retired as the selector** (real detection
  replaces it), demoted to a single **force-headless opt-out** for users who never want the agent
  near their real browser.
- **Consent becomes load-bearing.** With local on-by-default, the per-action guards
  (`curl_allowed_domains.yaml` allowlist + driving indicator, phase 3) are now the primary friction
  protecting the user — so consent UX (phase 4) must mature before the CLI toggle leaves the panel.
- **No silent fallback.** If no local Chrome is reachable (cloud / `REMOTE` / no debug port),
  `yaar://session/browser` returns a clear error ("no local browser available"), never a quiet
  downgrade to headless — a silent sandbox would lie about identity.

> Net change to the substrate proposal: instantiate both providers and bind each to a door, rather
> than `getBrowserProvider()` returning a single env-selected singleton. This is the Phase-5
> ("provider auto-selection") evolution, reframed around *identity* instead of *environment*.

### Reuse what phase 3 already built

`yaar://session/browser` dispatches into the **existing** `features/browser/actions.ts` against the
`LocalUserBrowser` instance, so the already-shipped protections apply unchanged:

- `enforceBrowserGuards()` — self-target guard (no raw-DOM mutation of YAAR's own tab) + per-origin
  tab-control consent via `curl_allowed_domains.yaml`.
- `BrowserSession.setDriving()` → the SSE `driving` / `isSelf` fields — **this is the
  "agent is acting as you right now" indicator.** It already exists; here it gains a clear meaning:
  it fires precisely when the session agent drives the local browser.
- Raw binary `/api/browser/:id/screenshot` and `/events` SSE stay as the streaming/binary
  escape-hatch (verbs carry JSON + base64 images fine, but live streams don't belong in a verb
  result).

---

## 6. The CLI toggle (scoped: CLI panel only, for now)

The privileged path should be **opt-in and visible** — which is also the observability requirement.
Add a toggle to the CLI panel (`Shift+Tab`, `DesktopSurface.tsx`) that chooses the **target** of the
typed message:

- **Monitor** (default) — message routes to the monitor agent, sandbox browsing only. Today's
  behavior, unchanged.
- **Session ("act as me")** — message routes to the **session agent**, which can drive the local
  browser as the user.

Wiring:

1. `USER_MESSAGE` (`packages/shared/src/events.ts`) gains an optional
   `target?: 'monitor' | 'session'` (default `'monitor'`).
2. `LiveSession.routeMessage()` (`live-session.ts:403`): when `target === 'session'`, enqueue a
   session-agent task (via `ContextPool.getOrCreateSessionAgent()`) instead of
   `handleTask({ type: 'monitor', ... })`. This also *wakes the currently-dormant session agent*,
   giving it a real, user-initiated job.
3. The toggle lives **only** in the CLI panel for now — it is the experimental, power-user surface
   for "let the agent act as me," kept out of the main command palette until the consent UX matures.

Default-off + explicit-toggle + the existing "driving" indicator together satisfy *observable,
single-agent, opt-in*.

---

## 7. The resulting layering

```
                 ┌─────────────────────────────────────────────┐
  user types ──▶ │ CLI panel toggle:  Monitor  |  Session("me") │
                 └───────────────┬───────────────────┬──────────┘
                                 ▼                   ▼
                          Monitor agent        Session agent  (the user's deputy)
                                 │                   │
                    sandbox browsing         yaar://session/browser  (role-gated)
                    (Browser app /                   │
                     yaar-web →                      ▼
                     /api/browser →            LocalUserBrowser  (real Chrome,
                     HeadlessServerBrowser)     real identity; driving-indicator on)
```

- Common case (browse a public page, extract data) flows through monitor/app agents and the headless
  sandbox — **no bottleneck**, no identity at risk.
- Acting *as the user* is one named agent, reached deliberately, surfaced while it happens.

---

## 8. Phasing

1. **✅ DONE — Agent-role access control (the missing primitive).** Added `role`
   (`session`/`monitor`/`app`) to `AgentContext` + `getAgentRole()`; added a declared `access`
   requirement to handler registration; enforced centrally in `ResourceRegistry.execute()` (the role
   resolver is injected via `setAccessRoleResolver()`, wired in `lifecycle.ts`, to avoid a runtime
   import cycle). The whole `yaar://session/*` namespace is now session-agent-only — every verb,
   not just mutations (Q3). `POST /api/verb` additionally hard-refuses `yaar://session/*` for apps
   (§4b). Role is resolved from the pool (`AgentPool.getRoleForAgent` → `SessionHub.findRoleForAgent`)
   on the MCP path and from the per-turn role string (`principalRole()`) in-process. *(Pure security
   tightening; no new capability.)*
2. **✅ DONE — `yaar://session/browser` handler + provider split.** `getBrowserProvider()`'s single
   env-keyed singleton is replaced by two doors: `getHeadlessBrowser()` (pinned behind
   `POST /api/browser`) and `getLocalBrowser()` (a `LocalUserBrowser` that auto-attaches to a
   reachable Chrome). `features/browser/actions.ts` now threads the provider instance through every
   handler and exposes a shared `runBrowserAction` switch + `runGuardedBrowserAction` (guards +
   driving indicator); the HTTP route and the session door both dispatch into it.
   `features/session/browser.ts` picks the provider (local, or headless under the force-headless
   opt-out, or a clear "no local browser" error — never a silent downgrade) and is registered at
   `yaar://session/browser` with `access: 'session-principal'`. `'browser'` added to the session
   URI parser. Tested in `tests/browser-doors.test.ts`.
3. **✅ DONE — CLI toggle.** `USER_MESSAGE.target?: 'monitor' | 'session'` added to the shared event;
   `LiveSession.routeMessage()` routes `target === 'session'` to `ContextPool.handleSessionTask()`,
   which wakes the lazy session agent and runs a `session-*` turn (the principal tier that unlocks
   `yaar://session/browser`) with the session-agent profile prompt. Frontend: `cliTarget` in the cli
   slice, a Monitor/Session toggle in `CliPanel`, and `sendMessage` attaching `target` only while the
   CLI panel is open (§6).
4. **Consent UX polish.** Make the "driving as you" indicator prominent; tighten per-origin grants
   for the local browser before exposing the toggle beyond the CLI panel.

Each phase is independently shippable; phases 1–3 have landed. Phase 1 was a pure correctness fix
(monitor agents could hit `yaar://session/*`); phase 2 split one shared singleton into two
door-bound instances; phase 3 added the opt-in, panel-only "act as me" route.

---

## 9. Files / seams

- `packages/server/src/agents/agent-context.ts` — add `role` to `AgentContext` + `getAgentRole()`.
- `packages/server/src/agents/agent-session.ts` — populate `role` when entering the turn context.
- `packages/server/src/handlers/uri-registry.ts` — `access` field on registration; central enforce
  in `execute()`.
- `packages/server/src/handlers/session.ts` — register `yaar://session/browser`; mark session
  mutations `access: 'session-principal'`.
- `packages/server/src/http/routes/verb.ts` — non-self-grant allowlist for `yaar://session/*` perms.
- `packages/server/src/lib/browser/index.ts` — instantiate both providers; bind local to the
  session door, headless to `/api/browser`.
- `packages/shared/src/events.ts` — `USER_MESSAGE.target?: 'monitor' | 'session'`.
- `packages/server/src/session/live-session.ts` — route `target === 'session'` to the session agent.
- `packages/frontend/.../DesktopSurface.tsx` — CLI-panel target toggle.
- *(reused as-is)* `features/browser/guards.ts`, `lib/browser/local-user-browser.ts`,
  `lib/browser/session.ts` (driving indicator) — from substrate proposal phases 1–3.

---

## 10. Resolved decisions

1. **Session-agent lifecycle → lazy birth, for now.** Born on the first `target: 'session'` message
   from the CLI toggle; no eager creation. A better lifecycle (idle disposal, explicit teardown) is
   acknowledged as needed but **deferred** — keep it simple first.
2. **Relay path → deferred, as-is.** A monitor agent that needs user-identity browsing does **not**
   auto-relay up; the user re-issues via the toggle. The existing (non-ergonomic) monitor→session
   relay stays untouched. Revisit later.
3. **`access` granularity → whole-namespace, session-only.** `yaar://session/*` is session-agent-only
   with **no per-verb exceptions**. If another agent needs a piece, **extract it to a separate URI**
   rather than carving a read hole. Per-handler `'session-principal'` is sufficient.
4. **Headless default for apps → hard-pinned.** `/api/browser` always uses the headless instance and
   **ignores `YAAR_BROWSER_PROVIDER=local`**. The local browser is reachable *only* through
   `yaar://session/browser`. No silent headless fallback when local is unavailable — error instead
   (§5).
5. **Session door defaults to local — by detection.** Because the session-agent gate replaces the
   env var as the safety control, local no longer needs `YAAR_BROWSER_PROVIDER=local` to enable:
   `getLocalBrowser()` auto-attaches whenever a debuggable Chrome is reachable (never launches it).
   Correct *and* safe — the deputy is useless against a logged-out sandbox. Env var retired as
   selector; kept only as a force-headless opt-out (§5).

---

## 11. Documentation impact — reframe as each phase lands

These changes invalidate prose in several docs. **Doc edits are part of each phase's
definition-of-done**, not a cleanup afterthought — otherwise the contradictions compound. Line
numbers are anchors at time of writing; match on the quoted text.

### Guiding move: supersede-and-link, don't contradict

[`browser_substrate_proposal.md`](./browser_substrate_proposal.md) is the **parent**. This design
*overturns its provider-selection model* (env-global flip → principal-routed + detection). The worst
outcome is two live docs that silently disagree. So: when **Phase 2** lands, edit the parent's
Phase 5 / provider-selection section to **point here and mark itself superseded** on that one axis —
keep the rest (the substrate thesis, the consent guards, the `LocalUserBrowser` mechanism) as the
still-authoritative source. One topic, one owner.

### Phase 1 — agent-role access control ✅ DONE (mostly *added* docs)

There was no existing line claiming "all agents have equal access," so this phase documented a model
that was previously implicit. All of the edits below have landed:

- ✅ **`packages/server/CLAUDE.md`** — added an *"Access tiers"* note (agents carry a `role`;
  `yaar://session/*` is session-only, enforced centrally in `ResourceRegistry.execute()`); updated the
  AgentPool diagram line to call the Session Agent the session principal.
- ✅ **`docs/monitor_and_windows_guide.md`** — reframed the session-agent description as **"the
  session principal — the one tier with access to `yaar://session/*`."**
- ✅ **`docs/common_flow.md`** — noted it is the exclusive principal for `yaar://session/*`.
- ✅ **`docs/os_architecture.md`** — added the Session agent as a distinct process tier with its own
  privilege level + the role-based access-control note.
- ✅ **`docs/app-development.md`** — in the URI-verbs reference, noted **`yaar://session/*` is
  session-agent-only** (not reachable by apps via `/api/verb`).

### Phase 2 — `yaar://session/browser` + provider split ✅ DONE

- ✅ **`docs/browser_substrate_proposal.md`** — reframed: the "Invariant" block now carries a
  *superseded-on-one-axis* note (`/api/browser` hard-pinned to headless; real browser via the new
  `yaar://session/browser` door); the provider-selection table is replaced by a *door/principal +
  Chrome detection* table; Phase 5 ("Provider auto-selection") marked superseded & resolved, with
  `YAAR_BROWSER_PROVIDER` demoted to a force-headless opt-out. All link here.
- ✅ **`packages/server/CLAUDE.md`** — `YAAR_BROWSER_PROVIDER` rewritten ("no longer a selector";
  `/api/browser` always headless; local is the session door's auto-detected default; var = force-
  headless opt-out). AgentPool session-agent line extended to *"the only principal that drives the
  user's real browser via `yaar://session/browser`."*
- N/A **root `CLAUDE.md`** — `YAAR_BROWSER_PROVIDER` was never in the root Environment-Variables list,
  so there was nothing to fix there (semantics live in `packages/server/CLAUDE.md`).
- ✅ **`docs/app-development.md`** — `yaar://session/browser` noted in the URI-verbs reference
  (session-only; apps use `@bundled/yaar-web` → headless sandbox instead).

### Phase 3 — CLI toggle ✅ DONE

- ✅ **`packages/shared/CLAUDE.md`** — documented `USER_MESSAGE.target?: 'monitor' | 'session'` in the
  WebSocket-events section (default `'monitor'`).
- ✅ **`packages/frontend/CLAUDE.md`** — added a "CLI Panel" section describing the Monitor/Session
  ("act as me") target toggle (`cliTarget`) and how `sendMessage` attaches `target` only while the
  panel is open.
- ✅ **root `CLAUDE.md`** — the `press(key: "Shift+Tab")` note now mentions the panel also carries the
  Monitor/Session target toggle.

### Phase 4 — consent UX

- **`docs/browser_substrate_proposal.md`** §"Security surface (consent model)" — update to note that,
  with local-by-default, the consent guards are now **load-bearing** (no longer backstopped by the
  env-var opt-in), and the CLI toggle stays panel-only until this matures.
