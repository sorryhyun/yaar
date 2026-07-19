# Proposal: Compiler-Supported App Protocol Manifest

**Status:** Draft — extracted from `runtime_decomposition_proposal.md` (formerly its Phase 3)
**Scope:** `packages/compiler`, `packages/compiler/src/shims/yaar.ts`, bundled app `protocol.ts` files
**Primary objective:** let app protocol handler implementations be organized by domain without losing compiler-visible manifest entries

## Why this is a separate proposal

This work was originally Phase 3 of the runtime decomposition program, but it is a
compiler/DX project, not a runtime-architecture one. It shares no code with the
session-routing and coordinator extractions, has a different risk profile (trusted
build surface, typecheck contracts), and its payoff depends on how often authors
actually suffer editing the large `protocol.ts` files. It should be pulled by demand —
scheduled when someone is blocked decomposing a protocol file — rather than sequenced
with the runtime phases.

The one coupling that remains: until this lands, app protocol descriptor maps must
stay single-literal `app.register({ ... })` expressions. The runtime proposal carries
that as an invariant and defers here.

## Problem

The compiler discovers each app's protocol manifest by scanning source text for the
`.register({` call and brace-matching the literal `state`, `commands`, and `events`
blocks (`packages/compiler/src/extract-protocol.ts`, 488 lines). Spreads, computed
keys, and imported descriptor maps can work at runtime but disappear from the static
manifest. That forces large protocol declarations to remain visibly monolithic.

Moving handler bodies into imported functions is safe today, but moving descriptor
objects is not generally safe.

### Evidence

App protocol declarations total roughly 5,300 lines across 22 `protocol.ts` files.
The largest are `devtools` (963), `image-edit` (554), `slides-lite` (519), and
`video-editor-lite` (380).

## Required invariant

Static and runtime app protocol manifests must agree. A refactor must never create a
command that works at runtime but is invisible to an agent.

## Proposed contract

Introduce a compiler-recognized, typed manifest declaration separate from runtime
binding:

```ts
export const manifest = defineProtocolManifest({
  appId: 'devtools',
  state: {
    project: { description: 'Active project', schema: projectSchema },
  },
  commands: {
    readFile: { description: 'Read files', params: readFileParams },
  },
});

app.register(bindProtocol(manifest, {
  state: projectStateHandlers,
  commands: fileCommandHandlers,
}));
```

The exact runtime API may differ, but it must provide:

- one statically extractable manifest;
- handler keys checked against manifest keys;
- no handler without a manifest entry;
- no manifest entry without a handler, unless explicitly declared read-only/generated;
- runtime/static manifest parity diagnostics.

## Compiler implementation options

Preferred: parse `defineProtocolManifest()` with the TypeScript AST already available
to compiler guards (the same infrastructure as `solid-html-guard.ts`). This supports
imported literal schemas only if the compiler deliberately resolves them; start with
same-file literals and make unsupported constructs a build error with a source
location, rather than a best-effort warning.

Alternative: execute a build-time manifest-only module in a restricted evaluator. This
is more flexible but expands the trusted build surface and should not be the first
choice.

Do not silently continue with a partial manifest. The current diagnostic mechanism
should become a hard compile failure for deployed apps once migration is complete.

## Migration order

1. Add the new contract and parity tests.
2. Migrate `devtools` as the stress case.
3. Migrate `image-edit`, `slides-lite`, and `video-editor-lite`.
4. Provide a compatibility path for literal `app.register()` apps.
5. Deprecate best-effort regex extraction only after all bundled apps migrate.

## Acceptance tests

- Static and runtime manifests match for every bundled app.
- Spreads/computed keys either resolve deliberately or fail compilation with a location.
- Handler maps cannot omit or invent keys at typecheck time.
- Existing compiled app output and app-agent descriptions remain equivalent.

## Change inventory

- `packages/compiler/src/extract-protocol.ts`
- `packages/compiler/src/shims/yaar.ts`
- `packages/compiler/src/bundled-types/index.d.ts`
- protocol compiler tests
- bundled app `protocol.ts` files, beginning with `apps/devtools`

## Risks

### Protocol manifest drift

Do not modularize descriptor maps with spreads under the existing extractor — that is
exactly the failure this proposal exists to prevent. Land the compiler contract first,
migrate one complex app, and require parity before expanding.

### Partial migration limbo

A long tail of unmigrated apps keeps both extraction paths alive. Bound this by
migrating all bundled apps in one push once the contract is proven on `devtools`, and
by making the compatibility path loud (a build note per legacy app) rather than
silent.

## Recommendation

Treat this as a standalone compiler/DX project. Do not schedule it alongside the
runtime decomposition phases; let demand pull it — the trigger is the first time
someone genuinely needs to split a protocol file by domain. When that happens, the
migration order above starts with the contract and parity tests, never with moving
descriptors under the existing extractor.
