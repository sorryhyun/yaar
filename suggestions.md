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

### 1. Typed command builder for `app.register`
The single biggest win. There are ~210 hand-written JSON Schema `params` blocks and ~271
handlers across apps, each declaring the shape twice (schema + `p as {...}` cast) with
nothing keeping them in sync. A `defineCommand` helper that derives the JSON Schema from a
typed descriptor (or types the handler from the schema) would delete the largest category
of hand-authored app code. Protocol files are the biggest hand-written surface
(`apps/devtools/src/protocol.ts` is 557 LOC, mostly this boilerplate).

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
