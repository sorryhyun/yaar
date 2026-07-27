# Plan: `packages/compiler` structure & deduplication

**Status:** Tiers A and C landed. Tier B remains.
**Scope:** `packages/compiler/src` only. No behavior change is intended by any item below —
every one is a refactor, and the existing test suite (`bun run --filter @yaar/compiler test`)
is the acceptance signal.

## Summary

The package is ~5.5k lines across 13 source modules plus the shims. It is coherent, and the
hard parts (protocol extraction, the fold, the three runtime-contract guards) are where the
thinking is. The headroom is not in those — it is in **four mechanisms that exist twice**,
**two modules that hold unrelated concerns**, and **the same bytes being read off disk three
times per compile**.

Work was grouped into three tiers by risk, not by value:

| Tier | What | Risk | Status |
|---|---|---|---|
| A | Mechanical duplication (7 items) | low — pure deletion/extraction | **done** |
| B | Module splits & I/O (4 items) | medium — import graph moves | one per change |
| C | Dead code & barrel drift (3 items) | trivial | **done** |

Explicitly **out of scope**: the two `buildProtocol` implementations. See the last section.

Tier A added two modules — `build-app.ts` (the one `Bun.build` call for an app, plus
`formatBuildLogs`) and `ts-source.ts` (`createAppSourceFile`, so the bundler's `onLoad` parses
each file once for both guards) — and one exported constant,
`APP_REGISTER_REMOVED_MESSAGE`. Tier C widened `index.ts` to cover everything the scripts and
tests need, so `scripts/prebundle-libs.js`, `scripts/check-doc-freshness.ts`, and
`prebundle-completeness.test.ts` now go through the barrel. **That is what makes B1 an
internal move rather than a breaking one.**

---

## Tier B — module boundaries and I/O

### B1. `plugins.ts` (661 lines) is three unrelated modules

It currently holds:

1. the bundled-library registry and `toForwardSlash` (lines 22–154),
2. the four Bun plugins (166–528),
3. ~100 lines of `.d.ts` text-slicing behind the agent-facing `getBundledLibraryDetail`
   (537–661: `sliceBraceBlock`, `collectYaarRefs`, `extractTypeDeclaration`) — which touches
   no Bun API at all.

The import graph is the tell: `extract-protocol-dir.ts`, `typecheck.ts`, `prebundle.ts`, and
`tests/prebundle-completeness.test.ts` all import `toForwardSlash` / `BUNDLED_LIBRARIES` /
`BUNDLED_SHIMS` **from the module that constructs Bun plugins**.

**Do:** split into

- `bundled-registry.ts` — `BUNDLED_LIBRARIES`, `BUNDLED_SHIMS`, `GATED_BUNDLED_LIBRARIES`,
  `CONDITIONAL_EXPORT_LIBS`, `resolveBrowserEntry`, `toForwardSlash`, `getAvailableBundledLibraries`
- `describe-library.ts` — `getBundledLibraryDetail`, `PSEUDO_LIBRARIES`, and the three slicers
- `plugins.ts` — the four plugins and nothing else

**Watch:** the scripts and tests that used to reach into `plugins.ts` / `prebundle.ts`
directly now import from `index.ts` (C2), and `@yaar/server` always did — so the only imports
to update are the package's own. `prebundle.ts`, `typecheck.ts`, `extract-protocol-dir.ts`,
and `build-app.ts` each take `toForwardSlash` / `BUNDLED_LIBRARIES` / `BUNDLED_SHIMS` /
`GATED_BUNDLED_LIBRARIES` from `plugins.js` and would move to `bundled-registry.js`.

**Already landed:** A3/A4 tidied the plugin bodies, so the three regions are cleanly
separable — `getEmbeddedLibs`/`isExeMode`/`resolveNpmBrowserPath` belong with the plugins,
not the registry.

### B2. `extract-protocol-ast.ts` (1436 lines) has its seams already drawn

The banner comments mark three regions: module graph (124–257), the `Extractor` class
(263–787), the `defineApp` reader (789–1436). `Extractor` is the only shared state and is
already fully parameterized by `(ts, readFile)`.

**Do:** `protocol-module-graph.ts` (path resolution, `buildScope`, `ModuleScope`),
`protocol-extractor.ts` (the class), `extract-protocol-ast.ts` (the `defineApp` reader and the
public entry points). Keep every exported name and its module of origin for `index.ts`.

**Priority:** lower than B1. The file is long but internally coherent, and it is the most
correctness-critical module in the package — split it on its own, with no other change riding
along.

### B3. App sources are read from disk three times per compile

1. `compile.ts:281` `readAppSources()` — all `src/**/*.{ts,tsx,css}`, for the token guard
2. the bundler's `onLoad` in `solidHtmlSourcePlugin` — each reachable `.ts`/`.tsx`, again
3. `extract-protocol-dir.ts:55` `readModuleTexts()` — all `src/**/*.{ts,tsx,mts,js,jsx}`, again

Same directory, overlapping extension sets, three full reads.

**Do:** thread one per-compile source map (path → text) through `compileTypeScript`, and have
`readAppSources` and `readModuleTexts` consume it. `(3)` is the easy win — it already keys by
the same `src/…` forward-slash path the guard uses. `(2)` is harder: the plugin is called by
Bun with its own paths and must return possibly-rewritten contents, so it can read *through*
the cache but not skip it.

**Watch:** the cache must not outlive one compile — `dev.ts`'s compile route recompiles the
same path repeatedly, and a stale entry there is a silently old build.

### B4. The two guards share a shape they don't share code for

`solid-html-guard.ts` and `mount-guard.ts` both: `createSourceFile` → recursive `visit` →
`getLineAndCharacterOfPosition` → `.replace(/\s+/g,' ').slice(0, 72)` snippet →
`formatX(fileName, findings)` producing the identical
`path:line:col: snippet` / `  problem:` / `  fix:` block. Both files independently document
the ASCII-only rule for Bun's plugin error path.

**Do:** a `guard-report.ts` with `walk(ts, sourceFile, visit)`, `snippetOf(node, sf)`, and
`formatGuardFindings(fileName, kindLabel, findings)`. The ASCII rule then has one place to be
enforced (and, if wanted, asserted by a test) instead of two comments.

**Watch:** the two headers differ (`solid-js/html: N broken templates` vs
`app mount point: N bad render targets`) and the tests assert on them — parameterize, don't
unify.

**Already landed:** A7 took the `createSourceFile` half — both scanners now have a
`SourceFile`-taking form (`scanSourceFile`, `scanMountTargetsIn`) over a thin string wrapper,
and `ts-source.ts` owns the parse. `guard-report.ts` should absorb `createAppSourceFile` when
it lands, leaving the `visit`/snippet/format shape to factor.

---

## Not in scope: the two `buildProtocol`s

`extract-protocol-ast.ts:1060` and the worker source string in `fold-schemas.ts:266` look like
the largest duplication in the package. They should stay as they are.

One walks a TypeScript AST in the compiler process; the other walks live objects inside a
Worker, in generated source that must not depend on anything outside the app's own bundle.
The rules they genuinely share — keybinding validity — are already factored out to
`listKeybindingIssues` in `@yaar/shared`, deliberately, so both reject identically. And a case
in `fold-schemas.test.ts` asserts the two readers return the identical manifest for one app,
which is the right way to hold agreement between implementations that cannot share a runtime.

Merging them would mean either shipping the AST reader into a Worker or making the fold source
non-self-contained. Both are worse than the duplication.

---

## Remaining order

1. **B1** — the `plugins.ts` split, landing in a file that A3/A4 already tidied.
2. **B4**, then **B3**, then **B2** — each on its own, in that order of increasing blast radius.

After each: `bun run --filter @yaar/compiler test`, `bun run typecheck`, and one real app
compile (`apps/devtools` is the widest exercise of the extractor — 28 commands split across
files by `...spread`).
