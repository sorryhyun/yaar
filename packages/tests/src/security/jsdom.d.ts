/**
 * Minimal ambient declaration for jsdom, used only by `html-sanitization.test.ts`.
 *
 * The obvious move is `@types/jsdom`, but that package references `lib.dom`, and this
 * tsconfig deliberately sets `"lib": ["ES2022"]` with `"types": ["bun-types"]` — no
 * DOM. Pulling `lib.dom` in globally redefines `BodyInit` and friends, which breaks
 * typechecking in unrelated server files that this package compiles through its path
 * mappings (`http/routes/files.ts` starts rejecting `Uint8Array` response bodies).
 *
 * A test-only dependency must not change how the rest of the workspace typechecks, so
 * the surface actually used is declared here instead. Widen it if a test needs more.
 */
declare module 'jsdom' {
  export class JSDOM {
    constructor(html?: string);
    readonly window: unknown;
  }
}
