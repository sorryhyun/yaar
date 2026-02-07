/**
 * esbuild plugins for the app compiler.
 *
 * Provides bundled library support via @bundled/* imports.
 */

import type { Plugin } from 'esbuild';

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
      build.onResolve({ filter: /^@bundled\// }, (args) => {
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

        // Resolve to the actual npm module (installed as devDep)
        // Return external: false to bundle the library into the output
        return {
          path: actualModule,
          external: false,
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
