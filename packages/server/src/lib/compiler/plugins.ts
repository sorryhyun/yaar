/**
 * Bun plugins for the app compiler.
 *
 * Provides bundled library support via @bundled/* imports.
 * In bundled exe mode, resolves from embedded or disk-based pre-bundled files.
 * In dev mode, resolves from node_modules via Bun.resolveSync().
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

/** Directory of this file — inside packages/server, where devDependencies are installed. */
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Libraries with browser/node conditional exports that need consistent resolution.
 * Bare imports of these from within bundled code must resolve to the same path as
 * the @bundled/* aliased imports to prevent duplicate module copies.
 */
const CONDITIONAL_EXPORT_LIBS = ['solid-js', 'solid-js/web', 'solid-js/html'];

/**
 * Map of @bundled/* import names to actual npm module paths.
 * These libraries are installed as devDependencies and bundled into apps.
 * `null` = internal library (resolved from server source, not npm).
 */
export const BUNDLED_LIBRARIES: Record<string, string | null> = {
  yaar: null,
  'solid-js': 'solid-js',
  'solid-js/html': 'solid-js/html',
  'solid-js/web': 'solid-js/web',
  uuid: 'uuid',
  lodash: 'lodash-es',
  'date-fns': 'date-fns',
  clsx: 'clsx',
  anime: 'animejs',
  konva: 'konva',
  three: 'three',
  'cannon-es': 'cannon-es',
  xlsx: 'xlsx',
  'chart.js': 'chart.js',
  d3: 'd3',
  'matter-js': 'matter-js',
  tone: 'tone',
  'pixi.js': 'pixi.js',
  p5: 'p5',
  mammoth: 'mammoth',
  marked: 'marked',
  prismjs: 'prismjs',
};

/**
 * Resolve a npm package to its browser entry point by reading package.json exports.
 *
 * Bun.resolveSync() uses runtime (node/bun) conditions, which for packages like
 * solid-js resolves to the SSR build (dist/server.js) instead of the browser build
 * (dist/solid.js). This helper reads the exports map and picks the browser condition.
 */
function resolveBrowserEntry(npmName: string, fromDir: string): string | null {
  // Split 'solid-js/web' → pkg='solid-js', subpath='./web'
  const parts = npmName.split('/');
  const isScoped = npmName.startsWith('@');
  const pkgName = isScoped ? parts.slice(0, 2).join('/') : parts[0];
  const subpath =
    parts.length > (isScoped ? 2 : 1) ? './' + parts.slice(isScoped ? 2 : 1).join('/') : '.';

  try {
    const pkgJsonPath = Bun.resolveSync(`${pkgName}/package.json`, fromDir);
    const pkgDir = dirname(pkgJsonPath);
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));

    const exportEntry = pkgJson.exports?.[subpath];
    if (!exportEntry) return null;

    // Prefer browser > default import condition
    const browser = exportEntry.browser;
    if (browser) {
      const entry = typeof browser === 'string' ? browser : (browser.import ?? browser.default);
      if (entry) return join(pkgDir, entry);
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Bun plugin that resolves @bundled/* imports.
 *
 * Resolution strategies (in order):
 * 1. **Embedded** (exe): Libraries embedded via `with { type: "file" }`,
 *    available as globalThis.__YAAR_BUNDLED_LIBS = { 'uuid': '/$bunfs/...', ... }.
 * 2. **Disk**: Libraries read from `bundled-libs/` directory next to the exe (fallback).
 * 3. **node_modules** (dev): Resolves browser entry from package.json exports,
 *    falling back to Bun.resolveSync() for packages without conditional exports.
 */
export function bundledLibraryPluginBun(): { name: string; setup: (build: any) => void } {
  return {
    name: 'bundled-libraries-bun',
    setup(build: any) {
      const NAMESPACE = 'bundled-lib';

      build.onResolve({ filter: /^@bundled\// }, (args: any) => {
        const libName = args.path.replace('@bundled/', '');
        if (!(libName in BUNDLED_LIBRARIES)) {
          const available = Object.keys(BUNDLED_LIBRARIES).join(', ');
          throw new Error(`Unknown bundled library: "${libName}". Available: ${available}`);
        }
        // Internal libraries resolve to real file paths so Bun follows relative imports
        if (BUNDLED_LIBRARIES[libName] === null) {
          const internalPath = join(PLUGIN_DIR, '..', `${libName}-runtime`, 'index.ts');
          return { path: internalPath };
        }

        // Strategy 1: embedded libs (production exe)
        const embeddedLibs = (globalThis as any).__YAAR_BUNDLED_LIBS as
          | Record<string, string>
          | undefined;
        if (embeddedLibs?.[libName]) {
          return { path: libName, namespace: NAMESPACE };
        }

        // Strategy 3: node_modules (dev) — first try browser-aware resolution
        // (Bun.resolveSync uses runtime/node conditions which gives SSR builds
        // for packages like solid-js), then fall back to Bun.resolveSync for
        // packages without conditional exports.
        const npmName = BUNDLED_LIBRARIES[libName]!;
        const browserPath = resolveBrowserEntry(npmName, PLUGIN_DIR);
        if (browserPath) return { path: browserPath };

        try {
          const resolved = Bun.resolveSync(npmName, PLUGIN_DIR);
          return { path: resolved };
        } catch {
          // fall through to namespace for disk-based resolution
        }

        return { path: libName, namespace: NAMESPACE };
      });

      // Intercept bare solid-js imports from within bundled libraries (e.g.,
      // solid-js/html imports solid-js/web, solid-js/web imports solid-js).
      // Without this, Bun's default resolver may pick different paths (e.g., dev
      // builds or symlinked paths) causing duplicate module copies with separate
      // reactive runtimes that break solid-js's signal tracking.
      build.onResolve({ filter: /^solid-js(\/|$)/ }, (args: any) => {
        const libName = args.path as string;
        if (!CONDITIONAL_EXPORT_LIBS.includes(libName)) return undefined;
        const browserPath = resolveBrowserEntry(libName, PLUGIN_DIR);
        if (browserPath) return { path: browserPath };
        try {
          return { path: Bun.resolveSync(libName, PLUGIN_DIR) };
        } catch {
          return undefined;
        }
      });

      build.onLoad({ filter: /.*/, namespace: NAMESPACE }, async (args: any) => {
        const libName = args.path;

        // Strategy 1: embedded libs (production exe)
        const embeddedLibs = (globalThis as any).__YAAR_BUNDLED_LIBS as
          | Record<string, string>
          | undefined;
        if (embeddedLibs?.[libName]) {
          const contents = await Bun.file(embeddedLibs[libName]).text();
          return { contents, loader: 'js' };
        }

        // Strategy 2: disk libs (dev exe) — bundled-libs/ next to executable
        const exeDir = dirname(process.execPath);
        const diskPath = join(exeDir, 'bundled-libs', `${libName}.js`);
        const diskFile = Bun.file(diskPath);
        if (await diskFile.exists()) {
          const contents = await diskFile.text();
          return { contents, loader: 'js' };
        }

        throw new Error(
          `Bundled library "${libName}" not found. ` +
            `Looked for embedded lib and disk file at ${diskPath}. ` +
            `Ensure the library is installed as a devDependency.`,
        );
      });
    },
  };
}

/**
 * Bun plugin that converts `.css` file imports into JS modules
 * that inject a <style> element at runtime.
 */
export function cssFilePlugin(): { name: string; setup: (build: any) => void } {
  return {
    name: 'css-file-loader',
    setup(build: any) {
      build.onLoad({ filter: /\.css$/ }, async (args: any) => {
        const css = await Bun.file(args.path).text();
        const escaped = css.replace(/`/g, '\\`').replace(/\$/g, '\\$');
        return {
          contents: `{const s=document.createElement('style');s.textContent=\`${escaped}\`;document.head.appendChild(s);}`,
          loader: 'js',
        };
      });
    },
  };
}

/**
 * Get the list of available bundled libraries.
 */
export function getAvailableBundledLibraries(): string[] {
  return Object.keys(BUNDLED_LIBRARIES).filter((k) => !k.includes('/'));
}
