/**
 * lodash shim — works around a Bun bundler defect on pure re-export barrels.
 *
 * `@bundled/lodash` maps to `lodash-es`, whose entry (`lodash.js`) is nothing but
 * `export { default as add } from './add.js'` lines. Prebundling that file
 * directly (exe build, `scripts/build/prebundle-libs.js`) makes Bun emit an
 * `export { ... }` list whose identifiers were dropped/renamed out from under it,
 * collapsing the whole library to a ~4.7 KB stub whose exports reference
 * undeclared names. The prebundle still *succeeds*, so the breakage only surfaces
 * later, when an app that imports `@bundled/lodash` is compiled against the broken
 * artifact (exe mode) and fails with:
 *
 *   lodash:1:8: "Yu" is not declared in this file
 *
 * This is the same defect `uuid.ts` and `zod.ts` document. Routing the library
 * through this shim adds a layer of indirection: `lodash-es` is no longer the
 * bundle entrypoint but an inner module, so Bun materializes its bindings before
 * re-exporting them.
 *
 * `export *` carries the full named surface — including lodash's default-as-named
 * re-exports (`add`, `debounce`, `cloneDeep`, …), which is exactly what
 * `declare module '@bundled/lodash'` exposes. The default export
 * (the monolithic `lodash.default.js` object) is deliberately NOT re-exported:
 * it drags the entire library into every consuming app (~38 KB even for a
 * single-function import) and defeats the tree-shaking that `lodash-es` exists
 * to provide. Apps use named imports.
 */
export * from 'lodash-es';
