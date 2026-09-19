/**
 * The TypeScript view of an app sandbox — one definition, two readers.
 *
 * `typecheckSandbox` hands it to tsc as a temporary tsconfig; `findReferences`
 * builds a LanguageService from it. They must agree on what `@bundled/*` means:
 * a symbol typecheck resolves and references cannot (or the reverse) is two tools
 * describing two different programs. So the compiler options and the gated-bundle
 * slicing live here, and neither reader restates them.
 */

import { join } from 'path';
import { GATED_BUNDLED_LIBRARIES } from './bundled/registry.js';
import { THREE_WEBGPU_LIBS, type ThreeRenderer } from './bundled/three-renderer.js';
import { BUNDLED_TYPES_DTS } from './paths.js';

/** The directory `@bundled/*` resolves into. */
export const BUNDLED_TYPES_DIR = BUNDLED_TYPES_DTS.slice(0, BUNDLED_TYPES_DTS.lastIndexOf('/'));

/** Source files a sandbox program includes, relative to the sandbox root. */
export const SANDBOX_INCLUDE = ['src/**/*.ts'];

/**
 * The `@bundled/*` names this sandbox may not import: the gated SDKs it did not
 * declare in `bundles`, and the WebGPU-only three entries unless app.json says
 * `"three": "webgpu"`. The build refuses the same set (`plugins.ts`).
 */
function deniedModules(bundles: string[], three: ThreeRenderer): string[] {
  const deniedGated = GATED_BUNDLED_LIBRARIES.filter((bundle) => !bundles.includes(bundle));
  return three === 'webgpu' ? deniedGated : [...deniedGated, ...THREE_WEBGPU_LIBS];
}

/**
 * What `@bundled/three` means to a `"three": "webgpu"` app, standing in for the
 * canonical block — which says `three` — once that is sliced out. It has to be a
 * replacement rather than a second block: two ambient declarations of one name
 * merge, and the WebGL-only `WebGLRenderer` would still typecheck.
 */
const WEBGPU_THREE_BLOCK = `
declare module '@bundled/three' {
  export * from 'three/webgpu';
}
`;

/**
 * Compiler options for a sandbox, as tsconfig JSON (string enums, not the numeric
 * ones — `ts.convertCompilerOptionsFromJson` turns them into the latter).
 */
export function sandboxCompilerOptions(
  bundles: string[] = [],
  three: ThreeRenderer = 'webgl',
): Record<string, unknown> {
  // A denied gated bundle points at a directory that does not exist, so importing
  // it fails to resolve even where the declarations were not sliced out.
  const deniedBundlePaths = Object.fromEntries(
    deniedModules(bundles, three).map((bundle) => [
      `@bundled/${bundle}`,
      [join(BUNDLED_TYPES_DIR, '__bundle-not-enabled__', bundle)],
    ]),
  );

  return {
    strict: false,
    noEmit: true,
    noUnusedLocals: true,
    noUnusedParameters: true,
    target: 'ES2022',
    module: 'ES2022',
    moduleResolution: 'bundler',
    // Bun's bundler loads an imported .json natively, so an app may ship a data
    // asset beside its source; without this tsc alone would call that import
    // unresolvable and fail a build the compiler is perfectly happy with.
    resolveJsonModule: true,
    lib: ['ES2022', 'DOM', 'DOM.Iterable'],
    types: [],
    paths: {
      ...deniedBundlePaths,
      '@bundled/*': [join(BUNDLED_TYPES_DIR, '*')],
    },
    skipLibCheck: true,
  };
}

/**
 * The bundled declarations with every module the app did not opt into cut out,
 * or null when nothing is denied (the canonical file stands as is).
 *
 * One canonical declaration file serves docs and editor tooling; a sandbox only
 * loses the ambient modules it has no grant for. A WebGPU app also loses the
 * canonical `@bundled/three` and gets `WEBGPU_THREE_BLOCK` in its place.
 */
export function sliceBundledTypes(
  ts: typeof import('typescript'),
  source: string,
  bundles: string[] = [],
  three: ThreeRenderer = 'webgl',
): string | null {
  const denied = new Set(deniedModules(bundles, three));
  if (three === 'webgpu') denied.add('three');
  if (denied.size === 0) return null;

  const sourceFile = ts.createSourceFile(
    BUNDLED_TYPES_DTS,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const ranges = sourceFile.statements
    .filter(
      (statement): statement is import('typescript').ModuleDeclaration =>
        ts.isModuleDeclaration(statement) &&
        ts.isStringLiteral(statement.name) &&
        statement.name.text.startsWith('@bundled/') &&
        denied.has(statement.name.text.slice('@bundled/'.length)),
    )
    .map((statement) => ({ start: statement.getStart(sourceFile), end: statement.end }))
    .sort((a, b) => b.start - a.start);

  let sliced = source;
  for (const range of ranges) sliced = sliced.slice(0, range.start) + sliced.slice(range.end);
  return three === 'webgpu' ? sliced + WEBGPU_THREE_BLOCK : sliced;
}
