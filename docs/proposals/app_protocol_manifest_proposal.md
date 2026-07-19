# Proposal: Compiler-Supported App Protocol Manifest

**Status:** Landed — as an AST extractor, not the `defineProtocolManifest` contract below.
**Scope:** `packages/compiler`
**Primary objective:** let app protocol handler implementations be organized by domain
without losing compiler-visible manifest entries

## Outcome

The objective is met. Descriptor maps may now be split across files by domain and spread
into `app.register({ ... })`; the compiler resolves them and the manifest keeps every entry.

What shipped is **not** the `defineProtocolManifest` / `bindProtocol` contract proposed
below. That design splits descriptors from handlers and then needs typecheck-enforced key
parity to hold the two halves together — parity machinery that exists to police a split the
design itself introduces. Rewriting the extractor to parse the TypeScript AST reaches the
same objective with no new API, no migration of the 22 `protocol.ts` files, and no parity
risk: manifest and handlers stay in one literal, so they cannot disagree.

Landed in `packages/compiler`:

- `extract-protocol-ast.ts` — resolves the `register()` argument through relative imports,
  `...spreads`, `const` references, `as const`/`satisfies`, and single-argument wrappers
  (`defineCommand`). Constant-folds `+` string concatenation anywhere, including inside
  `params`/`returns`/`schema` blocks. Anything unresolvable is a hard error with
  `file:line:col`.
- `extract-protocol-dir.ts` — the single entry point used by both `compileTypeScript` and
  the deploy path, so a manifest never depends on which caller asked for it.
- `load-typescript.ts` — shared memoized runtime `import('typescript')`.
- `extract-protocol.ts` — retained unchanged as the bundled-exe fallback (see below).

### Measured effect

All 31 bundled apps extract with zero errors. 29 are byte-identical to the old scanner's
output. Two improve: `image-edit` (3 commands) and `slides-lite` (4 commands) recover
`params` schemas that the text scanner silently dropped because the block contained a
`+`-concatenated description — exactly the invisible-degradation failure this work targets.
After the change every command in every bundled app carries its schema.

### The one thing that is not solved

Bundled-exe builds have no `typescript` module, so the legacy text scanner still runs there
and keeps its weaker warning-based gate. An app authored with cross-file descriptor spreads
will extract fully in a normal build and partially under a compile performed inside a
standalone executable. Closing this means either bundling `typescript` into the exe or
writing a minimal parser; neither was worth doing before someone hits it. `DirExtraction.degraded`
marks which path ran.

---

The rest of this document is the original proposal, kept for the reasoning that led here.

## Problem

The compiler discovered each app's protocol manifest by scanning source text for the
`.register({` call and brace-matching the literal `state`, `commands`, and `events`
blocks (`packages/compiler/src/extract-protocol.ts`, 488 lines). Spreads, computed
keys, and imported descriptor maps can work at runtime but disappear from the static
manifest. That forced large protocol declarations to remain visibly monolithic.

Moving handler bodies into imported functions was safe; moving descriptor objects was not.

### Evidence

App protocol declarations total roughly 5,300 lines across 22 `protocol.ts` files.
The largest are `devtools` (963), `image-edit` (554), `slides-lite` (519), and
`video-editor-lite` (380).

## Required invariant

Static and runtime app protocol manifests must agree. A refactor must never create a
command that works at runtime but is invisible to an agent.

## Proposed contract (not taken)

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

**Why this was not taken:** every bullet after the first exists to re-couple what the first
bullet decoupled. Keeping descriptors and handlers in one literal satisfies them by
construction, and the compiler work then reduces to reading that literal properly.

## Compiler implementation options

Preferred: parse with the TypeScript AST already available to compiler guards (the same
infrastructure as `solid-html-guard.ts`). This supports imported literal schemas only if the
compiler deliberately resolves them; start with same-file literals and make unsupported
constructs a build error with a source location, rather than a best-effort warning.

Alternative: execute a build-time manifest-only module in a restricted evaluator. This
is more flexible but expands the trusted build surface and should not be the first
choice.

Do not silently continue with a partial manifest.

*This is what shipped, extended to resolve imported descriptor maps as well as same-file
literals — the cross-file case is the one that actually unblocks decomposition. The
restricted evaluator was not needed.*

## Acceptance tests

- Static and runtime manifests match for every bundled app.
- Spreads/computed keys either resolve deliberately or fail compilation with a location.
- Handler maps cannot omit or invent keys at typecheck time.
- Existing compiled app output and app-agent descriptions remain equivalent.

*The third is moot under the shipped design: with descriptors and handlers in one literal
there is no separate handler map to disagree. The others are covered by
`src/tests/extract-protocol-ast.test.ts` and `src/tests/compile-protocol-gate.test.ts`.*

## Risks

### Protocol manifest drift

Do not modularize descriptor maps with spreads under the *old* extractor — that is
exactly the failure this proposal exists to prevent. This is now safe: the AST extractor
resolves spreads or fails the build.

### Partial migration limbo

No longer applicable. Nothing was migrated, so there is no long tail of unmigrated apps
and no compatibility path to keep alive. The only surviving dual path is the bundled-exe
fallback, which is a runtime-environment branch rather than a migration state.
