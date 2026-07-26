/**
 * dompurify shim — keeps `purify.es.mjs` out of the entrypoint slot.
 *
 * dompurify is the one bundled library that is both a **prebundle entrypoint**
 * (`prebundleLibrary('dompurify')` builds `dist/purify.es.mjs` directly) and a
 * **dependency of other builds in the same process** — `@bundled/yaar`'s
 * `sanitizeHtml` imports it, so every app compile pulls the same file in. Bun's
 * bundler does not survive that combination: once the prebundle has used the
 * file as an entrypoint, a later `Bun.build()` in the same process reads it
 * through stale cached state and fails with
 *
 *   dist/purify.es.mjs:-1:-1: EISDIR reading file: ".../dist/purify.es.mjs"
 *
 * The file is an ordinary 64 KB regular file; nothing about it is a directory.
 * This is what broke CI: `prebundle-completeness.test.ts` prebundles every
 * library, and the `define-app` / `fold-schemas` suites running after it in the
 * same `bun test` process then failed to compile any app importing
 * `@bundled/yaar` — 15 failures, none reproducible when those files ran alone.
 *
 * Routing dompurify through this shim makes the shim the entrypoint and
 * `purify.es.mjs` an inner module in *both* builds, so no build caches it as an
 * entrypoint. Same indirection `uuid.ts`, `zod.ts`, `lodash.ts`, and `pixi.ts`
 * apply for their own Bun bundler defect.
 *
 * `export *` plus the explicit default mirrors `declare module
 * '@bundled/dompurify'` in `bundled-types/index.d.ts`; dompurify's ESM build
 * exposes its API as the default export.
 */
export * from 'dompurify';
export { default } from 'dompurify';
