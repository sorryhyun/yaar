/**
 * Prebundle a single `@bundled/*` library into one self-contained ESM string.
 *
 * This is the exact build the exe ships: `scripts/build/prebundle-libs.js` writes the
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
import { BUNDLED_LIBRARIES, BUNDLED_SHIMS, resolveBrowserEntry } from './registry.js';
import { MODULE_ROOT } from '../paths.js';
import { formatBuildLogs } from '../build/build-app.js';
import { ortVersionDefine } from './ort-version.js';

/** Where devDependencies for bundled libraries are installed (this package). */
const ANCHOR = MODULE_ROOT;

/**
 * Some browser builds `require` Node builtins that don't exist in the browser.
 * Stub them so the bundle resolves — mirrors the plugin in build/prebundle-libs.js.
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

const SOLID_ENTRIES = ['solid-js', 'solid-js/web', 'solid-js/html', 'solid-js/store'];

/**
 * No prebundled artifact may carry its own copy of solid-js — two copies are two
 * reactive runtimes, and a signal created under one is invisible to a render
 * effect created under the other. Mark solid external everywhere except in
 * solid-js's own artifact; at runtime the compiler plugin redirects every bare
 * `solid-js*` import to the shared bundle (`^solid-js(\/|$)` in `plugins.ts`).
 *
 * This started as a rule about solid's sub-packages (html imports web imports
 * solid) and had to widen: `@bundled/yaar`'s shim imports `solid-js/web` for
 * `defineApp`'s `render()`, so the yaar artifact would otherwise embed a second
 * runtime and break reactivity in exe builds only — with no build signal.
 */
export function solidExternals(name: string): string[] {
  if (name === 'solid-js') return [];
  return SOLID_ENTRIES.filter((n) => n !== name);
}

/**
 * Mark one three entry external without taking its subpaths with it.
 *
 * three joins solid as a runtime that must exist once (`SHARED_RUNTIME_LIBS`):
 * every `examples/jsm` module behind `@bundled/three/addons` opens with
 * `import { ... } from 'three'`, and an addons artifact carrying its own three
 * would hand the app a second `Mesh`/`Material`/`Object3D` — every `instanceof`
 * across the two silently false, with nothing in the build to say so.
 * `three/tsl` is the same shape one level over: it opens with
 * `import { TSL } from 'three/webgpu'`.
 *
 * It cannot ride in `Bun.build`'s `external` array: an entry there externalizes
 * the package *and all its subpaths*, so `'three'` would also externalize the
 * very `three/addons/*` modules this artifact exists to bundle — leaving a
 * 1KB re-export shell that resolves to nothing. An `onResolve` hook is the only
 * spelling that separates the package from its subpaths.
 */
function threeExternalPlugin(specifier: 'three' | 'three/webgpu'): Bun.BunPlugin {
  const filter = new RegExp(`^${specifier.replace('/', '\\/')}$`);
  return {
    name: `external-${specifier}`,
    setup(build) {
      build.onResolve({ filter }, () => ({ path: specifier, external: true }));
    },
  };
}

/**
 * The three entry an artifact must leave to the app, or null.
 *
 * `three` and `three/webgpu` are the two roots: each inlines `three.core.js`, and
 * an app links exactly one of them (`three-renderer.ts`). Everything else under
 * `three/` imports a root and must not carry it.
 */
function sharedThreeRoot(name: string): 'three' | 'three/webgpu' | null {
  if (name === 'three' || name === 'three/webgpu') return null;
  if (name === 'three/tsl') return 'three/webgpu';
  return name.startsWith('three/') ? 'three' : null;
}

/** Prebundle plugins for `name`: the Node stubs, plus shared-runtime externals. */
function prebundlePlugins(name: string): Bun.BunPlugin[] {
  const root = sharedThreeRoot(name);
  return root ? [nodeShimPlugin, threeExternalPlugin(root)] : [nodeShimPlugin];
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
    define: ortVersionDefine(),
    plugins: prebundlePlugins(name),
    external: solidExternals(name),
  });
  if (!result.success) {
    const errors = formatBuildLogs(result.logs);
    throw new Error(errors.join('\n') || `Bun.build() failed for @bundled/${name}`);
  }
  return await result.outputs[0].text();
}
