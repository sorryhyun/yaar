/**
 * Prebundle a single `@bundled/*` library into one self-contained ESM string.
 *
 * This is the exact build the exe ships: `scripts/prebundle-libs.js` writes the
 * result of `prebundleLibrary(name)` to `dist/bundled-libs/<name>.js`, and those
 * files are embedded into the standalone binary. Sharing this one function
 * between the build script and the prebundle-completeness test means the test
 * verifies the same artifact the exe embeds — the two cannot drift.
 *
 * The failure this guards against: several bundled libraries are pure re-export
 * barrels (`uuid`, `zod/mini`, `lodash-es`). Bundling such a file *directly* as
 * an entrypoint makes Bun emit an `export { ... }` list whose identifiers were
 * dropped/renamed, so an app compiled against the artifact later dies with
 * `"<id>" is not declared in this file`. Those libraries are routed through a
 * shim (see `BUNDLED_SHIMS`) so the barrel becomes an inner module Bun
 * materializes before re-exporting. The test compiles a consumer against each
 * prebundled artifact to prove no such drop slipped through.
 */
import { fileURLToPath } from 'url';
import {
  BUNDLED_LIBRARIES,
  BUNDLED_SHIMS,
  resolveBrowserEntry,
  toForwardSlash,
} from './plugins.js';

/** Where devDependencies for bundled libraries are installed (this package). */
const ANCHOR = toForwardSlash(fileURLToPath(new URL('.', import.meta.url)));

/**
 * Some browser builds `require` Node builtins that don't exist in the browser.
 * Stub them so the bundle resolves — mirrors the plugin in prebundle-libs.js.
 */
const nodeShimPlugin: Bun.BunPlugin = {
  name: 'node-shim',
  setup(build) {
    build.onResolve({ filter: /^(perf_hooks|worker_threads)$/ }, (args) => ({
      path: args.path,
      namespace: 'node-shim',
    }));
    build.onLoad({ filter: /.*/, namespace: 'node-shim' }, (args) => {
      if (args.path === 'perf_hooks') {
        return {
          contents: 'export const performance = globalThis.performance || {};',
          loader: 'js',
        };
      }
      return { contents: 'export default {};', loader: 'js' };
    });
  },
};

/**
 * solid-js sub-packages (html, web, store) must NOT each bundle their own copy of
 * solid-js — that yields duplicate reactive runtimes. Mark the sisters external;
 * at runtime the compiler plugin redirects the bare imports to the shared bundle.
 */
export function solidExternals(name: string): string[] {
  if (!name.startsWith('solid-js/')) return [];
  return [
    'solid-js',
    ...['solid-js/web', 'solid-js/html', 'solid-js/store'].filter((n) => n !== name),
  ];
}

/** Resolve the entrypoint a library is prebundled from (shim wins over the npm entry). */
export function resolvePrebundleEntrypoint(name: string): string {
  if (name in BUNDLED_SHIMS) return BUNDLED_SHIMS[name];
  const pkg = BUNDLED_LIBRARIES[name];
  if (!pkg) throw new Error(`Unknown bundled library: "${name}"`);
  // Prefer the browser condition (Bun.resolveSync picks node/SSR for e.g. solid-js).
  const browserEntry = resolveBrowserEntry(pkg, ANCHOR);
  const resolved = browserEntry ?? Bun.resolveSync(pkg, ANCHOR);
  return resolved.startsWith('file://') ? fileURLToPath(resolved) : resolved;
}

/**
 * Prebundle `@bundled/<name>` and return the minified ESM source. Throws with the
 * collected Bun error logs if the bundle fails.
 */
export async function prebundleLibrary(name: string): Promise<string> {
  const entrypoint = resolvePrebundleEntrypoint(name);
  const result = await Bun.build({
    entrypoints: [entrypoint],
    minify: true,
    format: 'esm',
    target: 'browser',
    plugins: [nodeShimPlugin],
    external: solidExternals(name),
  });
  if (!result.success) {
    const errors = result.logs
      .filter((l) => l.level === 'error')
      .map((l) => l.message || String(l));
    throw new Error(errors.join('\n') || `Bun.build() failed for @bundled/${name}`);
  }
  return await result.outputs[0].text();
}
