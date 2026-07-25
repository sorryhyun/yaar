# Proposal: An embedded app DSL — `defineApp()`, Zod-first schemas, replay-safe commands

**Status:** Partially implemented — Part 1, Part 3, and Part 5's extraction half have shipped.
Parts 2 and 4 are open; see **Next action**.
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

- **Two parallel schema systems**: `defineCommand` and `defineApp` both take raw JSON-Schema
  literals (`YaarJsonSchema` with its own TS inference engine, `bundled-types/index.d.ts`) while
  `@bundled/zod` is the documented tool for validating persisted/external JSON. An app wanting both
  writes every shape twice with nothing keeping them in sync — and in practice ~20/25 apps resolve
  the tension by validating nothing.
- **Schemas must be pure literals** — the extractor folds `params`/`returns`/`schema` to constants
  and hard-errors on anything computed. So a schema cannot be generated from a Zod schema today,
  forcing the hand-duplication.
- **Runtime params validation is presence-only** — `app-protocol.ts` checks `required` and unknown
  keys against `properties`, but never declared types: a param declared `{type: 'number'}` accepts
  a string.
- **Alias collisions are silent** — last-registered alias wins at runtime, and the extractor
  validates only that `aliases` is an array of strings. Part 1 proposed a build-time error for
  this; it did not ship with the rest of Part 1.
- **Bundled-exe mode refuses `defineApp` apps.** The legacy text scanner only knows
  `app.register({...})`, and emitting "declares no protocol" for an app full of commands is
  indistinguishable from the truth while being wrong about every one of them, so it fails loudly
  instead. This makes Part 2's folded-manifest build artifact load-bearing rather than optional.
- **`onClose`/`onCapture` failures are swallowed**; `emit()` to undeclared channels is dropped
  without error.

## Design

### Part 2 — Zod-first schemas

`params`/`returns`/`schema` accept a Zod schema. Two consumers:

- **Build time**: the extractor folds `z.*` builder chains via `z.toJSONSchema()` (Zod v4 ships
  this) into the literal JSON Schema that `protocol.json` and the manifest need. Rather than
  teaching the AST evaluator Zod's full API, the compiler **executes** the schema expressions in a
  subprocess — the compiler already runs `Bun.build` + a typecheck pass, and evaluating a
  side-effect-free schema module is the same trust level. Unresolvable/side-effectful schema
  expressions stay hard errors, preserving the no-silent-drift property.
- **Runtime**: `run` handlers receive `schema.parse(params)` output — **type-deep validation**,
  closing the presence-only gap, with no extra code in the app. Same for `persist` reads.

One schema then drives four things that are today zero-to-two: TS param types (inferred from Zod
instead of the bespoke `YaarInferSchema` engine), runtime validation, the manifest, and
persisted-state validation. Plain JSON-Schema literals remain accepted for compat.

**Constraint discovered while shipping Part 1** — the headless fold pass needs a `window` stub, not
merely an import-safe `defineApp`. `defineApp` already guards its own DOM access (`typeof document`,
mount-element lookup) precisely so an entry module can be imported without a DOM. But the
`@bundled/yaar` barrel reaches `window.yaar` at *module scope* in `verbs.ts`, so importing a
**compiled** entry module headlessly dies before `defineApp` ever runs. Importing the shim source
directly is fine. The subprocess must therefore stub `window` (and the SDK globals the barrel
touches) before importing, or the barrel must defer its global access.

Degraded (bundled-exe) mode: compile embeds the folded manifest as a build artifact
(`__yaar_manifest__` export) at normal build time, and exe mode reads that artifact instead of
re-extracting — eliminating the two-extractors drift vector for `defineApp` apps entirely, and
lifting the current refusal.

Also in scope, as the small leftover from Part 1: **alias collision becomes a build-time error**
instead of silent last-wins.

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

**Part 2, before porting any app.** Two reasons, in order:

1. Reference ports written against JSON-Schema-literal `params` would have to be rewritten when Zod
   folding lands — every migrated app touched twice.
2. Bundled-exe mode currently refuses `defineApp` apps outright, and the folded-manifest artifact is
   what lifts that.

Suggested order within Part 2: the fold subprocess (with the `window`-stub constraint above) →
`__yaar_manifest__` build artifact + exe-mode read → Zod accepted in `params`/`returns`/`schema` →
runtime `parse` → alias-collision build error.

Then migration resumes where the original plan left it:

- Port two reference apps — one simple (memo), one command-heavy (github) — and update the app-dev
  agent guidance + SKILL templates to emit `defineApp` for all *new* apps. Settle Part 4's
  `view`/`persist` signature first if Part 4 is landing in the same window.
- Port remaining apps opportunistically, folding in the companion proposal's phases (a
  registration-timing fix and a `defineApp` port touch the same lines — do them together).
- A codemod is feasible for the simple cases (top-level `register()` with literal descriptor →
  `defineApp`) but the lifecycle-tied apps need eyes; don't over-invest in automation for ~17 call
  sites.

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
- **Teach the AST evaluator Zod's API** instead of sandbox-executing schemas: rejected — chasing
  Zod's surface in a static evaluator is a treadmill; the sandbox already exists and runs app code
  at the same trust level during typecheck.
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

## Open questions

- Should `persist` write-through go to `appDb` above a size threshold instead of `appStorage` JSON
  files?
- How does the view reach `persist` signals (see Part 4) — `view: (ctx) => ...`, or something that
  doesn't change every app's signature?
