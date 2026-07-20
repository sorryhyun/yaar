# Devtools Friction Fixes — remaining items

**Source:** `storage/devtools-friction-report-2026-07-20.md` + `storage/friction-comparison-2026-07-20.md` (app-agent + monitor reports from the dc-comics 짤방댓글 session), verified against the codebase on 2026-07-20.

**Already landed** (removed from this document): F1 `previewScreenshot` failure reasons, F2 `editFile` anchor + removed-echo, F3 `previewEval`, F5.1/F5.2 remount + caching docs, F8 confirm-twice guidance, and the whole of Part 2 (the protocol diet — 33 → 28 commands, `protocol.json` 21,116 → 17,899 bytes, `AGENTS.md` 25,885 → 21,435 bytes).

One note carried forward from the diet: `protocol.json`'s remaining weight is **schema, not prose**. `editFile` is 2,194 chars of which 1,476 is `params` — and that grew when F2 added the required `anchor`. Further shrinking means deleting documented parameters, which is a capability cut, not a diet. Do not set byte targets on command JSON without separating description from schema first.

---

### F4. `evaluate` timeout + `scrollToBottom` (severity: medium, cheap)

**Root cause.** `CDPClient.send(method, params, timeout = 15_000)` — hardcoded default (`packages/server/src/lib/browser/cdp.ts:52`), no caller overrides it. `evaluate` uses `awaitPromise: true`, so page-side sleeps count against the 15 s. Neither the shim nor the `.d.ts` mentions the limit. `scroll` is a fixed 500 px step (`session.ts:689-702`) with no amount exposed.

**Fix.**

1. Thread `timeoutMs` through `yaar-web.evaluate` → `features/browser/actions.ts#handleEvaluate` → `session.evaluate` → `send(..., timeout)`, capped at 120 000 (matching the shim's fetch abort).
2. Add `scrollToBottom({ maxSteps?, dwellMs?, browserId? })` in `session.ts`: loop `scrollBy(0, viewportHeight)` until `scrollHeight` stabilizes or `maxSteps` (default 40); return `{ steps, finalHeight, reachedBottom }`.
3. `.d.ts` (`packages/compiler/src/bundled-types/index.d.ts`): document the timeout on `evaluate`, add `scrollToBottom`, and fix `html()`'s declared return (see F6).

*Touches:* `packages/server/src/lib/browser/cdp.ts`, `session.ts`, `packages/server/src/features/browser/actions.ts`, `packages/compiler/src/shims/yaar-web.ts`, `packages/compiler/src/bundled-types/index.d.ts`.

### F5.3. Style-only hot swap (deferred — proposal-sized on its own)

F5's docs half has landed. What remains: when a recompile's diff against the previous bundle is confined to CSS, swap `<style>` content in the live iframe instead of remounting. Requires the compiler to emit styles separably. The remount itself is deliberate (`build.ts:54-58` → `openPreview()` close + create, "a new build is a new app"), so this is an optimization against a correct default — do not attempt it as a drive-by.

### F6. `web.html()` semantics + tab isolation docs (severity: low, docs + small API)

**Confirmed:** `getHtml` returns `document.body.innerHTML` — a fragment, no doctype/head/title, no metadata (`session.ts:733-740`). **Report's hypothesis corrected:** every `browserId` is a new tab in *one shared Chrome profile* (`cdp-provider.ts:329` via `/json/new`; single `--user-data-dir`, `chrome.ts:139-176`) — cookies/localStorage are **shared** across browserIds within a provider. The empty-img_comment mystery was not cookie isolation; likely referrer/JS-state dependent serving. Isolation exists only between the headless sandbox and the user's real Chrome (separate providers, `pool.ts:121-143`).

**Fix.**

1. `html({ includeMeta: true })` → `{ html, url, title, readyState }` (opt-in; default stays a bare string for compatibility). Optionally `outerHTML: true` for the full document.
2. Document in the `.d.ts`: fragment semantics, shared-profile tab semantics, the 5-tab cap (`MAX_SESSIONS`, `cdp-provider.ts:24`), default `browserId: '0'`.

### F7. Storage scope visibility (severity: low; deny-by-design stays)

Root denial of `list yaar://storage/` is intentional (`http/access.ts:162-175`) — no change. Fixes are about *visibility*:

1. The MCP app-agent storage interceptor (`mcp/app-agent/index.ts:187-204, 254-289`) includes the resolved URI in results, so `storage/x` → `apps/devtools/storage/x` is visible instead of silent.
2. For the friction-report workflow: the monitor copies prior reports into devtools' own storage before asking for a comparison (no permission change), or devtools gains a narrow `yaar://storage/reports/` grant in `app.json`. Prefer the copy — no new standing permission.

---

## Suggested execution order

1. **F4** — evaluate `timeoutMs` + `scrollToBottom` + `.d.ts` docs.
2. **F6 + F7** — html metadata + docs; storage-rewrite visibility.
3. **F5.3** — style-only hot swap (separate proposal-sized effort; explicitly deferred).

Verification: `bun run typecheck`, server + shared tests. For F4/F6, exercise the headless browser against a real lazy-loading page rather than trusting the unit path — both items exist because the documented behavior and the actual behavior had drifted apart.
