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

// Import the canonical map and shims from @yaar/compiler (Bun can resolve .ts directly)
const { BUNDLED_LIBRARIES: _allLibs, BUNDLED_SHIMS, resolveBrowserEntry } = await import('../packages/compiler/src/plugins.ts');
// Filter out shim-based libraries (bundled separately below)
const BUNDLED_LIBRARIES = Object.fromEntries(
  Object.entries(_allLibs).filter(([k]) => !(k in BUNDLED_SHIMS)),
);

mkdirSync(outDir, { recursive: true });

console.log(`Pre-bundling ${Object.keys(BUNDLED_LIBRARIES).length} libraries into ${outDir}...`);

const results = await Promise.allSettled(
  Object.entries(BUNDLED_LIBRARIES).map(async ([name, pkg]) => {
    const outfile = join(outDir, `${name}.js`);
    try {
      // For packages with browser/node conditional exports (e.g. solid-js),
      // import.meta.resolve() picks the node/bun condition (SSR build).
      // Use resolveBrowserEntry() first to get the browser build.
      const browserEntry = resolveBrowserEntry(pkg, __dirname);
      const resolved = browserEntry ?? import.meta.resolve(pkg);
      const entrypoint = resolved.startsWith('file://') ? Bun.fileURLToPath(resolved) : resolved;
      if (browserEntry) console.log(`    (browser entry: ${entrypoint})`);
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
      // For solid-js sub-packages (html, web, store), mark sister packages as
      // external so they don't each bundle their own copy of solid-js. At runtime,
      // the compiler plugin's onResolve interceptor redirects these bare imports
      // to the shared prebundled solid-js bundle, preventing duplicate instances.
      const external = [];
      if (name.startsWith('solid-js/')) {
        external.push('solid-js', ...['solid-js/web', 'solid-js/html', 'solid-js/store'].filter(n => n !== name));
      }
      const result = await Bun.build({
        entrypoints: [entrypoint],
        minify: true,
        format: 'esm',
        target: 'browser',
        plugins: [nodeShimPlugin],
        external,
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

// Bundle shim-based libraries (e.g. yaar) — these are local .ts files, not npm packages
for (const [name, shimPath] of Object.entries(BUNDLED_SHIMS)) {
  const outfile = join(outDir, `${name}.js`);
  try {
    const result = await Bun.build({
      entrypoints: [shimPath],
      minify: true,
      format: 'esm',
      target: 'browser',
    });
    if (!result.success) {
      const errors = result.logs.filter(l => l.level === 'error').map(l => l.message || String(l));
      throw new Error(errors.join('\n') || `Bun.build() failed for shim ${name}`);
    }
    mkdirSync(dirname(outfile), { recursive: true });
    await Bun.write(outfile, result.outputs[0]);
    console.log(`  ✓ ${name} (shim)`);
  } catch (err) {
    console.error(`  ✗ ${name} (shim): ${err.message}`);
    process.exit(1);
  }
}

// Bundle CSS files from bundled libraries as JS style-injector modules.
// These are embedded into the exe via __YAAR_BUNDLED_LIBS, keyed by their
// original import path (e.g. "diff2html/bundles/css/diff2html.min.css").
const BUNDLED_CSS_FILES = [
  'diff2html/bundles/css/diff2html.min.css',
];

for (const cssPath of BUNDLED_CSS_FILES) {
  try {
    const resolved = import.meta.resolve(cssPath);
    const absPath = resolved.startsWith('file://') ? Bun.fileURLToPath(resolved) : resolved;
    const css = await Bun.file(absPath).text();
    const escaped = css.replace(/`/g, '\\`').replace(/\$/g, '\\$');
    const js = `{const s=document.createElement('style');s.textContent=\`${escaped}\`;document.head.appendChild(s);}`;
    const outfile = join(outDir, `${cssPath}.js`);
    mkdirSync(dirname(outfile), { recursive: true });
    await Bun.write(outfile, js);
    console.log(`  ✓ ${cssPath} (css→js)`);
  } catch (err) {
    console.error(`  ✗ ${cssPath} (css): ${err.message}`);
  }
}

console.log(`\nAll libraries bundled to ${outDir}`);
