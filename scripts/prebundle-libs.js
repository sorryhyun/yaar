#!/usr/bin/env bun
/**
 * Pre-bundle @bundled/* libraries into single ESM files for exe embedding.
 *
 * Runs at build time (before build-exe-bundle.js) to produce one .js file
 * per library in dist/bundled-libs/. These are then embedded into the exe
 * via Bun's `with { type: "file" }` import mechanism.
 *
 * The per-library build lives in @yaar/compiler's `prebundleLibrary()` so the
 * prebundle-completeness test verifies the exact artifact this script writes —
 * the two cannot drift. Entry resolution (shim vs npm browser entry), the Node
 * builtin shims, and the solid-js external handling all live there.
 */

import { mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const outDir = join(rootDir, 'dist', 'bundled-libs');

// The canonical library map and the shared per-library build (Bun resolves .ts directly).
// `prebundleLibrary` routes shim-backed names (uuid, zod, lodash, pixi.js, yaar*) through
// their shim and everything else through the npm browser entry — one code path for both.
const { BUNDLED_LIBRARIES } = await import('../packages/compiler/src/plugins.ts');
const { prebundleLibrary } = await import('../packages/compiler/src/prebundle.ts');

mkdirSync(outDir, { recursive: true });

const libNames = Object.keys(BUNDLED_LIBRARIES);
console.log(`Pre-bundling ${libNames.length} libraries into ${outDir}...`);

const results = await Promise.allSettled(
  libNames.map(async (name) => {
    // Output written manually to support names with slashes (e.g. solid-js/html, pixi.js).
    const outfile = join(outDir, `${name}.js`);
    try {
      const code = await prebundleLibrary(name);
      mkdirSync(dirname(outfile), { recursive: true });
      await Bun.write(outfile, code);
      console.log(`  ✓ ${name} (${BUNDLED_LIBRARIES[name]})`);
      return { name, success: true };
    } catch (err) {
      console.error(`  ✗ ${name} (${BUNDLED_LIBRARIES[name]}): ${err.message}`);
      return { name, success: false, error: err.message };
    }
  }),
);

const failed = results.filter(
  (r) => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.success),
);
if (failed.length > 0) {
  console.error(`\n${failed.length} library(ies) failed to bundle.`);
  process.exit(1);
}

// Bundle CSS files from bundled libraries as JS style-injector modules.
// These are embedded into the exe via __YAAR_BUNDLED_LIBS, keyed by their
// original import path (e.g. "diff2html/bundles/css/diff2html.min.css").
const BUNDLED_CSS_FILES = ['diff2html/bundles/css/diff2html.min.css'];

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
