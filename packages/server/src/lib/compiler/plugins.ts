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
 * Bun plugin that resolves @bundled/* imports.
 *
 * Three resolution strategies:
 * 1. **Embedded** (production exe): Libraries embedded via `with { type: "file" }`,
 *    available as globalThis.__YAAR_BUNDLED_LIBS = { 'uuid': '/$bunfs/...', ... }.
 * 2. **Disk** (dev exe): Libraries read from `bundled-libs/` directory next to the exe.
 *    Requires `pnpm build:exe:libs` to have been run.
 * 3. **node_modules** (dev non-exe): Resolves from PLUGIN_DIR via Bun.resolveSync().
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
        const actualModule = BUNDLED_LIBRARIES[libName];

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

        // Strategy 3: node_modules (dev non-exe) — resolve from server package
        try {
          const resolved = Bun.resolveSync(actualModule!, PLUGIN_DIR);
          const contents = await Bun.file(resolved).text();
          return { contents, loader: 'js' };
        } catch {
          // fall through to error
        }

        throw new Error(
          `Bundled library "${libName}" not found. ` +
            `Looked for embedded lib, disk file at ${diskPath}, ` +
            `and node_modules resolution from ${PLUGIN_DIR}. ` +
            `Ensure the library is installed as a devDependency.`,
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
