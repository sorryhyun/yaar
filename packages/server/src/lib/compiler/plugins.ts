/**
 * esbuild plugins for the app compiler.
 *
 * Provides bundled library support via @bundled/* imports.
 * In bundled exe mode, resolves from embedded pre-bundled files.
 */

import type { Plugin } from 'esbuild';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

/** Directory of this file — inside packages/server, where devDependencies are installed. */
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Map of @bundled/* import names to actual npm module paths.
 * These libraries are installed as devDependencies and bundled into apps.
 */
export const BUNDLED_LIBRARIES: Record<string, string> = {
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
};

/**
 * Plugin that intercepts @bundled/* imports and resolves them to
 * actual npm modules installed as devDependencies.
 *
 * This allows apps to use common utilities without npm install:
 * ```typescript
 * import { v4 as uuid } from '@bundled/uuid';
 * import anime from '@bundled/anime';
 * ```
 */
export function bundledLibraryPlugin(): Plugin {
  return {
    name: 'bundled-libraries',
    setup(build) {
      // Intercept @bundled/* imports
      build.onResolve({ filter: /^@bundled\// }, async (args) => {
        const libName = args.path.replace('@bundled/', '');
        const actualModule = BUNDLED_LIBRARIES[libName];

        if (!actualModule) {
          const available = Object.keys(BUNDLED_LIBRARIES).join(', ');
          return {
            errors: [
              {
                text: `Unknown bundled library: "${libName}". Available: ${available}`,
              },
            ],
          };
        }

        // Resolve from the server package directory where devDependencies are installed,
        // not from the sandbox directory (which has no node_modules).
        const result = await build.resolve(actualModule, {
          kind: args.kind,
          resolveDir: PLUGIN_DIR,
        });

        if (result.errors.length > 0) {
          return { errors: result.errors };
        }

        return { path: result.path };
      });
    },
  };
}

/**
 * Bun plugin that resolves @bundled/* from pre-bundled files.
 *
 * Two resolution strategies:
 * 1. **Embedded** (production exe): Libraries embedded via `with { type: "file" }`,
 *    available as globalThis.__YAAR_BUNDLED_LIBS = { 'uuid': '/$bunfs/...', ... }.
 * 2. **Disk** (dev exe): Libraries read from `bundled-libs/` directory next to the exe.
 *    Requires `pnpm build:exe:libs` to have been run.
 */
export function bundledLibraryPluginBun(): { name: string; setup: (build: any) => void } {
  return {
    name: 'bundled-libraries-bun',
    setup(build: any) {
      const NAMESPACE = 'bundled-lib';

      build.onResolve({ filter: /^@bundled\// }, (args: any) => {
        const libName = args.path.replace('@bundled/', '');
        if (!BUNDLED_LIBRARIES[libName]) {
          const available = Object.keys(BUNDLED_LIBRARIES).join(', ');
          throw new Error(`Unknown bundled library: "${libName}". Available: ${available}`);
        }
        return { path: libName, namespace: NAMESPACE };
      });

      build.onLoad({ filter: /.*/, namespace: NAMESPACE }, async (args: any) => {
        const libName = args.path;
        const BunApi = (globalThis as any).Bun;

        // Strategy 1: embedded libs (production exe)
        const embeddedLibs = (globalThis as any).__YAAR_BUNDLED_LIBS as
          | Record<string, string>
          | undefined;
        if (embeddedLibs?.[libName]) {
          const contents = await BunApi.file(embeddedLibs[libName]).text();
          return { contents, loader: 'js' };
        }

        // Strategy 2: disk libs (dev exe) — bundled-libs/ next to executable
        const exeDir = dirname(process.execPath);
        const diskPath = join(exeDir, 'bundled-libs', `${libName}.js`);
        const file = BunApi.file(diskPath);
        if (await file.exists()) {
          const contents = await file.text();
          return { contents, loader: 'js' };
        }

        throw new Error(
          `Bundled library "${libName}" not found. ` +
            `Looked for embedded lib and disk file at ${diskPath}. ` +
            `Run "pnpm build:exe:libs" to generate bundled-libs/.`,
        );
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
