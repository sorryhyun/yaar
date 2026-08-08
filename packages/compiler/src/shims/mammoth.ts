/**
 * mammoth shim — restores the default export the prebundled artifact loses.
 *
 * mammoth is CommonJS (`exports.convertToHtml = …`) and its types are
 * `export = mammoth`, so the only spelling that typechecks is the default import:
 *
 *   import mammoth from '@bundled/mammoth';
 *
 * In a repo install that import resolves straight to `mammoth/lib/index.js`, where
 * Bun's CJS interop synthesizes `default` for it. In the exe it resolves to the
 * *prebundled* artifact instead — and prebundling the CJS entry emits named
 * exports only:
 *
 *   export{…,rz as convertToMarkdown,oz as convertToHtml,tz as convert}
 *
 * so an installed app died at compile time with
 * `No matching export in "bundled-lib:mammoth" for import "default"`: green in
 * dev, broken in the release. That asymmetry is the one `uuid.ts` / `zod.ts` /
 * `lodash.ts` / `pixi.ts` document for barrel libraries, reached by a different
 * route — CJS interop rather than a dropped re-export.
 *
 * Routing through this shim makes mammoth an inner module whose default the
 * bundler re-exports for real, in either environment. The named half is not in
 * the declared type surface; it is kept because it is what the artifact already
 * exported, and an app written against the broken release may be using it.
 */
import mammoth from 'mammoth';

/**
 * mammoth's `.d.ts` describes four of the ten members its CJS module exports.
 * The four keep their real types; the rest are reached through this widened view
 * rather than being dropped from a surface the artifact already carried.
 */
const api = mammoth as typeof mammoth & Record<string, unknown>;

export default mammoth;

export const { convertToHtml, extractRawText, embedStyleMap, images } = mammoth;
export const convert = api.convert;
export const convertToMarkdown = api.convertToMarkdown;
export const readEmbeddedStyleMap = api.readEmbeddedStyleMap;
export const styleMapping = api.styleMapping;
export const transforms = api.transforms;
export const underline = api.underline;
