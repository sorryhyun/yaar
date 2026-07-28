/**
 * zod shim — works around a Bun bundler defect on pure re-export barrels.
 *
 * `@bundled/zod` maps to `zod/mini`, whose browser entry (`mini/index.js`) is a
 * nested `export * from …` barrel. Prebundling that file directly (exe build,
 * `scripts/build/prebundle-libs.js`) makes Bun emit an `export { … }` list whose
 * identifiers were dropped/renamed out from under it, producing an artifact
 * whose exports reference undeclared names:
 *
 *   zod:40:23830: "u6" is not declared in this file
 *
 * The prebundle still *succeeds*, so the breakage only surfaces later, when an
 * app that imports `@bundled/zod` is compiled against the broken prebundled
 * artifact (exe mode) — the same failure mode `uuid.ts` documents.
 *
 * Routing the library through this shim adds a layer of indirection: `zod/mini`
 * is no longer the bundle entrypoint but an inner module, so Bun materializes
 * its bindings before re-exporting them. The explicit `import * as z` gives the
 * bundler real references to follow (the fix uuid.ts relies on), `export *`
 * carries the tree-shakeable functional API (`object`, `string`, `safeParse`,
 * …), and the explicit `export { z }` guarantees the `z` namespace regardless
 * of how the star-export resolves.
 */
import * as z from 'zod/mini';

export * from 'zod/mini';
export { z };
