/**
 * esbuild plugins for the app compiler.
 *
 * Provides bundled library support via @bundled/* imports.
 */

import type { Plugin } from 'esbuild';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

/** Directory of this file — inside packages/server, where devDependencies are installed. */
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Map of @bundled/* import names to actual npm module paths.
 * These libraries are installed as devDependencies and bundled into apps.
 */
const BUNDLED_LIBRARIES: Record<string, string> = {
  'uuid': 'uuid',
  'lodash': 'lodash-es',
  'date-fns': 'date-fns',
  'clsx': 'clsx',
  'anime': 'animejs',
  'konva': 'konva',
  'three': 'three',
  'cannon-es': 'cannon-es',
  'xlsx': 'xlsx',
  'chart.js': 'chart.js',
  'd3': 'd3',
  'matter-js': 'matter-js',
  'tone': 'tone',
  'pixi.js': 'pixi.js',
  'p5': 'p5',
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
            errors: [{
              text: `Unknown bundled library: "${libName}". Available: ${available}`,
            }],
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
 * Get the list of available bundled libraries.
 */
export function getAvailableBundledLibraries(): string[] {
  return Object.keys(BUNDLED_LIBRARIES);
}
