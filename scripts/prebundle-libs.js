#!/usr/bin/env bun
/**
 * Pre-bundle @bundled/* libraries into single ESM files for exe embedding.
 *
 * Runs at build time (before build-exe-bundle.js) to produce one .js file
 * per library in dist/bundled-libs/. These are then embedded into the exe
 * via Bun's `with { type: "file" }` import mechanism.
 */

import { mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const outDir = join(rootDir, 'dist', 'bundled-libs');

// Import the canonical map from @yaar/compiler (Bun can resolve .ts directly)
const { BUNDLED_LIBRARIES: _allLibs } = await import('../packages/compiler/src/plugins.ts');
// Filter out 'yaar' (it's a shim, not an npm package to pre-bundle)
const BUNDLED_LIBRARIES = Object.fromEntries(
  Object.entries(_allLibs).filter(([k]) => k !== 'yaar'),
);

mkdirSync(outDir, { recursive: true });

console.log(`Pre-bundling ${Object.keys(BUNDLED_LIBRARIES).length} libraries into ${outDir}...`);

const results = await Promise.allSettled(
  Object.entries(BUNDLED_LIBRARIES).map(async ([name, pkg]) => {
    const outfile = join(outDir, `${name}.js`);
    try {
      const resolved = import.meta.resolve(pkg);
      const entrypoint = resolved.startsWith('file://') ? Bun.fileURLToPath(resolved) : resolved;
      /** Shim Node builtins that some libs try to require in browser builds */
      const nodeShimPlugin = {
        name: 'node-shim',
        setup(build) {
          build.onResolve({ filter: /^(perf_hooks|worker_threads)$/ }, (args) => ({
            path: args.path,
            namespace: 'node-shim',
          }));
          build.onLoad({ filter: /.*/, namespace: 'node-shim' }, (args) => {
            if (args.path === 'perf_hooks') {
              return { contents: 'export const performance = globalThis.performance || {};', loader: 'js' };
            }
            return { contents: 'export default {};', loader: 'js' };
          });
        },
      };
      const result = await Bun.build({
        entrypoints: [entrypoint],
        minify: true,
        format: 'esm',
        target: 'browser',
        plugins: [nodeShimPlugin],
      });
      if (!result.success) {
        const errors = result.logs
          .filter((l) => l.level === 'error')
          .map((l) => l.message || String(l));
        throw new Error(errors.join('\n') || `Bun.build() failed for ${pkg}`);
      }
      // Write output manually to support names with slashes (e.g. solid-js/html)
      mkdirSync(dirname(outfile), { recursive: true });
      await Bun.write(outfile, result.outputs[0]);
      console.log(`  ✓ ${name} (${pkg})`);
      return { name, success: true };
    } catch (err) {
      console.error(`  ✗ ${name} (${pkg}): ${err.message}`);
      return { name, success: false, error: err.message };
    }
  })
);

const failed = results.filter(r => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.success));
if (failed.length > 0) {
  console.error(`\n${failed.length} library(ies) failed to bundle.`);
  process.exit(1);
}

console.log(`\nAll libraries bundled to ${outDir}`);
