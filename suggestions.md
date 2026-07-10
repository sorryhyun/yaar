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
- `devtools.editFile` — see finding below.
- `image-viewer.setImages` / `.addImages` — see finding below.
- `market-apps.setData` — schema says `items: { type: 'object' }`, handler wants
  `ListedApp[]`.
- `excel-lite.setStyles` — schema is a bare `{ type: 'object' }`, handler wants
  `Record<string, Partial<CellStyle>>`.

The last two are schemas that are genuinely vaguer than their handlers. Tightening them
would change what the agent is told, so it is a deliberate follow-up, not a refactor.

#### Latent bugs the migration surfaced

Both pre-existing, both confirmed against `dist/protocol.json`. Left unfixed here so the
migration commit stays behaviour-neutral.

- **`image-viewer.setImages` / `.addImages` ship no `params` schema at all.** They write
  `params: IMAGE_ITEMS_SCHEMA` — a reference to a module-level const. `extract-protocol.ts`
  is a source parser and cannot resolve a variable, so both commands land in
  `dist/protocol.json` with `params: undefined`. The agent is told nothing about what to
  send. Inline the schema (or teach the extractor to resolve top-level consts).
- **`devtools.editFile` reads params that are not in its schema.** The handler does
  `String(p.search ?? p.oldString)` and `String(p.replace ?? p.newString)`, but only
  `search` / `replace` are declared (their `description`s advertise the aliases in prose).
  No agent will ever send `oldString` / `newString`, so both fallbacks are dead code.

Minor, not a bug: `music-maker.setScale` declares `scale: { type: 'string' }` while the
handler needs the narrower `ScaleType`, so it keeps a cast. An `enum` there would let the
cast go and would tell the agent which scales are legal.

### 2. Surface storage errors instead of letting apps swallow them
17 catch-and-ignore blocks sit around storage saves across apps (`excel-lite/src/state.ts:295`,
`slides-lite/src/storage.ts:7`, `github/src/storage.ts:25,49`, `rss-reader/src/storage.ts:38`).
Consider a save API variant that toasts/reports failure by default, and show `errMsg` /
`showToast` / `withLoading` in the guide's examples — apps re-implement all of them
(inline `e instanceof Error ? e.message : String(e)` appears 14× across 7 apps; `debounce`
re-implemented twice despite bundled lodash; `wait` re-implemented in browser-user).

### 3. Make `subscribe()` real or document polling
The SDK exports `subscribe()` and the docs promote it, but zero apps use it — five apps
run `setInterval` polls instead (`dc-comics`, `thesingularity-reader`, `process-explorer`,
`dock`, `browser`). Either the primitive doesn't fit real needs or it's undiscoverable.
Find out which; if it works, ship one bundled app on it as the reference example.

### 4. Type `appStorage.list()`'s return value
`YaarAppStorage.list()` is declared `Promise<unknown[]>` in
`packages/compiler/src/bundled-types/index.d.ts`, which is why `apps/devtools/src/project.ts`
could read `entry.size` (always `undefined`) and still typecheck. Declaring a
`YaarAppStorageEntry { path; isDirectory; uri; mimeType }` would make that class of bug a
compile error instead of a doc footnote. Note it will surface the existing `entry.size`
read in devtools, which needs fixing at the same time.

### 5. Generate the bundled-library lists
There are three hand-maintained prose copies of the bundled-lib list (compiler CLAUDE.md,
root CLAUDE.md, app-development.md) beside the real one (`plugins.ts` `BUNDLED_LIBRARIES`).
They have already diverged once. Generate the prose from `getAvailableBundledLibraries()`
(already exposed via `GET /api/dev/bundled-libraries`), or add a check like
`scripts/check-doc-freshness.ts` that diffs them.

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
