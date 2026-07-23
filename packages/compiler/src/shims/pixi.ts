/**
 * pixi.js shim — works around a Bun bundler defect on pure re-export barrels.
 *
 * pixi.js's browser entry (`lib/index.mjs`) is a barrel of `export { … } from
 * './…'` re-exports (plus side-effect `import './…/init.mjs'` registrations).
 * Prebundling it directly (exe build, `scripts/prebundle-libs.js`) makes Bun
 * emit `export { … }` lists whose identifiers were dropped/renamed, collapsing
 * the library to a ~16 KB stub and failing later, when an app imports
 * `@bundled/pixi.js`, with:
 *
 *   pixi.js:1:…: "wA" is not declared in this file
 *
 * The same defect `uuid.ts`, `zod.ts`, and `lodash.ts` document. Routing pixi
 * through this shim makes `pixi.js` an inner module Bun materializes before
 * re-exporting; `export *` carries the full named surface (matching
 * `declare module '@bundled/pixi.js'`) and pixi's side-effect init imports run
 * as its module is pulled in.
 */
export * from 'pixi.js';
