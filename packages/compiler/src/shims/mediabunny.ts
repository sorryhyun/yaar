/**
 * mediabunny shim — works around a Bun bundler defect on pure re-export barrels.
 *
 * mediabunny's browser entry (`dist/modules/src/index.js`) is nothing but
 * `export { Output, … } from './output.js'` lines, one per module. Prebundling it
 * directly (exe build, `scripts/build/prebundle-libs.js`) makes Bun emit those
 * `export { … }` lists with the identifiers dropped out from under them,
 * collapsing a 0.66 MB library to a **5.3 KB stub** — and the prebundle still
 * *succeeds*, so nothing fails until an app that imports `@bundled/mediabunny` is
 * compiled against the broken artifact in exe mode.
 *
 * The same defect `uuid.ts`, `zod.ts`, `lodash.ts`, and `pixi.ts` document.
 * Routing the library through this shim makes `mediabunny` an inner module Bun
 * materializes before re-exporting, restoring the full artifact.
 *
 * `export *` carries the whole named surface (`Input`/`Output`/`Conversion`, the
 * sources, sinks, formats, targets, and capability helpers) with no default
 * export to reconcile — mediabunny has none. The package sets
 * `"sideEffects": false`, so an app importing only `Input` still tree-shakes the
 * encoders away.
 */
export * from 'mediabunny';
