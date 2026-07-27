/**
 * `@yaar/shared/schemas` — the Zod-bearing surface, kept off the package barrel.
 *
 * The barrel (`index.ts`) is imported by the frontend, which needs types and lightweight guards
 * but never parses anything; re-exporting the schemas from there dragged Zod into the browser
 * bundle (~540 references in `dist/main-*.js`). Everything that actually validates — the server's
 * MCP tools and the extension bridge handlers — imports from here instead.
 *
 * The types stay on the barrel: `export type` is erased at emit, so a type-level consumer pays
 * nothing for schemas it never touches.
 */

export { componentSchema, componentLayoutSchema, displayContentSchema } from './components.js';
export type { ComponentLayout, DisplayContent } from './components.js';

export * from './bridge.js';
