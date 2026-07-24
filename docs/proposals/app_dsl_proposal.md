# Proposal: An embedded app DSL — `defineApp()`, Zod-first schemas, replay-safe commands

**Status:** Draft
**Scope:** `packages/compiler` (shims, AST extractor, guards), `packages/shared` (iframe scripts), `packages/server` (command replay), apps (incremental migration)
**Companion:** [`apps_modernization_proposal.md`](./apps_modernization_proposal.md) — cleanup of the existing apps against today's conventions. This proposal changes the platform so those conventions stop needing manual discipline.

## Summary

Introduce a single blessed entrypoint for apps:

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

## Motivation

An audit of all 25 apps found the divergence is concentrated exactly where apps have the most
degrees of freedom. Since apps are largely AI-generated, every degree of freedom becomes drift:

- **Five registration conventions coexist**: module top-level before `render()`, after
  `render()`, inside `onMount` (anima, dc-comics, memo, process-explorer), bare component body
  (curious-library-vn), and import side-effect (market-apps). The lifecycle-tied ones
  re-register on iframe remount. Nothing enforces any of them.
- **Two parallel schema systems**: `defineCommand` takes raw JSON-Schema literals
  (`YaarJsonSchema` with its own TS inference engine, `bundled-types/index.d.ts:299`) while
  `@bundled/zod` is the documented tool for validating persisted/external JSON. An app wanting
  both writes every shape twice with nothing keeping them in sync — and in practice ~20/25
  apps resolve the tension by validating nothing.
- **Command replay is unguarded**: the server re-broadcasts every recorded command on iframe
  remount, and no SDK primitive lets a handler detect or dedupe it (details below). Apps with
  non-idempotent handlers double-apply.
- **Ceremony is copied, not shared**: the `if (!app) return; app.register({...})` shape is
  hand-written in all ~17 protocol-bearing apps; two apps (browser, browser-user) hand-maintain
  a `manifest` state key the framework already auto-derives.

## Current state (verified)

- **Runtime `register()` is last-write-wins with no double-register guard** —
  `packages/shared/src/iframe-scripts/app-protocol.ts:67-89` unconditionally overwrites
  `registration`. A second call (remount, conditional branch) silently replaces the protocol.
- **The extractor guesses which `register()` call is canonical** —
  `packages/compiler/src/extract-protocol-ast.ts:759-825` (`findRegisterCall`) requires the
  receiver be literally `app`/`*.app`, falls back to property-name heuristics, hard-errors on
  ambiguity. Runtime has no such rule: whatever executes last wins, so statically-invisible
  control flow is a standing drift vector between `protocol.json` and the live iframe.
- **Two extractors of different reach** — bundled-exe (degraded) mode uses the legacy text
  scanner, which stops at the first spread and gates on warnings, not errors
  (`extract-protocol-dir.ts:9-14`). An app composing its commands from spread fragments
  produces a *different manifest* in exe builds than in dev builds.
- **Schemas must be pure literals** — the extractor folds `params`/`returns`/`schema` to
  constants (`extract-protocol-ast.ts:522-613`) and hard-errors on anything computed. So a
  schema cannot be generated from a Zod schema today, forcing the hand-duplication.
- **Runtime params validation is presence-only** — `app-protocol.ts:162-199` checks
  `required` and unknown keys against `properties`, but never declared types: a param declared
  `{type: 'number'}` accepts a string.
- **Command replay on remount is blind** — `WindowStateRegistry.recordAppCommand()`
  (`packages/server/src/session/window-state.ts:305`) stores every `app_command`; on
  re-registration after remount, `app-window-coordinator.ts:125-140` re-broadcasts all of them
  with fresh `replay-*` requestIds. No idempotency key reaches the handler; nothing reconciles
  replay against state the app already restored from its own persistence. (A `reannounce`
  correctly skips replay; a real remount replays everything, always.)
- **Alias collisions are silent** — last-registered alias wins (`app-protocol.ts:76-79`);
  `onClose`/`onCapture` failures are swallowed (`app-protocol.ts:265`); `emit()` to undeclared
  channels is dropped without error.

## Design

### Part 1 — `defineApp()`

New export from `@bundled/yaar`. Shape:

```ts
import { defineApp } from '@bundled/yaar';
import { z } from '@bundled/zod';

export default defineApp({
  id: 'memo',                    // must match folder/app.json; checked at build time
  name: 'Memo',

  state: {
    memoCount: {
      description: 'Number of saved memos',
      schema: z.number(),        // optional; validated + exported to manifest
      get: () => memos().length,
    },
  },

  commands: {
    addMemo: {
      description: 'Create a memo',
      params: z.object({ text: z.string().min(1) }),
      returns: z.object({ id: z.string() }),
      replay: 'never',           // 'never' | 'always' (default) — see Part 3
      run: async ({ text }) => ({ id: await createMemo(text) }),
    },
  },

  persist: {
    settings: { schema: SettingsSchema, default: DEFAULTS },  // see Part 4
  },

  events: { memoAdded: { description: 'Fired after a memo is created' } },

  view: App,                     // Solid component
  onClose: () => flush(),
});
```

Semantics `defineApp` owns (removing them from app authors):

- **Registration timing**: exactly once, module scope, before `render(view, #app)` — the SDK
  script is injected ahead of app code (`compile.ts:126-141`), so this ordering is always
  safe. The runtime gains a **double-register guard**: a second `register()` for the same
  window throws instead of silently overwriting.
- **Mounting**: `defineApp` calls `render()` itself, targeting `#app` — subsuming what
  `mount-guard` checks today.
- **Manifest**: auto-derived, killing the hand-maintained `manifest` state keys.
- **Alias collision**: build-time error instead of silent last-wins.
- **`run` error contract**: thrown `Error`s are wrapped into `AppCommandError` automatically —
  collapsing the four error-shape conventions found in the audit (plain `Error`,
  `AppCommandError`, local `guard()` wrappers, nothing).

`app.register()` stays. Existing apps keep working; the extractor keeps its current path for
them. `defineApp` is additive sugar whose real payoff is build-time legibility.

### Part 2 — Zod-first schemas

`params`/`returns`/`schema` accept a Zod schema. Two consumers:

- **Build time**: the extractor recognizes `z.*` builder chains inside `defineApp` and folds
  them via `z.toJSONSchema()` (Zod v4 ships this) into the literal JSON Schema that
  `protocol.json` and the manifest need. Implementation: rather than teaching the AST evaluator
  Zod's full API, the compiler **executes the schema expressions** in the typecheck sandbox
  (the compiler already runs `Bun.build` + a typecheck pass; evaluating a side-effect-free
  schema module is the same trust level). Unresolvable/side-effectful schema expressions stay
  hard errors, preserving the no-silent-drift property.
- **Runtime**: `run` handlers receive `schema.parse(params)` output — **type-deep validation**,
  closing the presence-only gap, with no extra code in the app. Same for `persist` reads.

One schema now drives four things that were previously zero-to-two: TS param types (inferred
from Zod instead of the bespoke `YaarInferSchema` engine), runtime validation, the manifest,
and persisted-state validation. Plain JSON-Schema literals remain accepted for compat.

Degraded (bundled-exe) mode: `defineApp`'s canonical shape is *easier* for the legacy text
scanner than freeform `register()` calls, but folded-Zod schemas require execution. Resolution:
compile embeds the folded manifest as a build artifact (`__yaar_manifest__` export) at normal
build time, and exe mode reads that artifact instead of re-extracting — eliminating the
two-extractors drift vector for `defineApp` apps entirely.

### Part 3 — replay-safe commands

Server + SDK change, the highest-severity item:

1. **Envelope flag**: replayed commands carry `replayed: true`
   (`app-window-coordinator.ts:125-140` sets it; one field added to the frame).
2. **Per-command policy** in the descriptor, exported to the manifest:
   - `replay: 'always'` (default) — current behavior; correct for idempotent
     state-restoration commands (`navigate`, `setDeck`, `setAppearance`).
   - `replay: 'never'` — server skips it during replay; for commands whose effect is
     persisted by the app itself or is inherently one-shot (`addMemo`,
     `recommendTop2Today`'s `sendInteraction`, anything that appends/notifies).
3. **Handler visibility**: `run(params, ctx)` gains `ctx.replayed` for the rare command that
   wants replay-aware behavior rather than a binary policy.

The server-side skip reads the policy from the registered manifest at replay time — no
protocol-version negotiation needed; old apps without the field keep today's behavior.

### Part 4 — declarative persistence

`persist` entries become `createPersistedSignal`s under the hood, with the schema applied on
read (`safeParse`, logged fallback to `default`) and an optional `version`/`migrate` hook:

```ts
persist: {
  settings: {
    schema: SettingsSchema, default: DEFAULTS,
    version: 2, migrate: (old, from) => ({ ...DEFAULTS, ...old }),
  },
}
```

This closes the audit's most-duplicated single pattern (the "user edit before load lands wins"
race guard, hand-rolled at least five times) and gives persisted JSON a migration convention,
which currently doesn't exist anywhere.

### Part 5 — extractor and guard simplification

For `defineApp` apps the extractor no longer heuristically hunts for `register()` receivers:
the default export *is* the protocol. `findRegisterCall`'s ambiguity machinery, the
`createProtocolContext` escape hatch, and the mount-guard all become legacy-path-only. New
guard: an app importing `defineApp` that also calls `app.register()` is a build error.

## Migration

Incremental and mechanical. Suggested order:

1. Land `defineApp` + double-register guard + envelope flag (no app changes required).
2. Port two reference apps — one simple (memo), one command-heavy (github) — and update the
   app-dev agent guidance + SKILL templates to emit `defineApp` for all *new* apps.
3. Port remaining apps opportunistically, folding in the companion proposal's phases (a
   registration-timing fix and a `defineApp` port touch the same lines — do them together).
4. A codemod is feasible for the simple cases (top-level `register()` with literal descriptor
   → `defineApp`) but the lifecycle-tied apps need eyes; don't over-invest in automation for
   ~17 call sites.

## What does NOT change

- `app.register()` and JSON-Schema-literal descriptors keep working indefinitely.
- The wire protocol (`app_query`/`app_command`/`yaar:app-ready`) — only one optional envelope
  field is added.
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
- **Teach the AST evaluator Zod's API** instead of sandbox-executing schemas: rejected —
  chasing Zod's surface in a static evaluator is a treadmill; the sandbox already exists and
  runs app code at the same trust level during typecheck.
- **Journal-based exactly-once replay** (SDK persists applied requestIds in `appStorage`):
  considered as a complement; deferred. The per-command policy covers the audited failure
  cases with far less machinery, and the journal can be added later behind the same envelope
  flag if a real case needs it.

## Open questions

- Should `replay: 'never'` be the *default* for commands with no `returns` schema (heuristic:
  fire-and-forget commands are the non-idempotent ones), or is an explicit default of
  `'always'` safer for state-restoration semantics? Current lean: explicit `'always'`,
  because silent under-replay breaks window restoration in ways that are harder to notice
  than duplicate effects.
- Does `view` need a non-Solid escape hatch (excel-lite's imperative grid) — e.g.
  `view: { mount(el) {...} }` — or do imperative apps simply keep using `app.register()`?
- Should `persist` write-through go to `appDb` above a size threshold instead of
  `appStorage` JSON files?
