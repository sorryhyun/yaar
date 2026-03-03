/**
 * Bun plugins for the app compiler.
 *
 * Provides bundled library support via @bundled/* imports.
 * In bundled exe mode, resolves from embedded or disk-based pre-bundled files.
 * In dev mode, resolves from node_modules via Bun.resolveSync().
 */

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

/** Directory of this file — inside packages/server, where devDependencies are installed. */
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Map of @bundled/* import names to actual npm module paths.
 * These libraries are installed as devDependencies and bundled into apps.
 * `null` = internal library (resolved from server source, not npm).
 */
export const BUNDLED_LIBRARIES: Record<string, string | null> = {
  yaar: null,
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
 * Bun plugin that resolves @bundled/* imports.
 *
 * Resolution strategies (in order):
 * 1. **Embedded** (exe): Libraries embedded via `with { type: "file" }`,
 *    available as globalThis.__YAAR_BUNDLED_LIBS = { 'uuid': '/$bunfs/...', ... }.
 * 2. **Disk**: Libraries read from `bundled-libs/` directory next to the exe (fallback).
 * 3. **node_modules** (dev): Resolves from PLUGIN_DIR via Bun.resolveSync().
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

        // Strategy 3: node_modules (dev) — resolve to real filesystem path so
        // Bun can follow relative imports within the library (e.g. THREE.js
        // imports ./three.core.js from three.module.js).
        try {
          const resolved = Bun.resolveSync(BUNDLED_LIBRARIES[libName]!, PLUGIN_DIR);
          return { path: resolved };
        } catch {
          // fall through to namespace for disk-based resolution
        }

        return { path: libName, namespace: NAMESPACE };
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
  return Object.keys(BUNDLED_LIBRARIES);
}
