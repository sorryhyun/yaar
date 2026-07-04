# Proposal: YAAR Bridge — a Companion Extension Making the Real Browser Part of the OS

YAAR presents itself as an OS, but the surface most of the user's digital life happens on — their
real, logged-in, everyday browser — is outside it. This proposal adds **YAAR Bridge**: a small
companion browser extension that connects the user's existing Chrome *outward* to the YAAR server,
turning real tabs into resources YAAR can observe, manage, and (under the strictest existing gate)
act on. This is the point where "YAAR as OS" stops being a metaphor for windows YAAR draws itself
and starts covering the windows the user already has: **the browser becomes a managed device of the
YAAR OS, under YAAR's ecosystem controls.**

> Companion doc: [`os_presence_bridge_proposal.md`](./os_presence_bridge_proposal.md) is the
> zero-setup, read-only floor (OS-level signals: MPRIS, session files). This proposal is the rich
> tier. **Both feed the same `yaar://browser/*` URI surface** — when the Bridge connects, the feed
> upgrades in place; consuming apps change nothing.
> Parents: [`browser_substrate_proposal.md`](./browser_substrate_proposal.md) — this *is* its
> "Phase 4: Companion extension," pulled forward and specified — and
> [`session_agent_browser_design.md`](./session_agent_browser_design.md), whose principal model
> this proposal preserves exactly.

> **Status:** **T1 (Observe) and T2 (Manage) have moved from proposal to implementation.** Their
> concrete build record, seam map, and remaining plan live in [`../0607plan.md`](../0607plan.md)
> (Slices 0–2); T1 is shipped and verified live. This document stays authoritative for the *tier /
> consent thesis* and for **T3+** (act-in-page, site adapters, productization). Sections describing
> T1/T2 mechanics are kept for context but are superseded on implementation detail by `0607plan.md`.

---

## 1. Why an extension, and why the connection points outward

Every other channel to the user's *everyday* browser is blocked or coarse:

- CDP requires a launch flag, and since Chrome 136 refuses it on the default profile — so the
  CDP door (`yaar://session/browser`) reaches a relaunched second-profile Chrome, not the one the
  user lives in.
- OS presence signals (companion proposal) reach the real browser but are read-only and coarse —
  no in-page events, no actuation, no tab management.
- Process-level attach is malware territory; not a path.

An extension inverts the connection: it runs *inside* the user's existing browser and profile and
**dials out** to `ws://localhost:{PORT}/bridge` whenever a YAAR server is up. Nothing to relaunch,
no flags, no second profile; if YAAR isn't running, the Bridge idles at zero cost. Consent becomes
native — Chrome's own install prompt and per-site host permissions are the outer consent layer,
with YAAR's per-app grants layered inside.

This is the same architecture as `claude-in-chrome` (which already drives this repo's development):
a WebExtension bridging a real browser to an external agent system. The pattern is proven; the
novelty is only pointing it at YAAR's server and URI model.

## 2. Capability tiers — three, strictly ordered

The Bridge's capabilities are deliberately tiered, because each tier has a different risk profile
and a different gate. Shipping order = tier order.

| Tier | Capability | Chrome APIs | Who may use it (YAAR side) |
|------|-----------|-------------|---------------------------|
| **T1 Observe** | tab list, URL/title/active/audible, navigation events, media state | `tabs` | apps/monitor agents with a `yaar://browser/tabs` grant (read-only) |
| **T2 Manage** | create/focus/close/group tabs, reorder — *window-manager verbs* | `tabs`, `tabGroups` | monitor agents + apps with an explicit manage grant; every mutation user-consented per origin |
| **T3 Act-in-page** | site adapters (in-page events like "like clicked"), DOM reads, and full actuation via `chrome.debugger` | `scripting` (per-origin host permissions), `debugger` | **session agent only** — routed through `yaar://session/browser`, same principal gate as today |

The tier boundary that matters most: **T1/T2 never see or touch page *content*** — only tab-level
metadata and arrangement. Everything content-shaped is T3 and inherits the session-principal gate
unchanged. The confused-deputy analysis of `session_agent_browser_design.md` §1 is not weakened by
this proposal; T3 is the *same door* with a better transport behind it.

## 3. Architecture

```
User's everyday Chrome (default profile, already running)
└── YAAR Bridge extension (MV3)
    ├── background service worker
    │     ├── WebSocket → ws://localhost:{PORT}/bridge   (outbound; token auth in REMOTE mode)
    │     ├── chrome.tabs.* listeners  → T1 event stream
    │     ├── chrome.tabs / tabGroups  → T2 command executor
    │     └── chrome.debugger          → T3 CDP relay (attach per-tab on demand)
    └── content scripts (site adapters) — injected ONLY on origins the user granted (T3)

YAAR server
├── http/routes/bridge.ts        — WS upgrade, auth (same story as frontend WS), heartbeat
├── lib/browser/bridge-browser.ts — ExtensionBridgeBrowser implements BrowserProvider
│                                    (third sibling of HeadlessServerBrowser / LocalUserBrowser;
│                                     controlsUserBrowser = true; ownsChrome = false)
└── features/browser/…           — same action layer; same guards (enforceBrowserGuards,
                                    driving indicator) apply unchanged to T3
```

Key structural decisions:

- **`ExtensionBridgeBrowser` is a third `BrowserProvider`**, not a new subsystem. The seam built in
  substrate phases 1–2 (provider interface, shared action layer, guards, driving indicator) absorbs
  it. For T3, `yaar://session/browser` prefers the Bridge transport when connected (it reaches the
  *actual* everyday browser — strictly better for the "deputy" premise than the second-profile CDP
  path), falling back to `LocalUserBrowser`, else erroring — never a silent downgrade (§5 of the
  session-agent design, honored).
- **T1 feeds the shared observation namespace.** Bridge tab events publish into
  `yaar://browser/tabs` and enrich `yaar://browser/presence` — the exact URIs the OS-presence
  proposal defines. `subscriptionRegistry` delivers changes to apps; consuming apps cannot tell
  (and need not care) which transport produced the data. Feed metadata carries a
  `fidelity: 'os-signals' | 'bridge'` field so UIs can show what's available.
- **T2 becomes verbs on tab resources:** `yaar://browser/tabs/{id}` supporting
  `invoke {action: focus|close|group|move}` — window-manager operations, mirroring how
  `yaar://windows/{id}` already works. This is the "YAAR manages your browser like an OS manages
  windows" surface: the dock can show real tabs beside YAAR windows; a monitor agent can tidy,
  group, and compose them.
- **The YAAR tab is one target among targets.** Per the substrate proposal's addressing principle,
  the Bridge annotates YAAR's own tab (`isSelf`) rather than hiding it; T2/T3 mutations of self
  remain refused by the existing self-target guard.

## 4. Consent model — three layers, all pre-existing patterns

1. **Browser-native (outermost).** Installing the extension is itself consent to T1. T3 host
   permissions are granted per-origin through Chrome's own prompt (`optional_host_permissions`),
   and `chrome.debugger` attachment shows Chrome's built-in "is being debugged" banner — an
   indicator YAAR doesn't even have to build.
2. **YAAR per-app grants.** Apps declare `yaar://browser/tabs` (T1) or manage access (T2) in
   `app.json` `permissions` — existing default-deny enforcement in `/api/verb`. Same permission
   dialog + `config/permissions.json` persistence as everything else.
3. **YAAR principal gate (innermost).** T3 is `yaar://session/browser` — session agent only,
   `access: 'session-principal'`, driving indicator on, per-origin allowlist via
   `curl_allowed_domains.yaml`. Zero changes to that design; the Bridge is just a better cable.

"Under strict control within the YAAR ecosystem" is thus not a slogan — every tier maps to an
already-shipped enforcement mechanism.

## 5. Honest costs

- **A second deliverable.** The extension is a separate artifact with its own build, versioning,
  and (eventually) Web Store review cycle. Mitigation: keep it *dumb* — a transport plus Chrome-API
  glue, no policy. All policy lives server-side where it already is. Dev distribution is
  "Load unpacked" from `extension/` in the repo; Store packaging is a late phase.
- **MV3 service-worker lifetime.** MV3 workers sleep; the design leans on the fact that an active
  WebSocket keeps the worker alive (Chrome ≥ 116) plus `chrome.alarms` heartbeat + exponential
  reconnect for the sleep/wake edge cases. This is the known-annoying part of every MV3 bridge;
  budget real time for it.
- **Protocol drift.** Bridge messages become a *public-ish* contract (an installed extension may be
  older than the server). Version the hello message; server refuses/warns on mismatch.
- **Site adapters are a treadmill.** "Like clicked on YouTube" means a per-site content script that
  breaks when YouTube ships a redesign. Ship adapters as *data + tiny matcher* (selector maps),
  ideally hot-updatable from the server, and treat each adapter as best-effort.
- **Security surface widens at T3.** An extension holding `debugger` permission over granted
  origins is a high-value target. T3 stays off by default (no host permissions requested at
  install), and the session-principal gate means a compromised *app* still cannot reach it.
- **Chromium-first.** MV3 WebExtensions port to Edge/Brave nearly for free and to Firefox with
  modest effort (`chrome.debugger` has no Firefox equivalent — T3 would be Chromium-only). Scope v1
  to Chromium, matching the rest of the repo.

## 6. What this unlocks (the product argument)

The substrate proposal's identity — *"an agentic window-manager layer over your real browser"* —
currently has no path to a normal user's browser (CDP needs flags and a second profile). The Bridge
is that path, and it composes with everything YAAR already has:

- **Real tabs in the dock**, groupable and focusable next to YAAR windows — the OS metaphor made
  literal, on day one of T2.
- **Presence-aware apps** — the OS-presence proposal's YouTube scenario upgrades from "what's
  playing" to real in-page events, with zero app-side changes.
- **Cross-tab composition** — dashboards/extractors the AI builds over *logged-in* pages (T3,
  session-gated), the differentiator vs. chat-about-a-page products.
- **"Reverse YAAR"** — the app-that-watches-the-user becomes buildable exactly as the substrate
  proposal predicted, but with a consent chain worth defending.

## 7. Phasing

> **Phases 1–2 (T1 Observe, T2 Manage) are implemented / in progress in
> [`../0607plan.md`](../0607plan.md) (Slices 0–2)** — pulled out of this proposal because they carry
> no page-content access and ship on their own risk profile. T1 is done and verified. This section
> now tracks only the tiers beyond the manage surface.

3. **T3 transport swap.** `chrome.debugger` relay; `yaar://session/browser` prefers Bridge when
   connected. No policy change — same gate, same guards, same indicator.
4. **Site adapters.** Adapter format + first two adapters (YouTube, GitHub); events flow into the
   presence feed as `fidelity: 'bridge'` entries.
5. **Productization.** Store packaging, version handshake hardening, Firefox port evaluation.

## 8. Files / seams

- `extension/` (new, repo root) — `manifest.json`, `background.ts`, `adapters/` (T3+).
- `packages/server/src/http/routes/bridge.ts` — WS endpoint + auth (new).
- `packages/server/src/lib/browser/bridge-browser.ts` — `ExtensionBridgeBrowser` (new; extends the
  provider seam, *not* `CdpBrowserProvider` — its transport is the extension, not a CDP socket,
  except where T3 relays raw CDP).
- `packages/server/src/features/browser/presence.ts` — accepts Bridge-fidelity input (shared with
  the OS-presence proposal).
- `packages/server/src/handlers/browser-presence.ts` / `handlers/session.ts` — T1/T2 URIs; T3
  routing preference inside the existing session-browser handler.
- `packages/shared/` — bridge message schemas (Zod), versioned hello.
- *(reused as-is)* `features/browser/guards.ts`, driving indicator, `curl_allowed_domains.yaml`,
  `config/permissions.json`, `subscriptionRegistry`.

## 9. Open questions

1. **Bridge ↔ server pairing in REMOTE mode.** Localhost is easy; when YAAR runs remotely
   (`REMOTE=1`), should the Bridge pair via the existing QR/token flow, or is Bridge local-only for
   v1? (Leaning: local-only v1; remote pairing is a real feature, not a checkbox.)
2. **Multiple YAAR servers / multiple browsers.** One Bridge, several servers (dev + main)? Several
   browsers, one server? Probably: Bridge targets one port, configurable in its popup; server
   accepts many bridges keyed by browser identity.
3. **Adapter distribution.** Bundled with the extension (Store-review latency) vs. served by the
   server at connect time (fast iteration, but "remote code" constraints under MV3 mean adapters
   must be *data* interpreted by a fixed engine, not eval'd script).
4. **Does T2 need per-mutation consent or per-origin standing grants?** Closing a tab is
   destructive-ish but low-stakes; grouping is cosmetic. Proposal: standing grant per app for
   T2, with a visible action log — revisit if it feels spooky in practice.
