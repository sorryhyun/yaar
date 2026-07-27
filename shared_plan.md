# `packages/shared` — structure & deduplication plan

Findings from a full read of the package plus every consumer that imports it. Ordered by payoff.
Each item states what is wrong, the evidence, the change, and how to verify it.

**Landed so far:** the entry-point split (`@yaar/shared` vs `@yaar/shared/schemas`) — the frontend
bundle went from 539 `zod` references to 0 — and the dead-export deletion. What remains below is
surface reduction and drift-proofing; none of it changes behavior except item 1, which removes an
unwritten load-order contract.

---

## 1. Three implementations of one iframe bootstrap, with a load-order dependency

**Now.** Token / API-base bootstrap is written three times, each differently:

| file | reads URL `__yaar_token` | reads `__yaar_api` | token freshness |
|---|---|---|---|
| `iframe-scripts/verb-sdk.ts:16-38` | yes — writes `window.__YAAR_TOKEN__` | yes | live, per call |
| `iframe-scripts/storage-sdk.ts:18-34` | yes — keeps a local | yes | live, per call |
| `iframe-scripts/fetch-proxy.ts:14-32` | **no** | yes | **snapshot at install** |

`fetch-proxy` works only because `verb-sdk` runs before it in both injection sites
(`packages/compiler/src/compile.ts:77-89` and
`packages/frontend/src/components/window/renderers/IframeRenderer.tsx:333-345`) and back-fills
the global it reads. Reorder that array and cross-origin fetches lose their token, silently.

Also duplicated verbatim across these scripts:

- base64 → `ArrayBuffer` → `new Response(...)` — `verb-sdk.ts:158-172` ≡ `fetch-proxy.ts:134-147`
  (14 lines each, character-identical)
- the install-guard preamble (`if (window.__yaarXInstalled) return; … = true`) — 9 copies
- `window.yaar = window.yaar || {}` — 5 copies
- `storage-sdk`'s `res.json().catch(…).then(err => { throw … })` unwrap — 4 copies of 5 lines

**Change.** New `src/iframe-scripts/prelude.ts` exporting composable **string fragments** (these
files are template literals, so composition is interpolation):

```ts
export const installGuard = (flag: string) => `…`;   // one spelling of the guard
export const API_BOOTSTRAP = `…`;                    // __yaar_token + __yaar_api, one semantics
export const TOKEN_HEADERS = `…`;
export const RESPONSE_FROM_PROXY = `…`;              // the base64 → Response block
export const JSON_ERROR_UNWRAP = `…`;
```

Pick one token semantics for all three — read the URL param *and* prefer a live
`window.__YAAR_TOKEN__` at call time, i.e. the `storage-sdk` behavior — which removes the
ordering contract rather than documenting it.

**Verify.** The iframe scripts are already exercised by evaluating them against a stub window
(`src/tests/app-protocol-params.test.ts:29-38`, `fetch-proxy.test.ts`,
`capture-url-strip.test.ts`), so this is testable without a browser. Add one case asserting
`fetch-proxy` picks up a URL-only token with no `verb-sdk` present. Then compile an app and
confirm `dist/index.html` still boots (`make claude-dev`, open one bundled app).

---

## 2. The `yaar:*` message vocabulary is declared three times, and has already drifted

**Now.** The same names live as raw strings inside the iframe scripts, as TS literal types in
`src/app-protocol.ts:167-261`, and as a hand-written union in
`packages/frontend/src/lib/iframeMessageRouter.ts:61-74` — whose comment claims the scripts
*"can't participate in the type system."* They can: interpolation.

Drift already present: `'yaar:contextmenu'` appears in the frontend union
(`iframeMessageRouter.ts:63`) and two doc comments, but **no script posts it and no handler
listens for it**. It is a phantom.

**Change.**

- Add `export const APP_MSG = { … } as const` to `src/app-protocol.ts` naming every
  `yaar:*` postMessage type (app-protocol, capture, contextmenu, console, notifications,
  subscription, stream).
- Interpolate it in the scripts: `type: '${APP_MSG.queryResponse}'`.
- Derive the frontend union from it: `type YaarMessageType = (typeof APP_MSG)[keyof typeof APP_MSG]`,
  and delete `'yaar:contextmenu'`.

**Same file, same theme:** `src/iframe-scripts/app-protocol.ts:365-493` contains 12 near-identical
`window.parent.postMessage({ type, requestId, result/data, error })` blocks across the query and
command handlers. A `reply(type, requestId, payload)` helper plus a `settle(valueOrPromise, key)`
that folds the sync / thenable / throw triplet collapses ~90 lines to ~20, with no behavior
change. The existing `app-protocol-params.test.ts` and `app-protocol-registration.test.ts` cover
the paths.

---

## 3. Smaller structural items

**3a. `WindowState` ⟷ `WindowCreateAction` duplicate 8 fields and their doc comments.**
`actions.ts:103-150` — `appId`, `variant`, `dockEdge`, `frameless`, `windowStyle`, `minimized`,
`isolateOrigin`, `appOrigin`, with `isolateOrigin`/`appOrigin` carrying two prose paragraphs each
in `WindowState` and a "see WindowState" pointer in the action. Extract
`interface WindowPresentation { … }` and spread it into both; the doc lives once.

**3b. No compile-time check that the event constant tables and the unions agree.**
`ClientEventType` (20 keys) and `ClientEvent` (20 members) currently match, as do
`ServerEventType` / `ServerEvent` (17 each) — by hand. Add to `events.ts`:

```ts
type _NoOrphanClientEvents =
  Exclude<(typeof ClientEventType)[keyof typeof ClientEventType], ClientEvent['type']> extends never
    ? true : ['client event type with no interface'];
type _NoOrphanServerEvents = /* mirror */;
```

Four lines, and drift becomes a type error instead of a runtime `default:` fallthrough.

**3c. `events.ts` is 708 lines holding three concerns.** Lines 8-138 are the routing tables and
predicates (`ANSWER_EVENT_TYPES`, `CONTROL_EVENT_TYPES`, `isAnswerEvent`, `isControlEvent`), then
client events, then server events. Split into `events/routing.ts`, `events/client.ts`,
`events/server.ts` with `events/index.ts` re-exporting — import sites stay identical. The long
rationale comments move with their subject.

**3d. `index.ts` is not a barrel.** It declares `SessionId`, `MonitorId`, `DEFAULT_MONITOR_ID`,
`MAX_MONITORS` inline, and mixes `export *` for four modules with hand-maintained named lists for
`yaar-uri`, `bridge` types, and `iframe-scripts`. Move the session/monitor constants to
`src/session.ts`; convert the `yaar-uri` and `iframe-scripts` lists to `export *`. (The `bridge`
type list must stay explicit — a bare `export *` would re-export its Zod schemas onto the barrel and
undo the entry-point split. The `CLAUDE.md` export inventory, which documented two `yaar-uri`
functions that never existed, has been corrected.)

**3e. The Component DSL declares every field twice, now across two files.** The flat Zod
`baseFields` (`components.ts:40-101`) and the seven hand-written component types
(`component-types.ts:76-153`) describe the same props. The `satisfies` bindings
(`component-types.ts:22-61`) cover only the enum *value lists*, so a prop added to one side is
silent on the other. Either derive the types from the schema or add a `satisfies` check per
component binding its keys to `keyof typeof baseFields` — note this now crosses a file boundary in
the direction `components.ts` → `component-types.ts`, which is the direction the imports already
run. Low urgency — the split is deliberate (flat schema for the LLM, narrow types for renderers)
and should stay.

**3f. `yaar-uri.ts` repeats "split path at first slash" three times** — `resolveContentUri:78-81`,
`extractAppId:139-140`, `parseBareWindowUri:232-237`. One `splitFirst(path)` helper. Separately,
`YAAR_RE` (line 43) re-lists the nine authorities already enumerated in the `YaarAuthority` type;
derive the regex from a `const AUTHORITIES = [...] as const satisfies readonly YaarAuthority[]`.

---

## Suggested sequencing

| Phase | Items | Risk | Why |
|---|---|---|---|
| 1 | **#1** iframe prelude | medium | removes a real latent failure; do it while the scripts are still small |
| 2 | **#2** message vocabulary | medium | crosses into the frontend; wants #1's prelude in place |
| 3 | **#3a–3d** | low | cleanup; 3b is 4 lines and could ride along with any phase |
| 4 | **#3e, 3f** | low | optional |

Verification for every phase: `bun run typecheck`, `bun run --filter @yaar/shared test`,
`bun run --filter @yaar/frontend test`, `bun run --filter @yaar/server test`, plus one real
`make claude-dev` boot with a bundled app opened for phases 1 and 2 (the iframe scripts are not
fully covered by unit tests — capture and contextmenu in particular).

Standing check after any change to `index.ts`: `bun run build && grep -c zod
packages/frontend/dist/main-*.js` must stay at 0.
