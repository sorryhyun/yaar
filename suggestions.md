# App-Dev Library: Doc Drift & Improvement Suggestions

Findings from a review of the `@bundled/yaar` SDK surface, the app compiler, and the
docs app authors (mostly AI agents) work from. Bugs found in the same review were fixed
directly (see git history); this file tracks the remaining documentation drift and
improvement opportunities.

The documentation-drift items have been fixed (see the `docs: fix app-dev doc drift`
commit): the `appStorage.list()` contract, the root `CLAUDE.md` and guide bundled-library
lists, the `app.register` signal-setter example (English + Korean), the missing
`sendInteraction` / `emit` / `onClose` docs, the `app.json` field reference, and the
`readBlob()`-on-PDF quirk. What remains below is code, not prose.

## Inert manifest fields (code cleanup)

Verifying the doc-drift findings turned up two fields that no code reads. They were
documented as ignored rather than deleted, since removing them touches `apps/`:

- **`capture`** (`"dom"` / `"canvas"`) — carried by 19 bundled apps, read by nothing. It
  once named a screenshot strategy for a `window.capture` tool removed in the
  "legacy removal" commit; the manifest field outlived the feature. Either delete it from
  all 19 `app.json` files or re-wire it to whatever replaced `window.capture`.
- **`id` / `appId` in `app.json`** — the folder name is the only app id;
  `discovery.ts` never reads `meta.id` or `meta.appId`. So `apps/github` (`"id"`) and
  `apps/memo` / `apps/music-maker` (`"appId"`) are carrying dead keys. This supersedes the
  original "three id conventions, pick one and migrate" finding: there is only one
  convention, and the other two are no-ops. Just delete the keys. (The `appId` passed to
  `app.register()` in app source is a separate, live thing.)

## Doc drift — remaining

- 5 apps ship both `SKILL.md` and `AGENTS.md` (`browser`, `devtools`, `session-logs`,
  `slides-lite`, `video-editor-lite`); per the docs only AGENTS.md is used, so those
  SKILL.md files are dead and silently drifting. Delete them or make the loader merge them.
- Advertised-but-unused bundled libraries: `clsx`, `konva`, `pixi.js`, `p5`, `cannon-es`,
  `matter-js` are imported by zero apps. Either trim the advertising or keep them and say
  nothing — but the guide currently reads as a recommendation list.

## Improvement suggestions (by leverage)

### 1. Typed command builder for `app.register` — **shipped and adopted**
`defineCommand` now derives a command handler's parameter type from its `params` JSON
Schema, so the schema is the single source of truth and a stale handler annotation is a
compile error instead of a runtime surprise. It is an identity function at runtime;
`dist/protocol.json` and the agent-facing manifest are unchanged.

Of the two options originally sketched, this is "types the handler from the schema", not
"derives the schema from a typed descriptor". The schema has to stay a plain object
literal because `extract-protocol.ts` is a source *parser*, not an evaluator — it cannot
see through a `str('Page URL')` helper. Deriving schemas from a terser descriptor would
mean evaluating the protocol module at build time (or replacing the extractor with a
proper AST walk), which is a much larger change than the win justifies. The schema was
never the redundant half anyway: its `description` strings are the agent's contract.

- `packages/compiler/src/bundled-types/index.d.ts` — `YaarInferSchema` + `defineCommand`
  overloads. Handles `enum` (→ literal union), the primitive types, `array`/`items`,
  `object`/`properties`/`required`, and `object`/`additionalProperties` (→ `Record`),
  nested. `anyOf`/`oneOf`/`$ref` degrade to `unknown`.
- `packages/compiler/src/shims/yaar.ts` — the runtime identity function.
- `packages/compiler/src/extract-protocol.ts` — steps over a single identifier call
  wrapping a descriptor literal. Verified manifest-identical across all 22 apps.
- `packages/compiler/src/define-command.test.ts` — runs real `tsc` over fixtures, since
  nothing else in the suite would notice the type machinery breaking.

**Adoption:** all 22 apps migrated — 166 of 172 commands wrapped, every extracted manifest
byte-identical to its pre-migration baseline, all 22 still compile. The plain-literal form
still works and the two mix freely within one `commands` block, which is why the remaining
six can stay as they are:

- `devtools.readFile` — `path` uses `oneOf`.
- `image-viewer.setImages` / `.addImages` — see finding below.
- `market-apps.setData` — schema says `items: { type: 'object' }`, handler wants
  `ListedApp[]`.
- `excel-lite.setStyles` — schema is a bare `{ type: 'object' }`, handler wants
  `Record<string, Partial<CellStyle>>`.

The last two are schemas that are genuinely vaguer than their handlers. Tightening them
would change what the agent is told, so it is a deliberate follow-up, not a refactor.

#### Latent bugs the migration surfaced

All pre-existing, all confirmed against `dist/protocol.json`.

**Fixed:**

- **Concatenated descriptions were silently truncated.** `extractStringProp` took only the
  first literal of a `'a' + 'b'` expression, so every description written across two lines
  lost everything after the first `+` — 15 command and 6 state descriptions across 5 apps.
  The agent was reading half a sentence: `browser-user.screenshot` never mentioned that the
  tab must be focused first, and `slides-lite.theme` listed one of its four valid themes.
  The runtime manifest (built from the live descriptor in `app-protocol.ts`) was always
  correct; only the build-time `protocol.json` that seeds the agent's prompt was clipped.
  Now the literals are joined, stopping at the first non-literal operand.
- **`devtools.editFile` could write the string `"undefined"` into a source file.** The
  handler did `String(p.replace ?? p.newString)` with no guard on the result — only `search`
  was checked. Nothing validates params against the schema (`command` takes
  `z.record(z.string(), z.unknown())` and passes it through), so `required` is advisory: an
  agent omitting `replace` got `"undefined"` substituted into its own code, reported as
  success. Its `oldString` / `newString` aliases were also real but undeclared, advertised
  only in prose inside a `description`. Both aliases are now in the schema (with only `path`
  required) and both operands are guarded, `''` still being a legal replacement.
- **`editFile` expanded `$` patterns in the replacement.** It passed the replacement to
  `String.prototype.replace` as a string, so `$&`, `$1`, `` $` `` and `$'` were interpreted
  — replacing with source that contains a `$` corrupted the file (`` $` `` splices in the
  entire preceding file). Now uses a function replacer, which inserts the text literally.

**Open:**

- **`image-viewer.setImages` / `.addImages` ship no `params` schema at all.** They write
  `params: IMAGE_ITEMS_SCHEMA` — a reference to a module-level const. `extract-protocol.ts`
  is a source parser and cannot resolve a variable, so both commands land in
  `dist/protocol.json` with `params: undefined`. The agent is told nothing about what to
  send. Inline the schema (or teach the extractor to resolve top-level consts).

Minor, not a bug: `music-maker.setScale` declares `scale: { type: 'string' }` while the
handler needs the narrower `ScaleType`, so it keeps a cast. An `enum` there would let the
cast go and would tell the agent which scales are legal.

### 2. Surface storage errors instead of letting apps swallow them — **shipped**
`appStorage.trySave(path, content, { encoding?, label?, onError? })` is the reporting save:
it resolves `false` instead of throwing, always logs, and toasts once per 5s per path (an
autosave retries every tick, so an undeduped toast would be a stream). A success re-arms the
toast. `onError` replaces the toast — never the log — for apps with their own error surface.
`createPersistedSignal` now writes through it and forwards both options.

- `packages/compiler/src/shims/yaar.ts` — `trySave` + the dedup, `createPersistedSignal`.
- `packages/compiler/src/bundled-types/index.d.ts` — `YaarAppStorageTrySaveOptions`.
- `packages/compiler/src/shims/yaar.test.ts` — stubs `window.yaar`/`document` and imports the
  real shim. `src/shims/**` is tsconfig-excluded, so the file runs under `bun test` without
  entering the build.
- `docs/app-development.md` + `docs/ko/app-development.md` — "Never swallow a failed save" and
  "Error handling helpers" sections, plus two anti-pattern bullets.

**The bug it was really about.** `slides-lite.persist()` called the swallowing `saveDeck()`
without awaiting it, then unconditionally cleared the dirty flag, stamped `lastSavedAt`, and
toasted "Saved". A failed write was reported to the user as a successful one. `persist()` now
awaits, holds back all three on failure, and the topbar chip reads "Not saved" instead of
"Saving…" forever. `word-lite` had the same shape via `createPersistedSignal` +
`setSaveStateText('Saved at …')`; it now passes `onError` to overwrite that label.

Verified against the compiled bundle in a browser (not just unit tests): stubbing
`window.yaar.invoke` to reject drives the chip Saved → Not saved → Saved across a
fail/recover cycle, with 3 failures logged and 1 toast shown.

**The counts in the original finding were wrong**, which is worth recording since they were
cited as evidence:

- "17 catch-and-ignore blocks around storage saves" — there were **two**
  (`excel-lite/src/state.ts:295` autosave, `slides-lite/src/storage.ts:7`). Both are gone.
  `rss-reader/src/storage.ts:38` is a *read* miss on an optional file, and
  `github/src/storage.ts:25,49` swallow `remove()` of a possibly-absent token. Both are
  correct as written and were left alone.
- "`wait` re-implemented in browser-user" — it is not; no app re-implements `wait`.
- "`debounce` re-implemented twice despite bundled lodash" — true, and fixed: `slides-lite`
  and `word-lite` now import it from `@bundled/lodash`, as `excel-lite` already did.
- "inline `e instanceof Error ? … : String(e)` 14× across 7 apps" — roughly right (20 sites,
  9 apps). Left as-is: the guide now shows `errMsg`, which is what the finding actually asked
  for. Mechanically rewriting 20 call sites across apps that already import `errMsg` for
  *other* lines is a separate, reviewable sweep.

Still open, deliberately: `github/src/storage.ts` `writeToken`/`writeClientId` swallow a failed
`storage.remove()`, so a logout that fails to delete the token reports success. That is the raw
`storage` SDK, not `appStorage`, and it has no `trySave` equivalent.

### 3. Make `subscribe()` real or document polling
The SDK exports `subscribe()` and the docs promote it, but zero apps use it — five apps
run `setInterval` polls instead (`dc-comics`, `thesingularity-reader`, `process-explorer`,
`dock`, `browser`). Either the primitive doesn't fit real needs or it's undiscoverable.
Find out which; if it works, ship one bundled app on it as the reference example.

### 4. Type `appStorage.list()`'s return value — **shipped**
`YaarAppStorage.list()` now returns `Promise<YaarAppStorageEntry[]>`, where each entry has
`path`, `isDirectory`, `uri`, and optional `mimeType`. The runtime shim carries the same
return type. The bogus `entry.size` read and casts in devtools are gone; Excel's duplicate
raw-storage shape was removed too. Type-level tests verify both the supported fields and
that `entry.size` is a compile error.

### 5. Generate the bundled-library lists — **shipped as a freshness check**
The existing `scripts/check-doc-freshness.ts` now extracts `@bundled/*` imports from the
Bundled Libraries sections in the root CLAUDE.md, compiler CLAUDE.md, and
app-development.md, then compares each set exactly with `plugins.ts` `BUNDLED_LIBRARIES`.
The existing `bun run check:docs` CI step therefore fails on either a missing or a stale
extra entry. The two CLAUDE lists now spell out full `@bundled/*` import paths so the check
reads the same visible prose app authors use rather than relying on hidden metadata.

### 6. Compiler hygiene
- Merge the two `onLoad` hooks that each read every `.ts` source file
  (`solidHtmlTemplateGuardPlugin` + `solidHtmlClosingTagPlugin` in
  `packages/compiler/src/plugins.ts`) — every file is currently read from disk twice per
  compile.
- Gate the verbose per-resolution `console.log`s in `bundledLibraryPluginBun` behind a
  debug env var — they run multiple lines per `@bundled/*` import on every compile and
  leak filesystem paths into server logs.
- `typecheckSandbox` doesn't know about the `bundles` gate: gated-SDK imports typecheck
  fine and only fail later at compile time — a confusing two-step failure for authors.
  Thread `bundles` through and drop the gated module declarations when not granted.
- `extract-protocol.ts` `extractStringArrayProp` still uses naive `'` → `"` replacement
  where `extractObjectProp` already has `normalizeToJson()`; reuse it.
- The solid-html-guard's template detection assumes the tag is literally `` html` ``
  (tight, no line break) and that any `html` tagged template is solid's. All 20 current
  apps satisfy this; worth a comment in the guard since it is a hard build-failure gate.

### 7. SDK API consistency (minor, breaking-ish — batch for a cleanup pass)
- `yaar-web`'s `navigate(url, browserId)` is the only function taking `browserId`
  positionally; everything else uses `{ ...opts, browserId }`.
- `del(uri)` vs `appStorage.remove(path)` vs `deleteCookies` — three delete verbs in one
  SDK surface.
- `devHeaders()` / `browserHeaders()` are byte-identical private helpers in
  `yaar-dev.ts` / `yaar-web.ts`; share one.
