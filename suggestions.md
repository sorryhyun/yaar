# App-Dev Library: Doc Drift & Improvement Suggestions

Findings from a review of the `@bundled/yaar` SDK surface, the app compiler, and the
docs app authors (mostly AI agents) work from. Bugs found in the same review were fixed
directly (see git history); this file tracks the remaining documentation drift and
improvement opportunities.

## Doc drift

### `appStorage.list()` contract is wrong in the guide
- `docs/app-development.md:387` promises `[{ path, isDirectory, size, modifiedAt }]`; the
  shim (`packages/compiler/src/shims/yaar.ts`) actually returns
  `{ path, isDirectory, uri, mimeType }` — no `size`, no `modifiedAt`. This already
  produced a silent bug: `apps/devtools/src/project.ts:95` reads `entry.size` and always
  gets `undefined`.
- Its shallow (non-recursive) behavior is undocumented; the devtools author discovered it
  the hard way (`apps/devtools/src/project.ts:72` comment).

### Root `CLAUDE.md` bundled-lib list has drifted
- Omits the entire `yaar-ml` gated SDK, plus `solid-js/store` and `cannon-es`.
  `packages/compiler/CLAUDE.md` and `docs/app-development.md` are up to date; root
  `CLAUDE.md` is not. Since agents treat CLAUDE.md as authoritative, they will believe
  in-browser inference doesn't exist.
- There are four hand-maintained copies of the bundled-lib list (`plugins.ts`
  `BUNDLED_LIBRARIES`, compiler CLAUDE.md, root CLAUDE.md, app-development.md) and they
  have already diverged. Consider generating the prose lists from
  `getAvailableBundledLibraries()` (already exposed via `GET /api/dev/bundled-libraries`).

### The main guide omits APIs a third of apps depend on
- `app.sendInteraction()` — used by 9 apps, documented only in
  `docs/app_protocol_reference.md:279`, never in `app-development.md`.
- `app.emit()` / `events` channels and the `onClose` hook — same situation
  (`onClose` is used by zero apps, likely a discoverability problem).
- `app-development.md:322-327` has a register example that calls a `createSignal` getter
  as a setter (`items([...items(), p.text])`) — copy-paste bait for an AI author. The two
  docs also contradict each other (reactive style vs. imperative `render()` style).

### `app.json` has no reference and three id conventions
- Field frequency across 30 apps: `capture` (19) is essentially undocumented; `variant`,
  `agentType`, `createShortcut` (6), `windowStyle`, `frameless`, `dockEdge`,
  `defaultWidth/Height`, `fileAssociations` have zero mentions in the author-facing docs.
  `controls`/`messaging` are documented only in root CLAUDE.md.
- App id is specified three different ways in the wild: implicit folder name (most),
  `"id"` (`apps/github`), `"appId"` (`apps/memo`, `apps/music-maker`). Pick one, document
  it, migrate the outliers.
- Suggestion: publish a single `app.json` field reference (or a JSON Schema — it could
  even be validated at discovery time). When the multi-window proposal lands, `windowMode`
  belongs there too.

### Dead / misleading doc content
- 5 apps ship both `SKILL.md` and `AGENTS.md` (`browser`, `devtools`, `session-logs`,
  `slides-lite`, `video-editor-lite`); per the docs only AGENTS.md is used, so those
  SKILL.md files are dead and silently drifting.
- `app-development.md:249` shows `protocol.json` in the authored file tree, but it is
  compiler-generated (`dist/`), never checked in.
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

### 4. Compiler hygiene
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

### 5. SDK API consistency (minor, breaking-ish — batch for a cleanup pass)
- `yaar-web`'s `navigate(url, browserId)` is the only function taking `browserId`
  positionally; everything else uses `{ ...opts, browserId }`.
- `del(uri)` vs `appStorage.remove(path)` vs `deleteCookies` — three delete verbs in one
  SDK surface.
- `devHeaders()` / `browserHeaders()` are byte-identical private helpers in
  `yaar-dev.ts` / `yaar-web.ts`; share one.

### Known quirk worth documenting
`appStorage.readBlob('*.pdf')` returns the **first page rendered as PNG**, not the PDF
bytes — the server converts PDFs to page images on read
(`packages/server/src/handlers/apps.ts:151-154`). Apps that need raw bytes should use the
`/api/storage/` URL directly. `apps/pdf-viewer`'s `openFromStorage` is affected today.
