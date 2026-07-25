# Proposal: An embedded app DSL — `defineApp()`, Zod-first schemas, replay-safe commands

**Status:** Partially implemented — Parts 1, 2, 3, Part 5's extraction half, and the migration
of every bundled app have shipped. Part 4 (`persist`) is open; see **Next action**.
**Scope:** `packages/compiler` (shims, AST extractor, guards), `packages/shared` (iframe scripts),
`packages/server` (command replay), apps (incremental migration)
**Companion:** [`apps_modernization_proposal.md`](./apps_modernization_proposal.md) — cleanup of the
existing apps against today's conventions. This proposal changes the platform so those conventions
stop needing manual discipline.

## Summary

A single blessed entrypoint for apps:

```ts
export default defineApp({
  id: 'memo',
  state: { ... },      // Zod schemas as the single source of truth
  commands: { ... },   // Zod params → JSON Schema derived at build time
  persist: { ... },    // declarative persisted state
  view: App,           // Solid component; defineApp owns render() + registration timing
});
```

Not an external DSL — the apps are too diverse (a spreadsheet, a video editor, and a VN engine
cannot share a declarative schema). An *embedded* one: a construct that collapses the ceremony
every app repeats, gives the AST extractor one canonical shape instead of heuristics, unifies
the two parallel schema systems (JSON-Schema literals vs `@bundled/zod`), and carries the
per-command replay policy that fixes the platform's worst structural bug. `app.register()`
remains supported; `defineApp` is sugar over it plus build-time knowledge.

## Shipped

**Part 2 — Zod-first schemas.** `params`/`returns`/`schema` accept a Zod schema (or any
Standard Schema). One declaration now drives four things: the TS type of `run`'s parameter,
runtime type-deep validation, `dist/protocol.json`, and the manifest the iframe serves.

The fold does not teach the AST evaluator Zod's API — it runs the app. `z.object({...})` is a
builder chain, so the evaluator *defers* it (records the descriptor path) instead of erroring,
and `fold-schemas.ts` builds the app together with a generated entry importing `@bundled/zod`,
then evaluates the default export. Deferral is legal only under `defineApp`, because only
there is the config reachable at runtime as a default export; `app.register()` keeps the hard
error. Nothing degrades silently: a schema with no JSON Schema equivalent, an app that throws
on import, a worker that hangs — each fails the build naming the descriptor path.

Two decisions differ from what this document proposed:

- **A Worker, not a subprocess.** A bundled exe has no `bun` binary to spawn — `process.execPath`
  there is the YAAR executable, which would relaunch the server. A Worker gives the same
  separate globals plus a `terminate()` that actually stops a runaway module scope. The
  `window` stub the proposal predicted is still required and still for the reason predicted.
- **`__yaar_manifest__` is injected into the page, not exported from the bundle.** A Zod
  `params` is a schema object at runtime, so the SDK would serve an opaque internal to agents
  unless the JSON Schema came back from the build. The HTML wrapper carries the extracted
  manifest as `window.__yaar_manifest__`; `defineApp` reads its schemas for the registration
  and keeps the schema object for parsing. The manifest the iframe serves and the one on disk
  are now the same bytes by construction rather than by agreement.

Validation goes through Standard Schema's `~standard.validate`, not Zod's own API:
`@bundled/zod` maps to `zod/mini`, whose schemas deliberately carry no `.parse` method, and
the spec interface also admits Valibot and ArkType at no cost.

Degraded (no-`typescript`) mode uses the same fold to produce the *whole* manifest, which lifts
the refusal to build `defineApp` apps there. `YAAR_NO_TYPESCRIPT=1` reproduces that environment
on a dev machine; a test asserts both readers return an identical manifest for one app.

Also shipped, the leftover from Part 1: **two commands reachable by the same name or alias is
a build error.** At runtime the SDK builds one flat lookup and the last registration wins, so a
duplicate made one command unreachable while the manifest kept advertising both.

**`7808b2b4` — Part 3, replay-safe commands.** A command may declare `replay: 'never'`; a replayed
command arrives stamped `replayed: true` and reaches the handler as `ctx.replayed`. Commands that
declare nothing keep today's behavior, so no app changes were required.

The policy rides the `yaar:app-ready` handshake rather than being read from `dist/protocol.json`:
that frame comes from the registration *actually running* in the iframe, and a manifest on disk can
disagree with it (stale build, devtools preview of uncompiled source). The disagreement would be
silent and one-sided — the server replaying a command the running app never declared safe. It is
re-sent on every ready, including the re-registration that triggers the replay, so the filter can
never use a stale policy. The SDK sends every *spelling* of an opted-out command, aliases included,
because the server records a request under whatever name the agent called it by and has no alias
table to canonicalize with. Covered by a loopback test.

**`7a27ac49` — Part 1 (`defineApp`) and Part 5's extraction half.** `defineApp` owns registration
timing (once, module scope, before mount), mounting (`render` into `#app`, or `view.mount(el)` for
imperative apps), and the `run` error contract. It returns the definition unchanged, so the default
export stays inspectable. Extraction gained a `defineApp` path that runs before `findRegisterCall` —
the default export *is* the protocol, and `id` is checked against `app.json`'s `appId`. Descriptor
resolution is the same code as the legacy path, so cross-module spreads, `const` refs, and
`defineCommand` transparency all still work. A double-register guard landed in two tiers: throw
against an authoritative (`defineApp`) registration, warn-and-overwrite for two plain `register()`
calls, because several shipped apps register from `onMount` or a component body and would otherwise
break at runtime with no build signal.

Verified: every app in `apps/` that ships source extracts a byte-identical manifest.

Two fixes fell out of the work. The module graph never followed side-effect-only imports
(`import './protocol'`, the idiom one shipped app registers through) or namespace imports, so a
registration in either was invisible and reported as "declares no protocol" — the same
silent-truncation class the extractor exists to prevent. And `prebundleLibrary('yaar')` had no solid
externals, so `defineApp`'s `solid-js/web` import would have embedded a second reactive runtime in
the prebundled artifact: broken reactivity in exe builds only, with every build signal green.

## Current state (what remains true)

- **Two parallel schema systems, now optional rather than forced.** `defineApp` takes either a Zod
  schema or a JSON-Schema literal; `defineCommand` and `app.register()` still take literals only
  (`YaarJsonSchema` with its own TS inference engine). An app on the legacy shape that wants
  validation still writes every shape twice.
- **`persist` does not exist yet** — the hand-rolled "user edit before load lands wins" race guard
  is still duplicated across apps, and persisted JSON still has no migration convention. Part 2's
  runtime `parse` covers command params, not persisted state.
- **`onClose`/`onCapture` failures are swallowed**; `emit()` to undeclared channels is dropped
  without error.
- **Every bundled app that ships source now uses `defineApp`** — all eleven with a protocol
  (browser, browser-user, devtools, dock, market-apps, memo, process-explorer, search,
  session-logs, storage, video-editor-lite). Each port was verified by extracting the manifest
  before and after: byte-identical in every case except memo, which gained the two `replay:
  'never'` flags it should always have had. `src/protocol.ts` is gone from the apps that had
  one only to hold a registration; devtools and video-editor-lite keep their split
  `src/protocol/` maps, which is what the extractor's spread resolution exists to allow.
- **Migration surfaced one gap and closed it.** `defineApp` infers `run`'s parameter from the
  `params` at *its own* call site, so a command spread in from another module silently loses
  that typing — devtools and video-editor-lite each independently hand-rolled the same identity
  wrapper to get it back. `defineAppCommand` is now an SDK export (`shims/yaar/ui.ts`),
  trusted by name by `isTransparentWrapper` exactly as `defineCommand` is, and
  `check-apps.ts`'s `infer-handler-params` rule now scans `run:` as well as `handler:` — it
  caught two ports that had annotated `run` as `Record<string, unknown>`/`any` the moment it
  did.
- **`defineApp` is now the documented default** for new apps: `.claude/agents/app-dev.md`, the
  compiler-generated App Authoring Contract in `agents/profiles/app-agent.ts`, devtools'
  `AGENTS.md`, `docs/guides/app-development.md`, and the protocol reference all lead with it;
  `app.register()` is documented as the low-level call it wraps.

## Design

### Part 4 — declarative persistence

`persist` entries become `createPersistedSignal`s under the hood, with the schema applied on read
(`safeParse`, logged fallback to `default`) and an optional `version`/`migrate` hook:

```ts
persist: {
  settings: {
    schema: SettingsSchema, default: DEFAULTS,
    version: 2, migrate: (old, from) => ({ ...DEFAULTS, ...old }),
  },
}
```

This closes the audit's most-duplicated single pattern (the "user edit before load lands wins" race
guard, hand-rolled at least five times) and gives persisted JSON a migration convention, which
currently doesn't exist anywhere.

**Open design point**: how the view reaches the signals. `view: App` is defined before `defineApp`
runs, so `App` cannot close over them. Cleanest is `view: (ctx) => ...` with `ctx.persist.settings`
as signals — but that changes every migrated app's signature, so it should be settled *before* the
reference ports, not after.

### Part 5 — extractor and guard simplification (residual)

The `defineApp` extraction path and the "`defineApp` + `app.register()` in one app" guard have
shipped. What remains is deletion, and it is gated on migration: `findRegisterCall`'s ambiguity
machinery, the `createProtocolContext` escape hatch (one app uses it —
`video-editor-lite/src/protocol/controller.ts`), and the mount guard stay until the apps that need
them are ported.

## Next action

**Part 4 — `persist`**, and settle its open design point first: how the view reaches the
signals. `view: (ctx) => ...` is the cleanest shape but changes every app's signature, and
there are now eleven of them.

**Part 5's residual deletion** is newly unblocked in part: no app registers through
`findRegisterCall` any more, so its ambiguity machinery has no in-tree caller. Two things still
hold: `createProtocolContext` (video-editor-lite still uses it, and it remains the supported
seam under `defineApp` — the context is installed in `view.mount`, which runs after the
registration `defineApp` performs), and `app.register()` itself, which stays supported
indefinitely for user-installed apps.

Left behind by the migration, each small and independent:

- **video-editor-lite mounts into `#app` now, not `document.body`** — its `createEditorUI`
  clears the parent, so mounting on `body` was deleting the wrapper's mount div. Two CSS rules
  in `editor/styles.css` that were written for `#app > .editor-root` therefore never matched
  and now do (a 1080px centering on `.editor-main`'s children). It looks like the original
  intent; nobody has looked at it rendered.
- **Two teardowns are no-ops** and now have a proper home: `onCleanup(...)` at module scope in
  browser and browser-user sits outside any reactive root, so it never runs. `defineApp`'s
  `onClose` is where that belongs.
- **The schema fold's browser stubs lacked bare `cancelAnimationFrame`** — anime.js calls it at
  module scope, so any app whose graph reaches anime.js died on import in no-`typescript`
  (bundled-exe) mode. Fixed; the stub set is still an allowlist that grows on contact.

### Adjacent, found while shipping Part 3 (not part of this proposal)

Reported by the replay work, none fixed. The first is the one that most undermines Part 3's
guarantee:

1. **Replay fans out to every connection on the monitor**, not the iframe that remounted. With two
   tabs on one monitor, tab B's remount replays the whole command log into tab A's iframe, which
   never lost its state — structurally the same double-apply the `reannounce` flag exists to
   prevent, reached by another route. `replay: 'never'` narrows the blast radius but does not close
   this.
2. **Replay bypasses `PendingStore`** — it calls `broadcast` directly, so `replay-*` ids have no
   pending entry. Every normal remount logs "Reply for unknown request… Duplicate reply, or a
   request from a dead session", and an app that throws on a replayed command is never noticed.
3. **The recorded command log is unbounded and un-deduped** — 50 `navigate`s replay as 50
   navigations in a burst. A last-write-wins collapse per (command, params) is the natural companion
   to `replay: 'never'`.
4. **Timed-out commands are never recorded**, so a command the app *did* apply but answered slowly
   is absent from the replay set — the inverse of the failure Part 3 fixed.

## What does NOT change

- `app.register()` and JSON-Schema-literal descriptors keep working indefinitely.
- The wire protocol (`app_query`/`app_command`/`yaar:app-ready`) — Part 3 added one optional
  envelope field and one optional handshake field.
- `protocol.json` remains the agent-facing manifest artifact; it just gains a reliable source.
- No new runtime dependency: Zod is already bundled; `toJSONSchema` runs at build time.

## Alternatives considered

- **External declarative DSL** (apps as data, interpreted by a runtime): rejected. It fits
  list-detail CRUD apps but excludes exactly the apps that generate the most code (excel-lite,
  video-editor-lite, thesingularity-reader). An embedded DSL constrains the ceremony without
  capping expressiveness.
- **Docs/SKILL-only fix**: rejected by the evidence — the conventions were documented and the
  primitives existed, yet 25 AI-written apps drifted into five registration idioms and three
  feedback conventions. For generated code, only build-time enforcement holds.
- **Teach the AST evaluator Zod's API** instead of executing schemas: rejected — chasing Zod's
  surface in a static evaluator is a treadmill, and the build already runs app code at the same
  trust level during `Bun.build` and typecheck.
- **A subprocess for the fold** (as originally proposed): rejected once the exe was considered. A
  compiled Bun executable cannot run a script, and `process.execPath` there is the YAAR binary, so
  spawning it relaunches the server. A Worker gives the same isolation with a working
  `terminate()`.
- **Journal-based exactly-once replay** (SDK persists applied requestIds in `appStorage`):
  considered as a complement; deferred. The per-command policy covers the audited failure cases
  with far less machinery, and the journal can be added later behind the same envelope flag if a
  real case needs it.

## Resolved questions

- *Should `replay: 'never'` be the default for commands with no `returns` schema?* — No. Explicit
  `'always'` shipped, because silent under-replay breaks window restoration in ways that are harder
  to notice than duplicate effects.
- *Does `view` need a non-Solid escape hatch?* — Yes, and it shipped as a first-class case:
  `view: { mount(el) }`. It is what lets imperative apps (excel-lite, video-editor-lite) adopt
  `defineApp` at all.
- *How does a Zod `params` validate a call without bundling zod into `defineApp`?* — Through
  Standard Schema's `~standard.validate`, which every Zod v4 schema implements. It also avoids a
  wrong answer: `zod/mini` schemas have no `.parse` method, so validating through Zod's own API
  would have missed the exact library `@bundled/zod` resolves to.

## Open questions

- Should `persist` write-through go to `appDb` above a size threshold instead of `appStorage` JSON
  files?
- How does the view reach `persist` signals (see Part 4) — `view: (ctx) => ...`, or something that
  doesn't change every app's signature?
