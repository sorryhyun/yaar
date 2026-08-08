/**
 * The `@bundled/*` registry: which libraries exist, which of them are gated,
 * where their shims live, and how an npm package name becomes a browser entry.
 *
 * This is data plus one resolver, and it deliberately touches no Bun plugin API.
 * `typecheck.ts`, `prebundle.ts`, and `protocol/extract-protocol-dir.ts` all need
 * the names — and `toForwardSlash` — without wanting anything to do with
 * constructing a bundler plugin, which is what they used to import them from.
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { SHIMS_DIR } from '../paths.js';

/**
 * Normalize a file path to use forward slashes.
 * On Windows, path.join/resolve produce backslashes which can cause
 * Bun.build() plugin resolution failures ("AggregateError: Bundle failed").
 */
export const toForwardSlash = (p: string): string => p.replace(/\\/g, '/');

/**
 * Local shim files that wrap npm libraries with compatibility fixes.
 * When a @bundled/* import matches a shim, it resolves to the shim file
 * instead of the npm package directly.
 */
export const BUNDLED_SHIMS: Record<string, string> = {
  anime: toForwardSlash(join(SHIMS_DIR, 'anime.ts')),
  dompurify: toForwardSlash(join(SHIMS_DIR, 'dompurify.ts')),
  lodash: toForwardSlash(join(SHIMS_DIR, 'lodash.ts')),
  mammoth: toForwardSlash(join(SHIMS_DIR, 'mammoth.ts')),
  mediabunny: toForwardSlash(join(SHIMS_DIR, 'mediabunny.ts')),
  mermaid: toForwardSlash(join(SHIMS_DIR, 'mermaid.ts')),
  'pixi.js': toForwardSlash(join(SHIMS_DIR, 'pixi.ts')),
  uuid: toForwardSlash(join(SHIMS_DIR, 'uuid.ts')),
  zod: toForwardSlash(join(SHIMS_DIR, 'zod.ts')),
  // The yaar SDK is split into internal modules; index.ts is the barrel entry.
  // onResolve returns this path verbatim, so it must name a file, not a directory.
  yaar: toForwardSlash(join(SHIMS_DIR, 'yaar', 'index.ts')),
  'yaar-dev': toForwardSlash(join(SHIMS_DIR, 'yaar-dev.ts')),
  'yaar-web': toForwardSlash(join(SHIMS_DIR, 'yaar-web.ts')),
  'yaar-ml': toForwardSlash(join(SHIMS_DIR, 'yaar-ml.ts')),
};

/**
 * Libraries with browser/node conditional exports that need consistent resolution.
 * Bare imports of these from within bundled code must resolve to the same path as
 * the @bundled/* aliased imports to prevent duplicate module copies.
 */
export const CONDITIONAL_EXPORT_LIBS = [
  'solid-js',
  'solid-js/web',
  'solid-js/html',
  'solid-js/store',
];

/**
 * Map of @bundled/* import names to actual npm module paths.
 * These libraries are installed as devDependencies and bundled into apps.
 *
 * **An entry needs a concrete first consumer.** Every name here is prebundled into
 * the standalone exe (`scripts/build/prebundle-libs.js` walks this map), so a
 * library no app imports costs exe bytes and widens the choice an app-authoring
 * agent has to make — tree-shaking makes it free per app, never free in the
 * artifact. `clsx`, `konva`, and `p5` were retired for exactly that (zero
 * consumers, each redundant with a kept library or a platform API); re-adding one
 * is this line plus a `.d.ts` block, so retirement is cheap to reverse the moment
 * a real consumer appears. A zero-consumer entry stays only when it is the sole
 * provider of a capability apps cannot reasonably hand-roll (`cannon-es`,
 * `matter-js`) or is deliberately hidden behind the SDK (`dompurify`, reachable
 * only through `sanitizeHtml`).
 */
export const BUNDLED_LIBRARIES: Record<string, string> = {
  'solid-js': 'solid-js',
  'solid-js/html': 'solid-js/html',
  'solid-js/web': 'solid-js/web',
  'solid-js/store': 'solid-js/store',
  uuid: 'uuid',
  lodash: 'lodash-es',
  'date-fns': 'date-fns',
  anime: 'animejs',
  three: 'three',
  'cannon-es': 'cannon-es',
  xlsx: '@e965/xlsx',
  'chart.js': 'chart.js',
  d3: 'd3',
  diff: 'diff',
  diff2html: 'diff2html',
  dompurify: 'dompurify',
  'matter-js': 'matter-js',
  tone: 'tone',
  'pixi.js': 'pixi.js',
  mammoth: 'mammoth',
  marked: 'marked',
  mediabunny: 'mediabunny',
  mermaid: 'mermaid',
  prismjs: 'prismjs',
  zod: 'zod/mini',
  yaar: 'yaar',
  'yaar-dev': 'yaar-dev',
  'yaar-web': 'yaar-web',
  'yaar-ml': 'yaar-ml',
};

export const GATED_BUNDLED_LIBRARIES = Object.freeze(
  Object.keys(BUNDLED_LIBRARIES).filter((name) => name.startsWith('yaar-')),
);

/**
 * Resolve a npm package to its browser entry point by reading package.json exports.
 *
 * Bun.resolveSync() uses runtime (node/bun) conditions, which for packages like
 * solid-js resolves to the SSR build (dist/server.js) instead of the browser build
 * (dist/solid.js). This helper reads the exports map and picks the browser condition.
 */
export function resolveBrowserEntry(npmName: string, fromDir: string): string | null {
  // Split 'solid-js/web' → pkg='solid-js', subpath='./web'
  const parts = npmName.split('/');
  const isScoped = npmName.startsWith('@');
  const pkgName = isScoped ? parts.slice(0, 2).join('/') : parts[0];
  const subpath =
    parts.length > (isScoped ? 2 : 1) ? './' + parts.slice(isScoped ? 2 : 1).join('/') : '.';

  try {
    const pkgJsonPath = Bun.resolveSync(`${pkgName}/package.json`, fromDir);
    const pkgDir = toForwardSlash(dirname(pkgJsonPath));
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));

    const exportEntry = pkgJson.exports?.[subpath];
    if (!exportEntry) return null;

    // Prefer browser > default import condition.
    // The browser condition can be a string or nested object with import/default.
    const browser = exportEntry.browser;
    if (browser) {
      const entry = typeof browser === 'string' ? browser : (browser.import ?? browser.default);
      if (entry) return toForwardSlash(join(pkgDir, entry));
    }

    // Fallback: use the top-level import/default condition.
    // For solid-js, the top-level `import` points to the browser build (dist/solid.js),
    // while node/worker/deno conditions point to server.js. If the browser condition
    // failed to resolve (e.g. on Windows where Bun.resolveSync may behave differently),
    // the top-level import is still the correct browser build.
    const topImport = exportEntry.import ?? exportEntry.default;
    if (typeof topImport === 'string' && !topImport.includes('server')) {
      return toForwardSlash(join(pkgDir, topImport));
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Get the list of available bundled libraries.
 */
export function getAvailableBundledLibraries(): string[] {
  return Object.keys(BUNDLED_LIBRARIES).filter((k) => !k.includes('/'));
}
