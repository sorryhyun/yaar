# Devtools Friction Fixes & Protocol Diet

**Source:** `storage/devtools-friction-report-2026-07-20.md` + `storage/friction-comparison-2026-07-20.md` (app-agent + monitor reports from the dc-comics 짤방댓글 session), verified against the codebase on 2026-07-20.

The reports are accurate. Every mechanical claim was confirmed at the code level — error strings, the hardcoded CDP timeout, the missing line-range anchoring, the deliberate preview remount. One report hypothesis is wrong (item 6's cookie-isolation guess; see F6), which itself argues for the documentation fixes below.

The recurring theme across three sessions of reports: **devtools cannot see inside what it builds.** F1 (screenshot) and F3 (previewEval) attack that directly.

---

## Part 1 — Friction fixes

### F1. `previewScreenshot`: distinguishable failure reasons (severity: critical)

**Root cause.** The capture path is a postMessage self-capture: `read('yaar://windows/{wid}')` → server emits `window.capture` (`packages/server/src/handlers/window.ts:286-311`) → frontend posts `yaar:capture-request` into the iframe (`packages/frontend/src/store/iframe-bridge/capture.ts`) → injected script serializes the DOM to a foreignObject SVG and draws it to a canvas (`packages/shared/src/iframe-scripts/capture.ts`).

Two defects compound:

1. Any canvas taint makes `toDataURL` throw and the script returns bare `null` (`capture.ts:48`). dc-comics renders scraped external image URLs — anything the URL-stripping pass misses taints the canvas, so the failure was likely *deterministic*, not a paint race.
2. The frontend bridge **ignores null responses** (`iframe-bridge/capture.ts:32`), so "capture failed: taint" is indistinguishable from "no capture handler" — both time out and surface as the misleading "may not have painted yet" message, which induces useless retries.

**Fix.** Apply the `consoleLogs` `connected`-flag pattern end to end:

- `iframe-scripts/capture.ts`: respond `{ imageData: null, reason: 'taint' | 'zero-size' | 'serialize-error' | 'no-provider' }` instead of bare `null`; wrap each failure site to attach its reason.
- `iframe-bridge/capture.ts`: stop ignoring null responses; forward `reason` in `RENDERING_FEEDBACK` (distinct from the 2 s timeout, which becomes `'no-response'`).
- `handlers/window.ts`: when feedback has no image, include `captureFailure: reason` in the JSON fallback.
- `apps/devtools` `previewScreenshot`: replace the guessing error message with the actual reason and a correct recovery hint per reason (`taint` → "an external resource tainted the canvas; retrying will not help — check for non-`data:` URLs in the DOM").

*Touches:* `packages/shared/src/iframe-scripts/capture.ts`, `packages/frontend/src/store/iframe-bridge/capture.ts`, `packages/server/src/handlers/window.ts`, `apps/devtools/src/protocol/preview.ts`, `apps/devtools/src/preview.ts`.

### F2. `editFile` line-range: anchor + echo (severity: critical — silent code loss)

**Root cause.** `applyEdit` (`apps/devtools/src/project.ts:375-393`) validates only that the range is numerically in bounds. Search mode anchors on content (`content.includes(search)`); line mode anchors on nothing, so a stale line number splices into the wrong place. The result `{ editsApplied, lines }` doesn't show what was removed.

**Fix.**

1. Add `anchor` (string) to line-range edits: the current text of `startLine` (trimmed compare). Mismatch → reject with the actual line text in the error, nothing written. **Required**, not optional — an optional safety param is one an agent under token pressure will skip.
2. Echo removed content: result gains `removed` (the replaced text, truncated to ~500 chars with head/tail). A wrong splice becomes visible in the same turn.
3. Update the command description + AGENTS.md `## Files` accordingly.

*Touches:* `apps/devtools/src/project.ts`, `apps/devtools/src/protocol/files.ts`, `apps/devtools/AGENTS.md`.

### F3. `previewEval` (severity: highest leverage — 3-session recurring workaround)

**Root cause.** `app_query`/`app_command` dispatch only to handlers the app registered (`packages/server/src/features/window/app-protocol.ts`); there is no arbitrary-expression path into the preview iframe. Hence the plant-a-debug-command → compile → verify → remove → recompile loop (3× this session, ~20 turns; same pattern on 7-13).

**Fix.** New `app_eval` protocol kind, handled by the already-injected iframe SDK script (same channel as `yaar:capture-request`), surfaced as `previewEval({ expression })` in devtools.

**Scope guard:** allowed only on windows devtools itself created as previews (`devtools-preview-{projectId}` ids, throwaway `preview--{projectId}` principals). The server handler rejects `app_eval` for any non-preview window, so this never becomes a generic eval-into-any-app door. The report's security framing is correct: the preview is a disposable sandbox; blocking eval there costs much and protects nothing.

Result contract: `{ value }` (JSON-serialized, size-capped ~16KB with truncation marker) or `{ error }` with the thrown message. This also becomes the fallback when F1 reports a taint — structure checks without replacing pixels.

*Touches:* `packages/shared/src/iframe-scripts/` (eval responder), `packages/server/src/features/window/app-protocol.ts` + `handlers/window.ts` (new action + preview-window guard), `apps/devtools/src/protocol/preview.ts`.

### F4. `evaluate` timeout + `scrollToBottom` (severity: medium, cheap)

**Root cause.** `CDPClient.send(method, params, timeout = 15_000)` — hardcoded default (`packages/server/src/lib/browser/cdp.ts:52`), no caller overrides it. `evaluate` uses `awaitPromise: true`, so page-side sleeps count against the 15 s. Neither the shim nor the `.d.ts` mentions the limit. `scroll` is a fixed 500 px step (`session.ts:689-702`) with no amount exposed.

**Fix.**

1. Thread `timeoutMs` through `yaar-web.evaluate` → `features/browser/actions.ts#handleEvaluate` → `session.evaluate` → `send(..., timeout)`, capped at 120 000 (matching the shim's fetch abort).
2. Add `scrollToBottom({ maxSteps?, dwellMs?, browserId? })` in `session.ts`: loop `scrollBy(0, viewportHeight)` until `scrollHeight` stabilizes or `maxSteps` (default 40); return `{ steps, finalHeight, reachedBottom }`.
3. `.d.ts` (`packages/compiler/src/bundled-types/index.d.ts`): document the timeout on `evaluate`, add `scrollToBottom`, and fix `html()`'s declared return (see F6).

*Touches:* `packages/server/src/lib/browser/cdp.ts`, `session.ts`, `packages/server/src/features/browser/actions.ts`, `packages/compiler/src/shims/yaar-web.ts`, `packages/compiler/src/bundled-types/index.d.ts`.

### F5. Compile remount / lost preview state (severity: medium, mitigate — don't rebuild)

**Root cause.** Deliberate: `build.ts:54-58` → `openPreview()` close + create ("a new build is a new app"). The actual pain was not the remount but re-running ~60 s of live scraping to rebuild in-iframe state.

**Fix, tiered:**

1. **Now (docs):** document in AGENTS.md that compile remounts and resets app state, and that first headless-browser calls after a cold start can return empty (`postCount: 0`-style) results — retry once before diagnosing app bugs.
2. **Now (pattern):** AGENTS.md guidance — apps whose state is expensive (network scraping) should cache results in `appStorage` keyed by source URL + TTL, so a remount rehydrates instantly. This fixes the 8×-full-scrape cycle for every future app, not just dc-comics.
3. **Later:** style-only hot swap — when a recompile's diff against the previous bundle is confined to CSS, swap `<style>` content in the live iframe instead of remounting. Requires the compiler to emit styles separably; do not attempt as part of this batch.

### F6. `web.html()` semantics + tab isolation docs (severity: low, docs + small API)

**Confirmed:** `getHtml` returns `document.body.innerHTML` — a fragment, no doctype/head/title, no metadata (`session.ts:733-740`). **Report's hypothesis corrected:** every `browserId` is a new tab in *one shared Chrome profile* (`cdp-provider.ts:329` via `/json/new`; single `--user-data-dir`, `chrome.ts:139-176`) — cookies/localStorage are **shared** across browserIds within a provider. The empty-img_comment mystery was not cookie isolation; likely referrer/JS-state dependent serving. Isolation exists only between the headless sandbox and the user's real Chrome (separate providers, `pool.ts:121-143`).

**Fix.**

1. `html({ includeMeta: true })` → `{ html, url, title, readyState }` (opt-in; default stays a bare string for compatibility). Optionally `outerHTML: true` for the full document.
2. Document in the `.d.ts`: fragment semantics, shared-profile tab semantics, the 5-tab cap (`MAX_SESSIONS`, `cdp-provider.ts:24`), default `browserId: '0'`.

### F7. Storage scope visibility (severity: low; deny-by-design stays)

Root denial of `list yaar://storage/` is intentional (`http/access.ts:162-175`) — no change. Fixes are about *visibility*:

1. The MCP app-agent storage interceptor (`mcp/app-agent/index.ts:187-204, 254-289`) includes the resolved URI in results, so `storage/x` → `apps/devtools/storage/x` is visible instead of silent.
2. For the friction-report workflow: the monitor copies prior reports into devtools' own storage before asking for a comparison (no permission change), or devtools gains a narrow `yaar://storage/reports/` grant in `app.json`. Prefer the copy — no new standing permission.

### F8. Non-reproducible observations (severity: low, prompt-only)

Add one AGENTS.md line under Preview & Debugging: network-dependent probe results (scrape counts, lazy-load outcomes) must be confirmed twice before being reported as fact. No `repeat: N` helper for now — not worth a command slot (see Part 2).

---

## Part 2 — Protocol diet

**Current weight.** `dist/protocol.json` = **19,651 chars (~4.9k tokens), 32 commands, 9 state keys**. On top: AGENTS.md 24.8KB (~6.2k tokens) + auto-appended App Authoring Contract + Controllable Apps section. The app agent boots with **roughly 11-12k tokens of standing prompt** before any conversation. There is headroom.

Heaviest commands (JSON chars): `editFile` 1908, `importAsset` 1112, `readFile` 898, `listMedia` 662, `copyFile` 607, `gitDiff` 607, `manifest` 580, `deploy` 559.

### D1. Cut / merge commands: 32 → 27

| Command | Action | Rationale |
| --- | --- | --- |
| `typecheck` | **Cut** | Its own description says "`compile` already does this." `compile` + `skipTypecheck` covers every case. |
| `openFile` | **Cut** | Fully subsumed by `readFile({ openInEditor: true })`, which the manifest already documents. |
| `viewPreview` | **Merge** into `previewScreenshot({ info?: true })` | Both call `readPreview()`; viewPreview = screenshot + geometry. One command, one flag, one fewer decision point. |
| `describeUri` + `listUri` | **Merge** into `inspectUri({ uri, list?: true })` | Same introspection concern, two schema blocks for one job. |
| `clearConsole` | **Cut** | Lowest-value slot; `consoleLogs` reads are timestamped, agents can ignore old entries. (Keep if the UI button routes through it — verify before removing.) |

Net after F3 adds `previewEval`: **28 commands**.

### D2. Slim descriptions — the bigger win (~19.6KB → ~12KB)

Two principles:

1. **The manifest states contract, not pedagogy.** What params exist, what returns, what's destructive. *When/why/workflow* prose belongs in AGENTS.md — which is only loaded for the devtools agent itself, while `protocol.json` is also served to every controlling/inspecting agent.
2. **One home per fact.** AGENTS.md promises "this document covers only what the manifest does not tell you," then re-teaches `editFile`'s three modes, `readFile`'s params, `copyFile`, and the media import flow — all already in the manifest. Each fact keeps exactly one home: mechanics → manifest, procedure → AGENTS.md.

Concrete targets:

- `editFile` 1908 → ~800: mode list in one sentence each; drop the aliases from prose (keep the schema properties); the worked multi-edit explanation lives in AGENTS.md only.
- `importAsset` 1112 → ~500: contract only (copies from media/, WebP by default, returns import line). Bundle-size guidance already lives in AGENTS.md §Static Assets.
- `readFile` 898 → ~450: params speak through the schema; drop restated behaviors.
- `listMedia` 662 → ~300, `copyFile` 607 → ~250, `gitDiff` 607 → ~400, `manifest` 580 → ~300 (drift pedagogy already in AGENTS.md §Preview & Debugging).

### D3. AGENTS.md dedupe (~24.8KB → ~18KB)

Remove the manifest-restating halves of `## Files` and `### Assets the user made in another app`; keep the procedural content (read-before-edit rule, all-or-nothing semantics warning, publish/relay recovery when `listMedia` is empty). Add the small new sections from F5/F8. Net: prompt shrinks even after additions.

**Combined effect:** standing prompt ~11-12k → **~8k tokens**, with F1-F3's new capabilities included.

---

## Suggested execution order

1. **F1** — screenshot failure reasons (restores the two-sessions-running top request; the `reason` field will also confirm the taint hypothesis).
2. **F2** — editFile anchor + removed-echo (smallest diff, kills the only silent-corruption path).
3. **F3** — `previewEval` (largest turn-count win).
4. **D1 + D2 + D3** — protocol diet (one batch: cut, slim, dedupe, recompile devtools, verify with `manifest`).
5. **F4** — evaluate `timeoutMs` + `scrollToBottom` + `.d.ts` docs.
6. **F6 + F7** — html metadata + docs; storage-rewrite visibility.
7. **F5.3** — style-only hot swap (separate proposal-sized effort; explicitly deferred).

Verification for the batch: `bun run typecheck`, server + shared tests, recompile devtools and diff `dist/protocol.json` size, then one live pass — compile a scratch project, force a tainted-canvas preview, and confirm `previewScreenshot` reports `reason: 'taint'` while `previewEval` still answers structure queries.
